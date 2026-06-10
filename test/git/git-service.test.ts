// GitService orchestration: detection, staleness, single-flight, memos,
// and degradation. Scripted FakeRunner for the logic; real repos (via the
// hermetic git helpers) for the queries whose behavior IS git's behavior
// (branch summary, recent commits, detection variants).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { GitService } from '../../src/git/git-service.js';
import {
  GitError,
  type GitRunOptions,
  type GitRunnerLike,
} from '../../src/git/runner.js';
import type { ProbeConfig } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  mkSym,
  silenceStderr,
} from '../helpers.js';
import { addCommits, git, gitAvailable, makeBranch, makeGitRepo } from '../git-helpers.js';

// Scripted runner: every call is logged; responses are routed through a
// handler keyed on the first "interesting" git arg (skipping the -c
// prefix the real runner prepends — fakes receive the raw args).
class FakeRunner implements GitRunnerLike {
  calls: string[][] = [];
  disabled = false;
  warned: string[] = [];
  aborted = 0;

  constructor(
    private readonly handler: (args: string[]) => string | GitError,
  ) {}

  async run(args: string[], _opts?: GitRunOptions): Promise<string> {
    this.calls.push(args);
    const result = this.handler(args);
    if (result instanceof GitError) throw result;
    return result;
  }

  async tryRun(args: string[], opts?: GitRunOptions): Promise<string | null> {
    try {
      return await this.run(args, opts);
    } catch {
      return null;
    }
  }

  warnOnce(key: string, _msg: string): void {
    if (!this.warned.includes(key)) this.warned.push(key);
  }

  disableForSession(_reason: string): void {
    this.disabled = true;
  }

  abortAll(): void {
    this.aborted++;
  }
}

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

// Standard happy-path script: a repo at HEAD_A whose window log contains
// three co-commits of src/a.ts + src/b.ts.
function repoScript(head = HEAD_A): (args: string[]) => string | GitError {
  return (args) => {
    switch (args[0]) {
      case 'rev-parse':
        if (args.includes('--is-inside-work-tree')) return 'true\n.git';
        if (args.includes('HEAD') && !args.includes('--short')) return `${head}\n`;
        return new GitError('exit', 'unexpected rev-parse', { exitCode: 128 });
      case 'log':
        return [
          `\u0000300\nsrc/a.ts\nsrc/b.ts\n`,
          `\u0000200\nsrc/a.ts\nsrc/b.ts\n`,
          `\u0000100\nsrc/a.ts\nsrc/b.ts\n`,
        ].join('\n');
      default:
        return new GitError('exit', `unexpected: ${args[0]}`, { exitCode: 1 });
    }
  };
}

let tmp: string;
let cachePath: string;
let stderrSpy: ReturnType<typeof silenceStderr>;

function makeIndex(): CodeIndex {
  const idx = new CodeIndex(tmp);
  idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [mkSym({ name: 'a', file: 'src/a.ts' })], [], []);
  idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [mkSym({ name: 'b', file: 'src/b.ts' })], [], []);
  return idx;
}

function cfg(overrides: Partial<ProbeConfig> = {}): ProbeConfig {
  return makeConfig(tmp, overrides);
}

beforeEach(() => {
  tmp = makeProjectDir('probe-git-service-');
  cachePath = join(tmp, 'git-service-cache.json');
  stderrSpy = silenceStderr();
});

