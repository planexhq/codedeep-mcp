import {
  type CallerEdge,
  type CodeIndex,
  isCallerOf,
  isClassMember,
} from '../indexer/code-index.js';
import type { GitService } from '../git/git-service.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import { qualifiedSymbolName, type NoteStore } from '../notes/note-store.js';
import {
  computeNoteStatusSafe,
  newCommitCache,
  newFileProbeCache,
  type StalenessDeps,
} from '../notes/staleness.js';
import type { Anchor, Note } from '../notes/types.js';
import { classNameFromFqn } from '../types.js';
import type { ImportInfo, CodedeepConfig, Symbol } from '../types.js';
import { renderNote } from './note-render.js';

import {
  BEHAVIORAL_TAG,
  MODULE_LEVEL,
  NAME_MATCH_HEADER_QUALIFIER,
  NAME_MATCH_TAG,
  STRUCTURAL_TAG,
  displaySignature,
  estimate,
  formatComplexity,
  normalizeFilePath,
  pickByLine,
  plural,
  readinessBanner,
  renderAmbiguous,
  renderSuggestions,
  safeReadIndexedFile,
  sectionOrEmpty,
  sectionOrNone,
  textResponse,
  topCoChangePartners,
  type ToolResponse,
} from './common.js';

export interface GetContextArgs {
  file: string;
  symbol?: string;
  line?: number;
  max_tokens?: number;
  include?: string[];
}

export interface GetContextDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: CodedeepConfig;
  git: Pick<GitService, 'recentCommits'>;
  // PULL surface of the knowledge layer: anchored notes render inside the
  // response (read-only — get_context never writes the store).
  notes: NoteStore;
}

const DEFAULT_MAX_TOKENS = 3000;
const SUGGEST_LIMIT = 5;
// `exported_by` is intentionally absent: the TS extractor skips re-export
// statements (`export { x } from './y'`), so any "exported by" listing in
// Phase 1a would only surface coincidentally same-named exports from
// unrelated files. The section returns when re-export edges land.
// `notes` (anchored knowledge-layer notes, staleness-checked) sits after the
// structural sections — enrichment must never displace body/callers — but
// above the git tail: a curated note about THIS symbol outranks generic
// churn data. `co_changes` and `git` sit last: they render at the end and are
// the first casualties under max_tokens pressure (enrichment, not core).
const ALL_SECTIONS = ['body', 'callers', 'callees', 'coupling', 'imports', 'notes', 'co_changes', 'git'] as const;
type Section = typeof ALL_SECTIONS[number];

type SectionItem = {
  name: string;
  includeKey: Section;
  render: () => Promise<string> | string;
  // Cheap synchronous answer to "would render() be non-empty?" — used
  // only after the budget is exhausted, to skip paying for renders whose
  // output would be discarded (or to name the truncation point without
  // rendering it). Omit when emptiness is only knowable by rendering
  // (e.g. the recent-changes subprocess).
  peekNonEmpty?: () => boolean;
};

function truncationNote(at: string, maxTokens: number): string {
  return `(Sections from \`${at}\` onward omitted to stay within max_tokens=${maxTokens}.)`;
}

async function renderBudgeted(
  header: string,
  items: SectionItem[],
  include: Set<Section>,
  maxTokens: number,
  neverDrop?: Section,
): Promise<string> {
  const blocks: string[] = [header];
  let used = estimate(header);
  let truncatedAt: string | null = null;
  for (const item of items) {
    if (!include.has(item.includeKey)) continue;
    // Once the budget is spent, a cheap peek avoids rendering work whose
    // output would be discarded: known-empty sections skip silently,
    // known non-empty ones become the truncation point without paying
    // their render. Sections without a peek (recent-changes subprocess)
    // still render below so the note stays honest.
    if (item.includeKey !== neverDrop && used >= maxTokens) {
      const peek = item.peekNonEmpty?.();
      if (peek === false) continue;
      if (peek === true) {
        truncatedAt = item.name;
        break;
      }
    }
    // Render BEFORE deciding truncation: a section that renders empty
    // (e.g. git sections outside a repo) is silently elided either way,
    // so the truncation note can never name it and promise content a
    // larger max_tokens would not reveal.
    const text = await item.render();
    if (!text) continue;
    const cost = estimate(text);
    if (item.includeKey !== neverDrop && used + cost > maxTokens) {
      truncatedAt = item.name;
      break;
    }
    blocks.push(text);
    used += cost;
  }
  if (truncatedAt) blocks.push(truncationNote(truncatedAt, maxTokens));
  return blocks.join('\n\n');
}

