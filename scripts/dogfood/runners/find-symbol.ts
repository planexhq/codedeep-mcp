import { dirname } from 'node:path';

import { runFindSymbol } from '../../../src/tools/find-symbol.js';
import { captureCall } from '../capture.js';
import type { HarnessEnv } from '../harness-env.js';
import type { Selection } from '../input-selection.js';
import type { ToolCallRecord } from '../types.js';

// Drop a middle char to exercise the fuzzy "Did you mean" path.
function typo(name: string): string | null {
  if (name.length < 4) return null;
  const mid = Math.floor(name.length / 2);
  return name.slice(0, mid) + name.slice(mid + 1);
}

// A real prefix (shorter than the name) to exercise the prefix tier.
function prefixOf(name: string): string | null {
  const p = name.slice(0, Math.min(4, name.length - 1));
  return p.length >= 2 && p.length < name.length ? p : null;
}

export async function runFindSymbolSuite(
  env: HarnessEnv,
  sel: Selection,
): Promise<ToolCallRecord[]> {
  const out: ToolCallRecord[] = [];
  for (const [i, s] of sel.findSymbolTargets.entries()) {
    out.push(
      await captureCall('find_symbol', { name: s.name }, `exact/${s.bucket}`, () =>
        runFindSymbol({ name: s.name }, env),
      ),
    );
    const p = prefixOf(s.name);
    if (p) {
      out.push(
        await captureCall('find_symbol', { name: p }, `prefix-of/${s.name}`, () =>
          runFindSymbol({ name: p }, env),
        ),
      );
    }
    const t = typo(s.name);
    if (t) {
      out.push(
        await captureCall('find_symbol', { name: t }, `typo-of/${s.name}`, () =>
          runFindSymbol({ name: t }, env),
        ),
      );
    }
    // kind + scope filters on the first few only, to keep the call count sane.
    if (i < 3) {
      out.push(
        await captureCall(
          'find_symbol',
          { name: s.name, kind: s.kind },
          `kind-filter/${s.kind}`,
          () => runFindSymbol({ name: s.name, kind: s.kind }, env),
        ),
      );
      const scope = `${dirname(s.file)}/`;
      out.push(
        await captureCall(
          'find_symbol',
          { name: s.name, scope },
          `scope-filter`,
          () => runFindSymbol({ name: s.name, scope }, env),
        ),
      );
    }
  }
  return out;
}
