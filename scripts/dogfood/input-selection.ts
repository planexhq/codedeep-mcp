// The feedback loop: for an arbitrary repo we don't know symbol names a
// priori, so we mine the index codedeep-mcp just built for high-value inputs
// and feed them back into the tools. Every selection carries provenance so
// an empty result on a top-referenced symbol reads as a finding, not noise.

import type { CodeIndex } from '../../src/indexer/code-index.js';
import { SHORT_NAME_THRESHOLD } from '../../src/indexer/code-index.js';
import type { IndexStats, Symbol, SymbolKind } from '../../src/types.js';

export interface SelectedSymbol {
  id: string;
  name: string;
  file: string;
  kind: SymbolKind;
  exported: boolean;
  startLine: number;
  endLine: number;
  language: string;
  signature: string;
  doc: string | null;
  callerCount: number;
  bucket: string;
}

export interface Selection {
  // Most-referenced (callerCount desc), names >= SHORT_NAME_THRESHOLD — the
  // only inputs worth the ripgrep oracle.
  topReferenced: SelectedSymbol[];
  findSymbolTargets: SelectedSymbol[];
  getContextSymbolTargets: SelectedSymbol[];
  fileModeTargets: string[];
  findRefTargets: SelectedSymbol[];
  patternSymbols: SelectedSymbol[];
  byKind: Record<string, SelectedSymbol[]>;
  byLanguage: Record<string, SelectedSymbol[]>;
  queryTerms: Array<{ term: string; from: string }>;
}

// mulberry32 — deterministic, seedable; sorting handles the rest.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toSelected(sym: Symbol, callerCount: number, bucket: string): SelectedSymbol {
  return {
    id: sym.id,
    name: sym.name,
    file: sym.file,
    kind: sym.kind,
    exported: sym.exported,
    startLine: sym.startLine,
    endLine: sym.endLine,
    language: sym.language,
    signature: sym.signature,
    doc: sym.doc,
    callerCount,
    bucket,
  };
}

const TS_LANGS = new Set(['typescript', 'tsx', 'javascript']);
const KINDS: SymbolKind[] = ['function', 'class', 'interface', 'type', 'variable', 'method', 'module', 'enum'];

