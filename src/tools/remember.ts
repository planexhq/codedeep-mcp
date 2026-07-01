import { createHash, randomBytes } from 'node:crypto';

import type { GitService } from '../git/git-service.js';
import type { CodeIndex } from '../indexer/code-index.js';
import { hashContent } from '../indexer/pipeline.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import { NoteStore, qualifiedSymbolName } from '../notes/note-store.js';
import type { Anchor, Note } from '../notes/types.js';
import type { CodedeepConfig } from '../types.js';
import {
  normalizeFilePath,
  pickByLine,
  readinessBanner,
  safeReadIndexedFile,
  textResponse,
  type ToolResponse,
} from './common.js';

export interface RememberArgs {
  note: string;
  anchors?: string[];
}

export interface RememberDeps {
  notes: NoteStore;
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: CodedeepConfig;
  git: Pick<GitService, 'currentHead'>;
}

const MAX_NOTE_CHARS = 4000;

interface ParsedAnchor {
  file: string; // raw, pre-normalization
  symbol?: string;
  line?: number;
}

// "file" | "file:symbol" | "file:symbol:line". The file/symbol boundary is the
// FIRST ':' that follows the last path separator, so neither a path's own ':'
// (a Windows drive letter "C:\proj\a.ts") nor a symbol's "::" scope / "." member
// separators are mis-split. The symbol may be a simple name, "Class.member", or
// "Ns::Type::method" (resolved below); a trailing ":<digits>" is the 1-based line.
function parseAnchor(raw: string): ParsedAnchor | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const lastSep = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  // Split at the first ':' after the last path separator. A normal Windows
  // absolute path ("C:\proj\a.ts:sym") is handled because its drive ':' precedes
  // the last '\'. The only ambiguous form left is a separator-less string like
  // "X:rest" (a single-char filename "X" with symbol "rest" vs a drive-relative
  // "C:foo.ts") — we favor file+symbol, since anchors are almost always
  // project-relative paths; drive-relative-without-separator is vanishingly rare.
  const splitAt = trimmed.indexOf(':', lastSep + 1);
  const file = splitAt === -1 ? trimmed : trimmed.slice(0, splitAt);
  let tail = splitAt === -1 ? '' : trimmed.slice(splitAt + 1);
  let line: number | undefined;
  // Peel a trailing ":<digits>" — the line pin, OR the COLUMN of a
  // "file:line:col" paste (grep --column / editor gutter / stack-trace ref).
  const lineMatch = tail.match(/:(\d+)$/);
  if (lineMatch) {
    const n = Number(lineMatch[1]);
    if (Number.isInteger(n) && n >= 1) line = n; // 1-based; :0 is not a pin
    tail = tail.slice(0, lineMatch.index);
  }
  // A purely-numeric remainder is a line number, not a symbol literally named
  // after a number. Covers both "file:line" (nothing peeled above) and
  // "file:line:col" (the column was peeled into `line`; this remainder is the
  // real LINE and OVERRIDES it — the column is discarded). Without the override a
  // "file:10:20" ref would parse as a phantom symbol "10" and lose the location.
  if (/^\d+$/.test(tail)) {
    const n = Number(tail);
    if (n >= 1) line = n;
    tail = '';
  }
  return { file: file.trim(), symbol: tail.trim() || undefined, line };
}

