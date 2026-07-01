import type { GitService } from '../git/git-service.js';
import type { CodeIndex } from '../indexer/code-index.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import { NoteStore } from '../notes/note-store.js';
import {
  computeNoteStatus,
  newCommitCache,
  newFileProbeCache,
  type AnchorStatus,
  type AnchorVerdict,
  type NoteStatus,
  type StalenessDeps,
} from '../notes/staleness.js';
import type { Note } from '../notes/types.js';
import type { CodedeepConfig } from '../types.js';
import {
  BEHAVIORAL_TAG,
  estimate,
  formatRelativeAge,
  normalizeFilePath,
  readinessBanner,
  textResponse,
  type ToolResponse,
} from './common.js';

export interface RecallArgs {
  query?: string;
  file?: string;
  symbol?: string;
  limit?: number;
  max_tokens?: number;
}

export interface RecallDeps {
  notes: NoteStore;
  index: CodeIndex;
  // recall is READ-ONLY: it reads the index but never re-indexes (that would
  // mutate shared state other tools depend on), so it needs only `ready`.
  indexer: Pick<Indexer, 'ready'>;
  config: CodedeepConfig;
  git: Pick<GitService, 'recentCommits'>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const DEFAULT_MAX_TOKENS = 3000;
// The summary line + truncation tail are emitted around the note blocks but not
// counted per-block; reserve for their worst-case length (a full multi-lever
// tail + count breakdown runs ~200 chars) so the response respects the soft
// max_tokens budget rather than overshooting.
const SUMMARY_RESERVE = 64;

const VERDICT_TAG: Record<AnchorVerdict, string> = {
  fresh: '✓ fresh',
  stale: '⚠ stale',
  unverified: '? unverified',
  missing: '✗ missing',
};
const VERDICT_MARK: Record<AnchorVerdict, string> = {
  fresh: '✓',
  stale: '⚠',
  unverified: '?',
  missing: '✗',
};

export async function runRecall(
  args: RecallArgs,
  deps: RecallDeps,
): Promise<ToolResponse> {
  try {
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;
    const banner = readinessBanner(deps.indexer.ready);

    // Ensure the store is loaded (retries a prior transient read failure so a
    // recovered store serves its real notes instead of a stale empty view).
    await deps.notes.load();

    // A store-level degraded notice — set when the prior notes were quarantined
    // (moved aside), an interrupted-swap `.bak` may hold recoverable notes, or the
    // store is transiently unreadable. Surfaced on EVERY recall (not just the
    // zero-match one): after a quarantine the agent may add new notes, so a later
    // NON-empty recall must still warn that the earlier notes were moved aside and
    // need manual recovery. A newer-version store that SERVES its notes has no
    // notice (its zero-match filter is a normal no-match), nor does a truly-empty one.
    const degraded = deps.notes.degradedReason;
    const degradedNote = degraded
      ? `\n\n(The note store is degraded: ${degraded})`
      : '';

    const selection = selectNotes(args, deps);
    if ('error' in selection) return textResponse(selection.error);
    const { notes, header } = selection;

    if (notes.length === 0) {
      return textResponse(banner + `${header}\n\nNo notes match.${degradedNote}`);
    }

    // Hash each distinct anchored file — and fetch its last commit — at most
    // once across the whole result set.
    const fileCache = newFileProbeCache();
    const commitCache = newCommitCache();
    const stalenessDeps: StalenessDeps = {
      index: deps.index,
      config: deps.config,
      git: deps.git,
    };

    // Compute staleness for the CHECKED window (top `limit`) concurrently — the
    // fileCache dedups same-file probes and each note is independent, so this
    // avoids serializing per-note git/disk latency.
    const considered = notes.slice(0, limit);
    const statuses = await Promise.all(
      considered.map(async (note): Promise<{ note: Note; status: NoteStatus }> => {
        try {
          return {
            note,
            status: await computeNoteStatus(note, stalenessDeps, fileCache, commitCache),
          };
        } catch (err) {
          // One bad anchor must not sink the whole recall — degrade this note.
          return {
            note,
            status: {
              overall: 'unverified',
              anchors: note.anchors.map((anchor) => ({
                anchor,
                verdict: 'unverified' as const,
                detail: `staleness check failed: ${errMsg(err)}`,
              })),
            },
          };
        }
      }),
    );
    const staleCount = statuses.filter((s) => s.status.overall === 'stale').length;
    const missingCount = statuses.filter((s) => s.status.overall === 'missing').length;

    // Render as many as fit the token budget.
    const rendered: string[] = [];
    let used = estimate(header) + SUMMARY_RESERVE;
    for (const { note, status } of statuses) {
      const block = renderNote(note, status);
      const cost = estimate(block);
      if (rendered.length > 0 && used + cost > maxTokens) break;
      rendered.push(block);
      used += cost;
    }

    // Two DISTINCT kinds of omission: `limitHid` notes were never CHECKED
    // (staleness unknown — so "0 stale" must NOT read as "area is clean"), while
    // `budgetHid` notes were checked+counted but not rendered under the budget.
    const limitHid = notes.length - considered.length;
    const budgetHid = considered.length - rendered.length;
    const flags = [
      staleCount > 0 ? `${staleCount} stale` : '',
      missingCount > 0 ? `${missingCount} missing` : '',
    ]
      .filter(Boolean)
      .join(', ');
    const shownDesc =
      rendered.length < considered.length
        ? `${rendered.length} shown of ${considered.length} checked`
        : `${rendered.length} shown`;
    const summary = `${header} — ${shownDesc}${flags ? `, ${flags}` : ''}`;

    const moreParts = [
      budgetHid > 0 ? `${budgetHid} checked but not shown` : '',
      limitHid > 0 ? `${limitHid} not checked` : '',
    ].filter(Boolean);
    const levers = [
      limitHid > 0 && limit < MAX_LIMIT ? 'raise `limit`' : '',
      budgetHid > 0 ? 'raise `max_tokens`' : '',
      moreParts.length > 0 ? 'narrow with `file`/`symbol`/`query`' : '',
    ].filter(Boolean);
    const tail = moreParts.length
      ? `\n\n(${moreParts.join('; ')}${levers.length ? ` — ${levers.join(', ')}` : ''}.)`
      : '';
    return textResponse(
      banner + [summary, ...rendered].join('\n\n') + tail + degradedNote,
    );
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

type Selection =
  | { notes: Note[]; header: string }
  | { error: string };

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// True if any query token appears in the note's text or its anchors. For an
// anchor on `excludeFile` (the file+query path — every candidate is already
// anchored there) the PATH is dropped from the haystack but the anchored SYMBOL
// is kept: leaving the path in would make a token that's a substring of it
// (e.g. "auth" in "src/auth.ts") match every note, but dropping the symbol too
// would lose a legitimate `query="login"` match on a `file:login` anchor.
function noteMatchesTokens(note: Note, tokens: string[], excludeFile?: string): boolean {
  const anchorHay = note.anchors
    .map((a) => (a.file === excludeFile ? (a.symbol ?? '') : `${a.file} ${a.symbol ?? ''}`))
    .join(' ');
  const hay = `${note.text} ${anchorHay}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

function selectNotes(args: RecallArgs, deps: RecallDeps): Selection {
  const symbol = args.symbol?.trim();
  const query = args.query?.trim();
  const fileArg = args.file?.trim(); // trim so a padded path still matches anchors
  if (fileArg) {
    const rel = normalizeFilePath(fileArg, deps.config.projectRoot);
    if (rel === null) {
      return { error: `Error: file "${args.file}" is outside the project root.` };
    }
    let notes = symbol ? deps.notes.bySymbol(rel, symbol) : deps.notes.byFile(rel);
    let header = symbol
      ? `Notes anchored to \`${rel}:${symbol}\``
      : `Notes anchored to \`${rel}\``;
    // Honor `query` as an additional filter over the anchored subset (matching
    // note TEXT + OTHER anchors, not the already-known filter path).
    if (query) {
      const tokens = tokenize(query);
      notes = notes.filter((n) => noteMatchesTokens(n, tokens, rel));
      header += ` matching "${query}"`;
    }
    return { notes, header };
  }
  if (query) {
    // A `symbol` without a `file` can't be resolved as an anchor, but if a query
    // is present, honor the query (folding the orphan symbol in as a search term)
    // rather than erroring or discarding it. The header reflects the ACTUAL query.
    const q = symbol ? `${symbol} ${query}` : query;
    return {
      notes: deps.notes.search(q).map((r) => r.note),
      header: `Notes matching "${q}"`,
    };
  }
  // Anchors are file-scoped, so a symbol with no file and no query can't be
  // resolved — reject in-band rather than silently returning every note.
  if (symbol) {
    return {
      error:
        'Error: `symbol` requires `file` (anchors are file-scoped). ' +
        'Provide both, or use `query` to search note text.',
    };
  }
  // No filter → all notes, recency-ranked.
  return {
    notes: deps.notes.search('').map((r) => r.note),
    header: 'All notes',
  };
}

function renderNote(note: Note, status: NoteStatus): string {
  // Guard a hand-edited / non-ISO createdAt that parses to NaN (isValidNote only
  // checks it's a string) so the header never reads "NaNd ago".
  const parsed = Date.parse(note.createdAt);
  const age = Number.isNaN(parsed)
    ? 'unknown age'
    : `${formatRelativeAge(Date.now() - parsed)} ago`;
  const tag = VERDICT_TAG[status.overall];
  const lines = [`### Note ${note.id}  ${tag} · ${age}`, note.text];
  if (status.anchors.length > 0) {
    lines.push('Anchors:');
    for (const a of status.anchors) lines.push(renderAnchor(a));
  } else {
    lines.push('(no anchors — not staleness-tracked)');
  }
  if (note.head) lines.push(`Noted at commit ${note.head}.`);
  return lines.join('\n');
}

function renderAnchor(a: AnchorStatus): string {
  const where = a.anchor.symbol
    ? `${a.anchor.file}:${a.anchor.symbol}`
    : a.anchor.file;
  let line = `- ${VERDICT_MARK[a.verdict]} ${where} — ${a.detail}`;
  if (a.lastCommit) {
    // The file's most recent COMMIT — not necessarily when it went stale (a
    // working-tree edit is uncommitted), so phrase it as provenance, not cause.
    line +=
      `; last commit ${a.lastCommit.hash} ${a.lastCommit.date} ` +
      `"${a.lastCommit.subject}" ${BEHAVIORAL_TAG}`;
  }
  return line;
}