export async function runGetContext(
  args: GetContextArgs,
  deps: GetContextDeps,
): Promise<ToolResponse> {
  try {
    const file = normalizeFilePath(args.file, deps.config.projectRoot);
    if (file === null) {
      return textResponse(
        `Error: file "${args.file}" is outside the project root.`,
      );
    }

    const { include, note: includeNote } = parseInclude(args.include);
    const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;
    const banner = readinessBanner(deps.indexer.ready);

    if (args.symbol !== undefined) {
      const trimmed = args.symbol.trim();
      if (trimmed.length === 0) {
        return textResponse('Error: symbol must be non-empty.');
      }
      const body = await renderSymbolMode(
        file,
        trimmed,
        args.line,
        include,
        maxTokens,
        deps,
      );
      return textResponse(banner + includeNote + body);
    }

    return textResponse(
      banner + includeNote + (await renderFileMode(file, include, maxTokens, deps)),
    );
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

// Unknown section names are SURFACED, never silently dropped: a typo'd
// `include: ["callrs"]` used to yield an empty shell that read as "no data
// here" — a false conclusion the agent then acts on. Unknown keys produce an
// in-band note listing the valid names, and when NOTHING valid remains the
// filter falls back to ALL_SECTIONS (a full answer with a correction beats an
// empty one). An explicit empty array means the default too. Hyphens fold to
// underscores so `co-changes` finds `co_changes`.
function parseInclude(input?: string[]): { include: Set<Section>; note: string } {
  if (!input || input.length === 0) {
    return { include: new Set(ALL_SECTIONS), note: '' };
  }
  const set = new Set<Section>();
  const unknown: string[] = [];
  for (const s of input) {
    const key = s.trim().toLowerCase().replace(/-/g, '_');
    if ((ALL_SECTIONS as readonly string[]).includes(key)) {
      set.add(key as Section);
    } else {
      unknown.push(s);
    }
  }
  if (unknown.length === 0) return { include: set, note: '' };
  const fellBack = set.size === 0;
  if (fellBack) for (const s of ALL_SECTIONS) set.add(s);
  const note =
    `(Ignored unknown include section${unknown.length === 1 ? '' : 's'}: ` +
    `${unknown.map((u) => `"${u}"`).join(', ')}. Valid: ${ALL_SECTIONS.join(', ')}.` +
    `${fellBack ? ' Showing all sections.' : ''})\n\n`;
  return { include: set, note };
}

async function renderSymbolMode(
  file: string,
  name: string,
  line: number | undefined,
  include: Set<Section>,
  maxTokens: number,
  deps: GetContextDeps,
): Promise<string> {
  const candidates = deps.index
    .getSymbolsInFile(file)
    .filter((s) => s.name === name);

  if (candidates.length === 0) {
    const suggestions = deps.index.suggest(name, SUGGEST_LIMIT, undefined, file);
    return renderNoSymbol(name, file, suggestions);
  }

  let target: Symbol;
  if (candidates.length > 1) {
    if (line === undefined) {
      return renderAmbiguous(name, file, candidates);
    }
    target = pickByLine(candidates, line);
  } else {
    target = candidates[0];
  }

  return renderSymbolBlock(target, file, include, maxTokens, deps);
}

function renderNoSymbol(
  name: string,
  file: string,
  suggestions: Symbol[],
): string {
  return [
    `No symbol '${name}' found in ${file}.`,
    ...renderSuggestions(suggestions),
  ].join('\n');
}

async function renderSymbolBlock(
  target: Symbol,
  file: string,
  include: Set<Section>,
  maxTokens: number,
  deps: GetContextDeps,
): Promise<string> {
  const headerLines: string[] = [];
  const exportedTag = target.exported ? ' | exported' : '';
  headerLines.push(
    `${target.file}:${target.startLine}-${target.endLine} | ${target.kind}${exportedTag}`,
  );
  if (target.signature) headerLines.push(target.signature);
  if (target.doc && target.doc.length > 0) headerLines.push(target.doc);
  const header = headerLines.join('\n');

  const { item: notesSection, degradedNotice } = await notesItem(
    deps,
    file,
    include,
    target,
  );

  // `body` is the highest-priority section and is never dropped to fit budget.
  const items: SectionItem[] = [
    {
      name: 'body',
      includeKey: 'body',
      render: () => renderBody(target, deps.config),
    },
    {
      name: 'callers',
      includeKey: 'callers',
      render: () => renderCallerEdges(deps.index.getCallerEdges(target.id)),
      peekNonEmpty: () => true, // sectionOrNone renders "(none)"
    },
    {
      name: 'callees',
      includeKey: 'callees',
      render: () => renderCalleeEdges(deps.index.getCallees(target.id)),
      peekNonEmpty: () => true,
    },
    {
      name: 'coupling',
      includeKey: 'coupling',
      render: () => renderCoupling(target, deps.index),
      peekNonEmpty: () => true,
    },
    {
      name: 'imports',
      includeKey: 'imports',
      render: () => renderImports(file, deps.index),
      peekNonEmpty: () => deps.index.getImports(file).length > 0,
    },
    notesSection,
    ...gitSectionItems(target.file, deps),
  ];

  return (await renderBudgeted(header, items, include, maxTokens, 'body')) + degradedNotice;
}

// --- PULL: anchored knowledge-layer notes rendered in place ---

// Cap so a note-heavy file can't displace the structural sections; the
// overflow line names the recall query that lists the rest.
const MAX_CONTEXT_NOTES = 3;

// Builds the notes SectionItem for either mode, plus a `degradedNotice` the
// caller appends OUTSIDE the token budget. The store load + selection happen up
// front (sync store queries after the memoized load, so the budget loop can
// peek emptiness for free) but are GATED on the include filter — a caller
// looping get_context({include:['body']}) must not pay a store read per call.
// Both modes share this so the load-before-select ordering and the peek
// contract can't drift apart.
async function notesItem(
  deps: GetContextDeps,
  file: string,
  include: Set<Section>,
  target?: Symbol,
): Promise<{ item: SectionItem; degradedNotice: string }> {
  let selected: Note[] = [];
  let degradedNotice = '';
  if (include.has('notes')) {
    await deps.notes.load();
    selected = selectContextNotes(deps.notes, file, target);
    const degraded = deps.notes.degradedReason;
    // Rides EVERY response — appended by the caller AFTER renderBudgeted, so a
    // body that eats the whole token budget (dropping the notes section) can't
    // suppress the "prior notes were quarantined; recover manually" signal.
    // Same guarantee recall makes.
    if (degraded) degradedNotice = `\n\n(note store degraded: ${degraded})`;
  }
  const item: SectionItem = {
    name: 'notes',
    includeKey: 'notes',
    render: () => renderNotesSection(selected, file, deps),
    peekNonEmpty: () => selected.length > 0,
  };
  return { item, degradedNotice };
}

// Symbol mode: a note surfaces when one of its anchors names THIS symbol —
// plus FILE-level anchors (notes about the whole file). An anchor names the
// symbol when EITHER:
//   - its stored (qualified) name equals this symbol's qualified name
//     ("Class.member" / top-level bare name) — a RESOLVED anchor; or
//   - it is a NAME-ONLY anchor (no symbolId — remember's ambiguous /
//     index-still-building paths, declared "anchored by name") whose bare name
//     equals this symbol's simple name, i.e. "about any symbol so named".
// The name arm is GATED on symbolId===undefined: a resolved anchor pinned to
// ONE specific symbol (e.g. top-level `foo`, symbolId set) must match by
// qualified name ONLY, never bleed onto a same-named sibling added later (a
// method `C.foo`) — and, symmetrically, a member-qualified anchor never bleeds
// onto a same-named top-level target. Anchors qualified to a DIFFERENT
// container, or to another symbol, stay out. File mode (no `target`): every
// note with an anchor in the file.
function selectContextNotes(
  notes: NoteStore,
  file: string,
  target?: Symbol,
): Note[] {
  const all = notes.byFile(file); // newest first
  if (target === undefined) return all;
  const qualified = qualifiedSymbolName(target.fqn, file, target.name);
  const anchorNamesSymbol = (a: Anchor): boolean => {
    if (a.file !== file || a.symbol === undefined) return false;
    if (a.symbol === qualified) return true; // resolved to THIS symbol
    return a.symbolId === undefined && a.symbol === target.name; // name-only
  };
  const symbolNotes = all.filter((n) => n.anchors.some(anchorNamesSymbol));
  const seen = new Set(symbolNotes.map((n) => n.id));
  const fileLevel = all.filter(
    (n) =>
      !seen.has(n.id) &&
      n.anchors.some((a) => a.file === file && a.symbol === undefined),
  );
  return [...symbolNotes, ...fileLevel];
}

async function renderNotesSection(
  selected: Note[],
  file: string,
  deps: GetContextDeps,
): Promise<string> {
  // Degraded-store signalling is handled OUTSIDE this section (notesItem's
  // degradedNotice, appended past the budget) — an empty selection here means
  // "no notes to render", nothing more.
  if (selected.length === 0) return '';
  const shown = selected.slice(0, MAX_CONTEXT_NOTES);
  // Same staleness path — and the same render grammar (note-render.ts) — as
  // recall, so a note reads identically everywhere. The caches dedupe the
  // per-file hash/git probe across the shown notes' anchors; per-note failure
  // isolation lives in computeNoteStatusSafe (shared with recall).
  const stalenessDeps: StalenessDeps = {
    index: deps.index,
    config: deps.config,
    git: deps.git,
  };
  const fileCache = newFileProbeCache();
  const commitCache = newCommitCache();
  const blocks = await Promise.all(
    shown.map(async (note) =>
      renderNote(
        note,
        await computeNoteStatusSafe(note, stalenessDeps, fileCache, commitCache),
      ),
    ),
  );
  const lines = ['### Notes (agent-curated)', ...blocks];
  if (selected.length > shown.length) {
    lines.push(notesOverflowLine(selected.length - shown.length, file));
  }
  return lines.join('\n\n');
}

// The cap hid `hidden` selected notes. Point the agent at recall to BROWSE the
// rest rather than promise reproduction: recall paginates (default 10, max 50).
// ALWAYS recall({file}) — NOT recall({file, symbol}): symbol mode's selection
// mixes symbol-anchored AND file-level notes, but recall's `symbol` filter is
// bySymbol (file-level anchors excluded), so it would return a SUBSET that can
// miss the very notes we hid. byFile ({file} only) is the true SUPERSET of the
// selection in both modes. JSON.stringify quotes+escapes the path so the
// suggested call is copy-paste valid even for exotic filenames.
function notesOverflowLine(hidden: number, file: string): string {
  return `(${hidden} more not shown — recall({ file: ${JSON.stringify(file)} }) to browse notes here.)`;
}

// The two git sections are identical in both modes and always trail the
// list (first to drop under budget pressure).
function gitSectionItems(file: string, deps: GetContextDeps): SectionItem[] {
  return [
    {
      name: 'co-change partners',
      includeKey: 'co_changes',
      render: () => renderCoChanges(file, deps.index),
      peekNonEmpty: () => deps.index.getCoChanges(file).length > 0,
    },
    {
      name: 'recent changes',
      includeKey: 'git',
      render: () => renderRecentChanges(file, deps.git),
    },
  ];
}

function renderCoChanges(file: string, index: CodeIndex): string {
  const rows = topCoChangePartners(index.getCoChanges(file), file);
  return sectionOrEmpty(
    `### Co-change Partners (${rows.length} behavioral)`,
    rows.map(
      (r) =>
        `- ${r.partner}  ${r.pct}% confidence (${r.shared} shared ${plural('commit', r.shared)})`,
    ),
  );
}

// Defensive try/catch at the tool boundary: GitService promises not to
// throw, but a git failure must never turn a get_context call into an
// in-band "Error:" response — the section just vanishes.
async function renderRecentChanges(
  file: string,
  git: GetContextDeps['git'],
): Promise<string> {
  let commits;
  try {
    commits = await git.recentCommits(file);
  } catch {
    return '';
  }
  return sectionOrEmpty(
    `### Recent Changes ${BEHAVIORAL_TAG}`,
    commits.map((c) => `- ${c.date} ${c.hash} "${c.subject}"`),
  );
}

async function renderBody(
  target: Symbol,
  config: CodedeepConfig,
): Promise<string> {
  let content: string;
  try {
    content = await safeReadIndexedFile(target.file, config);
  } catch (err) {
    return `### Body\n(unable to read ${target.file}: ${errMsg(err)})`;
  }
  const lines = content.split('\n');
  const start = Math.max(0, target.startLine - 1);
  const end = Math.min(lines.length, target.endLine);
  // Strip the trailing CR of each CRLF pair so a Windows-authored source file
  // doesn't leak a stray '\r' onto every rendered body line (the same class of
  // bug fixed for search_structure's snippet renderer). The split stays on
  // '\n' to keep line indices aligned with tree-sitter's row numbering, which
  // treats '\r\n' as a single row — so only a trailing '\r' can remain.
  const slice = lines
    .slice(start, end)
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .join('\n');
  return `### Body\n\`\`\`${target.language}\n${slice}\n\`\`\``;
}

function renderCallerEdges(edges: CallerEdge[]): string {
  return sectionOrNone(
    '### Callers',
    edges.map((e) => {
      const label = e.symbol ? displaySignature(e.symbol) : MODULE_LEVEL;
      return `- ${e.file}:${e.line} — ${label} ${STRUCTURAL_TAG}`;
    }),
  );
}

// Per-symbol coupling. The lines sit in different precision tiers, so each
// carries its own tag rather than a blanket one: fan-out is the id-keyed
// RESOLVED callee count ([structural]); fan-in (getCallerCount) and the
// transitive blast radius walk the SAME approximate name-match caller set
// find_references tags [name match, unverified]. Blast radius uses depth-2
// (enough to tell a leaf from a hub, cheap for one symbol) and the SAME
// counting method as `impact` via countDistinctCallers — the method matches,
// not necessarily the number, since `impact` defaults to a deeper walk; a
// trailing `+` flags an undercount from ANY cap (breadth/node OR the depth-2
// wall), so a deep caller chain is never silently truncated here.
function renderCoupling(target: Symbol, index: CodeIndex): string {
  const fanIn = index.getCallerCount(target.id);
  const fanOut = index.getFanOut(target.id);
  const blast = index.getBlastRadius(target.id, { maxDepth: 2 });
  const cap = blast.truncated ? '+' : '';
  const blastLine =
    blast.callers === 0
      ? `- Blast radius: 0 callers (no upstream call sites in the index) ${NAME_MATCH_TAG}`
      : `- Blast radius: ${blast.callers}${cap} ${plural('caller', blast.callers)} across ` +
        `${blast.depths} ${plural('depth', blast.depths)} ` +
        `(${blast.files} ${plural('file', blast.files)}) ${NAME_MATCH_TAG}`;
  const complexity = formatComplexity(target);
  return [
    '### Coupling',
    `- Fan-in: ~${fanIn} (callers) ${NAME_MATCH_TAG}`,
    `- Fan-out: ${fanOut} (callees) ${STRUCTURAL_TAG}`,
    ...(complexity ? [`- Complexity: ${complexity}`] : []),
    blastLine,
  ].join('\n');
}

function renderCalleeEdges(edges: Symbol[]): string {
  return sectionOrNone(
    '### Callees',
    edges.map((e) => `- ${e.file}:${e.startLine} — ${displaySignature(e)} ${STRUCTURAL_TAG}`),
  );
}

function renderImportLines(imports: ImportInfo[]): string[] {
  return imports.map((imp) => `- ${imp.sourceModule}: ${formatImportNames(imp)}`);
}

function renderImports(file: string, index: CodeIndex): string {
  return sectionOrEmpty('### Imports', renderImportLines(index.getImports(file)));
}

function formatImportNames(imp: ImportInfo): string {
  return imp.importedNames
    .map((n) =>
      n.alias && n.alias !== n.name ? `${n.name} as ${n.alias}` : n.name,
    )
    .join(', ');
}

async function renderFileMode(
  file: string,
  include: Set<Section>,
  maxTokens: number,
  deps: GetContextDeps,
): Promise<string> {
  const symbols = deps.index.getSymbolsInFile(file);
  const imports = deps.index.getImports(file);
  const indexed = deps.index.hasFile(file);

  let lineCount = 0;
  if (indexed) {
    try {
      const content = await safeReadIndexedFile(file, deps.config);
      lineCount = content.length === 0 ? 0 : content.split('\n').length;
    } catch {}
  }

  const indexedNote = indexed
    ? ''
    : '\n(File is not in the index — likely excluded by config, oversized, or not yet scanned. Use `overview` to see indexed paths.)';
  const header = `## File: ${file} (${lineCount} ${plural('line', lineCount)}, ${symbols.length} ${plural('symbol', symbols.length)})${indexedNote}`;

  // Methods/getters/setters inherit `exported` from their enclosing class;
  // the file-mode outline hides members to avoid duplicating each class's
  // surface area in the export list — but only when that class is declared
  // in THIS file. Go/Rust/Swift/Kotlin members routinely live apart from
  // their type (Go methods in handlers.go beside server.go; Rust impl blocks;
  // Swift/Kotlin extensions; Kotlin companion objects) — a methods-apart file
  // would otherwise render as "Exports (none)". The check is purely
  // name-presence (no per-language allow-list), so TS/Py/Java members (always
  // co-located with their class) keep their unchanged outlines automatically.
  const typeNamesInFile = new Set(
    symbols.filter((s) => !isClassMember(s)).map((s) => s.name),
  );
  const topLevel = symbols.filter((s) => {
    const cls = classNameFromFqn(s.fqn);
    return cls === null || !typeNamesInFile.has(cls);
  });
  const exported = topLevel.filter((s) => s.exported);
  const internal = topLevel.filter((s) => !s.exported);

  // File mode surfaces EVERY note anchored in the file (whole-file view).
  const { item: notesSection, degradedNotice } = await notesItem(deps, file, include);

  // `body` covers the outline (Exports + Internal); `callees` has no
  // file-mode analogue. Renderers are lazy so dropped sections don't pay
  // for caller scans.
  const items: SectionItem[] = [
    {
      name: 'Exports',
      includeKey: 'body',
      render: () => sectionOrNone('### Exports', exported.map(formatFileSymbolLine)),
    },
    {
      name: 'Internal',
      includeKey: 'body',
      render: () => sectionOrEmpty('### Internal', internal.map(formatFileSymbolLine)),
    },
    {
      name: 'Imports',
      includeKey: 'imports',
      render: () => sectionOrEmpty('### Imports', renderImportLines(imports)),
      peekNonEmpty: () => imports.length > 0,
    },
    {
      name: "Callers of this file's exports",
      includeKey: 'callers',
      render: () =>
        sectionOrNone(
          `### Callers of this file's exports ${NAME_MATCH_HEADER_QUALIFIER}`,
          collectExportCallers(exported, deps.index),
        ),
      // sectionOrNone always renders; peeking spares the reference scan
      // when the budget is already gone.
      peekNonEmpty: () => true,
    },
    notesSection,
    ...gitSectionItems(file, deps),
  ];

  return (await renderBudgeted(header, items, include, maxTokens)) + degradedNotice;
}

// Uses `getReferencesByNameOrAlias + isCallerOf` (same data path as
// find_references) so cross-file callers — the common case for exported
// symbols — are surfaced. `getCallerEdges` powers symbol-mode's strict
// [structural] view; this file-mode summary aggregates per-file and
// benefits from including import-scoped name-match refs. The
// `[name match, unverified]` tag matches find_references's caller list
// so consumers know the data is approximate (same precision tier).
// Member refs to top-level exports (`utils.foo()` through a namespace
// import) flow in here via getReferencesByNameOrAlias like bare-name
// refs; the aggregate per-file rows keep the shared name-match tag.
function collectExportCallers(
  exportedSyms: Symbol[],
  index: CodeIndex,
): string[] {
  const byFile = new Map<string, Set<string>>();
  for (const exp of exportedSyms) {
    // Pass targetIsMember so member-ref scoping matches find_references
    // exactly — the file-mode outline now admits members (a Go method whose
    // receiver type lives in another file), and a `pkg.Method()` module call
    // must not be scoped as if it could reach a member.
    for (const ref of index.getReferencesByNameOrAlias(exp.name, exp.file, isClassMember(exp))) {
      if (!isCallerOf(ref, exp)) continue;
      let set = byFile.get(ref.file);
      if (!set) {
        set = new Set();
        byFile.set(ref.file, set);
      }
      set.add(exp.name);
    }
  }
  const lines: string[] = [];
  for (const [f, names] of byFile) {
    lines.push(`- ${f} — uses ${[...names].sort().join(', ')}  ${NAME_MATCH_TAG}`);
  }
  return lines.sort();
}

function formatFileSymbolLine(s: Symbol): string {
  return `- ${s.name} (${s.kind}, line ${s.startLine}) — ${displaySignature(s)}`;
}

