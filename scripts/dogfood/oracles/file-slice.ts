// get_context Body oracle — the one EXACT check. The Body section renders
// content.split('\n').slice(startLine-1, endLine).join('\n') of the real
// file. We independently re-read and re-slice; the result must appear
// verbatim inside the output. A mismatch means disk-vs-index drift or
// render-pipeline corruption (wrong file read, dropped lines, truncation
// cutting the body). Coverage limitation: the slice formula here is
// deliberately IDENTICAL to renderBody's, so a systematic off-by-one in
// that shared formula would pass — this oracle checks the pipeline, not
// the formula. (Body is never dropped by the token budget, so it's always
// fully present when the file was readable.)

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
  const slice = lines.slice(start, end).join('\n');
  const contained = outputText.includes(slice);
  const hasCR = slice.includes('\r');
  if (!contained) {
    return {
      oracle: 'file-slice',
      target,
      verdict: 'mismatch',
      detail: 'rendered Body does not match the file slice at the symbol range (line drift?)',
      data: { sliceFirstLine: lines[start] ?? '', sliceLen: slice.length },
    };
  }
  return {
    oracle: 'file-slice',
    target,
    verdict: hasCR ? 'info' : 'clean',
    detail: hasCR
      ? 'Body matches the file slice but carries CRLF \\r — stray carriage returns in output'
      : 'Body matches the file slice exactly',
  };
}
