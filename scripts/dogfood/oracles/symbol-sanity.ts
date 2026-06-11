// Two practical sanity checks where no perfect external oracle exists:
//   (1) re-findability round-trip — every symbol the harness SELECTED from
//       the index must be returnable by find_symbol exact; a miss is an
//       internal inconsistency (selection read it from the same index).
//   (2) coarse extraction density — per language, compare probe's symbol
//       count against a naive declaration grep. Exactness is impossible
//       (probe skips nested defs, counts arrow-consts, etc.), so this only
//       flags CATASTROPHIC under-extraction (a grammar that silently
//       failed) and otherwise reports the ratio as info.

import type { HarnessEnv } from '../harness-env.js';
import type { Selection } from '../input-selection.js';
import { rgCountLines } from './exec.js';
import type { OracleResult } from '../types.js';

const LANG_GLOB: Record<string, string> = {
  typescript: '*.ts',
  tsx: '*.tsx',
  javascript: '*.{js,jsx,mjs,cjs}',
  python: '*.py',
};

const DECL_RE: Record<string, string> = {
  typescript: '^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?(async\\s+)?(function|class|interface|type|enum)\\s',
  tsx: '^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?(async\\s+)?(function|class|interface|type|enum)\\s',
  javascript: '^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function|class)\\s',
  python: '^\\s*(async\\s+)?(def|class)\\s',
};

// null = rg unusable on this machine; the density check is skipped rather
// than reported as a zero baseline.
function naiveDeclCount(repoDir: string, lang: string): number | null {
  const glob = LANG_GLOB[lang];
  const re = DECL_RE[lang];
  if (!glob || !re) return 0;
  return rgCountLines(repoDir, re, glob);
}

export function symbolSanityOracle(
  env: HarnessEnv,
  repoDir: string,
  sel: Selection,
): OracleResult[] {
  const out: OracleResult[] = [];

  // (1) round-trip
  const seen = new Set<string>();
  const sample = [...sel.topReferenced, ...sel.findSymbolTargets, ...Object.values(sel.byKind).flat()].filter(
    (s) => (seen.has(s.id) ? false : (seen.add(s.id), true)),
  );
  const missing: string[] = [];
  for (const s of sample) {
    const found = env.index.findSymbolByName(s.name).some((x) => x.id === s.id);
    if (!found) missing.push(`${s.name} (${s.kind}, ${s.file}:${s.startLine})`);
  }
  out.push({
    oracle: 'symbol-sanity',
    target: 're-findability round-trip',
    verdict: missing.length > 0 ? 'mismatch' : 'clean',
    detail:
      missing.length > 0
        ? `${missing.length}/${sample.length} selected symbols NOT re-findable by find_symbol`
        : `all ${sample.length} selected symbols re-findable by find_symbol exact`,
    data: missing.length > 0 ? { missing: missing.slice(0, 10) } : undefined,
  });

  // (2) per-language density
  const perLangSymbols = new Map<string, number>();
  const perLangFiles = new Map<string, number>();
  for (const fi of env.index.getAllFiles()) {
    perLangFiles.set(fi.language, (perLangFiles.get(fi.language) ?? 0) + 1);
    perLangSymbols.set(
      fi.language,
      (perLangSymbols.get(fi.language) ?? 0) + env.index.getSymbolsInFile(fi.path).length,
    );
  }
  for (const [lang, symbols] of perLangSymbols) {
    if (lang === 'unknown') continue;
    const files = perLangFiles.get(lang) ?? 0;
    const naive = naiveDeclCount(repoDir, lang);
    if (naive === null) {
      out.push({
        oracle: 'symbol-sanity',
        target: `extraction density (${lang})`,
        verdict: 'skipped',
        detail: 'ripgrep unavailable — no baseline to compare against',
      });
      continue;
    }
    const ratio = naive > 0 ? symbols / naive : null;
    const verdict: OracleResult['verdict'] =
      files > 5 && symbols === 0 ? 'suspicious' : 'info';
    out.push({
      oracle: 'symbol-sanity',
      target: `extraction density (${lang})`,
      verdict,
      detail:
        `${symbols} symbols across ${files} files; naive decl grep ~${naive}` +
        (ratio !== null ? ` (probe/naive=${ratio.toFixed(2)})` : ''),
      data: { symbols, files, naive },
    });
  }

  return out;
}
