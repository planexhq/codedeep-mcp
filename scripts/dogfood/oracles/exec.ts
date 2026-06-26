// execFileSync that returns the exit status instead of throwing (ripgrep
// exits 1 on no-match, git exits non-zero on many benign conditions).
// Also the single home for the GIT_* env strip and the rg count helper —
// repo-fetch.ts / run.ts / symbol-sanity.ts all share these so the
// sanitization and exclude lists can't drift between call sites.

import { execFileSync } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  status: number;
}

// git must not see GIT_DIR/GIT_WORK_TREE etc. from an ambient shell.
export function stripGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k.startsWith('GIT_')) delete out[k];
  }
  return out;
}

export function tryExec(
  cmd: string,
  args: string[],
  cwd?: string,
): ExecResult {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: stripGitEnv(process.env),
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; status?: number };
    const stdout = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() ?? '');
    return { stdout, status: typeof e.status === 'number' ? e.status : -1 };
  }
}

// Globs mirroring codedeep's DEFAULT_EXCLUDES (src/config.ts) so rg-based
// source counts compare against the same file set codedeep indexes.
export const RG_CODEDEEP_EXCLUDES: readonly string[] = [
  '!.git',
  '!node_modules',
  '!.symbols',
  '!__pycache__',
  '!.venv',
  '!dist',
  '!build',
  '!vendor',
  '!.next',
  '!.nuxt',
  '!target',
  '!__generated__',
  '!*.min.js',
  '!*.bundle.js',
];

// Sum of per-file match counts for `re` across files matching `glob`.
// Returns null when rg itself is unusable (not installed, exit 2 parse
// error) — callers must treat null as "unknown", NOT as zero, or every
// codedeep built on this silently evaporates on machines without rg.
export function rgCountLines(
  repoDir: string,
  re: string,
  glob: string,
): number | null {
  const args = ['-c', '--hidden', '-g', glob];
  for (const ex of RG_CODEDEEP_EXCLUDES) args.push('-g', ex);
  args.push('-e', re, '.');
  const { stdout, status } = tryExec('rg', args, repoDir);
  if (status === 1) return 0; // ran fine, no matches
  if (status !== 0) return null; // rg missing or invocation failed
  let total = 0;
  for (const line of stdout.split('\n')) {
    const m = line.match(/:(\d+)$/);
    if (m) total += Number(m[1]);
  }
  return total;
}
