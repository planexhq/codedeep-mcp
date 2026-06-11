import { runGetContext } from '../../../src/tools/get-context.js';
import { captureCall } from '../capture.js';
import type { HarnessEnv } from '../harness-env.js';
import type { Selection } from '../input-selection.js';
import type { ToolCallRecord } from '../types.js';

export async function runGetContextSuite(
  env: HarnessEnv,
  sel: Selection,
): Promise<ToolCallRecord[]> {
  const out: ToolCallRecord[] = [];

  for (const s of sel.getContextSymbolTargets) {
    out.push(
      await captureCall(
        'get_context',
        { file: s.file, symbol: s.name },
        `symbol/${s.bucket}`,
        () => runGetContext({ file: s.file, symbol: s.name }, env),
      ),
    );
    // Disambiguation probe when the name is non-unique in the file.
    const homonyms = env.index
      .getSymbolsInFile(s.file)
      .filter((x) => x.name === s.name);
    if (homonyms.length > 1) {
      out.push(
        await captureCall(
          'get_context',
          { file: s.file, symbol: s.name, line: s.startLine },
          `symbol-disambig/${s.name}`,
          () => runGetContext({ file: s.file, symbol: s.name, line: s.startLine }, env),
        ),
      );
    }
  }

  // Token-budget truncation probe on the physically largest target.
  const largest = [...sel.getContextSymbolTargets].sort(
    (a, b) => b.endLine - b.startLine - (a.endLine - a.startLine),
  )[0];
  if (largest) {
    out.push(
      await captureCall(
        'get_context',
        { file: largest.file, symbol: largest.name, max_tokens: 500 },
        `truncation-probe/${largest.name}`,
        () =>
          runGetContext(
            { file: largest.file, symbol: largest.name, max_tokens: 500 },
            env,
          ),
      ),
    );
  }

  // File-mode outline.
  for (const file of sel.fileModeTargets) {
    out.push(
      await captureCall('get_context', { file }, 'file-mode', () =>
        runGetContext({ file }, env),
      ),
    );
  }

  return out;
}
