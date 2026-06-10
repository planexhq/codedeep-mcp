import { dirname } from 'node:path';

import {
  isCallerOf,
  isClassMember,
  isWildcardImport,
  type CodeIndex,
} from '../indexer/code-index.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import type { ImportInfo, ProbeConfig, Reference, Symbol } from '../types.js';

import {
  MEMBER_MATCH_TAG,
  MODULE_LEVEL,
  NAME_MATCH_HEADER_QUALIFIER,
  NAME_MATCH_TAG,
  normalizeFilePath,
  omittedSuffix,
  pickByLine,
  readinessBanner,
  renderAmbiguous,
  renderSuggestions,
  sectionOrEmpty,
  sectionOrNone,
  textResponse,
  topCoChangePartners,
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
    // Behavioral coupling rides along with kind 'all' only: it is
    // file-granularity enrichment, not a reference kind, and it stays a
    // separate section rather than a rankRefs tier — a co-committing
    // file says nothing about whether any given AST row is a real call
    // site, so it must not outrank verified rows. Vanishes (no header)
    // outside git repos, unlike the structural sections above whose
    // "(none)" is a real answer.
    if (kind === 'all') {
      const coChanges = renderCoChangePartners(target.file, deps.index);
      if (coChanges) sections.push(coChanges);
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
    .getReferencesByNameOrAlias(target.name, target.file, isClassMember(target))
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
    // Resolved member refs (this.x() bound at extract time) carry the
    // same confidence as resolved bare refs and keep the name-match tag;
    // unresolved member rows get the noisier member tag.
    const tag =
      r.ref.receiver !== undefined && r.ref.targetId === null
        ? MEMBER_MATCH_TAG
        : NAME_MATCH_TAG;
    return `- ${r.ref.file}:${r.ref.line} — ${callerLabel}  ${tag}`;
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

// Confidence-only rows — find_references is the breadth view; the
// shared-commit detail lives in get_context's co-change section.
function renderCoChangePartners(file: string, index: CodeIndex): string {
  const rows = topCoChangePartners(index.getCoChanges(file), file);
  return sectionOrEmpty(
    '### Co-change Partners (behavioral — from git)',
    rows.map((r) => `- ${r.partner}  ${r.pct}% confidence`),
  );
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
    if (ref.targetId === null && ref.receiver !== undefined) {
      // Unresolved member refs rank by their receiver binding: an
      // import-connected receiver (`import * as u; u.fn()`) is as strong
      // as an import-connected bare name; anything else is the noisiest
      // tier — the property match alone is weak evidence.
      tier = importsReceiver(importsFor(ref.file), ref.receiver) ? 2 : 5;
    } else if (refDir === targetDir) {
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

// Only module-object bindings (`import * as u`, Python `import x` /
// `from . import x`) make a receiver "import-connected" for ranking:
// those are the bindings memberRefMatchesTarget can resolve precisely.
// A value import merely NAMED like the receiver says nothing about where
// the object's class lives, so it must not buy tier-2 placement.
function importsReceiver(imports: ImportInfo[], receiver: string): boolean {
  for (const imp of imports) {
    for (const named of imp.importedNames) {
      if (named.kind !== 'namespace' && named.kind !== 'module') continue;
      if ((named.alias ?? named.name) === receiver) return true;
    }
  }
  return false;
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
