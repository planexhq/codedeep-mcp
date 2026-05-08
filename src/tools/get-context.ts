import { promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { type CodeIndex, isClassMember } from '../indexer/code-index.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import type { ImportInfo, ProbeConfig, Symbol } from '../types.js';

import type { ToolResponse } from './overview.js';

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
}

const DEFAULT_MAX_TOKENS = 3000;
const SUGGEST_LIMIT = 5;
// `exported_by` is intentionally absent: the TS extractor skips re-export
// statements (`export { x } from './y'`), so any "exported by" listing in
// Phase 1a would only surface coincidentally same-named exports from
// unrelated files. The section returns when re-export edges land.
const ALL_SECTIONS = ['body', 'callers', 'callees', 'imports'] as const;
type Section = typeof ALL_SECTIONS[number];

type SectionItem = {
  name: string;
  includeKey: Section;
  render: () => Promise<string> | string;
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
    if (item.includeKey !== neverDrop && used >= maxTokens) {
      truncatedAt = item.name;
      break;
    }
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

// Re-check scanner admission rules at read time so stale on-disk
// state (symlink-swap, growth past cap, became-directory) can't
// bypass the indexer's contract.
async function safeReadIndexedFile(
  relPath: string,
  config: ProbeConfig,
): Promise<string> {
  const abs = join(config.projectRoot, relPath);
  const stats = await fs.lstat(abs);
  if (stats.isSymbolicLink()) {
    throw new Error('refusing to follow symlink');
  }
  if (!stats.isFile()) {
    throw new Error('not a regular file');
  }
  if (stats.size > config.maxFileSize) {
    throw new Error(
      `exceeds maxFileSize (${stats.size} > ${config.maxFileSize})`,
    );
  }
  // lstat only checks the final component. Resolve parent-directory
  // symlinks so a swap higher up in the path can't escape projectRoot.
  const [real, realRoot] = await Promise.all([
    fs.realpath(abs),
    fs.realpath(config.projectRoot),
  ]);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes project root');
  }
  return fs.readFile(abs, 'utf8');
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
    const banner = deps.indexer.ready
      ? ''
      : '⏳ Indexing in progress. Results may be incomplete.\n\n';

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

function normalizeFilePath(input: string, projectRoot: string): string | null {
  // `resolve` collapses `..` segments so traversal attempts are caught below.
  const cleaned = input.replace(/\\/g, '/');
  const absolute = resolve(projectRoot, cleaned);
  const rel = relative(projectRoot, absolute).replace(/\\/g, '/');
  if (rel === '' || rel === '..' || rel.startsWith('../')) {
    return null;
  }
  return rel;
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
  const lines: string[] = [`No symbol '${name}' found in ${file}.`];
  if (suggestions.length > 0) {
    lines.push('', 'Did you mean:');
    for (const s of suggestions) {
      const tag = s.exported ? ' [exported]' : '';
      lines.push(`- ${s.name} (${s.kind}, ${s.file}:${s.startLine})${tag}`);
    }
  }
  return lines.join('\n');
}

function renderAmbiguous(
  name: string,
  file: string,
  candidates: Symbol[],
): string {
  const lines: string[] = [
    `Multiple symbols named '${name}' in ${file}:`,
  ];
  for (const c of candidates) {
    const sig = c.signature || c.name;
    lines.push(`- ${c.kind} ${c.startLine}-${c.endLine}: ${sig}`);
  }
  lines.push('', 'Pass `line` to disambiguate.');
  return lines.join('\n');
}

function pickByLine(candidates: Symbol[], line: number): Symbol {
  // Among ranges that contain the line, pick the smallest. This targets
  // the innermost match (e.g. a method inside a same-named class) instead
  // of returning whichever container appears first in extraction order.
  let innermost: Symbol | null = null;
  let innermostSize = Infinity;
  for (const s of candidates) {
    if (s.startLine > line || line > s.endLine) continue;
    const size = s.endLine - s.startLine;
    if (size < innermostSize) {
      innermost = s;
      innermostSize = size;
    }
  }
  if (innermost) return innermost;
  let best = candidates[0];
  let bestDist = Math.abs(line - best.startLine);
  for (let i = 1; i < candidates.length; i++) {
    const d = Math.abs(line - candidates[i].startLine);
    if (d < bestDist) {
      best = candidates[i];
      bestDist = d;
    }
  }
  return best;
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
      render: () => renderEdges('Callers', deps.index.getCallers(target.id)),
    },
    {
      name: 'callees',
      includeKey: 'callees',
      render: () => renderEdges('Callees', deps.index.getCallees(target.id)),
    },
    {
      name: 'imports',
      includeKey: 'imports',
      render: () => renderImports(file, deps.index),
    },
  ];

  return renderBudgeted(header, items, include, maxTokens, 'body');
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

