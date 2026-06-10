// The bulk git-log pass: one parse of `git log --name-only` output builds
// BOTH per-file commit counts (hotspots / commitFrequency) and the
// co-change pair matrix. Pure functions, no I/O — the GitService owns the
// subprocess; tests feed canned stdout strings.
//
// Output format contract (verified against real git):
//   --pretty=format:%x00%ct --name-only
// emits, per commit, a NUL byte, the committer epoch-seconds, a newline,
// then one path per line (blank-line separated from the next record):
//   \0<epoch>\n<path>\n<path>\n\n\0<epoch>\n<path>\n
// NUL can never appear in %ct output or in a path line, so splitting
// stdout on NUL yields exactly one chunk per commit. We deliberately do
// NOT print %H or %s: this pass needs only boundaries and timestamps,
// and omitting the subject removes the entire weird-subject parsing
// class. core.quotepath=false (prepended by GitRunner) keeps non-ASCII
// paths literal; a pathological newline-containing filename just becomes
// a non-matching line that the membership filters discard.

import { posix } from 'node:path';

import { log } from '../logger.js';
import type { CoChange } from '../types.js';

// Delegated to git via --max-count; also asserted parse-side so a huge
// repo can't blow the pair map regardless of what git returns.
export const GIT_COMMIT_CAP = 10_000;
// Commits touching more than this many files (vendored-dep updates, mass
// renames, formatting sweeps) are skipped ENTIRELY — both for pairs and
// for counts. Using one filtered stream for numerators AND denominators
// keeps confidence <= 1 as an invariant.
export const MAX_FILES_PER_COMMIT = 30;
// A pair must share at least this many commits to register as coupling.
export const MIN_SHARED_COMMITS = 3;
// Per-file partner lists are truncated to this many strongest partners
// to bound persisted cache size.
export const COCHANGES_PER_FILE_CAP = 20;
// Tools render top 10; the extra headroom serves the search boost and
// survives files dropping out of the index between analyses.
export const HOTSPOTS_KEPT = 50;
// Bounds transient memory for the pair accumulation (worst case ~40 MB).
// git log is newest-first, so when the cap hits, the most recent (most
// relevant) pairs are already in the map; we stop inserting NEW keys but
// keep incrementing existing ones.
const PAIR_MAP_CAP = 250_000;

export function buildLogArgs(windowDays: number, now: number = Date.now()): string[] {
  const since = new Date(now - windowDays * 86_400_000).toISOString();
  return [
    'log',
    '--no-merges',
    // Rename detection is heuristic and git-version-dependent; with it
    // disabled a rename is a plain delete+add, so the old path simply
    // stops accruing and the new path starts fresh. Deterministic.
    '--no-renames',
    '--name-only',
    `--max-count=${GIT_COMMIT_CAP}`,
    `--since=${since}`,
    '--pretty=format:%x00%ct',
  ];
}

export interface GitAnalysis {
  // EVERY path seen in kept commits, including non-indexed ones — those
  // are needed as confidence denominators for partner values like
  // config/auth.yaml that probe doesn't index.
  counts: Map<string, number>;
  // Keyed by indexed paths only; partner values unrestricted.
  cochanges: Map<string, CoChange[]>;
  // Indexed paths only, commit count desc then path asc, <= HOTSPOTS_KEPT.
  hotspots: string[];
  // Kept (parsed, non-mega) commit count — callers log when the cap hit.
  commitCount: number;
}

interface PairAccum {
  shared: number;
  lastSeen: number;
}

