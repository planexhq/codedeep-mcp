// Three practical sanity checks where no perfect external oracle exists:
//   (1) re-findability round-trip — every symbol the harness SELECTED from
//       the index must be returnable by find_symbol exact; a miss is an
//       internal inconsistency (selection read it from the same index).
//   (2) per-file symbol-id uniqueness — round-trip is structurally blind to
//       id collisions (a collided symbol still finds *a* symbol), but two
//       symbols sharing an id merge their reference graphs (JG1: capped-
//       signature hashing collided long overloads), so check ids directly.
//   (3) coarse extraction density — per language, compare probe's symbol
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
  java: '*.java',
  go: '*.go',
  rust: '*.rs',
  swift: '*.swift',
  kotlin: '*.{kt,kts}',
  dart: '*.dart',
  csharp: '*.cs',
  php: '*.php',
};

const DECL_RE: Record<string, string> = {
  typescript: '^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?(async\\s+)?(function|class|interface|type|enum)\\s',
  tsx: '^\\s*(export\\s+)?(default\\s+)?(declare\\s+)?(abstract\\s+)?(async\\s+)?(function|class|interface|type|enum)\\s',
  javascript: '^\\s*(export\\s+)?(default\\s+)?(async\\s+)?(function|class)\\s',
  python: '^\\s*(async\\s+)?(def|class)\\s',
  // Type declarations only — probe also extracts methods/fields, so the
  // probe/naive ratio runs well above 1 for Java (info-only, same accepted
  // skew as TS; suspicious fires only on symbols === 0).
  java: '^\\s*((public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\\s+)*(class|interface|enum|record|@interface)\\s',
  // Top-level decl keywords only — probe also extracts struct fields and
  // interface members (one symbol per NAME in grouped specs), so the ratio
  // runs above 1 like Java's; suspicious fires only on symbols === 0.
  go: '^\\s*(func|type|const|var)\\s',
  // Top-level decl keywords only — probe also extracts struct/union fields,
  // trait/impl members, and recurses modules, so the ratio runs above 1 like
  // Java's/Go's; suspicious fires only on symbols === 0.
  rust: '^\\s*(pub(\\([^)]*\\))?\\s+)?(async\\s+)?(unsafe\\s+)?(fn|struct|enum|trait|impl|type|const|static|union|mod|macro_rules!)\\s',
  // Top-level decl keywords only — probe also extracts members (methods,
  // properties, extension methods keyed apart), so the ratio runs above 1
  // like Java's/Go's/Rust's; suspicious fires only on symbols === 0.
  swift: '^\\s*((public|private|internal|fileprivate|open|final|indirect)\\s+)*(class|struct|actor|enum|protocol|extension|func|typealias)\\s',
  // Top-level type/function decl keywords only — `val`/`var` are excluded
  // because they overwhelmingly match LOCAL variables (which probe never
  // extracts), which would invert the ratio. probe also extracts members
  // (methods, properties, primary-ctor val/var, extension methods keyed
  // apart), so the ratio runs above 1 like Java's/Go's/Swift's; suspicious
  // fires only on symbols === 0.
  kotlin: '^\\s*((public|private|internal|protected|open|final|abstract|sealed|data|enum|annotation|value|inner|companion|override|inline|infix|operator|suspend|external|tailrec|expect|actual)\\s+)*(class|interface|object|fun|typealias)\\s',
  // Top-level type-decl keywords only — bare `var`/`final`/`const`/`late` are
  // excluded (overwhelmingly LOCAL variables/fields, which would invert the
  // ratio), and `import`/`part` directives are excluded. Top-level FUNCTIONS
  // have no leading keyword (they start with a return type) so they're
  // intentionally unmatched. probe also extracts methods/fields/named-ctors and
  // mixin/extension-merged members, so the ratio runs above 1 like the others;
  // suspicious fires only on symbols === 0.
  dart: '^\\s*(abstract\\s+|base\\s+|final\\s+|sealed\\s+|interface\\s+)*(mixin\\s+)?(class|mixin|extension|enum|typedef)\\s',
  // Top-level type-decl keywords only — probe also extracts methods/properties/
  // fields/ctors and extension methods keyed apart, so the ratio runs above 1
  // like Java's/Kotlin's; suspicious fires only on symbols === 0. `record` is
  // matched bare and as `record struct`/`record class`.
  csharp: '^\\s*((public|private|protected|internal|partial|abstract|sealed|static|new|readonly|ref|file|unsafe|required)\\s+)*(class|struct|interface|enum|record|delegate)\\s',
  php: '^\\s*((abstract|final|readonly)\\s+)*(class|interface|trait|enum|function)\\s',
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

  // (2) per-file symbol-id uniqueness (cross-file collisions are practically
  // impossible — the file path is part of the 64-bit-truncated hash input,
  // so only a birthday collision on the truncated digest could cross files)
  let dupCount = 0;
  const dupSamples: string[] = [];
  for (const fi of env.index.getAllFiles()) {
    const seen = new Map<string, string>();
    for (const s of env.index.getSymbolsInFile(fi.path)) {
      const prev = seen.get(s.id);
      if (prev !== undefined) {
        dupCount++;
        if (dupSamples.length < 5) {
          dupSamples.push(`${s.id} shared by ${prev} and ${s.fqn}:${s.startLine} in ${fi.path}`);
        }
      } else {
        seen.set(s.id, s.fqn);
      }
    }
  }
  out.push({
    oracle: 'symbol-sanity',
    target: 'symbol-id uniqueness (per file)',
    verdict: dupCount > 0 ? 'suspicious' : 'clean',
    detail:
      dupCount > 0
        ? `${dupCount} duplicate symbol id(s) within single files — those symbols' reference graphs are merged`
        : 'no duplicate symbol ids within any file',
    data: dupCount > 0 ? { dupCount, samples: dupSamples } : undefined,
  });

  // (3) per-language density
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
