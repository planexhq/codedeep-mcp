// Debounced fs.watch wrapper driving live incremental re-indexing.
//
// Platform notes (fs.watch recursive): native on macOS (FSEvents) and
// Windows (ReadDirectoryChangesW); on Linux, Node >= 20 emulates it with
// one inotify watch per directory, so very large trees can exhaust
// fs.inotify.max_user_watches — that surfaces as an 'error' event, which
// disables the watcher while the server keeps serving from the existing
// index (indexChanged heals on next start). The `watchFactory` seam is
// the swap point for a chokidar backend if that ever bites in practice.
//
// Persistence: the design notes suggested a 5-minute save timer; this saves once
// per debounced flush instead — data loss is bounded by one debounce
// window rather than five minutes, there is no extra keep-alive timer to
// manage, and saves are event-driven (no disk writes when idle).
// CodeIndex.save is mutexed and atomic, so per-flush saves are safe.

import { watch as fsWatch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { errMsg, log } from '../logger.js';
import type { CodedeepConfig } from '../types.js';
import type { CodeIndex } from './code-index.js';
import type { Indexer } from './pipeline.js';
import { compileExcludeMatcher, isBinaryByExtension, toPosix } from './scanner.js';

// Minimal backend surface so tests (and a future chokidar swap) can
// substitute the event source.
export interface WatchBackend {
  close(): void;
}

export type WatchFactory = (
  root: string,
  onEvent: (eventType: string, filename: string | Buffer | null) => void,
  onError: (err: unknown) => void,
) => WatchBackend;

const defaultWatchFactory: WatchFactory = (root, onEvent, onError) => {
  const w = fsWatch(root, { recursive: true });
  w.on('change', onEvent);
  w.on('error', onError);
  // The stdio transport governs process lifetime. Without unref, the
  // watcher's libuv handle would keep the process alive forever after
  // the MCP client closes stdin.
  w.unref();
  return w;
};

export interface WatcherOptions {
  debounceMs?: number;
  // Backoff while the indexer is busy (startup indexAll) or paths were
  // dropped by the concurrency guard.
  retryMs?: number;
  // Hard ceiling on how long the trailing debounce may postpone a flush
  // while events keep arriving (a continuously-written file would
  // otherwise starve every other pending edit indefinitely).
  maxFlushDelayMs?: number;
  watchFactory?: WatchFactory;
}

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_RETRY_MS = 250;
const DEFAULT_MAX_FLUSH_DELAY_MS = 1000;
// Each incomplete rescan costs a full scanProject walk; bound the retries
// so a permanently unreadable subdirectory degrades gracefully.
const MAX_INCOMPLETE_RESCANS = 5;

export class Watcher {
  private readonly matchExclude: (relPath: string) => boolean;
  private readonly debounceMs: number;
  private readonly retryMs: number;
  private readonly maxFlushDelayMs: number;
  private readonly watchFactory: WatchFactory;
  // Canonical project-relative POSIX paths awaiting a flush.
  private readonly pending = new Set<string>();
  private rescanPending = false;
  // Consecutive rescans that completed but saw a PARTIAL scan (transient
  // readdir failures). Bounded so a permanently unreadable subdirectory
  // can't turn the retry tick into a full-scan-every-250ms loop.
  private incompleteRescans = 0;
  // Wall-clock bound for the current accumulation window (max-wait).
  private flushDeadline: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> = Promise.resolve();
  private backend: WatchBackend | null = null;
  private closed = false;

  constructor(
    private readonly indexer: Indexer,
    private readonly index: CodeIndex,
    private readonly config: CodedeepConfig,
    options: WatcherOptions = {},
  ) {
    this.matchExclude = compileExcludeMatcher(config.exclude);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.maxFlushDelayMs = options.maxFlushDelayMs ?? DEFAULT_MAX_FLUSH_DELAY_MS;
    this.watchFactory = options.watchFactory ?? defaultWatchFactory;
  }

  // Never throws: a watcher failure must degrade to "no live updates",
  // not crash the server.
  start(): void {
    if (this.backend || this.closed) return;
    try {
      this.backend = this.watchFactory(
        this.config.projectRoot,
        (eventType, filename) => {
          try {
            this.handleEvent(eventType, filename);
          } catch (err) {
            log.warn(`watcher: event handling failed: ${errMsg(err)}`);
          }
        },
        (err) => {
          // e.g. Linux inotify watch exhaustion (ENOSPC).
          log.warn(
            `watcher: backend error (${errMsg(err)}); live re-indexing disabled`,
          );
          this.backend?.close();
          this.backend = null;
        },
      );
      log.debug(`watcher: watching ${this.config.projectRoot} (recursive)`);
    } catch (err) {
      log.warn(
        `watcher: fs.watch unavailable (${errMsg(err)}); live re-indexing disabled`,
      );
      this.backend = null;
    }
  }

  // Stops the event source, waits for any in-flight drain, then runs one
  // FINAL drain of whatever is still pending so the last debounce batch is
  // not discarded (it saves through the normal per-flush path, so close()
  // leaves the on-disk cache current). Idempotent: a concurrent second
  // close() awaits the same final drain rather than resolving early.
  async close(): Promise<void> {
    if (this.closed) return this.settle();
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.backend?.close();
    this.backend = null;
    // Chaining serializes after any in-flight drain; a final drain over
    // an empty state is a no-op, so no pre-check is needed.
    this.flush(true);
    await this.settle();
  }

  // Awaits the current flush chain (drains already started or chained;
  // NOT timers still pending). Used by close() and tests.
  async settle(): Promise<void> {
    await this.flushPromise;
  }

  // Public so unit tests can drive events without a real fs.watch.
  // Must stay cheap and exception-free — it runs on every OS event.
  handleEvent(eventType: string, filename: string | Buffer | null): void {
    if (this.closed) return;
    const name =
      typeof filename === 'string'
        ? filename
        : filename instanceof Buffer
          ? filename.toString('utf8')
          : null;
    if (name === null || name === '') {
      // Some platforms emit events without a filename; the only safe
      // recovery is a full incremental rescan.
      this.rescanPending = true;
      this.scheduleDebounced();
      return;
    }
    const rel = toPosix(name);
    // Pre-debounce storm filter (node_modules churn, binary assets).
    // indexFile re-checks everything; this only keeps the pending set
    // small. Unknown-language files are NOT filtered — they are
    // legitimately indexed for overview's "Other files" count.
    if (this.matchExclude(rel) || isBinaryByExtension(rel)) return;
    // 'rename' and 'change' are handled identically: indexFile stats the
    // path and treats a missing file as a deletion, which also covers
    // renames (one event per old/new name).
    this.pending.add(rel);
    this.scheduleDebounced();
  }

  // Trailing debounce capped by the max-wait deadline: each event pushes
  // the flush out by debounceMs, but never past maxFlushDelayMs after the
  // window's first event.
  private scheduleDebounced(): void {
    this.flushDeadline ??= Date.now() + this.maxFlushDelayMs;
    const remaining = Math.max(0, this.flushDeadline - Date.now());
    this.schedule(Math.min(this.debounceMs, remaining));
  }

  private schedule(delayMs: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
    this.timer.unref?.();
  }

  // Chains drains on flushPromise so they never overlap — watcher updates
  // are processed sequentially, and close() can await the tail.
  private flush(final = false): void {
    this.flushPromise = this.flushPromise
      .then(() => this.drain(final))
      .catch((err) => {
        log.error(`watcher: flush failed: ${errMsg(err)}`);
      });
  }

  // `final` is the close()-time last pass: it ignores the closed flag,
  // never re-arms timers, and skips the rescan (indexChanged heals on
  // next start) in favor of flushing the per-file batch.
  private async drain(final = false): Promise<void> {
    if (this.closed && !final) return;
    // Until the startup indexAll/indexChanged completes, indexFile would
    // race the cache load (updates discarded by the load's Map swap, and
    // a premature save could clobber the populated on-disk cache) or be
    // dropped by the run guard — defer until the index is ready.
    if (this.indexer.isIndexing || !this.indexer.ready) {
      // Reset the max-wait window: nothing can flush while deferred, and
      // an expired deadline would turn every incoming event into an
      // immediate schedule(0), clobbering the retryMs backoff with
      // per-event timer churn for the rest of the busy period.
      this.flushDeadline = null;
      if (!final) this.schedule(this.retryMs);
      return;
    }

    // Snapshot: events arriving mid-drain re-enter pending and re-arm
    // the timer via handleEvent.
    const batch = [...this.pending];
    this.pending.clear();
    const rescan = this.rescanPending;
    this.rescanPending = false;
    this.flushDeadline = null;

    if (rescan && !final) {
      // The rescan covers the batched paths too — but only when its scan
      // completes, which a successful indexChanged does not guarantee
      // (a transiently unreadable directory yields a partial scan).
      // Re-queue the batch: paths the rescan DID cover become hash
      // no-ops in indexFile, while edits a partial scan missed stay
      // queued instead of being silently lost. A partial scan also
      // re-arms the rescan itself (bounded retries) — its trigger may
      // have had no batch representation (directory deletions).
      try {
        const ran = await this.indexer.indexChanged();
        if (!ran) {
          this.rescanPending = true;
        } else if (!this.indexer.lastScanComplete) {
          this.incompleteRescans++;
          if (this.incompleteRescans <= MAX_INCOMPLETE_RESCANS) {
            this.rescanPending = true;
          } else {
            log.error(
              `watcher: rescan saw ${this.incompleteRescans} consecutive partial scans; giving up until the next event (exclude the unreadable directory to silence this)`,
            );
            this.incompleteRescans = 0;
          }
        } else {
          this.incompleteRescans = 0;
        }
      } catch (err) {
        // Restore the flag so the retry tick heals a transient failure.
        this.rescanPending = true;
        log.error(`watcher: rescan failed: ${errMsg(err)}`);
      }
      for (const rel of batch) this.pending.add(rel);
      this.rearmIfNeeded();
      return;
    }

    // Stat phase: classify so deletions process before creations — at
    // the maxFiles cap, a rename's delete must free its slot before the
    // create claims one. Stats are independent; issue them concurrently
    // (threadpool-capped) so large batches on slow filesystems don't
    // serialize the flush.
    const stats = await Promise.all(
      batch.map((rel) =>
        lstat(join(this.config.projectRoot, rel)).catch(() => null),
      ),
    );
    const deleted: string[] = [];
    const present: string[] = [];
    for (let i = 0; i < batch.length; i++) {
      if (stats[i] === null) deleted.push(batch[i]);
      else if (!stats[i]!.isDirectory()) present.push(batch[i]);
      // A created/moved-in directory emits one event — its children may
      // emit none. Only a rescan finds them.
      else this.rescanPending = true;
    }
    if (!this.rescanPending) {
      // Deleted/moved-out directory: fs.watch gives no per-child events,
      // so indexed children need a rescan to prune — UNLESS this very
      // batch already carries every child's deletion (the common case:
      // per-child events land in the same window as the dir's), in
      // which case the per-file deletions below fully cover it.
      const deletedSet = new Set(deleted);
      for (const rel of deleted) {
        const children = this.index.filesUnder(`${rel}/`);
        if (children.length > 0 && children.some((c) => !deletedSet.has(c))) {
          this.rescanPending = true;
          break;
        }
      }
    }

    let mutated = false;
    let freedSlot = false;
    const capSkipped: string[] = [];
    for (const rel of [...deleted, ...present]) {
      if (this.closed && !final) {
        // close() mid-drain: keep the remainder queued for the final
        // drain that close() runs after this one settles.
        this.pending.add(rel);
        continue;
      }
      try {
        const outcome = await this.indexer.indexFile(rel);
        if (outcome === 'indexed' || outcome === 'removed') mutated = true;
        if (outcome === 'removed') freedSlot = true;
        else if (outcome === 'dropped') this.pending.add(rel); // guard drop — retry
        else if (outcome === 'cap-skipped') capSkipped.push(rel);
      } catch (err) {
        log.warn(`watcher: failed to index ${rel}: ${errMsg(err)}`);
      }
    }
    // Cap-skipped creations get ONE retry when this same batch freed a
    // slot (rename-at-cap whose delete was racing behind the create) —
    // re-queueing unconditionally would retry forever while at the cap.
    if (freedSlot) {
      for (const rel of capSkipped) this.pending.add(rel);
    }

    if (mutated) {
      try {
        await this.index.save(this.indexer.cachePath);
        log.debug(`watcher: saved cache after flush (${batch.length} paths)`);
      } catch (err) {
        log.error(`watcher: failed to save cache: ${errMsg(err)}`);
      }
    }
    if (!final) this.rearmIfNeeded();
  }

  private rearmIfNeeded(): void {
    // schedule() no-ops once closed; no second lifecycle guard here.
    if (this.pending.size > 0 || this.rescanPending) {
      this.schedule(this.retryMs);
    }
  }
}
