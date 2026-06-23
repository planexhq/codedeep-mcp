// Clone-or-reuse a pinned repo into the content-addressed cache. Blobless
// partial clone keeps the download small while preserving full history for
// the git oracle (see repos.ts).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { stripGitEnv } from './oracles/exec.js';
import type { RepoSpec } from './repos.js';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    // git itself must not see GIT_DIR/GIT_WORK_TREE from an ambient shell.
    env: stripGitEnv(process.env),
  }).trim();
}

export interface FetchedRepo {
  dir: string;
  commit: string;
}

export function fetchRepo(repo: RepoSpec, cacheRoot: string): FetchedRepo {
  const dir = join(cacheRoot, repo.name);
  if (existsSync(join(dir, '.git'))) {
    if (repo.ref) {
      try {
        git(['checkout', '--quiet', repo.ref], dir);
      } catch {
        // best effort: keep whatever is checked out
      }
    }
    return { dir, commit: git(['rev-parse', 'HEAD'], dir) };
  }

  // Fresh blobless clone. --no-tags trims ref clutter; origin/HEAD is still
  // set so branchSummary can resolve the default branch.
  const args = [
    'clone',
    '--filter=blob:none',
    '--no-tags',
    '-c',
    'advice.detachedHead=false',
  ];
  if (repo.ref) args.push('--branch', repo.ref);
  args.push(repo.url, dir);
  git(args);
  if (repo.ref) {
    try {
      git(['checkout', '--quiet', repo.ref], dir);
    } catch {
      /* default branch already checked out */
    }
  }
  return { dir, commit: git(['rev-parse', 'HEAD'], dir) };
}

export function codedeepMcpCommit(repoRoot: string): string {
  try {
    return git(['rev-parse', 'HEAD'], repoRoot);
  } catch {
    return 'unknown';
  }
}
