// find_references caller oracle. codedeep's caller list is an APPROXIMATE
// name match (rows tagged [unverified]); ripgrep with a word-boundary
// fixed-string search yields a SUPERSET of call sites (it also hits
// definitions, comments, strings, type positions, homonyms). So the sound
// relationship is containment: codedeep's caller FILES should be a subset of
// rg's. A file codedeep reports that rg never sees is the red flag worth
// surfacing; an rg file codedeep omits is expected (import-scoped out, or a
// non-call match) and reported only as info.

import { SHORT_NAME_THRESHOLD } from '../../../src/indexer/code-index.js';
import { RG_CODEDEEP_EXCLUDES, tryExec } from './exec.js';
import type { OracleResult } from '../types.js';

const CODE_GLOB = '*.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs,swift,kt,kts,dart,cs,php}';

// rg's file set must be a SUPERSET of codedeep's or containment is unsound:
// --hidden (codedeep indexes hidden dirs like trpc's examples/.test) and
// --no-ignore (codedeep never reads .gitignore/.ignore/global ignores — a
// tracked-but-ignored source file would otherwise be invisible to rg and
// flag codedeep's legitimate caller as a false positive). The shared exclude
// globs mirror codedeep's DEFAULT_EXCLUDES so the superset stays fair.
function rgFiles(repoDir: string, name: string): string[] | null {
  const args = ['-l', '-w', '-F', name, '--hidden', '--no-ignore', '-g', CODE_GLOB];
  for (const ex of RG_CODEDEEP_EXCLUDES) args.push('-g', ex);
  args.push('.');
  const { stdout, status } = tryExec('rg', args, repoDir);
  if (status === 1) return []; // no matches
  if (status !== 0) return null; // rg failed
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ''));
}

// Pull caller file paths out of the "### Callers" section only.
function parseCallerFiles(text: string): Set<string> {
  const files = new Set<string>();
  const start = text.indexOf('### Callers');
  if (start === -1) return files;
  const after = text.slice(start);
  const nextHeader = after.indexOf('\n### ', 4);
  const section = nextHeader === -1 ? after : after.slice(0, nextHeader);
  for (const line of section.split('\n')) {
    const m = line.match(/^- (.+?):(\d+) — /);
    if (m) files.add(m[1]);
  }
  return files;
}

export function ripgrepCallerOracle(
  repoDir: string,
  symbolName: string,
  outputText: string,
): OracleResult {
  const target = `find_references callers of '${symbolName}'`;
  if (symbolName.length < SHORT_NAME_THRESHOLD) {
    return {
      oracle: 'ripgrep',
      target,
      verdict: 'skipped',
      detail: `name shorter than SHORT_NAME_THRESHOLD (${SHORT_NAME_THRESHOLD}); rg comparison is pure noise`,
    };
  }
  // find_references returns a disambiguation message (no Callers section)
  // for an ambiguous name; that's correct behavior, not a 0-caller result,
  // so the containment check doesn't apply.
  if (!outputText.includes('### Callers')) {
    return {
      oracle: 'ripgrep',
      target,
      verdict: 'skipped',
      detail: outputText.includes('Multiple symbols named')
        ? 'ambiguous name — find_references returned disambiguation, not callers (correct behavior)'
        : 'output has no ### Callers section',
    };
  }
  const codedeepFiles = parseCallerFiles(outputText);
  const rg = rgFiles(repoDir, symbolName);
  if (rg === null) {
    return { oracle: 'ripgrep', target, verdict: 'skipped', detail: 'ripgrep invocation failed' };
  }
  const rgSet = new Set(rg);
  const codedeepOnly = [...codedeepFiles].filter((f) => !rgSet.has(f));
  const rgOnly = [...rgSet].filter((f) => !codedeepFiles.has(f));

  if (codedeepFiles.size === 0) {
    return {
      oracle: 'ripgrep',
      target,
      verdict: 'info',
      detail: `codedeep reported 0 caller files; rg sees the name in ${rgSet.size} file(s)`,
      data: { codedeep: 0, rg: rgSet.size, rgOnlySample: rgOnly.slice(0, 8) },
    };
  }
  const verdict = codedeepOnly.length > 0 ? 'suspicious' : 'clean';
  return {
    oracle: 'ripgrep',
    target,
    verdict,
    detail:
      verdict === 'clean'
        ? `all ${codedeepFiles.size} codedeep caller files are within rg's ${rgSet.size}; ${rgOnly.length} rg-only (expected: non-call/scoped-out)`
        : `${codedeepOnly.length} codedeep caller file(s) NOT seen by rg — investigate`,
    data: {
      codedeepFiles: codedeepFiles.size,
      rgFiles: rgSet.size,
      codedeepOnly,
      rgOnlyCount: rgOnly.length,
    },
  };
}