afterEach(() => {
  stderrSpy.mockRestore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GitService detection', () => {
  it('gitEnabled=false disables without spawning anything', async () => {
    const runner = new FakeRunner(repoScript());
    const service = new GitService(cfg({ gitEnabled: false }), makeIndex(), cachePath, runner);
    await service.start();
    expect(service.state).toBe('disabled');
    expect(runner.calls).toHaveLength(0);
    expect(await service.branchSummary()).toBeNull();
    expect(await service.recentCommits('src/a.ts')).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });

  it('non-repo probe failure lands in no-repo with null/empty queries', async () => {
    const runner = new FakeRunner(
      () => new GitError('exit', 'not a git repository', { exitCode: 128 }),
    );
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();
    expect(service.state).toBe('no-repo');
    expect(await service.branchSummary()).toBeNull();
    expect(await service.recentCommits('src/a.ts')).toEqual([]);
  });

  it('disabled runner (git missing) lands in disabled state', async () => {
    const runner = new FakeRunner(() => new GitError('git-missing', 'no git'));
    runner.disabled = true;
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();
    expect(service.state).toBe('disabled');
  });

  it('bare repo (work-tree=false) lands in no-repo', async () => {
    const runner = new FakeRunner((args) =>
      args[0] === 'rev-parse' ? 'false\n.' : new GitError('exit', 'x', { exitCode: 1 }),
    );
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();
    expect(service.state).toBe('no-repo');
  });
});

describe('GitService analysis + staleness', () => {
  it('start() analyzes, applies to the index, persists, and bumps generation', async () => {
    const runner = new FakeRunner(repoScript());
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, runner);
    expect(service.generation).toBe(0);

    await service.start();

    expect(service.state).toBe('ready');
    expect(service.generation).toBe(1);
    expect(index.getGitMeta()?.head).toBe(HEAD_A);
    expect(index.getFile('src/a.ts')?.commitFrequency).toBe(3);
    expect(index.getCoChanges('src/a.ts')).toHaveLength(1);
    expect(index.getHotspots().map((h) => h.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).gitMeta.head).toBe(HEAD_A);
  });

  it('skips analysis when persisted meta is fresh (same HEAD, window, recent)', async () => {
    const runner = new FakeRunner(repoScript());
    const index = makeIndex();
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 9]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_A, windowDays: cfg().gitWindow, analyzedAt: Date.now() },
    });
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();

    expect(runner.calls.filter((c) => c[0] === 'log')).toHaveLength(0);
    expect(index.getFile('src/a.ts')?.commitFrequency).toBe(9); // untouched
  });

  it.each([
    ['HEAD moved', { head: HEAD_B, ageMs: 0, windowDelta: 0 }],
    ['window changed', { head: HEAD_A, ageMs: 0, windowDelta: 30 }],
    ['analysis older than 24h', { head: HEAD_A, ageMs: 25 * 3_600_000, windowDelta: 0 }],
  ])('re-analyzes when %s', async (_label, { head, ageMs, windowDelta }) => {
    const runner = new FakeRunner(repoScript());
    const index = makeIndex();
    const config = cfg();
    await index.applyGitAnalysis({
      counts: new Map(),
      cochanges: new Map(),
      hotspots: [],
      meta: {
        head,
        windowDays: config.gitWindow + windowDelta,
        analyzedAt: Date.now() - ageMs,
      },
    });
    const service = new GitService(config, index, cachePath, runner);
    await service.start();

    expect(runner.calls.filter((c) => c[0] === 'log')).toHaveLength(1);
    expect(index.getGitMeta()?.head).toBe(HEAD_A);
  });

  it('empty repo (rev-parse HEAD fails) skips analysis silently', async () => {
    const runner = new FakeRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
        return 'true\n.git';
      }
      return new GitError('exit', 'unknown revision', { exitCode: 128 });
    });
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();
    expect(service.state).toBe('ready');
    expect(index.getGitMeta()).toBeNull();
    expect(runner.calls.filter((c) => c[0] === 'log')).toHaveLength(0);
  });

  it('bulk-log failure keeps previous data, warns once, does not disable', async () => {
    const index = makeIndex();
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 4]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_B, windowDays: cfg().gitWindow, analyzedAt: Date.now() },
    });
    const runner = new FakeRunner((args) =>
      args[0] === 'log'
        ? new GitError('timeout', 'git timed out after 30000ms')
        : repoScript()(args),
    );
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();

    expect(index.getGitMeta()?.head).toBe(HEAD_B); // stale data retained
    expect(index.getFile('src/a.ts')?.commitFrequency).toBe(4);
    expect(runner.warned).toContain('bulk-log');
    expect(runner.disabled).toBe(false);
    expect(service.generation).toBe(0);
  });

  it('coalesces a refresh requested mid-analysis into one trailing rerun', async () => {
    let releaseLog: ((s: string) => void) | null = null;
    let logCalls = 0;
    const runner = new FakeRunner(repoScript());
    runner.run = async (args: string[]) => {
      runner.calls.push(args);
      if (args[0] === 'log') {
        logCalls++;
        if (logCalls === 1) {
          return new Promise<string>((res) => {
            releaseLog = res;
          });
        }
        return '\u0000100\nsrc/a.ts\n';
      }
      if (args.includes('--is-inside-work-tree')) return 'true\n.git';
      return `${HEAD_A}\n`;
    };
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, runner);

    const first = service.start(); // blocks inside the first log call
    // Three more refresh requests while in flight — all coalesce.
    const extra = Promise.all([
      service.ensureFreshAnalysis(),
      service.ensureFreshAnalysis(),
      service.ensureFreshAnalysis(),
    ]);
    // Wait until the first log call is actually in flight.
    const deadline = Date.now() + 2_000;
    while (releaseLog === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(releaseLog).not.toBeNull();
    releaseLog!('\u0000100\nsrc/a.ts\nsrc/b.ts\n');
    await first;
    await extra;
    // Let the trailing rerun settle.
    await new Promise((r) => setTimeout(r, 20));

    // Exactly 2 log runs: the original + ONE coalesced rerun (the rerun's
    // own freshness check sees the same HEAD... but meta head matches, so
    // the rerun may legitimately skip). Accept 1 or 2, never 4.
    expect(logCalls).toBeLessThanOrEqual(2);
    expect(index.getGitMeta()?.head).toBe(HEAD_A);
  });

  it('close() aborts the runner and blocks later refreshes', async () => {
    const runner = new FakeRunner(repoScript());
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();
    service.close();
    expect(runner.aborted).toBe(1);
    runner.calls = [];
    await service.ensureFreshAnalysis();
    expect(runner.calls).toHaveLength(0);
  });
});

