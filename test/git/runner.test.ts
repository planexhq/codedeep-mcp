// GitRunner — first child_process code in the project. Process lifecycle
// (ENOENT, exit codes, timeout kill, abort, maxBuffer) is tested against
// REAL subprocesses: real `git` where behavior matters, stub scripts where
// we need a child that sleeps or floods stdout. No fake timers anywhere in
// this file — fake timers and real subprocesses don't mix.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { GitError, GitRunner, type ExecFileFn } from '../../src/git/runner.js';
import { makeProjectDir, silenceStderr, skipOnWindows } from '../helpers.js';
import { gitAvailable, makeGitRepo, REAL_GIT_SUITE_TIMEOUT, writeStubGit } from '../git-helpers.js';

async function expectGitError(
  promise: Promise<unknown>,
  kind: GitError['kind'],
): Promise<GitError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).kind).toBe(kind);
    return err as GitError;
  }
  throw new Error(`expected GitError(${kind}), but the call succeeded`);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      readFileSync(path, 'utf8');
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

// Polls until the PID recorded by a stub script is gone. Proves the child
// was actually reaped, not just that our promise rejected.
async function expectProcessGone(pidFile: string): Promise<void> {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH — gone
    }
    if (Date.now() > deadline) throw new Error(`stub git pid ${pid} still alive`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('GitRunner', () => {
  let tmp: string;
  let stderrSpy: ReturnType<typeof silenceStderr>;

  beforeEach(() => {
    tmp = makeProjectDir('codedeep-git-runner-');
    stderrSpy = silenceStderr();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe.skipIf(!gitAvailable)('with real git', { timeout: REAL_GIT_SUITE_TIMEOUT }, () => {
    it('returns stdout on success', async () => {
      const runner = new GitRunner(tmp);
      const out = await runner.run(['--version']);
      expect(out).toContain('git version');
      expect(runner.disabled).toBe(false);
    });

    it('classifies a non-zero exit as kind "exit" with code and stderr, without disabling', async () => {
      const runner = new GitRunner(tmp); // tmp is not a repo
      const err = await expectGitError(
        runner.run(['rev-parse', '--is-inside-work-tree']),
        'exit',
      );
      expect(err.exitCode).toBe(128);
      expect(err.stderr).toContain('not a git repository');
      expect(runner.disabled).toBe(false);
    });

    it('runs successfully inside a fixture repo', async () => {
      makeGitRepo(tmp, [{ files: { 'a.txt': 'a' }, message: 'init' }]);
      const runner = new GitRunner(tmp);
      const out = await runner.run(['rev-parse', '--is-inside-work-tree']);
      expect(out.trim()).toBe('true');
    });

    it('tryRun returns stdout on success and null on failure', async () => {
      const runner = new GitRunner(tmp);
      expect(await runner.tryRun(['--version'])).toContain('git version');
      expect(await runner.tryRun(['rev-parse', 'HEAD'])).toBeNull();
    });
  });

  describe('missing binary', () => {
    it('classifies ENOENT as "git-missing" and disables the session', async () => {
      const runner = new GitRunner(tmp, { gitBin: join(tmp, 'no-such-git') });
      await expectGitError(runner.run(['--version']), 'git-missing');
      expect(runner.disabled).toBe(true);
    });

    it('never spawns again after ENOENT disables the session', async () => {
      let spawns = 0;
      const counting: ExecFileFn = ((file, args, opts, cb) => {
        spawns += 1;
        return (execFile as ExecFileFn)(file, args, opts, cb);
      }) as ExecFileFn;
      const runner = new GitRunner(tmp, {
        gitBin: join(tmp, 'no-such-git'),
        execFileImpl: counting,
      });

      await expectGitError(runner.run(['--version']), 'git-missing');
      await expectGitError(runner.run(['--version']), 'disabled');
      expect(await runner.tryRun(['--version'])).toBeNull();
      expect(spawns).toBe(1);
    });

    it('disableForSession warns exactly once', () => {
      const runner = new GitRunner(tmp);
      runner.disableForSession('gitEnabled=false');
      runner.disableForSession('gitEnabled=false');
      const warns = stderrSpy.mock.calls.filter((c) => String(c[0]).includes('warn'));
      expect(warns).toHaveLength(1);
      expect(String(warns[0]?.[0])).toContain('disabled for this session');
    });
  });

  describe.skipIf(skipOnWindows)('process lifecycle (stub git)', () => {
    it('kills a child exceeding timeoutMs and classifies as "timeout"', async () => {
      const pidFile = join(tmp, 'pid');
      // `exec` replaces the shell, so the recorded pid IS the sleeper —
      // the kill reaps the real long-runner instead of orphaning a
      // grandchild for 30s.
      const stub = writeStubGit(tmp, `echo $$ > "${pidFile}"\nexec sleep 30`);
      const runner = new GitRunner(tmp, { gitBin: stub });

      // Generous timeout so the shell reliably writes its pid before the
      // kill fires, even under cold-start parallel test load.
      const pending = runner.run(['log'], { timeoutMs: 2_000 });
      pending.catch(() => {}); // no unhandled rejection if an assertion throws first
      await waitForFile(pidFile);
      const err = await expectGitError(pending, 'timeout');
      expect(err.message).toContain('2000ms');
      expect(runner.disabled).toBe(false);
      await expectProcessGone(pidFile);
    });

    it('abortAll kills in-flight children and rejects with "aborted"', async () => {
      const pidFile = join(tmp, 'pid');
      const stub = writeStubGit(tmp, `echo $$ > "${pidFile}"\nexec sleep 30`);
      const runner = new GitRunner(tmp, { gitBin: stub });

      const pending = runner.run(['log'], { timeoutMs: 60_000 });
      pending.catch(() => {}); // no unhandled rejection if an assertion throws first
      // Let the child start and write its pid before aborting.
      await waitForFile(pidFile);
      runner.abortAll();

      await expectGitError(pending, 'aborted');
      expect(runner.disabled).toBe(false);
      await expectProcessGone(pidFile);
    });

    it('classifies output beyond maxBuffer as "maxbuffer" without disabling', async () => {
      const stub = writeStubGit(tmp, 'head -c 65536 /dev/zero | tr "\\0" "x"');
      const runner = new GitRunner(tmp, { gitBin: stub });

      await expectGitError(runner.run(['log'], { maxBuffer: 1024 }), 'maxbuffer');
      expect(runner.disabled).toBe(false);
    });
  });

  describe('warnOnce', () => {
    it('logs a given key once and different keys independently', () => {
      const runner = new GitRunner(tmp);
      runner.warnOnce('bulk-log', 'first');
      runner.warnOnce('bulk-log', 'second');
      runner.warnOnce('branch', 'third');
      const warns = stderrSpy.mock.calls.map((c) => String(c[0]));
      expect(warns).toHaveLength(2);
      expect(warns[0]).toContain('first');
      expect(warns[1]).toContain('third');
    });
  });
});

describe.skipIf(!gitAvailable)('config injection prefix', () => {
  it('forces log.showSignature=false for every invocation', async () => {
    const repo = makeProjectDir('codedeep-git-sig-');
    try {
      makeGitRepo(repo, [{ files: { 'a.txt': 'a' }, message: 'init' }]);
      // A repo-local showSignature=true (stand-in for a user gitconfig)
      // must be overridden by the -c prefix, or GPG status lines would
      // pollute --name-only parsing on signed-commit repos.
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['config', 'log.showSignature', 'true'], { cwd: repo });

      const runner = new GitRunner(repo);
      const value = await runner.run(['config', '--get', 'log.showSignature']);
      expect(value.trim()).toBe('false');
      // The same prefix pins the other parse-corrupting user settings.
      expect((await runner.run(['config', '--get', 'log.follow'])).trim()).toBe('false');
      expect((await runner.run(['config', '--get', 'diff.relative'])).trim()).toBe('false');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipOnWindows)('spawn-failure classification', () => {
  it('classifies a non-executable binary as "spawn-failed", never "exit", without disabling', async () => {
    const tmp2 = makeProjectDir('codedeep-git-spawnfail-');
    try {
      const stub = writeStubGit(tmp2, 'exit 0');
      chmodSync(stub, 0o644); // not executable -> spawn EACCES (string code)
      const runner = new GitRunner(tmp2, { gitBin: stub });
      const err = await expectGitError(runner.run(['--version']), 'spawn-failed');
      expect(err.exitCode).toBeUndefined();
      expect(runner.disabled).toBe(false);
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
