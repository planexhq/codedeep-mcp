import { relative, resolve } from 'node:path';

import type { Symbol } from '../types.js';

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

// Among ranges that contain `line`, pick the smallest — targets the innermost
// match (e.g. a method inside a same-named class). Otherwise pick the candidate
// nearest by startLine.
export function pickByLine(candidates: Symbol[], line: number): Symbol {
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

// Heading qualifier that pairs with `NAME_MATCH_TAG`. Section headers
// compose their own prefix and append this so the precision tier is
// announced consistently.
export const NAME_MATCH_HEADER_QUALIFIER = '(approximate — from AST name matching)';

// Counterpart to `NAME_MATCH_TAG` for symbol-mode rows derived from the
// id-keyed adjacency (precise within-file resolution). Emitted by
// `get_context` symbol-mode caller/callee lists.
export const STRUCTURAL_TAG = '[structural]';

export function readinessBanner(ready: boolean): string {
  return ready ? '' : `${INDEXING_BANNER}\n\n`;
}
