// Wraps a single tool-handler call: times it, extracts the text, and
// classifies the output by string signature (handlers never throw — they
// return in-band `Error:`/`No symbol`/`(none)` text, so status is matched
// from the text, not caught).

import type { ToolCallRecord } from './types.js';

interface ToolResponseLike {
  content: Array<{ type: string; text: string }>;
}

const PREVIEW_CHARS = 1500;

// In-band error responses START with `Error: ` (optionally after the
// indexing banner; the harness always indexes fully first, so the banner
// is normally absent). Anchoring to the response start matters: a
// mid-text match would misclassify any get_context whose Body source
// contains a column-0 'Error: ' line (CLI usage strings, error tables).
function detectError(text: string): boolean {
  return /^(?:⏳[^\n]*\n\n)?Error: /.test(text);
}

// A valid call that found no primary result (distinct from an error). Each
// signature is a literal the handlers emit. Note overview renders its
// empty marker as a list item ('- (no source files indexed)').
function detectEmpty(text: string): boolean {
  return (
    /(^|\n)No symbol '[^']*' found\.?/.test(text) ||
    /(^|\n)No matches for '/.test(text) ||
    /(^|\n)No structural matches for pattern '/.test(text) ||
    /(^|\n)- \(no source files indexed\)/.test(text)
  );
}

// Heuristic flags consumed by the report's gap scan.
function collectNotes(text: string): string[] {
  const notes: string[] = [];
  if (text.includes('Did you mean:')) notes.push('fuzzy-suggestions');
  if (/Sections from `[^`]+` onward omitted/.test(text)) notes.push('token-truncated');
  if (text.includes('[member call, unverified]')) notes.push('member-call-callers');
  if (text.includes('[name match, unverified]')) notes.push('name-match-callers');
  if (text.includes('(none — ships with LSP in Phase 2)')) notes.push('phase2-stub');
  if (text.includes('Structural patterns are not supported')) notes.push('pattern-lang-unsupported');
  if (/\(stopped after scanning \d+ files/.test(text)) notes.push('pattern-file-cap');
  if (text.includes('(File is not in the index')) notes.push('file-not-indexed');
  if (text.includes('### Co-change Partners')) notes.push('co-change');
  if (text.includes('### Hotspots')) notes.push('hotspots');
  if (text.includes('### Recent Changes')) notes.push('recent-changes');
  if (/- \(\d+ more omitted/.test(text)) notes.push('limit-truncated');
  return notes;
}

export async function captureCall(
  tool: string,
  args: Record<string, unknown>,
  provenance: string,
  fn: () => Promise<ToolResponseLike>,
): Promise<ToolCallRecord> {
  const t0 = performance.now();
  let text: string;
  try {
    const res = await fn();
    text = res.content.map((c) => c.text).join('\n');
  } catch (err) {
    // A handler throwing is itself a finding (the contract says they don't).
    text = `HARNESS-CAUGHT THROW: ${err instanceof Error ? err.stack ?? err.message : String(err)}`;
  }
  const wallMs = performance.now() - t0;
  const isError = text.startsWith('HARNESS-CAUGHT THROW') || detectError(text);
  const isEmpty = detectEmpty(text);
  const notes = collectNotes(text);
  if (text.startsWith('HARNESS-CAUGHT THROW')) notes.push('handler-threw');
  return {
    tool,
    args,
    provenance,
    ok: !isError && !isEmpty,
    isError,
    isEmpty,
    bytes: Buffer.byteLength(text),
    estTokens: Math.ceil(text.length / 4),
    wallMs,
    notes,
    textPreview: text.slice(0, PREVIEW_CHARS),
    fullText: text,
  };
}
