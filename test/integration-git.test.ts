// End-to-end git enrichment over the small-ts fixture inside REAL git
// repos: index the fixture, run a real GitService analysis, and assert
// the git sections in actual tool output. The negative twin (same
// fixture, no .git) pins the silent-omission contract. Kept separate
// from integration.test.ts so vitest can parallelize the workers.

import { promises as fsp, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../src/indexer/code-index.js';
import * as parserModule from '../src/indexer/parser.js';
import { Indexer } from '../src/indexer/pipeline.js';
import { GitService } from '../src/git/git-service.js';
import { runGetContext } from '../src/tools/get-context.js';
import { runOverview } from '../src/tools/overview.js';
import type { CodedeepConfig } from '../src/types.js';
import { makeConfig, makeProjectDir, silenceStderr, writeTree } from './helpers.js';
import { addCommits, gitAvailable, makeBranch, makeGitRepo, REAL_GIT_SUITE_TIMEOUT } from './git-helpers.js';

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const FIXTURE_FILES = [
  'src/index.ts',
  'src/auth.ts',
  'src/utils.ts',
  'src/types.ts',
  'src/service.ts',
] as const;

async function copyFixture(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const rel of FIXTURE_FILES) {
    tree[rel] = await fsp.readFile(join(FIXTURES_ROOT, 'small-ts', rel), 'utf8');
  }
  writeTree(root, tree);
  return tree;
}

interface Env {
  index: CodeIndex;
  indexer: Indexer;
  config: CodedeepConfig;
  git: GitService;
}

beforeAll(async () => {
  await parserModule.initParser();
});

