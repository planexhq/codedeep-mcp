// Resolution-rate oracle (per extract-time-resolving language).
//
// Productizes the by-hand measurement: what fraction of a repo's call
// references the extractor resolves at extract time, split by call form.
// This is the per-repo signal that makes resolution QUALITY visible — the
// existing oracles only check that resolved edges aren't wrong, never how
// many calls resolve at all.
//
//   bare   (receiver omitted)  -> java: implicit-this `foo()` and `new X()`
//                                 go: same-file `foo()` and `X{...}` literals
//   member (receiver present)  -> java: `obj.x()`, `this.x()`, `Class.static()`
//                                 go: `recv.x()`, `pkg.F()`, `Type.method(v)`
//
// Java member resolution is expected ~0% (cross-file receivers are
// unresolvable without type info — by design). Go member resolution is
// expected MEANINGFULLY ABOVE zero: receiver self-calls resolve through
// PendingBody.selfReceiverName. Both are reported as info; bare resolution
// near 0% on a repo with real calls escalates to suspicious.

import type { HarnessEnv } from '../harness-env.js';
import type { OracleResult } from '../types.js';
import { RESOLVING_LANGS } from './resolving-langs.js';

const MIN_BARE_FOR_VERDICT = 50; // below this, a 0% rate isn't signal

export function resolutionRateOracle(env: HarnessEnv): OracleResult[] {
  const kindById = new Map<string, string>();
  for (const file of env.index.getAllFiles()) {
    for (const sym of env.index.getSymbolsInFile(file.path)) kindById.set(sym.id, sym.kind);
  }

  const results: OracleResult[] = [];
  for (const lang of RESOLVING_LANGS) {
    const files = env.index.getAllFiles().filter((f) => f.language === lang);
    if (files.length === 0) continue;

    let bareTotal = 0;
    let bareResolved = 0;
    let memberTotal = 0;
    let memberResolved = 0;
    const resolvedBareByKind: Record<string, number> = {};

    for (const file of files) {
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
      results.push({
        oracle: 'resolution-rate',
        target: `${lang} call resolution`,
        verdict: 'skipped',
        detail: `no ${lang} call references in this repo`,
      });
      continue;
    }

    const pct = (n: number, d: number): string =>
      d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`;
    const bareSuspicious = bareTotal >= MIN_BARE_FOR_VERDICT && bareResolved === 0;

    results.push(
      {
        oracle: 'resolution-rate',
        target: `${lang} bare call resolution`,
        verdict: bareSuspicious ? 'suspicious' : 'info',
        detail:
          `${bareResolved}/${bareTotal} bare calls resolved (${pct(bareResolved, bareTotal)})` +
          ` — by target kind ${JSON.stringify(resolvedBareByKind)}`,
        data: { bareResolved, bareTotal, resolvedBareByKind },
      },
      {
        oracle: 'resolution-rate',
        target: `${lang} member call resolution`,
        verdict: 'info',
        detail:
          `${memberResolved}/${memberTotal} member calls resolved (${pct(memberResolved, memberTotal)})` +
          (lang === 'java'
            ? ' — low is by design (cross-file receivers unresolved)'
            : ' — receiver self-calls resolve; other receivers unresolved by design'),
        data: { memberResolved, memberTotal },
      },
    );
  }

  if (results.length === 0) {
    return [
      {
        oracle: 'resolution-rate',
        target: 'call resolution',
        verdict: 'skipped',
        detail: `no files in extract-time-resolving languages (${RESOLVING_LANGS.join(', ')})`,
      },
    ];
  }
  return results;
}
