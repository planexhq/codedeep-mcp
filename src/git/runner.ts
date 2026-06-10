// GitRunner — the project's only subprocess boundary. Wraps execFile('git')
// with a timeout, an output cap, an AbortController per call (so shutdown
// can kill every in-flight child), and an error taxonomy that callers
// branch on:
//
//   'git-missing'  spawn ENOENT — git isn't installed. Disables the runner
//                  for the whole session (one warn, zero further spawns).
//   'disabled'     a call made after disableForSession; never spawned.
//   'aborted'      killed via abortAll() (shutdown) — log at debug only.
//   'timeout'      exceeded timeoutMs and was SIGTERM'd by execFile.
//   'maxbuffer'    output exceeded maxBuffer — skip this result, do NOT
//                  disable the session.
//   'exit'         git RAN and exited non-zero (numeric exit code). exit
//                  128 is *normal* for "not a git repository" / "no
//                  commits yet" — callers decide log level, the runner
//                  never warns on 'exit'. This is the ONLY kind callers
//                  may treat as an authoritative negative answer.
//   'spawn-failed' the child never ran or died abnormally: spawn errors
//                  other than ENOENT (EACCES/EMFILE/EAGAIN), external
//                  signal kills, anything unexplained. Transient — must
//                  never be read as "not a repository".
//
// Git failures must never surface to a tool response: callers degrade by
// omitting sections. The runner is also the warn-dedup point (warnOnce) so
// a failing command logs once per session, not once per tool call.

import { execFile } from 'node:child_process';

import { errMsg, log } from '../logger.js';

export type GitFailureKind =
  | 'git-missing'
  | 'disabled'
  | 'aborted'
  | 'timeout'
  | 'maxbuffer'
  | 'exit'
  | 'spawn-failed';

export class GitError extends Error {
  readonly kind: GitFailureKind;
  readonly exitCode?: number;
  readonly stderr?: string;

  constructor(
    kind: GitFailureKind,
    message: string,
    opts: { exitCode?: number; stderr?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'GitError';
    this.kind = kind;
    if (opts.exitCode !== undefined) this.exitCode = opts.exitCode;
    if (opts.stderr !== undefined) this.stderr = opts.stderr;
  }
}

export interface GitRunOptions {
  timeoutMs?: number;
  maxBuffer?: number;
}

export type ExecFileFn = typeof execFile;

export interface GitRunnerOptions {
  // Binary to spawn (tests point this at stub scripts / missing paths).
  gitBin?: string;
  // Injection seam for spawn-counting tests.
  execFileImpl?: ExecFileFn;
}

// Structural surface of GitRunner — exactly what GitService consumes
// (`disabled` feeds the mid-session ENOENT transition). Lets tests
// inject scripted fakes without matching the class's private fields.
export interface GitRunnerLike {
  readonly disabled: boolean;
  run(args: string[], opts?: GitRunOptions): Promise<string>;
  tryRun(args: string[], opts?: GitRunOptions): Promise<string | null>;
  warnOnce(key: string, msg: string): void;
  abortAll(): void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
// Keep GitError.stderr bounded — git can echo whole pathspecs into stderr.
const STDERR_CAP = 500;

// Prepended to every invocation — pins of user-config settings that
// would otherwise corrupt parsing or behavior:
// - core.quotepath=false: without it git %-escapes non-ASCII bytes in
//   --name-only output ("\303\251"-style), which would never match the
//   raw POSIX paths used as index keys.
// - log.showSignature=false: a user-level log.showSignature=true would
//   inject GPG status lines into every log output, which the analyzer
//   would otherwise parse as file paths.
// - log.follow=false: a user-level log.follow=true silently turns the
//   single-pathspec recentCommits query into a full-history rename walk
//   (the documented no---follow decision).
// - diff.relative=false: a user-level diff.relative=true makes the bulk
//   `log --name-only` emit cwd-relative paths and DROP paths outside the
//   cwd subtree — in monorepo-subdirectory mode that zeroes the whole
//   analysis. The branch diff's explicit --relative flag still wins.
const GIT_ARGS_PREFIX = [
  '-c', 'core.quotepath=false',
  '-c', 'log.showSignature=false',
  '-c', 'log.follow=false',
  '-c', 'diff.relative=false',
] as const;

// Inherited git environment would silently override cwd-based repo
// discovery (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR/
// GIT_OBJECT_DIRECTORY), block upward discovery entirely
// (GIT_CEILING_DIRECTORIES — fatal for monorepo-subdirectory roots,
// where the clean exit-128 would read as "no repo" and wipe the cache),
// or inject parent-process config (GIT_CONFIG_PARAMETERS /
// GIT_CONFIG_COUNT, set by hooks). Strip them all so discovery is
// always anchored to the project root passed as cwd.
function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_CEILING_DIRECTORIES;
  delete env.GIT_CONFIG_PARAMETERS;
  delete env.GIT_CONFIG_COUNT;
  return env;
}

type ExecError = NodeJS.ErrnoException & {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
};

export class GitRunner {
  private readonly cwd: string;
  private readonly gitBin: string;
  private readonly execFileImpl: ExecFileFn;
  private readonly controllers = new Set<AbortController>();
  private readonly warned = new Set<string>();
  private disabledReason: string | null = null;

