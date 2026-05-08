import { dirname } from 'node:path';

import {
  isCallerOf,
  isWildcardImport,
  type CodeIndex,
} from '../indexer/code-index.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import type { ImportInfo, ProbeConfig, Reference, Symbol } from '../types.js';

import {
  MODULE_LEVEL,
  NAME_MATCH_HEADER_QUALIFIER,
  NAME_MATCH_TAG,
  normalizeFilePath,
  omittedSuffix,
  pickByLine,
  readinessBanner,
  renderAmbiguous,
  renderSuggestions,
  sectionOrNone,
  textResponse,
  type ToolResponse,
} from './common.js';

export type FindReferencesKind =
  | 'callers'
  | 'callees'
  | 'implementations'
  | 'type_references'
  | 'all';

export interface FindReferencesArgs {
  file: string;
  symbol: string;
  line?: number;
  kind?: FindReferencesKind;
  limit?: number;
}

export interface FindReferencesDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: ProbeConfig;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const SUGGEST_LIMIT = 5;

const CALLERS_HEADER = `### Callers ${NAME_MATCH_HEADER_QUALIFIER}`;
const CALLEES_HEADER = '### Callees (within-file — from AST resolution)';
const PHASE_2_NOTE = '(none — ships with LSP in Phase 2)';

interface RankedRef {
  ref: Reference;
  tier: number;
  source: Symbol | null;
}

export async function runFindReferences(
  args: FindReferencesArgs,
  deps: FindReferencesDeps,
): Promise<ToolResponse> {
  try {
    const file = normalizeFilePath(args.file, deps.config.projectRoot);
    if (file === null) {
      return textResponse(
        `Error: file "${args.file}" is outside the project root.`,
      );
    }

    const trimmed = args.symbol.trim();
    if (trimmed.length === 0) {
      return textResponse('Error: symbol must be non-empty.');
    }

    // Compute banner before any index-dependent miss so partial first-pass
    // results don't surface as definitive errors.
    const banner = readinessBanner(deps.indexer.ready);

    if (!deps.index.hasFile(file)) {
      return textResponse(banner + `Error: file '${file}' not found in index.`);
    }

    const candidates = deps.index
      .getSymbolsInFile(file)
      .filter((s) => s.name === trimmed);

    if (candidates.length === 0) {
      const suggestions = deps.index.suggest(
        trimmed,
        SUGGEST_LIMIT,
        undefined,
        file,
      );
      return textResponse(banner + renderNoSymbol(trimmed, file, suggestions));
    }

    let target: Symbol;
    if (candidates.length === 1) {
      target = candidates[0];
    } else if (args.line !== undefined) {
      target = pickByLine(candidates, args.line);
    } else {
      return textResponse(banner + renderAmbiguous(trimmed, file, candidates));
    }

    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const kind = args.kind ?? 'all';

    const sections: string[] = [];
    sections.push(
      `## References for \`${target.name}\` (${target.file}:${target.startLine})`,
    );

    if (kind === 'callers' || kind === 'all') {
      sections.push(renderCallers(target, deps.index, limit));
    }
    if (kind === 'callees' || kind === 'all') {
      sections.push(renderCallees(target, deps.index, limit));
    }
    if (kind === 'implementations' || kind === 'all') {
      sections.push(renderPhase2('Implementations'));
    }
    if (kind === 'type_references' || kind === 'all') {
      sections.push(renderPhase2('Type References'));
    }

    return textResponse(banner + sections.join('\n\n'));
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

function renderCallers(
  target: Symbol,
  index: CodeIndex,
  limit: number,
): string {
  const filtered = index
    .getReferencesByNameOrAlias(target.name, target.file)
    .filter((ref) => isCallerOf(ref, target));

  const ranked = rankRefs(filtered, target, index);
  ranked.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.ref.file !== b.ref.file) {
      return a.ref.file < b.ref.file ? -1 : 1;
    }
    return a.ref.line - b.ref.line;
  });

  const shown = ranked.slice(0, limit);
  const body: string[] = shown.map((r) => {
    const callerLabel = r.source ? `${r.source.name}()` : MODULE_LEVEL;
    return `- ${r.ref.file}:${r.ref.line} — ${callerLabel}  ${NAME_MATCH_TAG}`;
  });
  if (ranked.length > shown.length) {
    body.push(omittedSuffix(ranked.length - shown.length));
  }
  return sectionOrNone(CALLERS_HEADER, body);
}

function renderCallees(
  target: Symbol,
  index: CodeIndex,
  limit: number,
): string {
  // Within-file only — cross-file callee resolution waits for LSP (Phase 2).
  const callees = index.getCallees(target.id);
  const body: string[] = callees
    .slice(0, limit)
    .map((c) => `- ${c.file}:${c.startLine} — ${c.name}()`);
  if (callees.length > limit) {
    body.push(omittedSuffix(callees.length - limit));
  }
  return sectionOrNone(CALLEES_HEADER, body);
}

function renderPhase2(label: string): string {
  return `### ${label}\n${PHASE_2_NOTE}`;
}

function rankRefs(
  refs: Reference[],
  target: Symbol,
  index: CodeIndex,
): RankedRef[] {
  const targetDir = dirname(target.file);
  const targetParent = dirname(targetDir);
  const importsCache = new Map<string, ImportInfo[]>();
  const importsFor = (file: string): ImportInfo[] => {
    let cached = importsCache.get(file);
    if (cached === undefined) {
      cached = index.getImports(file);
      importsCache.set(file, cached);
    }
    return cached;
  };
  const out: RankedRef[] = [];
  for (const ref of refs) {
    const refDir = dirname(ref.file);
    let tier: number;
    if (refDir === targetDir) {
      tier = 1;
    } else if (importsTargetName(importsFor(ref.file), target.name)) {
      tier = 2;
    } else if (refDir === targetParent || dirname(refDir) === targetParent) {
      tier = 3;
    } else {
      tier = 4;
    }
    const source = ref.sourceId ? index.getSymbolById(ref.sourceId) ?? null : null;
    out.push({ ref, tier, source });
  }
  return out;
}

function importsTargetName(imports: ImportInfo[], name: string): boolean {
  for (const imp of imports) {
    for (const named of imp.importedNames) {
      if (named.name === name || named.alias === name) return true;
      // Python `from .x import *` binds every export of source module to
      // local scope. Refs reach the ranker only after
      // primaryRefMatchesTarget admitted them via importResolvesTo, so a
      // wildcard's presence is a strong import-connected signal.
      if (isWildcardImport(named)) return true;
    }
  }
  return false;
}

function renderNoSymbol(
  name: string,
  file: string,
  suggestions: Symbol[],
): string {
  return [
    `Error: no symbol '${name}' in '${file}'.`,
    ...renderSuggestions(suggestions),
  ].join('\n');
}
