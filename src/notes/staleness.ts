import type { GitService, RecentCommit } from '../git/git-service.js';
import type { CodeIndex } from '../indexer/code-index.js';
import { hashContent } from '../indexer/pipeline.js';
import { safeReadIndexedFile } from '../fs-util.js';
import type { CodedeepConfig, Symbol } from '../types.js';
import { qualifiedSymbolName } from './note-store.js';
import type { Anchor, Note } from './types.js';

// Per-anchor freshness, computed lazily at recall time against DISK (never the
// possibly-lagging live index — see computeAnchorStatus).
//
//   fresh      — the anchored file is byte-identical to when the note was made.
//   stale      — the file changed since the note (detail refines symbol anchors).
//   unverified — no baseline hash captured, or the file couldn't be read.
//   missing    — the anchored file no longer exists.
export type AnchorVerdict = 'fresh' | 'stale' | 'unverified' | 'missing';

export interface AnchorStatus {
  anchor: Anchor;
  verdict: AnchorVerdict;
  detail: string;
  // Live last-commit-touching-the-file, attached only when stale + git is
  // available (the "changed at commit X — re-verify" signal).
  lastCommit?: RecentCommit;
}

export interface NoteStatus {
  // Worst verdict across the note's anchors (stale/missing > unverified > fresh).
  overall: AnchorVerdict;
  anchors: AnchorStatus[];
}

export interface StalenessDeps {
  index: CodeIndex;
  config: CodedeepConfig;
  git: Pick<GitService, 'recentCommits'>;
}

const SEVERITY: Record<AnchorVerdict, number> = {
  fresh: 0,
  unverified: 1,
  stale: 2,
  missing: 3,
};

// Note-level verdict = the worst of its anchors. A note with NO anchors is
// "unverified" (stored, but not staleness-tracked).
export async function computeNoteStatus(
  note: Note,
  deps: StalenessDeps,
  // Optional caches so a whole recall hashes each distinct file, and fetches
  // each file's last commit, at most once across the entire result set.
  fileCache?: FileProbeCache,
  commitCache?: CommitCache,
): Promise<NoteStatus> {
  if (note.anchors.length === 0) {
    return { overall: 'unverified', anchors: [] };
  }
  // Anchors are independent — check them concurrently (the caches dedup any
  // shared file probe / git call).
  const anchors = await Promise.all(
    note.anchors.map((a) => computeAnchorStatus(a, deps, fileCache, commitCache)),
  );
  let overall: AnchorVerdict = 'fresh';
  for (const a of anchors) {
    if (SEVERITY[a.verdict] > SEVERITY[overall]) overall = a.verdict;
  }
  return { overall, anchors };
}

// 'ok' carries the live content hash; the failure states classify the read.
export type FileProbe =
  | { state: 'ok'; liveHash: string }
  | { state: 'missing' }
  | { state: 'unreadable'; reason?: string };

// Lets a single recall hash each distinct anchored file at most once across
// the whole result set. Opaque to callers — build one with newFileProbeCache.
export type FileProbeCache = Map<string, Promise<FileProbe>>;
export function newFileProbeCache(): FileProbeCache {
  return new Map();
}

// Lets a single recall fetch each distinct file's last commit at most once —
// recentCommits memoizes RESOLVED values, so without this the parallel status
// computation would spawn K concurrent `git log` for K stale notes on one file.
export type CommitCache = Map<string, Promise<RecentCommit | undefined>>;
export function newCommitCache(): CommitCache {
  return new Map();
}

async function probeFile(
  relPath: string,
  config: CodedeepConfig,
): Promise<FileProbe> {
  try {
    const content = await safeReadIndexedFile(relPath, config);
    return { state: 'ok', liveHash: hashContent(content) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: (err as Error)?.message };
  }
}

