// Builds the {index, indexer, config, git} dependency bundle the tool
// handlers expect — the same wiring as test/integration-git.test.ts's
// indexAndStart(), but pointed at a real cloned repo and with PROBE_* env
// isolated and the cache forced to an external scratch dir.

import { loadConfig } from '../../src/config.js';
import { CodeIndex } from '../../src/indexer/code-index.js';
import { GitService } from '../../src/git/git-service.js';
import { Indexer } from '../../src/indexer/pipeline.js';
import type { ProbeConfig } from '../../src/types.js';

const PROBE_ENV_VARS = [
  'PROBE_EXCLUDE',
  'PROBE_CACHE_DIR',
  'PROBE_WATCH',
  'PROBE_GIT',
  'PROBE_GIT_WINDOW',
];

// Snapshot then clear every PROBE_* var so a developer's shell can't skew
// a run; returns a restore thunk. loadConfig reads these, so call before
// buildConfig.
export function isolateProbeEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const k of PROBE_ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of PROBE_ENV_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

export interface HarnessEnv {
  index: CodeIndex;
  indexer: Indexer;
  config: ProbeConfig;
  git: GitService;
  cacheDir: string;
}

// cacheDir is forced to an EXTERNAL scratch dir (outside the clone): keeps
// the checkout pristine for re-runs, sidesteps the self-indexing loop, and
// — because it's outside projectRoot — needs no exclude entry. watch is
// forced off so no fs.watch races the manually-driven indexing.
export function buildConfig(
  repoRoot: string,
  cacheDir: string,
  overrides: Partial<ProbeConfig> = {},
): ProbeConfig {
  const base = loadConfig(repoRoot);
  return { ...base, cacheDir, watch: false, ...overrides };
}

export function createEnv(
  repoRoot: string,
  cacheDir: string,
  overrides: Partial<ProbeConfig> = {},
): HarnessEnv {
  const config = buildConfig(repoRoot, cacheDir, overrides);
  // Construct CodeIndex with the SAME projectRoot the cache persists, so a
  // warm load()'s projectRoot check matches.
  const index = new CodeIndex(config.projectRoot);
  const indexer = new Indexer(config, index);
  const git = new GitService(config, index, indexer.cachePath);
  return { index, indexer, config, git, cacheDir };
}
