// Resolved-edge correctness oracle (Java).
//
// The extractor resolves a call ref's targetId at extract time. For Java the
// engine is configured so a resolved `calls` ref can ONLY point at a method
// (bare implicit-this / this.x() / Class.static()), a class, or an interface
// (`new X()` / anonymous `new Iface(){}`). It must NEVER point at a field
// ('variable'), enum, type, module, or top-level function — those are not
// invocable as a call in Java, so a resolved edge to one is a confidently
// WRONG graph edge (the exact bug class round 1 found: bare calls misbinding
// to same-name fields via nameToId).
//
// This is a standing regression guard for that class. It needs no external
// tooling: the invariant is checkable from the index alone, and any violation
// is a real extractor bug, not a heuristic warning.

import type { HarnessEnv } from '../harness-env.js';
import type { OracleResult } from '../types.js';
import type { Symbol } from '../../../src/types.js';

// Kinds a resolved Java call ref is allowed to point at.
const ALLOWED_TARGET_KINDS = new Set(['method', 'class', 'interface']);
const SAMPLE_CAP = 10;

export function resolvedEdgeOracle(env: HarnessEnv): OracleResult[] {
  const symbolById = new Map<string, Symbol>();
  for (const file of env.index.getAllFiles()) {
    for (const sym of env.index.getSymbolsInFile(file.path)) symbolById.set(sym.id, sym);
  }

  let javaResolved = 0;
  const violations: string[] = [];
  for (const file of env.index.getAllFiles()) {
    if (file.language !== 'java') continue;
    for (const ref of env.index.getReferencesBySourceFile(file.path)) {
      if (ref.kind !== 'calls' || ref.targetId === null) continue;
      javaResolved++;
      const target = symbolById.get(ref.targetId);
      // A targetId that resolves to no symbol is itself a violation (dangling
      // edge); an unexpected kind is the field-misbind class.
      if (!target || !ALLOWED_TARGET_KINDS.has(target.kind)) {
        if (violations.length < SAMPLE_CAP) {
          const where = `${ref.file}:${ref.line}`;
          const got = target ? `${target.kind} ${target.fqn}` : 'DANGLING (no symbol)';
          violations.push(`${ref.targetName}() @ ${where} -> ${got}`);
        }
      }
    }
  }

  if (javaResolved === 0) {
    return [
      {
        oracle: 'resolved-edge',
        target: 'resolved Java call edges',
        verdict: 'skipped',
        detail: 'no resolved Java call references in this repo',
      },
    ];
  }

  const bad = violations.length;
  return [
    {
      oracle: 'resolved-edge',
      target: 'resolved Java call edges',
      verdict: bad > 0 ? 'suspicious' : 'clean',
      detail:
        bad > 0
          ? `${bad}+ resolved Java refs point at a non-callable target (field/enum/dangling) — wrong graph edges`
          : `all ${javaResolved} resolved Java call edges target method/class/interface`,
      data: bad > 0 ? { javaResolved, violations } : { javaResolved },
    },
  ];
}