describe('GitService memoization', () => {
  it('branchSummary and recentCommits are memoized per generation', async () => {
    const script = repoScript();
    const runner = new FakeRunner((args) => {
      if (args[0] === 'symbolic-ref') return 'main\n';
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) {
        return new GitError('exit', 'no origin', { exitCode: 128 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return HEAD_A;
      if (args[0] === 'log' && args.includes('--')) {
        return 'abc1234\u00002026-06-01\u0000fix things';
      }
      return script(args);
    });
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();

    runner.calls = [];
    await service.branchSummary();
    await service.branchSummary();
    expect(runner.calls.filter((c) => c[0] === 'symbolic-ref')).toHaveLength(1);

    runner.calls = [];
    const first = await service.recentCommits('src/a.ts');
    await service.recentCommits('src/a.ts');
    expect(first).toEqual([{ hash: 'abc1234', date: '2026-06-01', subject: 'fix things' }]);
    expect(runner.calls.filter((c) => c[0] === 'log')).toHaveLength(1);
  });
});

describe.skipIf(!gitAvailable)('GitService against real repos', () => {
  // Real repos attach real fs.watch HeadWatchers — close them so timers
  // can't fire against the rmSync'd repo after the test ends.
  let services: GitService[] = [];

  afterEach(() => {
    for (const s of services) s.close();
    services = [];
  });

  function realService(config?: ProbeConfig) {
    const index = makeIndex();
    const service = new GitService(config ?? cfg(), index, cachePath);
    services.push(service);
    return { index, service };
  }

  it('end-to-end on a real repo: detection, analysis, branch summary, recent commits', async () => {
    makeGitRepo(tmp, [
      { files: { 'src/a.ts': 'export const a = 1;', 'src/b.ts': 'export const b = 1;' }, message: 'init' },
      { files: { 'src/a.ts': 'export const a = 2;', 'src/b.ts': 'export const b = 2;' }, message: 'touch both 1' },
      { files: { 'src/a.ts': 'export const a = 3;', 'src/b.ts': 'export const b = 3;' }, message: 'touch both 2' },
      { files: { 'src/a.ts': 'export const a = 4;' }, message: 'touch "a" — final' },
    ]);
    const { index, service } = realService();
    await service.start();

    expect(service.state).toBe('ready');
    expect(index.getFile('src/a.ts')?.commitFrequency).toBe(4);
    expect(index.getFile('src/b.ts')?.commitFrequency).toBe(3);
    const partners = index.getCoChanges('src/a.ts');
    expect(partners).toHaveLength(1);
    expect(partners[0].sharedCommits).toBe(3);

    const summary = await service.branchSummary();
    expect(summary).not.toBeNull();
    expect(summary!.branch).toBe('main');
    expect(summary!.defaultBranch).toBe('main');
    expect(summary!.ahead).toBe(0);
    expect(summary!.changedFiles).toEqual([]);

    const commits = await service.recentCommits('src/a.ts', 2);
    expect(commits).toHaveLength(2);
    expect(commits[0].subject).toBe('touch "a" — final');
    expect(commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(commits[1].subject).toBe('touch both 2');
  });

  it('feature branch reports ahead-of-main with changed files', async () => {
    makeGitRepo(tmp, [
      { files: { 'src/a.ts': 'export const a = 1;' }, message: 'init' },
    ]);
    makeBranch(tmp, 'feature/x', [
      { files: { 'src/b.ts': 'export const b = 1;' }, message: 'add b' },
      { files: { 'src/b.ts': 'export const b = 2;' }, message: 'tweak b' },
    ]);
    const { service } = realService();
    await service.start();

    const summary = await service.branchSummary();
    expect(summary).toMatchObject({
      branch: 'feature/x',
      defaultBranch: 'main',
      ahead: 2,
      changedFiles: ['src/b.ts'],
    });
  });

  it('detached HEAD renders as detached; analysis still runs', async () => {
    makeGitRepo(tmp, [
      { files: { 'src/a.ts': 'export const a = 1;' }, message: 'init' },
      { files: { 'src/a.ts': 'export const a = 2;' }, message: 'second' },
    ]);
    git(tmp, ['checkout', '-q', '--detach', 'HEAD~1']);
    const { index, service } = realService();
    await service.start();

    expect(index.getGitMeta()).not.toBeNull();
    const summary = await service.branchSummary();
    expect(summary!.branch).toMatch(/^HEAD \(detached at [0-9a-f]+\)$/);
  });

  it('repo with neither main nor master shows branch name only', async () => {
    makeGitRepo(tmp, [{ files: { 'src/a.ts': 'x' }, message: 'init' }], {
      branch: 'trunk',
    });
    const { service } = realService();
    await service.start();

    const summary = await service.branchSummary();
    expect(summary).toEqual({
      branch: 'trunk',
      defaultBranch: null,
      ahead: null,
      changedFiles: null,
    });
  });

  it('empty repo (no commits): ready, unborn branch name, no analysis, empty recents', async () => {
    makeGitRepo(tmp, []);
    const { index, service } = realService();
    await service.start();

    expect(service.state).toBe('ready');
    expect(index.getGitMeta()).toBeNull();
    const summary = await service.branchSummary();
    expect(summary?.branch).toBe('main');
    expect(await service.recentCommits('src/a.ts')).toEqual([]);
  });

  it('warm start: fresh persisted meta skips re-analysis', async () => {
    makeGitRepo(tmp, [
      { files: { 'src/a.ts': 'export const a = 1;' }, message: 'init' },
    ]);
    const first = realService();
    await first.service.start();
    const analyzedAt = first.index.getGitMeta()?.analyzedAt;
    expect(analyzedAt).toBeDefined();

    // Same cache file, new index + service — the warm-start path.
    const index2 = new CodeIndex(tmp);
    expect(await index2.load(cachePath)).toBe(true);
    const service2 = new GitService(cfg(), index2, cachePath);
    services.push(service2);
    await service2.start();
    expect(index2.getGitMeta()?.analyzedAt).toBe(analyzedAt);

    // New commit -> HEAD moved -> next start re-analyzes.
    addCommits(tmp, [{ files: { 'src/a.ts': 'export const a = 2;' }, message: 'bump' }]);
    const service3 = new GitService(cfg(), index2, cachePath);
    services.push(service3);
    await service3.start();
    expect(index2.getGitMeta()?.analyzedAt).not.toBe(analyzedAt);
    expect(index2.getFile('src/a.ts')?.commitFrequency).toBe(2);
  });
});

describe.skipIf(!gitAvailable)('GitService live refresh (real fs.watch)', () => {
  // Explicit timeouts: the internal 8s poll deadline must fit inside the
  // test budget (vitest's default is 5s).
  it('a new commit triggers a debounced re-analysis via the HEAD watcher', { timeout: 15_000 }, async () => {
    makeGitRepo(tmp, [
      { files: { 'src/a.ts': 'export const a = 1;' }, message: 'init' },
    ]);
    const index = makeIndex();
    // Short debounce keeps the real-FS smoke test fast; production uses 1s.
    const service = new GitService(cfg(), index, cachePath, undefined, {
      headDebounceMs: 50,
    });
    try {
      await service.start();
      const gen = service.generation;
      expect(index.getFile('src/a.ts')?.commitFrequency).toBe(1);

      addCommits(tmp, [
        { files: { 'src/a.ts': 'export const a = 2;' }, message: 'bump' },
      ]);

      // FSEvents registration latency can be substantial — poll generously.
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if ((index.getFile('src/a.ts')?.commitFrequency ?? 0) >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(index.getFile('src/a.ts')?.commitFrequency).toBe(2);
      expect(service.generation).toBeGreaterThan(gen);
    } finally {
      service.close();
    }
  });

  it('close() detaches the watcher — later commits no longer refresh', { timeout: 15_000 }, async () => {
    makeGitRepo(tmp, [
      { files: { 'src/a.ts': 'export const a = 1;' }, message: 'init' },
    ]);
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, undefined, {
      headDebounceMs: 50,
    });
    await service.start();
    service.close();

    addCommits(tmp, [
      { files: { 'src/a.ts': 'export const a = 2;' }, message: 'bump' },
    ]);
    await new Promise((r) => setTimeout(r, 400));
    expect(index.getFile('src/a.ts')?.commitFrequency).toBe(1);
  });
});

describe('GitService review hardening', () => {
  it('gitEnabled=false clears persisted git data from an earlier enabled session', async () => {
    const index = makeIndex();
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 7]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_A, windowDays: 180, analyzedAt: Date.now() },
    });
    const runner = new FakeRunner(repoScript());
    const service = new GitService(cfg({ gitEnabled: false }), index, cachePath, runner);
    await service.start();

    expect(service.state).toBe('disabled');
    expect(index.getGitMeta()).toBeNull();
    expect(index.getHotspots()).toEqual([]);
    expect(index.getFile('src/a.ts')?.commitFrequency).toBeUndefined();
    // The clear is persisted so the next session does not resurrect it.
    expect(existsSync(cachePath)).toBe(true);
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).gitMeta).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  it('no-repo detection clears persisted git data (repo deleted between sessions)', async () => {
    const index = makeIndex();
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 7]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_A, windowDays: 180, analyzedAt: Date.now() },
    });
    const runner = new FakeRunner(
      () => new GitError('exit', 'not a git repository', { exitCode: 128 }),
    );
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();

    expect(service.state).toBe('no-repo');
    expect(index.getGitMeta()).toBeNull();
    expect(index.getHotspots()).toEqual([]);
  });

  it('refuses to apply an analysis over an empty index (cold-start indexing failure)', async () => {
    const runner = new FakeRunner(repoScript());
    const emptyIndex = new CodeIndex(tmp);
    const service = new GitService(cfg(), emptyIndex, cachePath, runner);
    await service.start();

    // The bulk pass is skipped BEFORE spawning, and nothing is applied
    // or persisted as fresh.
    expect(runner.calls.filter((c) => c[0] === 'log')).toHaveLength(0);
    expect(emptyIndex.getGitMeta()).toBeNull();
    expect(service.generation).toBe(0);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('close() gates per-call queries so shutdown spawns no fresh children', async () => {
    const runner = new FakeRunner(repoScript());
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();
    service.close();

    runner.calls = [];
    expect(await service.branchSummary()).toBeNull();
    expect(await service.recentCommits('src/a.ts')).toEqual([]);
    expect(runner.calls).toHaveLength(0);
  });
});