// `pathPrefix` handles project roots that are a SUBDIRECTORY of the git
// toplevel (monorepo packages): git log emits repo-relative paths
// ('packages/app/src/x.ts') while index keys are project-relative
// ('src/x.ts'). Paths under the prefix are stripped to index-relative;
// paths OUTSIDE it are rewritten project-relative too ('../'-prefixed
// via posix.relative) — index keys never start with '..', so an outside
// file like the toplevel package.json can never collide with the
// package's own package.json key (it would silently merge counts and
// fabricate co-change pairs otherwise). Outside paths only ever serve
// as confidence denominators and partner values.
// Pass '' (the default) when the project root IS the toplevel.
export function analyzeLog(
  stdout: string,
  isIndexed: (path: string) => boolean,
  pathPrefix = '',
): GitAnalysis {
  const counts = new Map<string, number>();
  const pairs = new Map<string, PairAccum>();
  let commitCount = 0;
  let pairCapWarned = false;

  for (const chunk of stdout.split('\u0000')) {
    if (commitCount >= GIT_COMMIT_CAP) break;
    if (chunk.length === 0) continue; // leading separator before the first record
    const lines = chunk.split('\n');
    const timestampSec = Number(lines[0]?.trim());
    if (!Number.isFinite(timestampSec)) continue; // garbled record — drop, never throw
    const timestampMs = timestampSec * 1000;

    const files = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      let path = lines[i].replace(/\r$/, '');
      if (path.length === 0) continue;
      if (pathPrefix.length > 0) {
        path = path.startsWith(pathPrefix)
          ? path.slice(pathPrefix.length)
          : posix.relative(pathPrefix, path);
      }
      if (path.length > 0) files.add(path);
    }
    if (files.size === 0) continue; // empty commit
    if (files.size > MAX_FILES_PER_COMMIT) continue;
    commitCount++;

    for (const path of files) {
      counts.set(path, (counts.get(path) ?? 0) + 1);
    }

    const sorted = [...files].sort();
    // Hoisted out of the O(k²) pair loop: per-pair isIndexed calls would
    // re-resolve each path up to k-1 times.
    const indexedFlags = sorted.map(isIndexed);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (!indexedFlags[i] && !indexedFlags[j]) continue;
        const key = `${sorted[i]}\u0000${sorted[j]}`;
        const existing = pairs.get(key);
        if (existing) {
          existing.shared++;
        } else if (pairs.size < PAIR_MAP_CAP) {
          // Newest-first log order: first sighting IS the most recent.
          pairs.set(key, { shared: 1, lastSeen: timestampMs });
        } else if (!pairCapWarned) {
          pairCapWarned = true;
          log.debug(
            `git: co-change pair map hit ${PAIR_MAP_CAP} entries; older pairs ignored`,
          );
        }
      }
    }
  }

  const cochanges = new Map<string, CoChange[]>();
  for (const [key, accum] of pairs) {
    if (accum.shared < MIN_SHARED_COMMITS) continue;
    const sep = key.indexOf('\u0000');
    const fileA = key.slice(0, sep);
    const fileB = key.slice(sep + 1);
    const commitsA = counts.get(fileA);
    const commitsB = counts.get(fileB);
    if (!commitsA || !commitsB) continue; // defensive; both sides were counted
    const record: CoChange = {
      fileA,
      fileB,
      sharedCommits: accum.shared,
      confidenceAB: accum.shared / commitsA,
      confidenceBA: accum.shared / commitsB,
      lastSeen: accum.lastSeen,
    };
    if (isIndexed(fileA)) pushTo(cochanges, fileA, record);
    if (isIndexed(fileB)) pushTo(cochanges, fileB, record);
  }
  for (const [path, list] of cochanges) {
    list.sort(
      (a, b) =>
        b.sharedCommits - a.sharedCommits ||
        comparePaths(partnerOf(a, path), partnerOf(b, path)),
    );
    if (list.length > COCHANGES_PER_FILE_CAP) {
      cochanges.set(path, list.slice(0, COCHANGES_PER_FILE_CAP));
    }
  }

  const hotspots = [...counts.entries()]
    .filter(([path]) => isIndexed(path))
    .sort((a, b) => b[1] - a[1] || comparePaths(a[0], b[0]))
    .slice(0, HOTSPOTS_KEPT)
    .map(([path]) => path);

  return { counts, cochanges, hotspots, commitCount };
}

export function partnerOf(record: CoChange, selfPath: string): string {
  return record.fileA === selfPath ? record.fileB : record.fileA;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function pushTo(map: Map<string, CoChange[]>, key: string, value: CoChange): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