function dedupById(syms: SelectedSymbol[]): SelectedSymbol[] {
  const seen = new Set<string>();
  const out: SelectedSymbol[] = [];
  for (const s of syms) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// Longest alphabetic word (>= 4 chars) in a docstring — a salient query
// keyword that exercises doc-field matching in search_structure.
function salientWord(doc: string): string | null {
  const words = doc.match(/[A-Za-z][A-Za-z]{3,}/g);
  if (!words) return null;
  let best: string | null = null;
  for (const w of words) {
    const lw = w.toLowerCase();
    if (['this', 'that', 'with', 'from', 'when', 'then', 'true', 'false', 'null', 'returns', 'return', 'param', 'value'].includes(lw)) {
      continue;
    }
    if (!best || w.length > best.length) best = w;
  }
  return best;
}

export function selectInputs(index: CodeIndex, stats: IndexStats, seed: number): Selection {
  const files = index.getAllFiles();
  const corpus: Array<{ sym: Symbol; callerCount: number }> = [];
  for (const fi of files) {
    for (const sym of index.getSymbolsInFile(fi.path)) {
      corpus.push({ sym, callerCount: index.getCallerCount(sym.id) });
    }
  }

  // Stable global ordering by (callerCount desc, name asc, file asc).
  const ranked = [...corpus].sort(
    (a, b) =>
      b.callerCount - a.callerCount ||
      a.sym.name.localeCompare(b.sym.name) ||
      a.sym.file.localeCompare(b.sym.file),
  );

  const topReferenced = dedupById(
    ranked
      .filter((c) => c.callerCount > 0 && c.sym.name.length >= SHORT_NAME_THRESHOLD)
      .slice(0, 12)
      .map((c) => toSelected(c.sym, c.callerCount, 'top-referenced')),
  );

  // Exported public API surface, name-sorted for stability.
  const exported = dedupById(
    corpus
      .filter((c) => c.sym.exported && c.sym.name.length >= 3)
      .sort((a, b) => a.sym.name.localeCompare(b.sym.name) || a.sym.file.localeCompare(b.sym.file))
      .map((c) => toSelected(c.sym, c.callerCount, 'exported')),
  );

  // Stratified by kind: up to 3 per kind, preferring exported.
  const byKind: Record<string, SelectedSymbol[]> = {};
  for (const kind of KINDS) {
    const ofKind = corpus
      .filter((c) => c.sym.kind === kind && c.sym.name.length >= 3)
      .sort(
        (a, b) =>
          Number(b.sym.exported) - Number(a.sym.exported) ||
          b.callerCount - a.callerCount ||
          a.sym.name.localeCompare(b.sym.name),
      )
      .slice(0, 3)
      .map((c) => toSelected(c.sym, c.callerCount, `kind:${kind}`));
    if (ofKind.length > 0) byKind[kind] = ofKind;
  }

  // Stratified by language: up to 4 per language.
  const byLanguage: Record<string, SelectedSymbol[]> = {};
  for (const lang of Object.keys(stats.filesByLanguage)) {
    if (lang === 'unknown') continue;
    const ofLang = corpus
      .filter((c) => c.sym.language === lang && c.sym.name.length >= 3)
      .sort(
        (a, b) =>
          b.callerCount - a.callerCount || a.sym.name.localeCompare(b.sym.name),
      )
      .slice(0, 4)
      .map((c) => toSelected(c.sym, c.callerCount, `lang:${lang}`));
    if (ofLang.length > 0) byLanguage[lang] = ofLang;
  }

  // Seeded random tail across the whole corpus.
  const rand = rng(seed);
  const shuffled = [...corpus]
    .map((c) => ({ c, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, 8)
    .map(({ c }) => toSelected(c.sym, c.callerCount, 'random-tail'));
  const randomTail = dedupById(shuffled);

  // find_symbol gets a diverse target set: top referenced + a slice of
  // exported + one per kind + seeded random-tail leaves (the random slice
  // is what makes --seed actually vary the input set between runs).
  const findSymbolTargets = dedupById([
    ...topReferenced.slice(0, 5),
    ...exported.slice(0, 5),
    ...Object.values(byKind).map((v) => v[0]),
    ...randomTail.slice(0, 2),
  ]).slice(0, 14);

  // get_context: top referenced (rich callers/callees) + exported API +
  // seeded random-tail leaves.
  const getContextSymbolTargets = dedupById([
    ...topReferenced.slice(0, 8),
    ...exported.slice(0, 4),
    ...randomTail.slice(2, 4),
  ]).slice(0, 12);

  // File-mode targets: entry-point files + the files of the top referenced.
  const fileModeTargets = [
    ...new Set([
      ...stats.entryPoints.map((e) => e.file),
      ...topReferenced.map((s) => s.file),
    ]),
  ].slice(0, 6);

  const findRefTargets = topReferenced.slice(0, 10);
  // Pattern synthesis needs a plain identifier — private names (#x) and
  // other non-identifier tokens don't parse as a standalone ast-grep
  // pattern, which probe (correctly) rejects; that's not a probe finding.
  const identRe = /^[A-Za-z_$][\w$]*$/;
  const patternSymbols = topReferenced
    .filter((s) => TS_LANGS.has(s.language) && identRe.test(s.name))
    .slice(0, 6);

  // Query terms: salient docstring words + a few bare exported names.
  const terms = new Map<string, string>();
  for (const c of ranked) {
    if (terms.size >= 6) break;
    if (!c.sym.doc) continue;
    const w = salientWord(c.sym.doc);
    if (w && !terms.has(w.toLowerCase())) terms.set(w.toLowerCase(), `doc:${c.sym.name}`);
  }
  for (const s of exported.slice(0, 4)) {
    if (!terms.has(s.name.toLowerCase())) terms.set(s.name.toLowerCase(), `name:${s.name}`);
  }
  const queryTerms = [...terms.entries()].map(([term, from]) => ({ term, from }));

  return {
    topReferenced,
    findSymbolTargets,
    getContextSymbolTargets,
    fileModeTargets,
    findRefTargets,
    patternSymbols,
    byKind,
    byLanguage,
    queryTerms,
  };
}
