// Times indexing and git analysis and samples peak memory — codedeep-mcp has
// no built-in instrumentation, so the harness wraps it here.

import { promises as fs } from 'node:fs';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { GitService } from '../../src/git/git-service.js';
import { Indexer } from '../../src/indexer/pipeline.js';
import type { HarnessEnv } from './harness-env.js';
import type { Timing } from './types.js';

// Polls heapUsed/rss every 50ms while `fn` runs, returning the max seen.
async function withMemorySampling<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; peakHeapBytes: number; peakRssBytes: number }> {
  let peakHeap = 0;
  let peakRss = 0;
  const sample = () => {
    const m = process.memoryUsage();
    if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    if (m.rss > peakRss) peakRss = m.rss;
  };
  sample();
  const timer = setInterval(sample, 50);
  try {
    const result = await fn();
    sample();
    return { result, peakHeapBytes: peakHeap, peakRssBytes: peakRss };
  } finally {
    clearInterval(timer);
  }
}

// Clean pass: full indexAll() + git.start(), peak memory sampled across
// both, cache size measured after persist.
export async function indexWithTiming(env: HarnessEnv): Promise<Timing> {
  let indexAllMs = 0;
  let gitStartMs: number | null = null;

  const { peakHeapBytes, peakRssBytes } = await withMemorySampling(async () => {
    const t0 = performance.now();
    await env.indexer.indexAll();
    indexAllMs = performance.now() - t0;

    if (env.config.gitEnabled) {
      const g0 = performance.now();
      await env.git.start();
      gitStartMs = performance.now() - g0;
    }
  });

  let cacheBytes: number | null = null;
  try {
    cacheBytes = (await fs.stat(env.indexer.cachePath)).size;
  } catch {
    cacheBytes = null;
  }

  return {
    indexAllMs,
    indexChangedMs: null,
    gitStartMs,
    peakHeapBytes,
    peakRssBytes,
    cacheBytes,
  };
}

// Warm pass: a fresh CodeIndex/Indexer/GitService against the SAME cache
// dir. load() should succeed; indexChanged() should be near-zero (no edits)
// and git should serve persisted hotspots/co-change without re-analysis.
// Returns the indexChanged() wall-clock ONLY (the cold pass times
// gitStartMs separately, so including git.start() here would make the
// report's warmMs column not comparable to indexMs), or null if the cache
// didn't load. git.start() still runs, untimed, to exercise the
// warm-served-from-cache path.
export async function timeWarmReload(env: HarnessEnv): Promise<number | null> {
  const index = new CodeIndex(env.config.projectRoot);
  const loaded = await index.load(env.indexer.cachePath);
  if (!loaded) return null;
  const indexer = new Indexer(env.config, index);
  const git = new GitService(env.config, index, indexer.cachePath);
  const t0 = performance.now();
  await indexer.indexChanged();
  const ms = performance.now() - t0;
  await git.start();
  git.close();
  return ms;
}
