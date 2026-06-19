import type { CodeIndex } from '../indexer/code-index.js';
import type { Indexer } from '../indexer/pipeline.js';
import { depthOf } from '../indexer/scanner.js';
import { errMsg } from '../logger.js';
import type { ProbeConfig, Symbol, SymbolKind } from '../types.js';

import {
  STRUCTURAL_TAG,
  readinessBanner,
  renderSuggestions,
  textResponse,
  type ToolResponse,
} from './common.js';

export interface FindSymbolArgs {
  name: string;
  kind?: SymbolKind;
  scope?: string;
  limit?: number;
}

export interface FindSymbolDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: ProbeConfig;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const SUGGEST_LIMIT = 5;

export async function runFindSymbol(
  args: FindSymbolArgs,
  deps: FindSymbolDeps,
): Promise<ToolResponse> {
  try {
    const trimmed = args.name.trim();
    if (trimmed.length === 0) {
      return textResponse('Error: name must be non-empty.');
    }

    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const scope = normalizeScope(args.scope, deps.index);
    const kind = args.kind;

    const exactList = deps.index.findSymbolByName(trimmed, kind, scope);
    const exactIds = new Set(exactList.map((s) => s.id));
    const merged: Symbol[] = [...exactList];

    if (merged.length < limit) {
      const prefixList = deps.index.findSymbolsByPrefix(trimmed, Infinity, kind, scope);
      for (const sym of prefixList) {
        if (exactIds.has(sym.id)) continue;
        merged.push(sym);
      }
    }

    const banner = readinessBanner(deps.indexer.ready);

    if (merged.length === 0) {
      const filtered = deps.index.suggest(trimmed, SUGGEST_LIMIT, kind, scope);
      return textResponse(banner + renderNoMatch(trimmed, filtered));
    }

    merged.sort((a, b) => compareEntries(a, b, exactIds));
    const blocks = merged
      .slice(0, limit)
      .map((sym) => renderMatch(sym, deps.index));
    return textResponse(banner + blocks.join('\n\n'));
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

function normalizeScope(
  scope: string | undefined,
  index: CodeIndex,
): string | undefined {
  if (!scope) return undefined;
  if (scope.endsWith('/')) return scope;
  // '.storybook' and 'packages/api.v2' have dots but aren't files; ask the
  // index instead of guessing from the path shape.
  if (index.hasFile(scope)) return scope;
  return `${scope}/`;
}

function compareEntries(
  a: Symbol,
  b: Symbol,
  exactIds: Set<string>,
): number {
  const ea = exactIds.has(a.id);
  const eb = exactIds.has(b.id);
  if (ea !== eb) return ea ? -1 : 1;
  if (a.exported !== b.exported) return a.exported ? -1 : 1;
  const da = depthOf(a.file);
  const db = depthOf(b.file);
  if (da !== db) return da - db;
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  const nameCmp = a.name.localeCompare(b.name);
  if (nameCmp !== 0) return nameCmp;
  return a.startLine - b.startLine;
}

function renderMatch(sym: Symbol, index: CodeIndex): string {
  const range = `${sym.startLine}-${sym.endLine}`;
  const exportedSuffix = sym.exported ? ' | exported' : '';
  const lines: string[] = [
    `${sym.file}:${range} | ${sym.kind}${exportedSuffix}`,
    sym.signature,
  ];
  if (sym.doc && sym.doc.length > 0) lines.push(sym.doc);
  // Fan-in (reference-granular, cross-file) and fan-out (resolved within-file
  // callees, a lower bound). Both O(1) — no caller-tree walk per match.
  lines.push(`References: ~${index.getCallerCount(sym.id)}`);
  lines.push(`Fan-out: ${index.getFanOut(sym.id)}`);
  // Cyclomatic complexity — genuinely structural (no name-match approximation,
  // unlike fan-in). Present only for function/method symbols above the trivial 1.
  if (sym.complexity !== undefined) {
    lines.push(`Cyclomatic: ${sym.complexity} ${STRUCTURAL_TAG}`);
  }
  return lines.join('\n');
}

function renderNoMatch(name: string, suggestions: Symbol[]): string {
  return [`No symbol '${name}' found.`, ...renderSuggestions(suggestions)].join('\n');
}