describe.skipIf(!gitAvailable)('GitService in a monorepo subdirectory', () => {
  it('maps repo-relative log paths onto project-relative index keys', async () => {
    // The git toplevel is tmp; the probed project is tmp/packages/app.
    makeGitRepo(tmp, [
      {
        files: {
          'packages/app/src/a.ts': 'export const a = 1;',
          'packages/lib/src/b.ts': 'export const b = 1;',
        },
        message: 'init',
      },
      {
        files: {
          'packages/app/src/a.ts': 'export const a = 2;',
          'packages/lib/src/b.ts': 'export const b = 2;',
        },
        message: 'touch both 1',
      },
      {
        files: {
          'packages/app/src/a.ts': 'export const a = 3;',
          'packages/lib/src/b.ts': 'export const b = 3;',
        },
        message: 'touch both 2',
      },
    ]);
    const appRoot = join(tmp, 'packages', 'app');
    const index = new CodeIndex(appRoot);
    index.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'a', file: 'src/a.ts' })],
      [],
      [],
    );
    const config = makeConfig(appRoot);
    const service = new GitService(config, index, join(appRoot, 'cache.json'));
    try {
      await service.start();

    expect(service.state).toBe('ready');
    // Index-relative key carries the churn, not the repo-relative path.
    expect(index.getFile('src/a.ts')?.commitFrequency).toBe(3);
    expect(index.getHotspots().map((h) => h.path)).toEqual(['src/a.ts']);
    // The sibling package appears as a PROJECT-relative partner value
    // ('../'-prefixed) so it can never collide with an index key.
    const record = index.getCoChanges('src/a.ts')[0];
    expect(record).toBeDefined();
    const partner = record.fileA === 'src/a.ts' ? record.fileB : record.fileA;
    expect(partner).toBe('../lib/src/b.ts');

      // Recent commits resolve via the cwd-relative pathspec.
      const commits = await service.recentCommits('src/a.ts', 2);
      expect(commits[0]?.subject).toBe('touch both 2');
    } finally {
      // A real HeadWatcher attached here — a failing assertion above must
      // not leak it past afterEach's rmSync (sibling suites use a
      // services[] registry; this single-service suite uses try/finally).
      service.close();
    }
  });
});

