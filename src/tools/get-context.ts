import {
  type CallerEdge,
  type CodeIndex,
  isCallerOf,
  isClassMember,
} from '../indexer/code-index.js';
import type { GitService } from '../git/git-service.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import { classNameFromFqn } from '../types.js';
import type { ImportInfo, ProbeConfig, Symbol } from '../types.js';

import {
  BEHAVIORAL_TAG,
  MODULE_LEVEL,
  NAME_MATCH_HEADER_QUALIFIER,
  NAME_MATCH_TAG,
  STRUCTURAL_TAG,
  displaySignature,
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
  config: ProbeConfig;
  git: Pick<GitService, 'recentCommits'>;
}

const DEFAULT_MAX_TOKENS = 3000;
const SUGGEST_LIMIT = 5;
// `exported_by` is intentionally absent: the TS extractor skips re-export
// statements (`export { x } from './y'`), so any "exported by" listing in
// Phase 1a would only surface coincidentally same-named exports from
// unrelated files. The section returns when re-export edges land.
// `co_changes` and `git` sit last: they render at the end and are the
// first casualties under max_tokens pressure (enrichment, not core).
const ALL_SECTIONS = ['body', 'callers', 'callees', 'coupling', 'imports', 'co_changes', 'git'] as const;
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

    const include = parseInclude(args.include);
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
      return textResponse(banner + body);
    }

    return textResponse(
      banner + (await renderFileMode(file, include, maxTokens, deps)),
    );
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

function parseInclude(input?: string[]): Set<Section> {
  if (!input) return new Set(ALL_SECTIONS);
  const set = new Set<Section>();
  for (const s of input) {
    const lower = s.toLowerCase();
    if ((ALL_SECTIONS as readonly string[]).includes(lower)) {
      set.add(lower as Section);
    }
  }
  return set;
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
    ...gitSectionItems(target.file, deps),
  ];

  return renderBudgeted(header, items, include, maxTokens, 'body');
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
  config: ProbeConfig,
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
  const slice = lines.slice(start, end).join('\n');
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
  return [
    '### Coupling',
    `- Fan-in: ~${fanIn} (callers) ${NAME_MATCH_TAG}`,
    `- Fan-out: ${fanOut} (callees) ${STRUCTURAL_TAG}`,
    ...(target.complexity !== undefined
      ? [`- Cyclomatic: ${target.complexity} ${STRUCTURAL_TAG}`]
      : []),
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
    ...gitSectionItems(file, deps),
  ];

  return renderBudgeted(header, items, include, maxTokens);
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

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