function renderEdges(
  title: 'Callers' | 'Callees',
  edges: Symbol[],
): string {
  if (edges.length === 0) return `### ${title}\n(none)`;
  const lines: string[] = [`### ${title}`];
  for (const e of edges) {
    const sig = e.signature || e.name;
    lines.push(`- ${e.file}:${e.startLine} — ${sig} [structural]`);
  }
  return lines.join('\n');
}

function renderImports(file: string, index: CodeIndex): string {
  const imports = index.getImports(file);
  if (imports.length === 0) return '';
  const lines: string[] = ['### Imports'];
  for (const imp of imports) {
    lines.push(`- ${imp.sourceModule}: ${formatImportNames(imp)}`);
  }
  return lines.join('\n');
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
  // the file-mode outline lists only top-level definitions to avoid
  // duplicating each class's surface area in the export list.
  const topLevel = symbols.filter((s) => !isClassMember(s));
  const exported = topLevel.filter((s) => s.exported);
  const internal = topLevel.filter((s) => !s.exported);

  // `body` covers the outline (Exports + Internal); `callees` has no
  // file-mode analogue. Renderers are lazy so dropped sections don't pay
  // for caller scans.
  const items: SectionItem[] = [
    {
      name: 'Exports',
      includeKey: 'body',
      render: () =>
        exported.length > 0
          ? ['### Exports', ...exported.map(formatFileSymbolLine)].join('\n')
          : '### Exports\n(none)',
    },
    {
      name: 'Internal',
      includeKey: 'body',
      render: () =>
        internal.length > 0
          ? ['### Internal', ...internal.map(formatFileSymbolLine)].join('\n')
          : '',
    },
    {
      name: 'Imports',
      includeKey: 'imports',
      render: () =>
        imports.length > 0
          ? [
              '### Imports',
              ...imports.map(
                (imp) => `- ${imp.sourceModule}: ${formatImportNames(imp)}`,
              ),
            ].join('\n')
          : '',
    },
    {
      name: "Callers of this file's exports",
      includeKey: 'callers',
      render: () => {
        const callers = collectExportCallers(exported, deps.index);
        return callers.length > 0
          ? ["### Callers of this file's exports", ...callers].join('\n')
          : "### Callers of this file's exports\n(none)";
      },
    },
  ];

  return renderBudgeted(header, items, include, maxTokens);
}

function collectExportCallers(
  exportedSyms: Symbol[],
  index: CodeIndex,
): string[] {
  const byFile = new Map<string, Set<string>>();
  for (const exp of exportedSyms) {
    for (const c of index.getCallers(exp.id)) {
      let set = byFile.get(c.file);
      if (!set) {
        set = new Set();
        byFile.set(c.file, set);
      }
      set.add(exp.name);
    }
  }
  const lines: string[] = [];
  for (const [f, names] of byFile) {
    lines.push(`- ${f} — uses ${[...names].sort().join(', ')}`);
  }
  return lines.sort();
}

function formatFileSymbolLine(s: Symbol): string {
  const sig = s.signature || s.name;
  return `- ${s.name} (${s.kind}, line ${s.startLine}) — ${sig}`;
}

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}

function textResponse(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}
