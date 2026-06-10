// GitService — the facade the server hands to tools. Owns the runner and
// the analysis lifecycle:
//
//   - detection at start(): one `rev-parse` probe decides 'ready' /
//     'no-repo' / 'disabled' for the whole session;
//   - the bulk analysis pass (hotspots + co-change), persisted into the
//     CodeIndex cache, refreshed when stale (HEAD moved, window changed,
//     or older than a day);
//   - cheap per-call queries (branch summary, recent commits per file),
//     never persisted, memoized per generation.
//
// Degradation contract: NO method ever throws and none surface errors to
// tool output — every failure path returns null/empty so tools simply
// omit git sections. The service is constructed even when git is off so
// the ServerDeps shape stays uniform.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { CodeIndex } from '../indexer/code-index.js';
import { errMsg, log } from '../logger.js';
import type { ProbeConfig } from '../types.js';
import { GIT_COMMIT_CAP, analyzeLog, buildLogArgs } from './analyzer.js';
import { HeadWatcher } from './head-watcher.js';
import { GitError, GitRunner, type GitRunOptions, type GitRunnerLike } from './runner.js';

export type GitState = 'unknown' | 'disabled' | 'no-repo' | 'ready';

export interface BranchSummary {
  // Branch name, or `HEAD (detached at <short>)` when detached.
  branch: string;
  // Resolution order: origin/HEAD -> local main -> local master -> null.
  defaultBranch: string | null;
  // Commits on HEAD that the default branch lacks. ahead and
  // changedFiles each degrade to null INDEPENDENTLY on a transient probe
  // failure; both are null when no default branch resolves at all.
  ahead: number | null;
  // Files changed on the branch vs the merge base (triple-dot diff),
  // PROJECT-relative (scoped to the project subtree via --relative) so
  // they match index keys. Committed state only, which is what makes
  // the per-generation memo sound: the answer only changes when HEAD
  // moves.
  changedFiles: string[] | null;
}

export interface RecentCommit {
  hash: string; // short
  date: string; // committer date, YYYY-MM-DD
  subject: string;
}

// The bulk pass gets generous limits (whole-window history of a large
// repo); per-call queries stay snappy and just degrade on timeout.
const ANALYSIS_TIMEOUT_MS = 30_000;
const ANALYSIS_MAX_BUFFER = 64 * 1024 * 1024;
const QUICK_TIMEOUT_MS = 3_000;
// The window is relative to "now", so counts drift as commits age out —
// refresh a fresh-HEAD analysis once a day anyway.
const ANALYSIS_MAX_AGE_MS = 24 * 3_600_000;
const RECENT_MEMO_CAP = 256;
const RECENT_COMMITS_DEFAULT = 5;
// Per-call startup retries (maybeRetryStartup) are bounded: at most one
// attempt per interval, so a permanently failing bulk pass cannot turn
// every tool call into a 30s/64MB git child.
const STARTUP_RETRY_BACKOFF_MS = 60_000;

export class GitService {
  private readonly config: ProbeConfig;
  private readonly index: CodeIndex;
  private readonly cachePath: string;
  private readonly runner: GitRunnerLike;

  private stateValue: GitState = 'unknown';
  // Resolved actual git dir (`.git` may be a FILE in worktrees); the
  // head-watcher (live refresh) attaches here.
  private gitDir: string | null = null;
  // Non-empty when the project root is a SUBDIRECTORY of the git
  // toplevel (monorepo package): repo-relative log paths must be
  // stripped by this prefix to match project-relative index keys.
  private pathPrefix = '';
  private headWatcher: HeadWatcher | null = null;
  private readonly headDebounceMs: number | undefined;

  // Bumped when a completed analysis lands (and, later, on HEAD-watch
  // events). Memos and the search boost map key off it.
  private generationValue = 0;
  private branchMemo: { gen: number; value: BranchSummary | null } | null = null;
  private recentMemo = new Map<string, { gen: number; value: RecentCommit[] }>();