describe('GitService transient-failure handling (review round 2)', () => {
  it('a transient detection failure keeps persisted data and never classifies as no-repo', async () => {
    const index = makeIndex();
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 7]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_A, windowDays: 180, analyzedAt: Date.now() },
    });
    const runner = new FakeRunner(() => new GitError('timeout', 'git timed out after 3000ms'));
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();

    expect(service.state).toBe('unknown'); // not 'no-repo', not 'disabled'
    expect(index.getGitMeta()).not.toBeNull(); // stale beats none
    expect(index.getHotspots().map((h) => h.path)).toEqual(['src/a.ts']);
    expect(existsSync(cachePath)).toBe(false); // nothing wiped, nothing saved
  });

  it('recentCommits memoizes per requested count, not just per path', async () => {
    const runner = new FakeRunner((args) => {
      if (args[0] === 'log' && args.includes('--')) {
        const n = Number(args[args.indexOf('-n') + 1]);
        return Array.from({ length: n }, (_, i) => `h${i}\u00002026-06-0${i + 1}\u0000s${i}`).join('\n');
      }
      return repoScript()(args);
    });
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();

    const two = await service.recentCommits('src/a.ts', 2);
    const five = await service.recentCommits('src/a.ts', 5);
    expect(two).toHaveLength(2);
    expect(five).toHaveLength(5);
    // And each is independently memoized.
    runner.calls = [];
    expect(await service.recentCommits('src/a.ts', 2)).toHaveLength(2);
    expect(await service.recentCommits('src/a.ts', 5)).toHaveLength(5);
    expect(runner.calls.filter((c) => c[0] === 'log')).toHaveLength(0);
  });

  it('does not memoize transient failures of branchSummary or recentCommits', async () => {
    let failBranch = true;
    let failLog = true;
    const runner = new FakeRunner((args) => {
      if (args[0] === 'symbolic-ref') {
        if (failBranch) return new GitError('timeout', 'slow');
        return 'main\n';
      }
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) {
        return new GitError('exit', 'no origin', { exitCode: 128 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return HEAD_A;
      if (args[0] === 'rev-parse' && args.includes('--short')) {
        return new GitError('exit', 'nope', { exitCode: 128 });
      }
      if (args[0] === 'log' && args.includes('--')) {
        if (failLog) return new GitError('timeout', 'slow');
        return 'abc1234\u00002026-06-01\u0000recovered';
      }
      return repoScript()(args);
    });
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();

    // First calls fail transiently -> degraded answers...
    expect(await service.branchSummary()).toBeNull();
    expect(await service.recentCommits('src/a.ts')).toEqual([]);
    // ...but the failures were NOT pinned into the generation memo.
    failBranch = false;
    failLog = false;
    expect((await service.branchSummary())?.branch).toBe('main');
    expect(await service.recentCommits('src/a.ts')).toHaveLength(1);
  });
});

