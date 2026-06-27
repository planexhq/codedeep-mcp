// Hermetic git fixtures for Phase 2 tests.
//
// Every git invocation here runs with a sealed environment: global/system
// config disabled, fixed identity, and BOTH date env vars set per commit.
// Two traps this prevents:
//   - a maintainer's ~/.gitconfig (commit.gpgsign, hooks, init.defaultBranch)
//     breaking fixture creation locally while CI stays green;
//   - `git commit --date` setting only the AUTHOR date while `git log
//     --since` filters by COMMITTER date — without GIT_COMMITTER_DATE,
//     window tests would silently assert nothing.

import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeTree } from './helpers.js';

function probeGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const gitAvailable: boolean = probeGit();

// Per-test timeout for suites that drive real git. Each test spawns many
// SYNCHRONOUS git subprocesses (init/add/commit/log…); on Windows CI a cold
// process-spawn costs ~1s+, so the first real-git test in a file routinely
// blows past vitest's 5s default and times out. Set at the describe level it
// cascades to every test in the suite — but NOT to before*/after* hooks, which
// keep the default hookTimeout, so keep heavy setup inside the it() body. 15s
// leaves ~2-3x headroom over observed cold-start cost and also covers the
// live-refresh suite's internal 8s FSEvents poll.
export const REAL_GIT_SUITE_TIMEOUT = 15_000;

// GIT_CONFIG_GLOBAL is only honored by git >= 2.32; pointing HOME and
// XDG_CONFIG_HOME at an empty scratch dir seals ~/.gitconfig on older
// gits too (one dir for the whole test process is fine — it stays empty).
const HERMETIC_HOME = mkdtempSync(join(tmpdir(), 'codedeep-git-home-'));

// An empty real file is the portable "no config" sentinel. os.devNull works
// on POSIX, but git for Windows cannot open `\\.\nul` for GIT_CONFIG_GLOBAL
// and aborts every invocation with "fatal: unable to access '\\.\nul':
// Invalid argument" (GIT_CONFIG_SYSTEM is shielded by GIT_CONFIG_NOSYSTEM,
// but GIT_CONFIG_GLOBAL has no such guard). An empty file is read as zero
// settings on all platforms.
const EMPTY_GIT_CONFIG = join(HERMETIC_HOME, 'empty.gitconfig');
writeFileSync(EMPTY_GIT_CONFIG, '');
// Read-only: this one file is shared as GIT_CONFIG_GLOBAL/SYSTEM by every git()
// call in the process. devNull silently discarded writes; a plain file would
// PERSIST a stray `git config --global ...` and leak it into later calls
// (order-dependent flakiness). Read-only makes such a write fail loudly so the
// leak surfaces — git only ever reads this file in the current fixtures. (Best
// effort: enforced on Windows regardless of privilege and for any non-root
// POSIX owner; root bypasses the bits, but no fixture writes global config.)
chmodSync(EMPTY_GIT_CONFIG, 0o444);

const HERMETIC_ENV: Record<string, string> = {
  HOME: HERMETIC_HOME,
  XDG_CONFIG_HOME: HERMETIC_HOME,
  GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
  GIT_CONFIG_SYSTEM: EMPTY_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Codedeep Test',
  GIT_AUTHOR_EMAIL: 'codedeep@test.invalid',
  GIT_COMMITTER_NAME: 'Codedeep Test',
  GIT_COMMITTER_EMAIL: 'codedeep@test.invalid',
};

export function git(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  // Strip the same repo-discovery vars the production runner sanitizes
  // (runner.ts sanitizedEnv): an inherited GIT_DIR would redirect every
  // fixture init/add/commit at the developer's REAL repository.
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.GIT_DIR;
  delete base.GIT_WORK_TREE;
  delete base.GIT_INDEX_FILE;
  delete base.GIT_COMMON_DIR;
  delete base.GIT_OBJECT_DIRECTORY;
  delete base.GIT_CEILING_DIRECTORIES;
  delete base.GIT_CONFIG_PARAMETERS;
  delete base.GIT_CONFIG_COUNT;
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...base, ...HERMETIC_ENV, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface GitCommitSpec {
  // Written via writeTree before staging; merged over existing content.
  files?: Record<string, string>;
  // Paths deleted before staging (a rename is rm + add under --no-renames).
  rm?: string[];
  message: string;
  // ISO date for BOTH author and committer. Default: spaced one hour apart,
  // newest = now, so every default commit is inside any sane window and
  // ordering is strictly increasing.
  date?: string;
}

function commitOne(dir: string, spec: GitCommitSpec, date: string): void {
  if (spec.files && Object.keys(spec.files).length > 0) {
    writeTree(dir, spec.files);
  }
  for (const rel of spec.rm ?? []) {
    rmSync(join(dir, rel), { force: true });
  }
  git(dir, ['add', '-A']);
  // --no-gpg-sign belts-and-suspenders the hermetic seal: a maintainer's
  // commit.gpgsign=true must never reach for a signing key in tests.
  git(
    dir,
    ['commit', '--allow-empty', '--no-verify', '--no-gpg-sign', '-m', spec.message],
    {
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  );
}

function defaultDate(index: number, total: number): string {
  return new Date(Date.now() - (total - 1 - index) * 3_600_000).toISOString();
}

export function makeGitRepo(
  dir: string,
  commits: GitCommitSpec[],
  opts: { branch?: string } = {},
): void {
  const branch = opts.branch ?? 'main';
  try {
    git(dir, ['init', '-b', branch]);
  } catch {
    // git < 2.28 has no -b; normalize the unborn branch name instead.
    git(dir, ['init']);
    git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }
  addCommits(dir, commits);
}

export function addCommits(dir: string, commits: GitCommitSpec[]): void {
  commits.forEach((spec, i) => {
    commitOne(dir, spec, spec.date ?? defaultDate(i, commits.length));
  });
}

export function makeBranch(
  dir: string,
  name: string,
  commits: GitCommitSpec[],
): void {
  git(dir, ['checkout', '-q', '-b', name]);
  addCommits(dir, commits);
}

// Executable stub standing in for the git binary (timeout/abort/maxbuffer
// runner tests). POSIX-only — callers must skipOnWindows.
export function writeStubGit(dir: string, body: string): string {
  const path = join(dir, 'fake-git');
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}