export async function runRemember(
  args: RememberArgs,
  deps: RememberDeps,
): Promise<ToolResponse> {
  try {
    const text = (args.note ?? '').trim();
    if (text.length === 0) {
      return textResponse('Error: note must be non-empty.');
    }
    if (text.length > MAX_NOTE_CHARS) {
      return textResponse(
        `Error: note is too long (${text.length} > ${MAX_NOTE_CHARS} chars). ` +
          `Keep notes focused; split into multiple anchored notes.`,
      );
    }
    // load() first so a prior transient read failure is retried before we read
    // (and act on) the write-block flag.
    await deps.notes.load();
    const blocked = deps.notes.writeBlockReason;
    if (blocked) return textResponse(`Error: ${blocked}`);

    // Resolve anchors. A bad path fails the whole call (cheap to fix and a
    // silent skip would hide a typo); an unindexed file / missing symbol is
    // captured as a weaker anchor and flagged, never an error.
    const rawAnchors = (args.anchors ?? []).filter((a) => a.trim().length > 0);
    const anchors: Anchor[] = [];
    const lines: string[] = [];
    // Dedupe the disk read+hash: multiple anchors can target the same file.
    const hashCache = new Map<string, string | undefined>();
    for (const raw of rawAnchors) {
      const parsed = parseAnchor(raw);
      if (parsed === null) continue;
      if (parsed.file === '') {
        return textResponse(
          `Error: anchor "${raw}" is missing a file part (use "file" or "file:symbol").`,
        );
      }
      const rel = normalizeFilePath(parsed.file, deps.config.projectRoot);
      if (rel === null) {
        return textResponse(
          `Error: anchor "${parsed.file}" is outside the project root.`,
        );
      }
      const { anchor, line } = await resolveAnchor(
        rel,
        parsed,
        deps.index,
        deps.config,
        hashCache,
        deps.indexer.ready,
      );
      anchors.push(anchor);
      lines.push(line);
    }

    const head = (await deps.git.currentHead()) ?? undefined;
    const createdAt = new Date().toISOString();
    const note: Note = {
      id: noteId(createdAt, text),
      text,
      createdAt,
      anchors,
      ...(head ? { head } : {}),
    };
    await deps.notes.add(note);

    const banner = readinessBanner(deps.indexer.ready);
    const out: string[] = [`✓ Remembered (note ${note.id}).`];
    if (anchors.length === 0) {
      out.push(
        '⚠ No anchors — this note is stored but not staleness-tracked. ' +
          'Re-run with anchors like "src/auth.ts:authenticate" to track it.',
      );
    } else {
      out.push('Anchors:');
      out.push(...lines);
    }
    return textResponse(banner + out.join('\n'));
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

async function resolveAnchor(
  rel: string,
  parsed: ParsedAnchor,
  index: CodeIndex,
  config: CodedeepConfig,
  hashCache: Map<string, string | undefined>,
  indexReady: boolean,
): Promise<{ anchor: Anchor; line: string }> {
  // Baseline hash MUST come from DISK — the same bytes recall re-hashes — not
  // the index's contentHash, which lags disk (watcher debounce / watch off /
  // cold start). Trusting the index here would make a note written against
  // unindexed-but-current bytes read 'stale' on its very first recall.
  // Symbol-level detail (id/kind/signature) still comes from the index below.
  let fileContentHash: string | undefined;
  if (hashCache.has(rel)) {
    fileContentHash = hashCache.get(rel);
  } else {
    try {
      fileContentHash = hashContent(await safeReadIndexedFile(rel, config));
    } catch {
      fileContentHash = undefined; // missing / unreadable → unverified anchor
    }
    hashCache.set(rel, fileContentHash);
  }
  const anchor: Anchor = { file: rel };
  if (fileContentHash !== undefined) anchor.fileContentHash = fileContentHash;

  if (parsed.symbol === undefined) {
    const line =
      fileContentHash !== undefined
        ? `- ${rel} — file captured (hash ${fileContentHash})`
        : `- ⚠ ${rel} — not readable on disk; stored as an unverified anchor`;
    return { anchor, line };
  }

  // Symbol anchor. Match the simple name, OR an FQN-style "Class.member" /
  // "Ns::Type::method" via the symbol's fqn (`<file>:<Class>.<member>`, dotted)
  // so members can be anchored precisely without dropping to file level. `::`
  // scope separators are normalized to the extractor's `.` FQN form.
  const wantFqn = `${rel}:${parsed.symbol.replace(/::/g, '.')}`;
  const candidates = index
    .getSymbolsInFile(rel)
    .filter((s) => s.name === parsed.symbol || s.fqn === wantFqn);
  if (candidates.length === 0) {
    if (!indexReady) {
      // Startup indexing is still running, so a real-but-not-yet-parsed symbol
      // looks absent. Don't claim "symbol not found" (it may well exist once
      // indexing finishes). Store the normalized NAME so recall can still find
      // the note by symbol, and tell the agent to re-remember once indexed for
      // signature-level tracking — a name with no baseline symbolId yields only
      // file-level staleness (describeChange bails to the generic detail).
      anchor.symbol = parsed.symbol.replace(/::/g, '.');
      return {
        anchor,
        line:
          `- ⚠ ${rel}:${parsed.symbol} — index still building; not yet resolvable. ` +
          `Anchored by name (file-level staleness for now); re-remember after ` +
          `indexing completes for signature-level tracking.`,
      };
    }
    return {
      anchor,
      line: `- ⚠ ${rel}:${parsed.symbol} — symbol not found; anchored at file level`,
    };
  }
  let target = candidates[0];
  if (candidates.length > 1) {
    if (parsed.line === undefined) {
      // Ambiguous: anchor by file (still useful). Store the NORMALIZED name so
      // recall's `::`-folding bySymbol can still match it.
      anchor.symbol = parsed.symbol.replace(/::/g, '.');
      return {
        anchor,
        line:
          `- ⚠ ${rel}:${parsed.symbol} — ${candidates.length} symbols share this name; ` +
          `anchored by name (add a line, e.g. "${rel}:${parsed.symbol}:42", to pin one)`,
      };
    }
    target = pickByLine(candidates, parsed.line);
  }
  // Store the QUALIFIED name (fqn's part after "<file>:", e.g. "Class.member")
  // so recall can distinguish two same-simple-named members in one file.
  const qualified = qualifiedSymbolName(target.fqn, rel, target.name);
  anchor.symbol = qualified;
  anchor.symbolId = target.id;
  anchor.symbolKind = target.kind;
  if (target.signature) anchor.signature = target.signature;
  const hashSuffix =
    fileContentHash !== undefined ? `, hash ${fileContentHash}` : ', file unreadable';
  return {
    anchor,
    line: `- ${rel}:${qualified} — ${target.kind} #${target.id}${hashSuffix}`,
  };
}

// A random nonce (not a notes.length sequence — that repeats after a forget,
// so two same-text notes in the same millisecond could collide) makes the id
// collision-proof across the store's whole lifetime.
function noteId(createdAt: string, text: string): string {
  return createHash('sha1')
    .update(`${createdAt}\0${text}\0${randomBytes(8).toString('hex')}`)
    .digest('hex')
    .slice(0, 16);
}