describe('GitService transient-failure handling (review round 3)', () => {
  it('a timed-out symbolic-ref never fabricates detached HEAD and is not memoized', async () => {
    let failBranch = true;
    const runner = new FakeRunner((args) => {
      if (args[0] === 'symbolic-ref') {
        if (failBranch) return new GitError('timeout', 'slow');
        return 'main\n';
      }
      // rev-parse --short HEAD SUCCEEDS — the old code would fabricate
      // 'HEAD (detached at abc1234)' from this and memoize it.
      if (args[0] === 'rev-parse' && args.includes('--short')) return 'abc1234\n';
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) {
        return new GitError('exit', 'no origin', { exitCode: 128 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return HEAD_A;
      return repoScript()(args);
    });
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();

    const first = await service.branchSummary();
    expect(first).toBeNull(); // degraded, no detached fabrication

    failBranch = false;
    const second = await service.branchSummary();
    expect(second?.branch).toBe('main'); // failure was not pinned
  });

  it('a partially-degraded summary (origin probe timeout) is served but not memoized', async () => {
    let failOrigin = true;
    const runner = new FakeRunner((args) => {
      if (args[0] === 'symbolic-ref') return 'feature/x\n';
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) {
        if (failOrigin) return new GitError('timeout', 'slow');
        return 'origin/main\n';
      }
      if (args[0] === 'rev-list') return '2\n';
      if (args[0] === 'diff') return 'src/a.ts\n';
      return repoScript()(args);
    });
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    await service.start();

    const degradedValue = await service.branchSummary();
    expect(degradedValue?.branch).toBe('feature/x');
    expect(degradedValue?.defaultBranch).toBeNull(); // origin unknown

    failOrigin = false;
    const healed = await service.branchSummary();
    expect(healed?.defaultBranch).toBe('main'); // not pinned to the degraded shape
    expect(healed?.ahead).toBe(2);
  });

  it('recovers from a transient detection failure on a later tool call', async () => {
    let failProbe = true;
    const script = repoScript();
    const runner = new FakeRunner((args) => {
      if (args[0] === 'rev-parse' && args.includes('--is-inside-work-tree')) {
        if (failProbe) return new GitError('timeout', 'slow');
        return 'true\n.git';
      }
      if (args[0] === 'symbolic-ref') return 'main\n';
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) {
        return new GitError('exit', 'no origin', { exitCode: 128 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return HEAD_A;
      return script(args);
    });
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();
    expect(service.state).toBe('unknown');

    // Next tool call triggers the (backoff-limited) re-probe.
    failProbe = false;
    await service.branchSummary();
    // The retry is async: state flips to 'ready' before the analysis
    // applies — poll for the analysis itself.
    const deadline = Date.now() + 2_000;
    while (index.getGitMeta() === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(service.state).toBe('ready');
    expect(index.getGitMeta()?.head).toBe(HEAD_A); // analysis landed on retry
  });
});

describe('GitService scoped-pass hardening (whole-file review)', () => {
  it('per-call retries never run before the official start() settles', async () => {
    const runner = new FakeRunner(repoScript());
    const service = new GitService(cfg(), makeIndex(), cachePath, runner);
    // NO start(): tools can be served while startup indexing is still
    // running — the retry hook must not jump the gun and run startInner
    // against a partially-populated index.
    expect(await service.branchSummary()).toBeNull();
    expect(await service.recentCommits('src/a.ts')).toEqual([]);
    await new Promise((r) => setTimeout(r, 30));
    expect(runner.calls).toHaveLength(0);
    expect(service.state).toBe('unknown');

    await service.start();
    expect(service.state).toBe('ready');
  });

  it('git vanishing mid-session transitions to disabled and clears persisted data', async () => {
    const runner = new FakeRunner((args) => {
      if (args[0] === 'symbolic-ref') return 'main\n';
      return repoScript()(args);
    });
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();
    expect(index.getGitMeta()).not.toBeNull();

    // Simulate the runner hitting ENOENT (git uninstalled / PATH swap).
    runner.disabled = true;
    expect(await service.branchSummary()).toBeNull();
    const deadline = Date.now() + 2_000;
    while (index.getGitMeta() !== null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(service.state).toBe('disabled');
    expect(index.getGitMeta()).toBeNull();
    expect(index.getHotspots()).toEqual([]);
  });

  it('an analysis older than 24h is refreshed from a tool call, not only at startup', async () => {
    const runner = new FakeRunner((args) => {
      if (args[0] === 'symbolic-ref') return 'main\n';
      if (args[0] === 'rev-parse' && args.includes('origin/HEAD')) {
        return new GitError('exit', 'no origin', { exitCode: 128 });
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return HEAD_A;
      return repoScript()(args);
    });
    const index = makeIndex();
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();

    // Age the analysis past the daily refresh threshold.
    const staleAt = Date.now() - 25 * 3_600_000;
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 3]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_A, windowDays: cfg().gitWindow, analyzedAt: staleAt },
    });

    await service.branchSummary(); // triggers the backoff-limited retry
    const deadline = Date.now() + 2_000;
    while ((index.getGitMeta()?.analyzedAt ?? 0) <= staleAt && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(index.getGitMeta()!.analyzedAt).toBeGreaterThan(staleAt);
  });

  it('a transiently-failed bulk pass is re-attempted from a later tool call', async () => {
    let failLog = true;
    const runner = new FakeRunner((args) => {
      if (args[0] === 'log' && !args.includes('--')) {
        if (failLog) return new GitError('timeout', 'slow bulk');
        return repoScript()(args);
      }
      return repoScript()(args);
    });
    const index = makeIndex();
    // Warm cache whose HEAD is stale: startup tries to refresh and fails.
    await index.applyGitAnalysis({
      counts: new Map([['src/a.ts', 9]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      meta: { head: HEAD_B, windowDays: cfg().gitWindow, analyzedAt: Date.now() },
    });
    const service = new GitService(cfg(), index, cachePath, runner);
    await service.start();
    expect(index.getGitMeta()?.head).toBe(HEAD_B); // stale kept

    failLog = false;
    await service.branchSummary();
    const deadline = Date.now() + 2_000;
    while (index.getGitMeta()?.head !== HEAD_A && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(index.getGitMeta()?.head).toBe(HEAD_A); // retried and healed
  });
});
