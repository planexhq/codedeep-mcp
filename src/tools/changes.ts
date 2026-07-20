import type { CodeIndex } from '../indexer/code-index.js';
import { formatRepoList, type GitService } from '../git/git-service.js';
import type { ChangedFile } from '../git/git-service.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import type { NoteStore } from '../notes/note-store.js';
import {
  computeNoteStatusSafe,
  newCommitCache,
  newFileProbeCache,
  type StalenessDeps,
} from '../notes/staleness.js';
import type { Note } from '../notes/types.js';
import { compileExcludeMatcher } from '../indexer/scanner.js';
import { classNameFromFqn, type CodedeepConfig, type Symbol } from '../types.js';
import {
  BEHAVIORAL_TAG,
  estimate,
  plural,
  readinessBanner,
  textResponse,
  topCoChangePartners,
  type ToolResponse,
} from './common.js';
import { renderNoteLine } from './note-render.js';

export interface ChangesArgs {
  ref?: string;
  limit?: number;
  max_tokens?: number;
}

export interface ChangesDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: CodedeepConfig;
  // recentCommits rides along for the notes' staleness provenance line;
  // childGitRepos upgrades the no-repo error at a folder-of-repos root.
  git: Pick<GitService, 'changedFiles' | 'recentCommits' | 'childGitRepos'>;
  notes: NoteStore;
}

const DEFAULT_FILE_LIMIT = 10;
const MAX_FILE_LIMIT = 30;
const DEFAULT_MAX_TOKENS = 3000;
// Per-file caps: the tool is a working-set SUMMARY — depth lives in impact
// (per symbol) and recall (per note), and each row names its drill-down.
const MAX_SYMBOLS_PER_FILE = 3;
const MAX_NOTES_PER_FILE = 3;
const MAX_COCHANGE_NUDGES = 2;
// Same depth the overview risk rows use: enough to show real transitive reach
// without walking the whole graph per changed file.
const BLAST_DEPTH = 2;