  // Single-flight: a refresh requested while one is running coalesces
  // into exactly one trailing rerun.
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  // True while a startup retry (maybeRetryStartup) is in flight — at
  // most one at a time, rate-limited by nextStartupRetryAt.
  private retryingStartup = false;
  private nextStartupRetryAt = 0;
  // Retries must NOT run before the official start() settles: tools are
  // served while startup indexing is still populating the index, and an
  // early retry would run startInner (duplicate watcher) and persist an
  // analysis built against a PARTIAL index as fresh — exactly what the
  // index.ts start-after-indexing chaining exists to prevent.
  private startSettled = false;
  // Set when a bulk pass failed transiently or was skipped over an empty
  // index — lets the per-call retry re-attempt the analysis even though
  // a (stale) gitMeta exists. Cleared on successful apply.
  private analysisRetryNeeded = false;
  private closed = false;

  constructor(
    config: ProbeConfig,
    index: CodeIndex,
    cachePath: string,
    runner?: GitRunnerLike,
    options: { headDebounceMs?: number } = {},
  ) {
    this.config = config;
    this.index = index;
    this.cachePath = cachePath;
    this.runner = runner ?? new GitRunner(config.projectRoot);
    this.headDebounceMs = options.headDebounceMs;
  }

  get state(): GitState {
    return this.stateValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  // Detection + initial analysis. Never throws; never blocks server
  // startup (the caller backgrounds it AFTER the index is populated —
  // analyzing against an empty index would persist an empty result
  // marked fresh).
  async start(): Promise<void> {
    try {
      await this.startInner();
    } catch (err) {
      log.warn(`git: startup failed: ${errMsg(err)}`);
    } finally {
      this.startSettled = true;
    }
  }

  private async startInner(): Promise<void> {
    if (this.closed) return;
    if (!this.config.gitEnabled) {
      this.stateValue = 'disabled';
      log.debug('git: disabled by config (gitEnabled=false)');
      await this.clearPersistedGitData('gitEnabled=false');
      return;
    }
    // --show-prefix is the subdirectory-of-toplevel detector: empty at
    // the repo root, 'packages/app/' when the project root is a
    // monorepo package. Without it, every log path would miss the index.
    // run() (not tryRun) so the failure KIND survives: only a clean
    // non-zero exit means "not a repository". A transient timeout /
    // maxBuffer / shutdown abort must NOT classify as no-repo — that
    // branch wipes the persisted enrichment, and the repo may be fine.
    let probe: string;
    try {
      probe = await this.runner.run(
        ['rev-parse', '--is-inside-work-tree', '--git-dir', '--show-prefix'],
        { timeoutMs: QUICK_TIMEOUT_MS },
      );
    } catch (err) {
      if (this.closed) return;
      const kind = err instanceof GitError ? err.kind : null;
      if (kind === 'exit') {
        // Plain exit-128 non-repo is a normal deployment, debug only.
        this.stateValue = 'no-repo';
        log.debug('git: no repository detected; enrichment off');
        await this.clearPersistedGitData('no repository');
      } else if (kind === 'git-missing' || kind === 'disabled') {
        // ENOENT already session-disabled the runner (with one warn).
        this.stateValue = 'disabled';
        await this.clearPersistedGitData('git unavailable');
      } else {
        // timeout / maxbuffer / aborted / unknown: transient. Keep the
        // persisted data (stale beats none) and stay in 'unknown' —
        // sections that need 'ready' degrade, analysis-derived ones
        // keep serving the cache.
        log.debug(
          `git: detection failed transiently (${errMsg(err)}); enrichment off this session`,
        );
      }
      return;
    }
    if (this.closed) return;
    // Split WITHOUT trimming the whole probe first: the --show-prefix
    // line is legitimately empty at the toplevel.
    const lines = probe.split('\n');
    if (lines[0]?.trim() !== 'true') {
      // Bare repo or cwd inside .git — no work tree to enrich.
      this.stateValue = 'no-repo';
      log.debug('git: not inside a work tree; enrichment off');
      await this.clearPersistedGitData('no work tree');
      return;
    }
    this.gitDir = resolve(this.config.projectRoot, lines[1]?.trim() ?? '.git');
    this.pathPrefix = lines[2]?.trim() ?? '';
    this.stateValue = 'ready';
    this.startHeadWatcher();
    await this.ensureFreshAnalysis();
  }

  // Persisted enrichment from an earlier enabled session must not keep
  // rendering when it can never refresh again (kill switch flipped, repo
  // deleted, git uninstalled). Clearing also nulls gitMeta, so
  // re-enabling later triggers a clean re-analysis. Never during
  // shutdown: an aborted probe must not gut a healthy warm cache.
  private async clearPersistedGitData(reason: string): Promise<void> {
    if (this.closed) return;
    try {
      if (!(await this.index.clearGitData())) return;
      log.debug(`git: cleared persisted git data (${reason})`);
      await this.index.save(this.cachePath);
    } catch (err) {
      log.debug(`git: failed to clear persisted data: ${errMsg(err)}`);
    }
  }

  // Live refresh: <gitdir>/logs/HEAD changes on every commit, checkout,
  // merge, and rebase. When it can't be watched (no reflog, fs.watch
  // failure) we degrade to startup-only freshness — staleness heals on
  // the next server start.
  private startHeadWatcher(): void {
    // Idempotent: a retry re-running startInner must not overwrite (and
    // leak) an already-attached watcher — the orphan would double every
    // onHeadChanged and survive close().
    if (this.headWatcher !== null) return;
    if (this.gitDir === null || this.closed) return;
    const headLogPath = join(this.gitDir, 'logs', 'HEAD');
    if (!existsSync(headLogPath)) {
      log.debug(`git: ${headLogPath} missing; live refresh unavailable`);
      return;
    }
    this.headWatcher = new HeadWatcher(headLogPath, () => this.onHeadChanged(), {
      debounceMs: this.headDebounceMs,
      // Leading edge: the moment the reflog moves, the branch/recent
      // memos describe a world that may have changed — invalidate NOW
      // rather than serving a mid-rebase snapshot until the trailing
      // debounce (up to maxDelayMs) lands the analysis refresh.
      onWindowStart: () => this.bumpGeneration(),
    });
    if (!this.headWatcher.start()) this.headWatcher = null;
  }

  // The generation bumps IMMEDIATELY (not just after the analysis lands):
  // branch summary and recent-commits memos answer from HEAD's committed
  // state, which has definitely changed; the analysis refresh follows in
  // the background, bumping again when it applies.
  private onHeadChanged(): void {
    this.bumpGeneration();
    void this.ensureFreshAnalysis().catch((err) =>
      log.debug(`git: head-change refresh failed: ${errMsg(err)}`),
    );
  }

  // Re-analyze when the persisted gitMeta no longer matches reality.
  // The warm path — cache already loaded with matching HEAD/window —
  // returns without spawning anything beyond one rev-parse.
  async ensureFreshAnalysis(): Promise<void> {
    if (this.stateValue !== 'ready' || this.closed) return;
    const headRaw = await this.runner.tryRun(['rev-parse', 'HEAD'], {
      timeoutMs: QUICK_TIMEOUT_MS,
    });
    if (headRaw === null) return; // no usable answer (unborn HEAD or transient failure)
    const head = headRaw.trim();
    const meta = this.index.getGitMeta();
    const fresh =
      meta !== null &&
      meta.head === head &&
      meta.windowDays === this.config.gitWindow &&
      Date.now() - meta.analyzedAt <= ANALYSIS_MAX_AGE_MS;
    if (fresh && !this.analysisRetryNeeded) return;
    await this.runAnalysis(head);
  }

  private runAnalysis(head: string): Promise<void> {
    if (this.inFlight) {
      this.rerunRequested = true;
      return this.inFlight;
    }
    this.inFlight = this.doAnalysis(head).finally(() => {
      this.inFlight = null;
      if (this.rerunRequested && !this.closed) {
        this.rerunRequested = false;
        // Re-resolve HEAD — the rerun exists because it moved mid-run.
        void this.ensureFreshAnalysis().catch((err) =>
          log.debug(`git: rerun failed: ${errMsg(err)}`),
        );
      }
    });
    return this.inFlight;
  }

  private async doAnalysis(head: string): Promise<void> {
    // Cheap pre-spawn guard: an empty index cannot accept an analysis —
    // don't pay a (up to 30s / 64MB) bulk pass to discover that. The
    // post-await twin below still covers an index emptied mid-pass.
    if (this.index.fileCount === 0) {
      log.debug('git: index empty; skipping analysis');
      this.analysisRetryNeeded = true;
      return;
    }
    let stdout: string;
    try {
      stdout = await this.runner.run(buildLogArgs(this.config.gitWindow), {
        timeoutMs: ANALYSIS_TIMEOUT_MS,
        maxBuffer: ANALYSIS_MAX_BUFFER,
      });
    } catch (err) {
      const kind = err instanceof GitError ? err.kind : null;
      if (kind === 'aborted') {
        log.debug('git: analysis aborted (shutdown)');
      } else if (kind === 'git-missing' || kind === 'disabled') {
        // git vanished MID-SESSION (toolchain/PATH swap): the persisted
        // enrichment can never refresh again — same contract as the
        // detection-time disabled path.
        this.stateValue = 'disabled';
        await this.clearPersistedGitData('git unavailable');
      } else {
        // Keep whatever data the cache already holds — stale beats none;
        // the per-call retry hook may re-attempt later (backoff-bounded).
        this.analysisRetryNeeded = true;
        this.runner.warnOnce(
          'bulk-log',
          `git: history analysis failed (${errMsg(err)}); keeping previous git data`,
        );
      }
      return;
    }
    // Re-check after the await: a shutdown that raced the bulk pass must
    // not apply + save behind the watchdog's back.
    if (this.closed) {
      log.debug('git: analysis discarded (shutting down)');
      return;
    }
    // An empty index means startup indexing has not populated (or failed)
    // — applying now would persist an empty analysis whose fresh gitMeta
    // suppresses the real one for up to 24h. Skip; staleness re-triggers.
    if (this.index.fileCount === 0) {
      log.debug('git: index empty; skipping analysis apply');
      this.analysisRetryNeeded = true;
      return;
    }
    const analysis = analyzeLog(
      stdout,
      (p) => this.index.hasFile(p),
      this.pathPrefix,
    );
    if (analysis.commitCount >= GIT_COMMIT_CAP) {
      log.debug(
        `git: analysis hit the ${GIT_COMMIT_CAP}-commit cap; older activity is not counted`,
      );
    }
    await this.index.applyGitAnalysis({
      counts: analysis.counts,
      cochanges: analysis.cochanges,
      hotspots: analysis.hotspots,
      meta: {
        head,
        windowDays: this.config.gitWindow,
        analyzedAt: Date.now(),
      },
    });
    this.analysisRetryNeeded = false;
    // Bump BEFORE the save: memo/boost invalidation must be atomic with
    // the data swap, not deferred behind a potentially slow cache write.
    this.bumpGeneration();
    try {
      await this.index.save(this.cachePath);
    } catch (err) {
      this.runner.warnOnce(
        'analysis-save',
        `git: failed to persist analysis: ${errMsg(err)}`,
      );
    }
    log.debug(
      `git: analysis complete (${analysis.commitCount} commits, ` +
        `${analysis.hotspots.length} hotspots, head ${head.slice(0, 7)})`,
    );
  }

  private bumpGeneration(): void {
    this.generationValue++;
    this.branchMemo = null;
    this.recentMemo.clear();
  }

  async branchSummary(): Promise<BranchSummary | null> {
    if (this.closed) return null;
    // BEFORE the ready gate: the retry hook is what heals 'unknown'
    // (transient detection failure) — gating it on 'ready' would make
    // that state permanent.
    this.maybeRetryStartup();
    if (this.stateValue !== 'ready') return null;
    if (this.branchMemo?.gen === this.generationValue) return this.branchMemo.value;
    // Capture the generation BEFORE computing: if a HEAD change lands
    // mid-computation (bumpGeneration clears the memo), the straggler
    // must not restamp its possibly-torn result as current — stamped
    // with the captured gen, it self-invalidates on the next lookup.
    const gen = this.generationValue;
    const { value, degraded } = await this.computeBranchSummary();
    // Memoize only complete, failure-free answers: a degraded summary
    // (some probe failed transiently — possibly a FABRICATED field like
    // detached-HEAD from a timed-out symbolic-ref) pinned for a whole
    // generation could serve a wrong branch all session.
    if (value !== null && !degraded) this.branchMemo = { gen, value };
    return value;
  }

  // Heals startup and mid-session races from tool calls, at most one
  // retry in flight and no more than once per minute — and never before
  // the official start() has settled (which itself runs only after
  // startup indexing). Cases: git vanished mid-session -> transition to
  // 'disabled' and clear; state 'unknown' (transient detection failure)
  // -> re-run the whole probe; state 'ready' with no analysis landed, a
  // transiently-failed/skipped bulk pass, or an analysis older than the
  // daily refresh -> re-attach the reflog watcher (if missing) and
  // re-attempt the analysis. 'disabled' and 'no-repo' are permanent.
  private maybeRetryStartup(): void {
    if (this.closed || this.retryingStartup || !this.startSettled) return;
    if (this.runner.disabled && this.stateValue !== 'disabled') {
      this.stateValue = 'disabled';
      void this.clearPersistedGitData('git unavailable');
      return;
    }
    if (this.stateValue !== 'unknown') {
      if (this.stateValue !== 'ready') return;
      const meta = this.index.getGitMeta();
      const staleByAge =
        meta !== null && Date.now() - meta.analyzedAt > ANALYSIS_MAX_AGE_MS;
      if (meta !== null && !this.analysisRetryNeeded && !staleByAge) return;
    }
    const now = Date.now();
    if (now < this.nextStartupRetryAt) return;
    this.nextStartupRetryAt = now + STARTUP_RETRY_BACKOFF_MS;
    this.retryingStartup = true;
    void (async () => {
      try {
        if (this.stateValue === 'unknown') {
          await this.startInner();
        } else {
          this.startHeadWatcher();
          await this.ensureFreshAnalysis();
        }
      } catch (err) {
        log.debug(`git: startup retry failed: ${errMsg(err)}`);
      } finally {
        this.retryingStartup = false;
      }
    })();
  }

  // Kind-aware probe for per-call queries: distinguishes a REAL negative
  // (clean non-zero exit — e.g. "no such ref", a memoizable answer) from
  // a transient failure (timeout, spawn error, shutdown abort) that must
  // never be memoized or read as a negative. Also refuses to spawn after
  // close().
  private async probe(
    args: string[],
    opts?: GitRunOptions,
  ): Promise<{ out: string | null; transient: boolean }> {
    if (this.closed) return { out: null, transient: true };
    try {
      return { out: await this.runner.run(args, opts), transient: false };
    } catch (err) {
      log.debug(`git: ${args[0] ?? '?'} failed: ${errMsg(err)}`);
      const kind = err instanceof GitError ? err.kind : null;
      return { out: null, transient: kind !== 'exit' };
    }
  }

  // `degraded` = some probe failed transiently, so the value (possibly
  // null, possibly missing fields) is NOT a faithful answer and must not
  // be memoized. Real negatives (clean non-zero exits: detached HEAD, no
  // origin, no main/master) do NOT degrade — they are the true state.
  private async computeBranchSummary(): Promise<{
    value: BranchSummary | null;
    degraded: boolean;
  }> {
    const q = { timeoutMs: QUICK_TIMEOUT_MS };
    let degraded = false;
    // Branch detection and default-branch detection are independent —
    // run their first probes concurrently (each is a child spawn, and
    // this is user-facing tool latency on the first call per generation).
    // symbolic-ref works on unborn branches (fresh init), where
    // `rev-parse --abbrev-ref HEAD` errors.
    const [symR, originR] = await Promise.all([
      this.probe(['symbolic-ref', '--short', '-q', 'HEAD'], q),
      this.probe(['rev-parse', '--abbrev-ref', 'origin/HEAD'], q),
    ]);
    // A transient symbolic-ref failure is NOT detached HEAD — fabricating
    // 'HEAD (detached at ...)' from it would misreport the branch.
    if (symR.transient) return { value: null, degraded: true };
    if (originR.transient) degraded = true;

    let branch: string;
    if (symR.out !== null && symR.out.trim().length > 0) {
      branch = symR.out.trim();
    } else {
      const shortR = await this.probe(['rev-parse', '--short', 'HEAD'], q);
      if (shortR.transient) return { value: null, degraded: true };
      if (shortR.out === null) return { value: null, degraded }; // empty repo
      branch = `HEAD (detached at ${shortR.out.trim()})`;
    }

    // base = the rev we diff against (may be a remote-tracking ref);
    // defaultBranch = its display name.
    let base: string | null = null;
    let defaultBranch: string | null = null;
    if (originR.out !== null && originR.out.trim().length > 0) {
      base = originR.out.trim();
      defaultBranch = base.replace(/^origin\//, '');
    } else if (!originR.transient) {
      for (const candidate of ['main', 'master']) {
        const okR = await this.probe(
          ['rev-parse', '--verify', '-q', `refs/heads/${candidate}`],
          q,
        );
        if (okR.transient) degraded = true;
        if (okR.out !== null) {
          base = candidate;
          defaultBranch = candidate;
          break;
        }
      }
    }

    if (base === null) {
      return {
        value: { branch, defaultBranch: null, ahead: null, changedFiles: null },
        degraded,
      };
    }
    if (branch === defaultBranch) {
      return {
        value: { branch, defaultBranch, ahead: 0, changedFiles: [] },
        degraded,
      };
    }

    // Independent of each other (both only need `base`); run together.
    // '-- .' scopes the diff to the project subtree and --relative makes
    // the output PROJECT-relative — every path leaving GitService must
    // match index keys, exactly like the analyzer's prefix mapping.
    const [aheadR, diffR] = await Promise.all([
      this.probe(['rev-list', '--count', `${base}..HEAD`], q),
      this.probe(
        ['diff', '--name-only', '--relative', `${base}...HEAD`, '--', '.'],
        q,
      ),
    ]);
    if (aheadR.transient || diffR.transient) degraded = true;
    const ahead = aheadR.out === null ? null : Number(aheadR.out.trim());
    const changedFiles =
      diffR.out === null
        ? null
        : diffR.out.split('\n').filter((l) => l.length > 0);
    return {
      value: {
        branch,
        defaultBranch,
        ahead: ahead !== null && Number.isFinite(ahead) ? ahead : null,
        changedFiles,
      },
      degraded,
    };
  }

  // Last N commits touching one file. No --follow: rename tracking costs
  // a full history walk per call; with renames the new path simply has a
  // shorter history. NUL field separators make parsing immune to any
  // subject content.
  async recentCommits(
    path: string,
    n: number = RECENT_COMMITS_DEFAULT,
  ): Promise<RecentCommit[]> {
    if (this.closed) return [];
    this.maybeRetryStartup();
    if (this.stateValue !== 'ready') return [];
    // The requested count is part of the memo key: a 2-row answer must
    // not be served to a caller asking for 5 (or vice versa).
    const memoKey = `${n}:${path}`;
    const memo = this.recentMemo.get(memoKey);
    if (memo && memo.gen === this.generationValue) return memo.value;
    // Captured pre-compute for the same reason as branchSummary.
    const gen = this.generationValue;

    // :(literal) disables pathspec magic: glob metacharacters in real
    // filenames must not attribute foreign commits, and a ':'-prefixed
    // name must not parse as pathspec syntax.
    const { out } = await this.probe(
      ['log', '-n', String(n), '--pretty=format:%h%x00%cs%x00%s', '--', `:(literal)${path}`],
      { timeoutMs: QUICK_TIMEOUT_MS },
    );
    // null = git did not give an answer (transient failure, or a real
    // exit like an unborn HEAD): return empty WITHOUT memoizing so the
    // next call retries. A successful empty answer (file never
    // committed) is a real result and is memoized below.
    if (out === null) return [];
    const value: RecentCommit[] = [];
    for (const line of out.split('\n')) {
      const parts = line.split('\u0000');
      if (parts.length === 3 && parts[0].length > 0) {
        value.push({ hash: parts[0], date: parts[1], subject: parts[2] });
      }
    }
    if (this.recentMemo.size >= RECENT_MEMO_CAP) {
      const oldest = this.recentMemo.keys().next().value;
      if (oldest !== undefined) this.recentMemo.delete(oldest);
    }
    this.recentMemo.set(memoKey, { gen, value });
    return value;
  }

  // Shutdown: kill in-flight children, never await the analysis — the
  // 10s shutdown watchdog must not ride on a git subprocess.
  close(): void {
    this.closed = true;
    this.headWatcher?.close();
    this.headWatcher = null;
    this.runner.abortAll();
  }
}
