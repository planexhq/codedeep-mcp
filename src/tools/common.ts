import { promises as fs } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { partnerOf } from '../git/analyzer.js';
import type { CoChange, CodedeepConfig, Symbol } from '../types.js';

// Index signature required to satisfy the MCP SDK's CallToolResult shape.
export interface ToolResponse {
  [x: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export function textResponse(text: string): ToolResponse {
  return { content: [{ type: 'text', text }] };
}

// `resolve` collapses `..` segments so a traversal attempt produces a
// relative path starting with `..` — that's how we detect escapes.
export function normalizeFilePath(input: string, projectRoot: string): string | null {
  const cleaned = input.replace(/\\/g, '/');
  const absolute = resolve(projectRoot, cleaned);
  const rel = relative(projectRoot, absolute).replace(/\\/g, '/');
  if (rel === '' || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

// projectRoot is fixed for the process lifetime, so its realpath is too —
// caching it spares one syscall per safeReadIndexedFile call (pattern
// scans call this once per candidate file).
const realRootCache = new Map<string, string>();
async function realProjectRoot(projectRoot: string): Promise<string> {
  let cached = realRootCache.get(projectRoot);
  if (cached === undefined) {
    cached = await fs.realpath(projectRoot);
    realRootCache.set(projectRoot, cached);
  }
  return cached;
}

// Re-check scanner admission rules at read time so stale on-disk
// state (symlink-swap, growth past cap, became-directory) can't
// bypass the indexer's contract.
export async function safeReadIndexedFile(
  relPath: string,
  config: CodedeepConfig,
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
    realProjectRoot(config.projectRoot),
  ]);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes project root');
  }
  return fs.readFile(abs, 'utf8');
}

// Among ranges that contain `line`, pick the smallest — targets the innermost
// match (e.g. a method inside a same-named class). Returns null when no
// candidate spans `line`; callers that want a fallback handle it themselves.
export function innermostEnclosing(
  candidates: Symbol[],
  line: number,
): Symbol | null {
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
  return innermost;
}

// Innermost containing range when one exists; otherwise the candidate
// nearest by startLine.
export function pickByLine(candidates: Symbol[], line: number): Symbol {
  const innermost = innermostEnclosing(candidates, line);
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

export function renderAmbiguous(
  name: string,
  file: string,
  candidates: Symbol[],
): string {
  const lines: string[] = [`Multiple symbols named '${name}' in ${file}:`];
  for (const c of candidates) {
    lines.push(`- ${c.kind} ${c.startLine}-${c.endLine}: ${displaySignature(c)}`);
  }
  lines.push('', 'Pass `line` to disambiguate.');
  return lines.join('\n');
}

export function omittedSuffix(omitted: number): string {
  return `- (${omitted} more omitted; raise \`limit\` to see all)`;
}

// Always emits the header; uses `(none)` as the body placeholder when
// empty, so absence of callers/callees/exports is explicit in output.
export function sectionOrNone(header: string, body: string[]): string {
  if (body.length === 0) return `${header}\n(none)`;
  return [header, ...body].join('\n');
}

// Elides the section when empty — for outlines where a missing section
// is preferable to a `(none)` placeholder (imports, internal symbols).
export function sectionOrEmpty(header: string, body: string[]): string {
  if (body.length === 0) return '';
  return [header, ...body].join('\n');
}

// Falls back to `name` when no signature was extracted (variables, some
// Python defs) so list rows never trail an empty token.
export function displaySignature(s: Symbol): string {
  return s.signature || s.name;
}

// Builds the "Did you mean:" block for fuzzy suggestion replies. Returns
// the lines (including a leading blank separator) when non-empty, [] when
// empty so the calling site's leading sentence is the entire output.
export function renderSuggestions(suggestions: Symbol[]): string[] {
  if (suggestions.length === 0) return [];
  const lines: string[] = ['', 'Did you mean:'];
  for (const s of suggestions) {
    const tag = s.exported ? ' [exported]' : '';
    lines.push(`- ${s.name} (${s.kind}, ${s.file}:${s.startLine})${tag}`);
  }
  return lines;
}

export const INDEXING_BANNER = '⏳ Indexing in progress. Results may be incomplete.';

// Caller-row label for refs at file scope (no enclosing source symbol).
export const MODULE_LEVEL = '(module-level)';

// Per-line tag stamped on every approximate-name-match caller row so
// consumers can distinguish AST-only matches from precise (LSP) refs.
// Shared between `find_references` and `get_context`'s file-mode export
// caller summary — both render the same data path.
export const NAME_MATCH_TAG = '[name match, unverified]';

// Tag for unresolved member-call rows (`obj.method()` / `ns.fn()`):
// noisier than bare-name matches because the receiver could bind to any
// object, so the property match alone carries the evidence.
export const MEMBER_MATCH_TAG = '[member call, unverified]';

// Heading qualifier that pairs with `NAME_MATCH_TAG`. Section headers
// compose their own prefix and append this so the precision tier is
// announced consistently.
export const NAME_MATCH_HEADER_QUALIFIER = '(approximate — from AST name matching)';

// Counterpart to `NAME_MATCH_TAG` for symbol-mode rows derived from the
// id-keyed adjacency (precise within-file resolution). Emitted by
// `get_context` symbol-mode caller/callee lists.
export const STRUCTURAL_TAG = '[structural]';

// Tag-less complexity body ("cyc N / cog M") for anything carrying the two
// optional metrics, or null when neither is present. Cyclomatic is omitted at
// the trivial 1, cognitive at 0, so a value may carry either, both, or neither;
// show whichever the extractor populated. The param is a minimal structural
// shape (not full `Symbol`) so a RiskRow can render its offender's complexity
// without a synthetic Symbol. Used where the caller adds the [structural] tag
// (formatComplexity) or deliberately suppresses it (Risk Hotspots rows, already
// under a single [behavioral] heading).
export function formatComplexityMetrics(sym: {
  complexity?: number;
  cognitiveComplexity?: number;
}): string | null {
  const parts: string[] = [];
  if (sym.complexity !== undefined) parts.push(`cyc ${sym.complexity}`);
  if (sym.cognitiveComplexity !== undefined) parts.push(`cog ${sym.cognitiveComplexity}`);
  return parts.length === 0 ? null : parts.join(' / ');
}

// Renders the combined complexity body with the [structural] tag for a symbol,
// or null when neither metric is present. Both metrics are genuinely structural
// (no name-match approximation, unlike fan-in), so one [structural] tag covers
// the line. Callers add their own prefix ("Complexity:" / "- Complexity:").
export function formatComplexity(sym: Symbol): string | null {
  const body = formatComplexityMetrics(sym);
  return body === null ? null : `${body} ${STRUCTURAL_TAG}`;
}

// Tier tag for git-derived data: commit co-occurrence and history, not
// code structure. Pairs with the design-notes tier vocabulary
// ([structural] / [approximate] / [behavioral]).
export const BEHAVIORAL_TAG = '[behavioral]';

export interface CoChangePartnerRow {
  partner: string;
  // Confidence FROM the queried file, as a rounded percent: "when THIS
  // file changes, how often does the partner change too".
  pct: number;
  shared: number;
}

// The confidence direction is the most invertible bug in the git layer —
// confidenceAB is the from-self direction only when the queried file is
// fileA. Centralized (sharing analyzer's partnerOf for the orientation
// pick) so get_context and find_references cannot disagree. Both tools
// use the same default partner cap.
export function topCoChangePartners(
  coChanges: readonly CoChange[],
  selfPath: string,
  limit = 5,
): CoChangePartnerRow[] {
  const rows = coChanges.map((c) => {
    const selfIsA = c.fileA === selfPath;
    return {
      partner: partnerOf(c, selfPath),
      // Floor at 1%: a pair only exists because coupling registered, so a
      // "0% confidence" row (3 shared commits against a 600-commit hub
      // file) would be self-contradictory output.
      pct: Math.max(
        1,
        Math.round((selfIsA ? c.confidenceAB : c.confidenceBA) * 100),
      ),
      shared: c.sharedCommits,
    };
  });
  rows.sort(
    (a, b) =>
      b.pct - a.pct ||
      b.shared - a.shared ||
      (a.partner < b.partner ? -1 : a.partner > b.partner ? 1 : 0),
  );
  return rows.slice(0, limit);
}

export function readinessBanner(ready: boolean): string {
  return ready ? '' : `${INDEXING_BANNER}\n\n`;
}

export function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
