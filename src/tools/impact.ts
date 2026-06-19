import {
  type CallerTreeNode,
  type CallerTreeResult,
  type CodeIndex,
  type EdgeStrength,
  countDistinctCallers,
} from '../indexer/code-index.js';
import type { Indexer } from '../indexer/pipeline.js';
import { errMsg } from '../logger.js';
import type { ProbeConfig, Symbol } from '../types.js';

import {
  BEHAVIORAL_TAG,
  MEMBER_MATCH_TAG,
  MODULE_LEVEL,
  NAME_MATCH_TAG,
  STRUCTURAL_TAG,
  normalizeFilePath,
  pickByLine,
  plural,
  readinessBanner,
  renderAmbiguous,
  renderSuggestions,
  textResponse,
  topCoChangePartners,
  type ToolResponse,
} from './common.js';

export interface ImpactArgs {
  file: string;
  symbol: string;
  line?: number;
  depth?: number;
  max_tokens?: number;
  include_weak?: boolean;
}

// Mirrors FindReferencesDeps (no GitService): co-change partners come from
// the persisted index (`getCoChanges`), not the live git service.
export interface ImpactDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: ProbeConfig;
}

const DEFAULT_DEPTH = 3;
// Past 5 hops the heuristic name-match noise compounds multiplicatively and
// the tree is mostly candidates; cap is a precision guardrail, not just budget.
const MAX_DEPTH = 5;
const DEFAULT_MAX_TOKENS = 3000;
const SUGGEST_LIMIT = 5;