  constructor(cwd: string, opts: GitRunnerOptions = {}) {
    this.cwd = cwd;
    this.gitBin = opts.gitBin ?? 'git';
    this.execFileImpl = opts.execFileImpl ?? execFile;
  }

  get disabled(): boolean {
    return this.disabledReason !== null;
  }

  // Permanent for the session (git missing or gitEnabled=false). Later
  // run()/tryRun() calls fail fast without spawning.
  disableForSession(reason: string): void {
    if (this.disabledReason !== null) return;
    this.disabledReason = reason;
    this.warnOnce('disabled', `git: disabled for this session: ${reason}`);
  }

  warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(msg);
  }

  // Shutdown path: abort every in-flight child. Their promises reject with
  // kind 'aborted'; callers log those at debug.
  abortAll(): void {
    for (const controller of this.controllers) controller.abort();
  }

  async run(args: string[], opts: GitRunOptions = {}): Promise<string> {
    if (this.disabledReason !== null) {
      throw new GitError('disabled', `git disabled: ${this.disabledReason}`);
    }
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await new Promise<string>((resolvePromise, rejectPromise) => {
        this.execFileImpl(
          this.gitBin,
          [...GIT_ARGS_PREFIX, ...args],
          {
            cwd: this.cwd,
            env: sanitizedEnv(),
            encoding: 'utf8',
            timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
            signal: controller.signal,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            if (err === null) {
              resolvePromise(stdout as string);
              return;
            }
            rejectPromise(
              this.classify(
                err as ExecError,
                (stderr as string) ?? '',
                controller,
                opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              ),
            );
          },
        );
      });
    } finally {
      this.controllers.delete(controller);
    }
  }

  // null on any failure; logs at debug. For call sites where the caller
  // doesn't branch on the failure kind (cheap per-call queries).
  async tryRun(args: string[], opts: GitRunOptions = {}): Promise<string | null> {
    try {
      return await this.run(args, opts);
    } catch (err) {
      log.debug(`git: ${args[0] ?? '?'} failed: ${errMsg(err)}`);
      return null;
    }
  }

  private classify(
    err: ExecError,
    stderr: string,
    controller: AbortController,
    timeoutMs: number,
  ): GitError {
    const stderrCapped = stderr.trim().slice(0, STDERR_CAP);
    // Our own abort also reports killed/ABORT_ERR — check the signal first
    // so shutdown never masquerades as a timeout.
    if (controller.signal.aborted) {
      return new GitError('aborted', 'git call aborted', { cause: err });
    }
    if (err.code === 'ENOENT') {
      this.disableForSession(`'${this.gitBin}' not found on PATH`);
      return new GitError('git-missing', `git executable not found: ${this.gitBin}`, {
        cause: err,
      });
    }
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return new GitError('maxbuffer', 'git output exceeded maxBuffer', {
        stderr: stderrCapped,
        cause: err,
      });
    }
    if (err.killed === true) {
      return new GitError('timeout', `git timed out after ${timeoutMs}ms`, {
        stderr: stderrCapped,
        cause: err,
      });
    }
    if (typeof err.code === 'number') {
      return new GitError('exit', `git exited with code ${err.code}`, {
        exitCode: err.code,
        stderr: stderrCapped,
        cause: err,
      });
    }
    // Anything left never produced a numeric exit: spawn errors with
    // string errno codes (EACCES/EMFILE/EAGAIN), external signal kills
    // (code null, signal set), or unknown shapes. These are transient —
    // classifying them as 'exit' would let the detection probe read an
    // fd-pressure blip as "not a repository" and wipe the cache.
    return new GitError('spawn-failed', errMsg(err), {
      stderr: stderrCapped,
      cause: err,
    });
  }
}
