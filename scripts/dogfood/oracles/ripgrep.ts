// find_references caller oracle. probe's caller list is an APPROXIMATE
// name match (rows tagged [unverified]); ripgrep with a word-boundary
// fixed-string search yields a SUPERSET of call sites (it also hits
// definitions, comments, strings, type positions, homonyms). So the sound
// relationship is containment: probe's caller FILES should be a subset of
// rg's. A file probe reports that rg never sees is the red flag worth
// surfacing; an rg file probe omits is expected (import-scoped out, or a
// non-call match) and reported only as info.

import { SHORT_NAME_THRESHOLD } from '../../../src/indexer/code-index.js';
import { RG_PROBE_EXCLUDES, tryExec } from './exec.js';
import type { OracleResult } from '../types.js';

const CODE_GLOB = '*.{ts,tsx,js,jsx,mjs,cjs,py,java,go,rs,swift,kt,kts}';

// rg's file set must be a SUPERSET of probe's or containment is unsound:
// --hidden (probe indexes hidden dirs like trpc's examples/.test) and
// --no-ignore (probe never reads .gitignore/.ignore/global ignores — a
// tracked-but-ignored source file would otherwise be invisible to rg and
// flag probe's legitimate caller as a false positive). The shared exclude
// globs mirror probe's DEFAULT_EXCLUDES so the superset stays fair.
function rgFiles(repoDir: string, name: string): string[] | null {
  const args = ['-l', '-w', '-F', name, '--hidden', '--no-ignore', '-g', CODE_GLOB];
  for (const ex of RG_PROBE_EXCLUDES) args.push('-g', ex);
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
  const probeFiles = parseCallerFiles(outputText);
  const rg = rgFiles(repoDir, symbolName);
  if (rg === null) {
    return { oracle: 'ripgrep', target, verdict: 'skipped', detail: 'ripgrep invocation failed' };
  }
  const rgSet = new Set(rg);
  const probeOnly = [...probeFiles].filter((f) => !rgSet.has(f));
  const rgOnly = [...rgSet].filter((f) => !probeFiles.has(f));

  if (probeFiles.size === 0) {
    return {
      oracle: 'ripgrep',
      target,
      verdict: 'info',
      detail: `probe reported 0 caller files; rg sees the name in ${rgSet.size} file(s)`,
      data: { probe: 0, rg: rgSet.size, rgOnlySample: rgOnly.slice(0, 8) },
    };
  }
  const verdict = probeOnly.length > 0 ? 'suspicious' : 'clean';
  return {
    oracle: 'ripgrep',
    target,
    verdict,
    detail:
      verdict === 'clean'
        ? `all ${probeFiles.size} probe caller files are within rg's ${rgSet.size}; ${rgOnly.length} rg-only (expected: non-call/scoped-out)`
        : `${probeOnly.length} probe caller file(s) NOT seen by rg — investigate`,
    data: {
      probeFiles: probeFiles.size,
      rgFiles: rgSet.size,
      probeOnly,
      rgOnlyCount: rgOnly.length,
    },
  };
}
