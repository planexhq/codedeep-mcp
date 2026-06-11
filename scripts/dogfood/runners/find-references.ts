import { runFindReferences } from '../../../src/tools/find-references.js';
import { captureCall } from '../capture.js';
import type { HarnessEnv } from '../harness-env.js';
import type { Selection } from '../input-selection.js';
import type { ToolCallRecord } from '../types.js';

export async function runFindReferencesSuite(
  env: HarnessEnv,
  sel: Selection,
): Promise<ToolCallRecord[]> {
  const out: ToolCallRecord[] = [];
  for (const [i, s] of sel.findRefTargets.entries()) {
    out.push(
      await captureCall(
        'find_references',
        { file: s.file, symbol: s.name },
        `all/top-ref-${i}(callers~${s.callerCount})`,
        () => runFindReferences({ file: s.file, symbol: s.name }, env),
      ),
    );
    if (i < 2) {
      out.push(
        await captureCall(
          'find_references',
          { file: s.file, symbol: s.name, kind: 'callers' },
          `callers-only/${s.name}`,
          () => runFindReferences({ file: s.file, symbol: s.name, kind: 'callers' }, env),
        ),
      );
      out.push(
        await captureCall(
          'find_references',
          { file: s.file, symbol: s.name, kind: 'callees' },
          `callees-only/${s.name}`,
          () => runFindReferences({ file: s.file, symbol: s.name, kind: 'callees' }, env),
        ),
      );
    }
  }
  return out;
}