export async function runImpact(
  args: ImpactArgs,
  deps: ImpactDeps,
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

    // Computed before any miss so partial first-pass results aren't surfaced
    // as definitive errors (matches find_references).
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

    // Clamp to [1, MAX_DEPTH]. The MCP schema enforces .positive(), but
    // runImpact is also invoked directly (tests / internal callers); a
    // non-positive depth would make maxDepth<=0 and falsely report "0 callers".
    const depth = Math.max(1, Math.min(args.depth ?? DEFAULT_DEPTH, MAX_DEPTH));
    const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;
    const includeWeak = args.include_weak ?? false;

    const tree = deps.index.getCallerTree(target.id, {
      maxDepth: depth,
      includeWeak,
    });

    return textResponse(
      banner + renderImpact(tree, target, depth, maxTokens, deps.index),
    );
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
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

// Edge strength -> the existing per-row provenance tier tag. Honest by
// construction: resolved within-file edges are [structural]; everything
// cross-file is a name/member match, never asserted as verified.
function tagFor(strength: EdgeStrength): string {
  if (strength === 'resolved') return STRUCTURAL_TAG;
  if (strength === 'weak-member') return MEMBER_MATCH_TAG;
  return NAME_MATCH_TAG;
}

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function flattenByDepth(root: CallerTreeNode): Map<number, CallerTreeNode[]> {
  const byDepth = new Map<number, CallerTreeNode[]>();
  const walk = (node: CallerTreeNode): void => {
    for (const child of node.children) {
      let bucket = byDepth.get(child.depth);
      if (!bucket) {
        bucket = [];
        byDepth.set(child.depth, bucket);
      }
      bucket.push(child);
      walk(child);
    }
  };
  walk(root);
  return byDepth;
}

function renderNodeRow(node: CallerTreeNode): string {
  const label = node.isModuleLevel ? MODULE_LEVEL : `${node.name}()`;
  let row = `- ${node.file}:${node.line} — ${label}  ${tagFor(node.strength)}`;
  const marks: string[] = [];
  if (node.isCycle) marks.push('cycle — already shown on this path');
  if (node.leafByPolicy) {
    // Distinguish WHY this real caller was not expanded: a resolved /
    // import-connected leaf stopped on the depth-confidence floor; a weaker
    // edge stopped on its class. Both are lifted by include_weak.
    const reason =
      node.strength === 'resolved' || node.strength === 'import-connected'
        ? 'low confidence at this depth'
        : 'weak edge';
    marks.push(`not expanded (${reason}) — pass include_weak`);
  }
  if (node.truncatedChildren > 0) {
    marks.push(`+${node.truncatedChildren} more truncated`);
  }
  // The grouped call sites are otherwise unsurfaced; a caller that hits the
  // target several times (or a file with several module-level call sites)
  // would otherwise read as a single call.
  if (node.sites.length > 1) {
    marks.push(`${node.sites.length} call sites`);
  }
  if (marks.length > 0) row += `  (${marks.join('; ')})`;
  // BFS-flattening loses the tree edges; name the caller this row reaches the
  // target through.
  if (node.via) row += `\n  ← via ${node.via}()`;
  return row;
}

function renderDepthGroup(depth: number, nodes: CallerTreeNode[]): string {
  const label = depth === 1 ? 'direct callers' : 'callers of the above';
  const gloss = depth === 1 ? ' — highest risk' : '';
  const header = `### Depth ${depth} — ${label} (${nodes.length})${gloss}`;
  return [header, ...nodes.map(renderNodeRow)].join('\n');
}

function renderCoChanges(file: string, index: CodeIndex): string {
  const rows = topCoChangePartners(index.getCoChanges(file), file);
  if (rows.length === 0) return '';
  return [
    `### Co-change Partners ${BEHAVIORAL_TAG}`,
    ...rows.map((r) => `- ${r.partner}  ${r.pct}% confidence`),
    '(May also be affected: no call edge, but these files historically change with this one.)',
  ].join('\n');
}

// Depth-first budget loop: title/disclaimer/summary always; Depth 1 is the
// floor (never dropped, like get_context's body); deeper hops and then the
// behavioral section drop first, each with an honest, distinctly-worded note.
function renderImpact(
  tree: CallerTreeResult,
  target: Symbol,
  depth: number,
  maxTokens: number,
  index: CodeIndex,
): string {
  const header = `## Impact of \`${target.name}\` (${target.file}:${target.startLine})`;
  const disclaimer =
    `Upstream callers traced to depth ${depth}. Edges are AST name-matches, ` +
    `not compiler-verified — treat as candidates.`;

  const blocks: string[] = [header, disclaimer];

  if (tree.totalNodes === 0) {
    blocks.push('0 callers found.');
    blocks.push(
      '(No upstream call sites in the index — not proof of dead code; calls ' +
        'through dynamic dispatch or inheritance may be invisible.)',
    );
    const cc = renderCoChanges(target.file, index);
    if (cc) blocks.push(cc);
    pushLimitations(blocks, tree);
    return blocks.join('\n\n');
  }

  const byDepth = flattenByDepth(tree.root);
  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  // Distinct caller/file/depth counts (and the depth-wall flag) via the shared
  // helper (a DAG diamond is ONE caller, not N) — the single source of truth
  // get_context and overview reuse, so the surfaces never report divergent
  // numbers. impact keeps tree.truncated and depthCapped SEPARATE below: they
  // map to two distinct remediation hints (raise max_tokens/narrow vs raise
  // depth), unlike the scalar BlastRadius which collapses both into one `+`.
  const blast = countDistinctCallers(tree.root);
  const depthCapped = blast.depthCapped;
  const callerCount = blast.callers;
  // A trailing `+` flags that a breadth/size cap fired, so the true total may
  // be higher than the number shown.
  blocks.push(
    `${callerCount}${tree.truncated ? '+' : ''} ${plural('caller', callerCount)} across ` +
      `${blast.depths} ${plural('depth', blast.depths)} ` +
      `(${blast.files} ${plural('file', blast.files)}).`,
  );

  let used = estimate(blocks.join('\n\n'));
  let cutoff: number | null = null;
  for (const d of depths) {
    const group = renderDepthGroup(d, byDepth.get(d) ?? []);
    const cost = estimate(group);
    // Depth 1 is the floor — never dropped to fit budget.
    if (d > 1 && used + cost > maxTokens) {
      cutoff = d;
      break;
    }
    blocks.push(group);
    used += cost;
  }

  // Incompleteness notes — distinctly worded so the agent knows which lever to
  // pull: budget cutoff (raise max_tokens) vs depth wall (raise depth) vs the
  // graph-size cap (the walk itself was bounded; counts may understate).
  if (cutoff !== null) {
    blocks.push(
      `(Depth ${cutoff}+ omitted to stay within max_tokens=${maxTokens}; the counts above include the omitted callers — raise max_tokens to see them.)`,
    );
  } else if (depthCapped) {
    blocks.push(
      `(Some depth-${depth} callers may have further callers; raise \`depth\` to expand.)`,
    );
  }
  if (tree.truncated) {
    blocks.push(
      '(Caller discovery hit the breadth/size limit; some callers are not shown ' +
        'and the counts above may understate the true total — narrow the scope to see them.)',
    );
  }

  // Co-change rides last and only when the budget did not already cut off.
  if (cutoff === null) {
    const cc = renderCoChanges(target.file, index);
    if (cc && used + estimate(cc) <= maxTokens) blocks.push(cc);
  }

  pushLimitations(blocks, tree);
  return blocks.join('\n\n');
}

// Render the structured CallerTreeResult.limitations as a trailing footnote so
// the disclosure cannot drift from a hand-written copy of it (the top
// disclaimer stays short and the scope caveats live here, once).
function pushLimitations(blocks: string[], tree: CallerTreeResult): void {
  if (tree.limitations.length === 0) return;
  blocks.push(['Limitations:', ...tree.limitations.map((l) => `- ${l}`)].join('\n'));
}