describe.skipIf(!gitAvailable)('integration: git enrichment end-to-end', { timeout: REAL_GIT_SUITE_TIMEOUT }, () => {
  let root = '';
  // Every GitService created in a test registers here so afterEach can
  // close it — otherwise real fs.watch HeadWatchers and their debounce
  // timers outlive the test and fire against the rmSync'd repo.
  let services: GitService[] = [];

  afterEach(() => {
    for (const s of services) s.close();
    services = [];
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) {
      // Retry on Windows: a closed HEAD-watcher's fs.watch handle (or a
      // debounce timer re-touching .git/logs) can briefly hold root open after
      // s.close(), so an immediate rmdir hits ENOTEMPTY/EBUSY. The backoff lets
      // the handle release; mirrors git-service.test.ts. No-op on POSIX.
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      root = '';
    }
  });

  // Fixture history: everything committed once, then auth+service
  // co-committed 4x (appended comments keep content parseable) and
  // utils churned 5x. Expected: utils 6 commits (top hotspot), auth and
  // service 5 each sharing 5 (incl. the init commit) -> 100% confidence.
  async function setupRepo(): Promise<Env> {
    vi.stubEnv('CODEDEEP_EXCLUDE', undefined);
    vi.stubEnv('CODEDEEP_CACHE_DIR', undefined);
    root = makeProjectDir('codedeep-int-git-');
    const tree = await copyFixture(root);

    // Ignore the codedeep cache like a real project would — otherwise the
    // helper's `git add -A` commits .codedeep/cache/index.json and pollutes
    // branch diffs and co-change pairs.
    makeGitRepo(root, [
      { files: { '.gitignore': '.codedeep/\n' }, message: 'initial import' },
    ]);
    addCommits(
      root,
      [1, 2, 3, 4].map((i) => ({
        files: {
          'src/auth.ts': `${tree['src/auth.ts']}\n// auth rev ${i}\n`,
          'src/service.ts': `${tree['src/service.ts']}\n// service rev ${i}\n`,
        },
        message: `touch auth+service ${i}`,
      })),
    );
    addCommits(
      root,
      [1, 2, 3, 4, 5].map((i) => ({
        files: { 'src/utils.ts': `${tree['src/utils.ts']}\n// utils rev ${i}\n` },
        message: `churn utils ${i}`,
      })),
    );

    return indexAndStart();
  }

  async function indexAndStart(): Promise<Env> {
    const config = makeConfig(root);
    const index = new CodeIndex(root);
    const indexer = new Indexer(config, index);
    silenceStderr();
    await indexer.indexAll();
    const git = new GitService(config, index, indexer.cachePath);
    services.push(git);
    await git.start();
    return { index, indexer, config, git };
  }

  it('analyzes the repo: hotspots, co-changes, commitFrequency', async () => {
    const env = await setupRepo();

    expect(env.git.state).toBe('ready');
    expect(env.index.getGitMeta()).not.toBeNull();
    expect(env.index.getFile('src/utils.ts')?.commitFrequency).toBe(6);
    expect(env.index.getFile('src/auth.ts')?.commitFrequency).toBe(5);
    expect(env.index.getHotspots(1)[0]).toEqual({ path: 'src/utils.ts', commits: 6 });

    const partners = env.index.getCoChanges('src/auth.ts');
    const service = partners.find(
      (p) => p.fileA === 'src/service.ts' || p.fileB === 'src/service.ts',
    );
    expect(service).toBeDefined();
    expect(service!.sharedCommits).toBe(5);
  });

  it('overview renders Branch and Hotspots sections from real data', async () => {
    const env = await setupRepo();
    const text = (await runOverview({}, env)).content[0].text;

    expect(text).toContain('### Branch [behavioral]');
    expect(text).toContain('- main (default branch)');
    expect(text).toContain(`### Hotspots (last ${env.config.gitWindow} days) [behavioral]`);
    expect(text).toContain('- src/utils.ts — 6 commits');
    // Strongest first: utils above auth.
    expect(text.indexOf('- src/utils.ts')).toBeLessThan(text.indexOf('- src/auth.ts — 5 commits'));
  });

  it('get_context renders co-change partners and recent changes from real data', async () => {
    const env = await setupRepo();
    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, env)
    ).content[0].text;

    expect(text).toContain('### Co-change Partners');
    expect(text).toContain('- src/service.ts  100% confidence (5 shared commits)');
    expect(text).toContain('### Recent Changes [behavioral]');
    expect(text).toContain('"touch auth+service 4"');
    // Newest first.
    expect(text.indexOf('touch auth+service 4')).toBeLessThan(
      text.indexOf('touch auth+service 3'),
    );
  });

  it('feature branch shows ahead-of-main in overview', async () => {
    const env = await setupRepo();
    makeBranch(root, 'feature/probe', [
      { files: { 'src/extra.ts': 'export const x = 1;\n' }, message: 'add extra' },
      { files: { 'src/extra.ts': 'export const x = 2;\n' }, message: 'tweak extra' },
    ]);
    // New service so the branch summary is not memoized from main.
    const git2 = new GitService(env.config, env.index, env.indexer.cachePath);
    services.push(git2);
    await git2.start();
    const text = (
      await runOverview({}, { ...env, git: git2 })
    ).content[0].text;

    expect(text).toContain(
      '- feature/probe — 2 commits ahead of main, 1 file changed on branch',
    );
  });

  it('warm start serves persisted git data without re-analysis', async () => {
    const env = await setupRepo();
    const analyzedAt = env.index.getGitMeta()?.analyzedAt;

    const index2 = new CodeIndex(root);
    expect(await index2.load(env.indexer.cachePath)).toBe(true);
    // Hotspots available IMMEDIATELY from cache, before any git call.
    expect(index2.getHotspots(1)[0]?.path).toBe('src/utils.ts');

    const git2 = new GitService(env.config, index2, env.indexer.cachePath);
    services.push(git2);
    await git2.start();
    expect(index2.getGitMeta()?.analyzedAt).toBe(analyzedAt); // skipped — fresh
  });

  it('CODEDEEP_GIT=0 disables enrichment even inside a repo', async () => {
    const env = await setupRepo();
    const config = { ...env.config, gitEnabled: false } as CodedeepConfig;
    const index2 = new CodeIndex(root);
    const git2 = new GitService(config, index2, join(root, 'alt-cache.json'));
    services.push(git2);
    await git2.start();

    expect(git2.state).toBe('disabled');
    expect(await git2.branchSummary()).toBeNull();
  });

  it('negative twin: same fixture without .git -> zero git output anywhere', async () => {
    vi.stubEnv('CODEDEEP_EXCLUDE', undefined);
    vi.stubEnv('CODEDEEP_CACHE_DIR', undefined);
    root = makeProjectDir('codedeep-int-nogit-');
    await copyFixture(root);
    const env = await indexAndStart();

    expect(env.git.state).toBe('no-repo');

    const overview = (await runOverview({}, env)).content[0].text;
    expect(overview).toContain('## Project:');
    expect(overview).not.toContain('Branch');
    expect(overview).not.toContain('Hotspots');
    expect(overview).not.toContain('[behavioral]');

    const context = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, env)
    ).content[0].text;
    expect(context).toContain('### Body');
    expect(context).not.toContain('Co-change Partners');
    expect(context).not.toContain('Recent Changes');
  });
});