// 'What did I change, what breaks, and which of my notes are now suspect?'
// One call over the git working set (uncommitted by default; `ref` = committed
// changes vs that ref). Per changed file: the highest fan-in symbols with
// their transitive blast radius (walked ONLY for displayed rows — never per
// symbol in the file), staleness-checked anchored notes, and co-change
// partners conspicuously absent from the changeset.
export async function runChanges(
  args: ChangesArgs,
  deps: ChangesDeps,
): Promise<ToolResponse> {
  try {
    const banner = readinessBanner(deps.indexer.ready);
    const ref = args.ref?.trim() || undefined;
    const ws = await deps.git.changedFiles(ref);

    // Git is LOAD-BEARING here (there is no working set without it), so each
    // failure kind gets an honest, actionable in-band message — not the
    // silent section-omission the enrichment surfaces use.
    switch (ws.kind) {
      case 'no-repo': {
        // A folder-of-repos root gets the actionable variant: the repos exist,
        // they're just one level down — point at per-repo servers.
        const children = deps.git.childGitRepos;
        return textResponse(
          'Error: `changes` requires a git repository — the working set IS the ' +
            'git status. ' +
            (children.length > 0
              ? `This root is a workspace containing ${children.length} child git ` +
                `${plural('repo', children.length)} (${formatRepoList(children)}) — ` +
                'run one codedeep server per repository (--project <path> or CODEDEEP_ROOT).'
              : 'This project has no repo; use overview/find_symbol to explore.'),
        );
      }
      case 'unavailable':
        return textResponse(
          'Error: git is unavailable (disabled or not detected yet), so the ' +
            'working set cannot be determined. Retry shortly if the server just started.',
        );
      case 'transient':
        return textResponse(
          'Error: reading the git working set failed transiently; try again.',
        );
      case 'bad-ref':
        return textResponse(`Error: ref "${args.ref}" ${ws.detail}.`);
      case 'ok':
        break;
    }

    const scopeLabel = ws.scope;
    // Drop config-excluded paths (.codedeep's own cache, node_modules, dist…):
    // git legitimately reports them (an ignore-less repo shows the cache dir as
    // untracked), but they are the user's declared not-interesting set — and
    // the tool's own storage must never appear in its own answer.
    const matchExclude = compileExcludeMatcher(deps.config.exclude);
    const wsFiles = ws.files.filter((f) => !matchExclude(f.path));
    const excludedCount = ws.files.length - wsFiles.length;
    if (wsFiles.length === 0) {
      const excludedNote =
        excludedCount > 0
          ? ` (${excludedCount} changed ${plural('file', excludedCount)} in excluded paths not shown.)`
          : '';
      return textResponse(
        banner +
          (ref
            ? `No files changed ${scopeLabel}.`
            : 'Working tree clean — no uncommitted changes.') +
          excludedNote,
      );
    }

    await deps.notes.load();
    const limit = Math.min(args.limit ?? DEFAULT_FILE_LIMIT, MAX_FILE_LIMIT);
    const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;
    // The "did you forget X?" nudge filters against EVERY path git reported as
    // changed — the RAW set (pre-exclude) UNION each rename's old path — so a
    // partner that was changed-but-excluded, or changed-but-renamed, is not
    // falsely flagged as absent from the changeset.
    const changedForNudge = new Set<string>();
    for (const f of ws.files) {
      changedForNudge.add(f.path);
      if (f.origPath !== undefined) changedForNudge.add(f.origPath);
    }

    // Rank files by their hottest symbol's CACHED fan-in (O(1) per symbol) so
    // the highest-impact files render first and survive the limit/budget.
    // The expensive transitive walk happens later, only for rendered rows.
    const ranked = wsFiles
      .map((file) => {
        // A just-renamed file's symbols may still be keyed under the OLD path
        // (the incremental re-index hasn't run), so fall back to origPath —
        // matching the note lookup, which already does.
        let symbols = deps.index.getSymbolsInFile(file.path);
        if (symbols.length === 0 && file.origPath !== undefined) {
          symbols = deps.index.getSymbolsInFile(file.origPath);
        }
        // Fan-in computed ONCE here (cached O(1)); the per-symbol values ride
        // through to renderFileBlock so it never recomputes them.
        const withFanIn = symbols.map((s) => ({ s, fanIn: deps.index.getCallerCount(s.id) }));
        const maxFanIn = withFanIn.reduce((m, e) => Math.max(m, e.fanIn), 0);
        return { file, withFanIn, maxFanIn };
      })
      .sort(
        (a, b) => b.maxFanIn - a.maxFanIn || a.file.path.localeCompare(b.file.path),
      );

    const shown = ranked.slice(0, limit);
    const header =
      `## Working set — ${wsFiles.length} changed ${plural('file', wsFiles.length)} (${scopeLabel})`;

    // Shared caches so N changed files with notes hash each anchored file and
    // fetch its last commit at most once across the whole response.
    const stalenessDeps: StalenessDeps = {
      index: deps.index,
      config: deps.config,
      git: deps.git,
    };
    const fileCache = newFileProbeCache();
    const commitCache = newCommitCache();

    const blocks: string[] = [header];
    let used = estimate(header);
    let truncated = false;
    // DISTINCT suspect notes across the whole response — a cross-file note
    // anchored to two changed files must count ONCE, not once per block.
    const suspectNoteIds = new Set<string>();
    for (const entry of shown) {
      const { block, suspectIds } = await renderFileBlock(
        entry.file,
        entry.withFanIn,
        changedForNudge,
        deps,
        stalenessDeps,
        fileCache,
        commitCache,
      );
      const cost = estimate(block);
      if (blocks.length > 1 && used + cost > maxTokens) {
        truncated = true;
        break;
      }
      blocks.push(block);
      used += cost;
      // Only for RENDERED blocks, so the ⚠ tail matches what's visible above it.
      for (const id of suspectIds) suspectNoteIds.add(id);
    }

    const renderedCount = blocks.length - 1; // minus the header
    const tails: string[] = [];
    if (excludedCount > 0) {
      tails.push(
        `(${excludedCount} changed ${plural('file', excludedCount)} in excluded paths not shown.)`,
      );
    }
    // Two DISTINCT omission causes with DISTINCT levers: files in the shown
    // slice dropped by the token budget (raise max_tokens) vs files beyond the
    // file `limit` (raise limit). Conflating them mis-advised "raise limit"
    // when only max_tokens could help.
    const budgetDropped = truncated ? shown.length - renderedCount : 0;
    const limitDropped = ranked.length - shown.length;
    if (budgetDropped > 0) {
      tails.push(
        `(${budgetDropped} more changed ${plural('file', budgetDropped)} omitted to stay within \`max_tokens\` — raise it to see more.)`,
      );
    }
    if (limitDropped > 0) {
      const lever =
        limit < MAX_FILE_LIMIT
          ? ` — raise \`limit\` (max ${MAX_FILE_LIMIT})`
          : ` — \`limit\` is at its max; narrow the changeset or use \`ref\``;
      tails.push(
        `(${limitDropped} more changed ${plural('file', limitDropped)} beyond the file limit${lever}.)`,
      );
    }
    const suspectCount = suspectNoteIds.size;
    if (suspectCount > 0) {
      tails.push(
        `⚠ ${suspectCount} ${plural('note', suspectCount)} anchored to the files above ${suspectCount === 1 ? 'is' : 'are'} stale or missing — re-verify before relying on them (recall for detail).`,
      );
    }
    const degraded = deps.notes.degradedReason;
    if (degraded) tails.push(`(note store degraded: ${degraded})`);

    return textResponse(banner + [...blocks, ...tails].join('\n\n'));
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

// A blast row's label. Class members are QUALIFIED (`Session.send`) so two
// same-named methods in one file (e.g. SessionRedirectMixin.send vs
// Session.send — dogfooded on requests) are distinguishable, not two identical
// `send()` rows. Call parens only for functions/methods — a class or const
// with high fan-in is common, and `Foo()` would misread it as callable
// (overview's risk rows follow the same no-parens-on-non-callable rule).
function symbolLabel(s: Symbol): string {
  const cls = classNameFromFqn(s.fqn);
  const name = cls !== null ? `${cls}.${s.name}` : s.name;
  return s.kind === 'function' || s.kind === 'method' ? `${name}()` : name;
}

// Show the most actionable notes first: a rename's orphaned old-path note
// reports ✗ missing and MUST NOT be buried under fresh new-path notes and lost
// to the display cap. missing > stale > unverified > fresh.
const NOTE_SEVERITY: Record<string, number> = { missing: 0, stale: 1, unverified: 2, fresh: 3 };

async function renderFileBlock(
  file: ChangedFile,
  withFanIn: Array<{ s: Symbol; fanIn: number }>,
  changedForNudge: ReadonlySet<string>,
  deps: ChangesDeps,
  stalenessDeps: StalenessDeps,
  fileCache: ReturnType<typeof newFileProbeCache>,
  commitCache: ReturnType<typeof newCommitCache>,
): Promise<{ block: string; suspectIds: string[] }> {
  const renamedFrom = file.origPath !== undefined ? ` from ${file.origPath}` : '';
  const lines: string[] = [`### ${file.path} (${file.status}${renamedFrom})`];

  // --- Blast radius: rank by cached fan-in; walk the tree ONLY for the rows
  // actually displayed (the getRiskHotspots hybrid — a changed file with 400
  // symbols must not trigger 400 transitive walks).
  if (withFanIn.length === 0) {
    lines.push(
      file.status === 'deleted'
        ? '- (no indexed symbols — deleted)'
        : file.status === 'changed'
          ? // ref mode reports every path as 'changed', including files the
            // range DELETED — don't misread absence as an indexing gap.
            '- (not in the index — deleted in this range, or not an indexed source file)'
          : '- (not indexed — excluded, unknown language, or not yet scanned)',
    );
  } else {
    const top = [...withFanIn]
      .sort((a, b) => b.fanIn - a.fanIn || a.s.name.localeCompare(b.s.name))
      .slice(0, MAX_SYMBOLS_PER_FILE)
      .filter((e) => e.fanIn > 0);
    if (top.length === 0) {
      lines.push(
        `- ${withFanIn.length} ${plural('symbol', withFanIn.length)}, no known callers — likely safe to change in isolation`,
      );
    } else {
      for (const { s, fanIn } of top) {
        const blast = deps.index.getBlastRadius(s.id, { maxDepth: BLAST_DEPTH });
        const plus = blast.truncated ? '+' : '';
        lines.push(
          `- ${symbolLabel(s)} — ${blast.callers}${plus} distinct ${plural('caller', blast.callers)} ` +
            `across ${blast.files} ${plural('file', blast.files)} (≤${BLAST_DEPTH} hops; refs ~${fanIn}) — \`impact\` for the tree`,
        );
      }
    }
  }

  // --- Suspect notes: everything anchored to this file — AND, for a rename,
  // to the path it USED to be (those anchors are exactly what the rename just
  // orphaned; they'll report ✗ missing). Staleness is computed for the FULL
  // list so the suspect count is honest even when the display cap hides one.
  const fileNotes = deps.notes.byFile(file.path);
  if (file.origPath !== undefined) {
    const seen = new Set(fileNotes.map((n) => n.id));
    for (const n of deps.notes.byFile(file.origPath)) {
      if (!seen.has(n.id)) fileNotes.push(n);
    }
  }
  const suspectIds: string[] = [];
  if (fileNotes.length > 0) {
    const noteStatuses = await Promise.all(
      fileNotes.map(async (note: Note) => ({
        note,
        status: await computeNoteStatusSafe(note, stalenessDeps, fileCache, commitCache),
      })),
    );
    // Actionable-first, then recency (byFile already sorts newest-first, so a
    // stable sort on severity preserves it as the tiebreak).
    noteStatuses.sort(
      (a, b) => (NOTE_SEVERITY[a.status.overall] ?? 9) - (NOTE_SEVERITY[b.status.overall] ?? 9),
    );
    for (const { note, status } of noteStatuses) {
      if (status.overall === 'stale' || status.overall === 'missing') suspectIds.push(note.id);
    }
    lines.push('Notes anchored here:');
    for (const { note, status } of noteStatuses.slice(0, MAX_NOTES_PER_FILE)) {
      lines.push(renderNoteLine(note, status));
    }
    if (noteStatuses.length > MAX_NOTES_PER_FILE) {
      // A renamed file's notes span BOTH paths, and recall's file filter is
      // per-path — name both so the hidden old-path notes stay reachable.
      const calls = (
        file.origPath !== undefined ? [file.path, file.origPath] : [file.path]
      )
        .map((p) => `recall({ file: ${JSON.stringify(p)} })`)
        .join(' / ');
      lines.push(`- (${noteStatuses.length - MAX_NOTES_PER_FILE} more — ${calls})`);
    }
  }

  // --- Co-change nudge: partners that USUALLY ship with this file but are
  // absent from the changeset — the behavioral "did you forget X?" signal.
  // Filter BEFORE capping: when a file's top partners are all in the
  // changeset (the common good case), the nudge must fall through to the
  // next-ranked ABSENT partner, not vanish.
  const partners = topCoChangePartners(
    deps.index.getCoChanges(file.path),
    file.path,
    Number.MAX_SAFE_INTEGER,
  )
    .filter((p) => !changedForNudge.has(p.partner))
    .slice(0, MAX_COCHANGE_NUDGES);
  if (partners.length > 0) {
    lines.push(
      `Usually changes with: ${partners
        .map((p) => `${p.partner} (${p.pct}%)`)
        .join(', ')} — NOT in this changeset ${BEHAVIORAL_TAG}`,
    );
  }

  return { block: lines.join('\n'), suspectIds };
}
