// Resolved-edge correctness oracle (per extract-time-resolving language).
//
// The extractor resolves a call ref's targetId at extract time. Each
// language's engine config bounds what a resolved `calls` ref may point at;
// anything outside that set is a confidently WRONG graph edge (the exact
// bug class round 1 found: bare calls misbinding to same-name fields via
// nameToId).
//
//   java  method (bare implicit-this / this.x() / Class.static()),
//         class/interface (`new X()`, anonymous `new Iface(){}`) — never a
//         field, enum, type, module, or top-level function.
//   go    function (bare same-file calls incl. `var f = func(){}`),
//         method (receiver self-calls, method expressions), class/type
//         (composite literals `X{}` / named map-slice types) — never a
//         plain variable, interface, or module.
//
// This is a standing regression guard for that class. It needs no external
// tooling: the invariant is checkable from the index alone, and any
// violation is a real extractor bug, not a heuristic warning.

import type { HarnessEnv } from '../harness-env.js';
import type { OracleResult } from '../types.js';
import type { Symbol } from '../../../src/types.js';
import { ALLOWED_TARGET_KINDS, RESOLVING_LANGS } from './resolving-langs.js';

const SAMPLE_CAP = 10;

export function resolvedEdgeOracle(env: HarnessEnv): OracleResult[] {
  const symbolById = new Map<string, Symbol>();
  for (const file of env.index.getAllFiles()) {
    for (const sym of env.index.getSymbolsInFile(file.path)) symbolById.set(sym.id, sym);
  }

  const results: OracleResult[] = [];
  for (const [lang, allowed] of Object.entries(ALLOWED_TARGET_KINDS)) {
    const files = env.index.getAllFiles().filter((f) => f.language === lang);
    if (files.length === 0) continue;

    let resolved = 0;
    const violations: string[] = [];
    for (const file of files) {
      for (const ref of env.index.getReferencesBySourceFile(file.path)) {
        if (ref.kind !== 'calls' || ref.targetId === null) continue;
        resolved++;
        const target = symbolById.get(ref.targetId);
        // A targetId that resolves to no symbol is itself a violation
        // (dangling edge); an unexpected kind is the field-misbind class.
        if (!target || !allowed.has(target.kind)) {
          if (violations.length < SAMPLE_CAP) {
            const where = `${ref.file}:${ref.line}`;
            const got = target ? `${target.kind} ${target.fqn}` : 'DANGLING (no symbol)';
            violations.push(`${ref.targetName}() @ ${where} -> ${got}`);
          }
        }
      }
    }

    if (resolved === 0) {
      results.push({
        oracle: 'resolved-edge',
        target: `resolved ${lang} call edges`,
        verdict: 'skipped',
        detail: `no resolved ${lang} call references in this repo`,
      });
      continue;
    }

    const bad = violations.length;
    results.push({
      oracle: 'resolved-edge',
      target: `resolved ${lang} call edges`,
      verdict: bad > 0 ? 'suspicious' : 'clean',
      detail:
        bad > 0
          ? `${bad}+ resolved ${lang} refs point at a disallowed target kind — wrong graph edges`
          : `all ${resolved} resolved ${lang} call edges target ${[...allowed].join('/')}`,
      data: bad > 0 ? { resolved, violations } : { resolved },
    });
  }

  if (results.length === 0) {
    return [
      {
        oracle: 'resolved-edge',
        target: 'resolved call edges',
        verdict: 'skipped',
        detail: `no files in extract-time-resolving languages (${RESOLVING_LANGS.join(', ')})`,
      },
    ];
  }
  return results;
}