export async function computeAnchorStatus(
  anchor: Anchor,
  deps: StalenessDeps,
  fileCache?: FileProbeCache,
  commitCache?: CommitCache,
): Promise<AnchorStatus> {
  // 1. Read the file from DISK and hash it — index-independent, so a disabled
  //    or lagging watcher can't produce a false "fresh".
  let probePromise = fileCache?.get(anchor.file);
  if (!probePromise) {
    probePromise = probeFile(anchor.file, deps.config);
    fileCache?.set(anchor.file, probePromise);
  }
  const probe = await probePromise;

  if (probe.state === 'missing') {
    return { anchor, verdict: 'missing', detail: 'file no longer exists' };
  }
  if (probe.state === 'unreadable') {
    return {
      anchor,
      verdict: 'unverified',
      detail: `file could not be read (${probe.reason ?? 'unknown'})`,
    };
  }
  if (anchor.fileContentHash === undefined) {
    return {
      anchor,
      verdict: 'unverified',
      detail: 'no baseline captured at note time (file was unindexed)',
    };
  }
  if (probe.liveHash === anchor.fileContentHash) {
    // Byte-identical file ⇒ the anchored symbol is unchanged too.
    return { anchor, verdict: 'fresh', detail: 'unchanged' };
  }

  // 2. File changed. Refine the detail (and attach a live commit) for stale.
  const detail = describeChange(anchor, deps, probe.liveHash);
  let commitPromise = commitCache?.get(anchor.file);
  if (!commitPromise) {
    commitPromise = deps.git.recentCommits(anchor.file, 1).then((c) => c[0]);
    commitCache?.set(anchor.file, commitPromise);
  }
  const lastCommit = await commitPromise;
  return lastCommit
    ? { anchor, verdict: 'stale', detail, lastCommit }
    : { anchor, verdict: 'stale', detail };
}

// For a symbol anchor on a changed file, say WHAT changed by consulting the
// index AS-IS. recall is read-only, so it must NOT re-index (indexFile mutates
// the shared index — and can DELETE symbols other tools rely on when a file is
// now unparseable/excluded). When the watcher is on (default) the index is
// current, so signature-change detection is precise; with the watcher off the
// index may lag, so this DETAIL is best-effort — the note is still correctly
// flagged stale by the authoritative disk-hash comparison above.
function describeChange(
  anchor: Anchor,
  deps: StalenessDeps,
  liveHash: string,
): string {
  if (anchor.symbolId === undefined || anchor.symbol === undefined) {
    return 'file changed since this note';
  }
  // Trust the index's symbols ONLY when they reflect the CURRENT disk bytes. If
  // the index lags disk (watch off / mid-debounce / cap-skipped) its stored
  // symbolId still matches the note's, which would give a WRONG "signature
  // intact" detail for a signature that actually changed — so fall back to the
  // generic detail rather than mislead. (The note is already correctly stale.)
  const indexed = deps.index.getFile(anchor.file);
  if (indexed === undefined) {
    // The file isn't in the index at all — excluded by config, unknown-language,
    // or not re-scanned after a cache wipe. Re-indexing can't surface its symbols
    // (that's exactly why it's absent), so DON'T advise it; say symbol-level
    // detail is unavailable for this file.
    return 'file changed since this note (not indexed — no symbol-level detail)';
  }
  if (indexed.contentHash !== liveHash) {
    return 'file changed since this note (re-index for symbol-level detail)';
  }
  // anchor.symbol is the QUALIFIED name (e.g. "Class.member"), so reconstruct
  // each candidate's qualified name the same way remember stored it — matching
  // the simple Symbol.name here would never hit for a member anchor and would
  // falsely report every member as "renamed or removed".
  const candidates = deps.index
    .getSymbolsInFile(anchor.file)
    .filter((s) => qualifiedSymbolName(s.fqn, anchor.file, s.name) === anchor.symbol);
  if (candidates.length === 0) {
    return `\`${anchor.symbol}\` was renamed or removed`;
  }
  const match = pickSymbol(candidates, anchor);
  if (match.id === anchor.symbolId) {
    // symbolId is body-insensitive, so an intact id means the SIGNATURE is
    // unchanged — the file edit was the body (or elsewhere in the file).
    return `file edited; \`${anchor.symbol}\` signature intact, body may have changed`;
  }
  const was = anchor.signature ? ` (was \`${anchor.signature}\`)` : '';
  return `\`${anchor.symbol}\` signature changed${was}`;
}

// Prefer a candidate whose id matches the snapshot (so an overloaded/duplicated
// name still reports "intact" when the right one survives); otherwise prefer a
// kind match; otherwise the first.
function pickSymbol(candidates: Symbol[], anchor: Anchor): Symbol {
  const byId = candidates.find((s) => s.id === anchor.symbolId);
  if (byId) return byId;
  if (anchor.symbolKind) {
    const byKind = candidates.find((s) => s.kind === anchor.symbolKind);
    if (byKind) return byKind;
  }
  return candidates[0];
}
