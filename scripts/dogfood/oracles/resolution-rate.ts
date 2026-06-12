// Resolution-rate oracle (Java).
//
// Productizes the by-hand measurement: what fraction of a repo's Java call
// references the extractor resolves at extract time, split by call form. This
// is the per-repo signal that makes resolution QUALITY visible — the existing
// oracles only check that resolved edges aren't wrong, never how many calls
// resolve at all.
//
//   bare   (receiver omitted)  -> implicit-this `foo()` and `new X()`
//   member (receiver present)  -> `obj.x()`, `this.x()`, `Class.static()`
//
// Member resolution is expected to be LOW (cross-file receivers are
// unresolvable without type info — by design), so it's reported as info.
// Bare resolution near 0% on a repo with real intra-class calls would mean
// the implicit-this path broke, so that one case escalates to suspicious.

import type { HarnessEnv } from '../harness-env.js';
import type { OracleResult } from '../types.js';
import type { Symbol } from '../../../src/types.js';

const MIN_BARE_FOR_VERDICT = 50; // below this, a 0% rate isn't signal

export function resolutionRateOracle(env: HarnessEnv): OracleResult[] {
  const kindById = new Map<string, string>();
  for (const file of env.index.getAllFiles()) {
    for (const sym of env.index.getSymbolsInFile(file.path)) kindById.set(sym.id, sym.kind);
  }

  let bareTotal = 0;
  let bareResolved = 0;
  let memberTotal = 0;
  let memberResolved = 0;
  const resolvedBareByKind: Record<string, number> = {};

  for (const file of env.index.getAllFiles()) {
    if (file.language !== 'java') continue;
    for (const ref of env.index.getReferencesBySourceFile(file.path)) {
      if (ref.kind !== 'calls') continue;
      const isMember = ref.receiver !== undefined;
      const resolved = ref.targetId !== null;
      if (isMember) {
        memberTotal++;
        if (resolved) memberResolved++;
      } else {
        bareTotal++;
        if (resolved) {
          bareResolved++;
          const k = kindById.get(ref.targetId as string) ?? 'unknown';
          resolvedBareByKind[k] = (resolvedBareByKind[k] ?? 0) + 1;
        }
      }
    }
  }

  if (bareTotal === 0 && memberTotal === 0) {
    return [
      {
        oracle: 'resolution-rate',
        target: 'Java call resolution',
        verdict: 'skipped',
        detail: 'no Java call references in this repo',
      },
    ];
  }

  const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);
  const bareSuspicious = bareTotal >= MIN_BARE_FOR_VERDICT && bareResolved === 0;

  return [
    {
      oracle: 'resolution-rate',
      target: 'bare call resolution (implicit-this + new X)',
      verdict: bareSuspicious ? 'suspicious' : 'info',
      detail:
        `${bareResolved}/${bareTotal} bare calls resolved (${pct(bareResolved, bareTotal)})` +
        ` — by target kind ${JSON.stringify(resolvedBareByKind)}`,
      data: { bareResolved, bareTotal, resolvedBareByKind },
    },
    {
      oracle: 'resolution-rate',
      target: 'member call resolution (obj.x / Class.static)',
      verdict: 'info',
      detail: `${memberResolved}/${memberTotal} member calls resolved (${pct(memberResolved, memberTotal)}) — low is by design (cross-file receivers unresolved)`,
      data: { memberResolved, memberTotal },
    },
  ];
}
