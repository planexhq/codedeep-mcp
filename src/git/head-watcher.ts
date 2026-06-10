// Live-refresh trigger for the git layer: a tiny non-recursive fs.watch
// on <gitdir>/logs/ filtered to the HEAD reflog. logs/HEAD is appended on
// every commit, checkout, merge, reset, and rebase step — exactly the
// events after which hotspots/co-change data should refresh. The main
// project watcher never sees these (.git is in DEFAULT_EXCLUDES); this
// watcher exists only for that one file.
//
// Watching the DIRECTORY and filtering on filename survives the
// rotate/replace edge cases that a direct file watch does not (same
// robustness reasoning as src/indexer/watcher.ts). Rebases append in
// bursts, hence the trailing 1s debounce — much coarser than the source
// watcher's 100ms because a refresh costs a whole git log pass.

import { watch as fsWatch } from 'node:fs';
import { dirname, basename } from 'node:path';

import type { WatchBackend, WatchFactory } from '../indexer/watcher.js';
import { errMsg, log } from '../logger.js';

// Same backend/factory shape as the source watcher — single-sourced from
// watcher.ts so the two seams cannot drift; aliased because at this layer
// the watched thing is the HEAD reflog, not the project tree.
export type HeadWatchBackend = WatchBackend;
export type HeadWatchFactory = WatchFactory;

const defaultFactory: HeadWatchFactory = (dir, onEvent, onError) => {
  const w = fsWatch(dir, { recursive: false });
  w.on('change', onEvent);
  w.on('error', onError);
  // The stdio transport governs process lifetime, never this watcher.
  w.unref();
  return w;
};

export const DEFAULT_HEAD_DEBOUNCE_MS = 1_000;
// Max-wait cap on the trailing debounce: a sustained commit stream
// (scripted rebases, CI bots) must not postpone the refresh forever.
// Coarse — each refresh costs a whole git log pass.
export const DEFAULT_HEAD_MAX_DELAY_MS = 15_000;

export class HeadWatcher {
  private readonly dir: string;
  private readonly file: string;
  private readonly debounceMs: number;
  private readonly maxDelayMs: number;
  private readonly factory: HeadWatchFactory;
  private backend: HeadWatchBackend | null = null;
  private timer: NodeJS.Timeout | null = null;
  // Wall-clock bound for the current accumulation window.
  private deadline: number | null = null;
  private closed = false;

  constructor(
    headLogPath: string,
    private readonly onChange: () => void,
    options: {
      debounceMs?: number;
      maxDelayMs?: number;
      watchFactory?: HeadWatchFactory;
      // Fired synchronously on the FIRST event of each accumulation
      // window (the trailing onChange fires after the debounce). Lets
      // the owner invalidate memos the moment the reflog moves, instead
      // of serving values computed mid-rebase for up to maxDelayMs.
      onWindowStart?: () => void;
    } = {},
  ) {
    this.dir = dirname(headLogPath);
    this.file = basename(headLogPath);
    this.debounceMs = options.debounceMs ?? DEFAULT_HEAD_DEBOUNCE_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_HEAD_MAX_DELAY_MS;
    this.factory = options.watchFactory ?? defaultFactory;
    this.onWindowStart = options.onWindowStart;
  }

  private readonly onWindowStart: (() => void) | undefined;

  // False when the logs dir is missing or fs.watch fails — the caller
  // degrades to startup-only refresh (staleness still heals on the next
  // server start). Never throws.
  start(): boolean {
    if (this.backend || this.closed) return this.backend !== null;
    try {
      this.backend = this.factory(
        this.dir,
        (_eventType, filename) => this.handleEvent(filename),
        (err) => {
          log.debug(`git: HEAD watch error (${errMsg(err)}); live refresh off`);
          this.close();
        },
      );
      return true;
    } catch (err) {
      log.debug(
        `git: cannot watch ${this.dir} (${errMsg(err)}); live refresh off`,
      );
      return false;
    }
  }

  private handleEvent(filename: string | Buffer | null): void {
    if (this.closed) return;
    // A null filename means the platform couldn't attribute the event;
    // treat it as potentially-HEAD rather than dropping a real commit.
    if (filename !== null && filename.toString() !== this.file) return;
    if (this.timer !== null) clearTimeout(this.timer);
    // Trailing debounce: rebases append many reflog entries back to
    // back; only the last one should trigger a refresh. The wall-clock
    // deadline caps how long a continuous stream can keep postponing.
    if (this.deadline === null) {
      this.deadline = Date.now() + this.maxDelayMs;
      this.onWindowStart?.();
    }
    const delay = Math.max(
      0,
      Math.min(this.debounceMs, this.deadline - Date.now()),
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadline = null;
      if (!this.closed) this.onChange();
    }, delay);
    this.timer.unref();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.backend?.close();
    } catch {
      // closing a dead FSWatcher must never propagate
    }
    this.backend = null;
  }
}
