import { runOverview } from '../../../src/tools/overview.js';
import { captureCall } from '../capture.js';
import type { HarnessEnv } from '../harness-env.js';
import type { ToolCallRecord } from '../types.js';

// overview's `path` must equal the configured project root (multi-root is
// rejected in-band), so we exercise both the no-arg and path=root forms —
// the latter positively tests that validation branch.
export async function runOverviewSuite(env: HarnessEnv): Promise<ToolCallRecord[]> {
  return [
    await captureCall('overview', {}, 'whole-repo', () => runOverview({}, env)),
    await captureCall(
      'overview',
      { path: env.config.projectRoot },
      'path=root',
      () => runOverview({ path: env.config.projectRoot }, env),
    ),
  ];
}
