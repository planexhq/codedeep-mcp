// get_context Body oracle — the one EXACT check. The Body section renders
// content.split('\n').slice(startLine-1, endLine), strips each line's
// trailing CR, then joins on '\n'. We independently re-read and re-slice
// the SAME way; the result must appear verbatim inside the output. A
// mismatch means disk-vs-index drift or render-pipeline corruption (wrong
// file read, dropped lines, truncation cutting the body). Coverage
// limitation: the slice formula here is deliberately IDENTICAL to
// renderBody's, so a systematic off-by-one in that shared formula would
// pass — this oracle checks the pipeline, not the formula. The trailing-CR
// strip MUST mirror renderBody: without it a CRLF-authored source slices to
// '\r'-laden lines that renderBody no longer emits, fabricating a mismatch.
// (Body is never dropped by the token budget, so it's always fully present
// when the file was readable.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OracleResult } from '../types.js';

export function fileSliceOracle(
  repoDir: string,
  file: string,
  startLine: number,
  endLine: number,
  outputText: string,
): OracleResult {
  const target = `get_context Body of ${file}:${startLine}-${endLine}`;
  // get_context only renders a Body when the name resolves to exactly one
  // symbol. For an ambiguous name (no `line`) it returns a disambiguation
  // message, and for a miss a "No symbol" line — neither is a body, so the
  // slice check doesn't apply.
  if (!outputText.includes('### Body')) {
    return {
      oracle: 'file-slice',
      target,
      verdict: 'skipped',
      detail: outputText.includes('Multiple symbols named')
        ? 'ambiguous name — get_context returned disambiguation, not a body (correct behavior)'
        : 'output has no ### Body section (not-found/error)',
    };
  }
  // The tool's read-failure branch renders '### Body\n(unable to read …)'
  // — a correct degradation (symlink refusal, transient EMFILE), not line
  // drift; comparing a slice against it would fabricate a mismatch.
  if (outputText.includes('### Body\n(unable to read ')) {
    return {
      oracle: 'file-slice',
      target,
      verdict: 'skipped',
      detail: 'get_context could not read the file (in-band degradation) — no body to compare',
    };
  }
  let content: string;
  try {
    content = readFileSync(join(repoDir, file), 'utf8');
  } catch (err) {
    return {
      oracle: 'file-slice',
      target,
      verdict: 'skipped',
      detail: `could not read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const lines = content.split('\n');
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  // Mirror renderBody's per-line trailing-CR strip (see header comment).
  const sliceLines = lines
    .slice(start, end)
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const slice = sliceLines.join('\n');
  const contained = outputText.includes(slice);
  // A trailing-CR strip already ran, so a surviving '\r' is an embedded or
  // lone (non-CRLF) carriage return, never a normal CRLF line ending.
  const hasCR = slice.includes('\r');
  if (!contained) {
    return {
      oracle: 'file-slice',
      target,
      verdict: 'mismatch',
      detail: 'rendered Body does not match the file slice at the symbol range (line drift?)',
      // Report the first line of the COMPARED (stripped) slice, not the raw
      // line — otherwise a CRLF source shows a phantom '\r' the check never used.
      data: { sliceFirstLine: sliceLines[0] ?? '', sliceLen: slice.length },
    };
  }
  return {
    oracle: 'file-slice',
    target,
    verdict: hasCR ? 'info' : 'clean',
    detail: hasCR
      ? 'Body matches the file slice but carries an embedded/lone \\r (non-CRLF carriage return) in output'
      : 'Body matches the file slice exactly',
  };
}
