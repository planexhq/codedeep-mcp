#!/usr/bin/env node
import { join } from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, resolveCacheDir } from "./config.js";
import { GitService } from "./git/git-service.js";
import { CodeIndex } from "./indexer/code-index.js";
import { Indexer } from "./indexer/pipeline.js";
import { Watcher } from "./indexer/watcher.js";
import { errMsg, log } from "./logger.js";
import { NoteStore } from "./notes/note-store.js";
import { createServer } from "./server.js";
import type { CodedeepConfig } from "./types.js";

let initial: CodedeepConfig;
try {
  initial = loadConfig();
} catch (err) {
  log.error(`codedeep-mcp: invalid config: ${errMsg(err)}`);
  process.exit(1);
}
let cacheDir: string;
try {
  cacheDir = await resolveCacheDir(initial);
} catch (err) {
  log.error(`codedeep-mcp: failed to resolve cache directory: ${errMsg(err)}`);
  process.exit(1);
}
const config = Object.freeze({ ...initial, cacheDir });
const index = new CodeIndex(config.projectRoot);
const indexer = new Indexer(config, index);

const indexingPromise = (async () => {
  const loaded = await index.load(indexer.cachePath);
  log.debug(
    loaded
      ? "Indexer: cache loaded; running indexChanged"
      : "Indexer: no cache; running indexAll",
  );
  // The run guard drops (not queues) concurrent requests. Nothing else can
  // hold it this early — the watcher defers until `ready`, which only the
  // startup run sets — so a refusal here means a code change broke that
  // invariant; surface it loudly rather than papering over it with retries.
  const ran = loaded ? await indexer.indexChanged() : await indexer.indexAll();
  if (!ran) {
    log.error("Indexer: startup indexing refused by run guard; index is stale");
  }
})();
// Attach .catch synchronously so a rejection during indexing can't crash the
// process under --unhandled-rejections=throw. The server stays up either way.
indexingPromise.catch((err) => {
  log.error(`Indexer top-level failure: ${errMsg(err)}`);
});

// Safe to start while the cache load / background index runs: the watcher
// defers its flushes until `indexer.ready`, so it can neither race the
// load's Map swap nor steal the startup run's concurrency guard.
let watcher: Watcher | null = null;
if (config.watch) {
  watcher = new Watcher(indexer, index, config);
  watcher.start();
}

// Git enrichment starts strictly AFTER the startup index resolves: the
// analyzer filters to fileByPath membership, so running against a
// cold/empty index would persist an EMPTY analysis whose gitMeta marks
// it fresh for a day. The .catch(() => {}) keeps git alive when
// indexChanged fails over a successfully loaded cache. Tool calls served
// before the first analysis simply omit git sections (warm starts get
// them instantly from the v5 cache).
// git.start() never throws (it catches internally), and the leading
// .catch makes the chain unrejectable — one line, one error path.
const git = new GitService(config, index, indexer.cachePath);
void indexingPromise.catch(() => {}).then(() => git.start());

// The note store is independent of the code index (notes are primary,
// non-rebuildable user data, NOT derived from source), so it survives every
// index invalidation. It sits next to index.json under the resolved cacheDir,
// inheriting the read-only-root ~/.cache fallback and the `.codedeep` scanner
// exclude. Write-through saves on each remember/forget mean no shutdown flush is
// needed. load() is FIRE-AND-FORGET (like git.start below): it never throws
// (quarantines on corruption) and is memoized, and every note tool re-awaits it
// before acting — so we must NOT block server.connect (and the 6 structural
// tools that never touch notes) on note-store disk I/O, which can be slow on a
// networked cacheDir or one cluttered with stale .tmp/.bak entries.
const notes = new NoteStore(join(config.cacheDir, "notes.json"), config.projectRoot);
void notes.load();

// Flush-on-shutdown — the watcher's per-flush saves bound the loss window,
// but exiting between flushes shouldn't discard the last debounce batch.
// watcher.close() drains that batch and persists through its normal save
// path (and refuses to touch the index before the startup run completes),
// so no separate save is needed here.
//
// The graceful work is raced against a watchdog — a save wedged on a
// dead network mount must not orphan the process after the client is
// gone. Exit codes are honest: 0 only when the flush completed; 1 when
// the watchdog cut it, it failed, or a signal escalated past it.
const SHUTDOWN_WATCHDOG_MS = 10_000;
let shuttingDown = false;
function shutdown(
  reason: string,
  waitForStartup: boolean,
  // Signals escalate an in-flight graceful shutdown to an immediate
  // exit. Duplicate stdin events ('end' then 'close' fire back-to-back
  // on EOF) must NOT — they'd cut the flush they themselves started.
  escalateIfShuttingDown = false,
): void {
  if (shuttingDown) {
    if (escalateIfShuttingDown) {
      log.debug("codedeep-mcp: signal during shutdown; exiting immediately");
      process.exit(1);
    }
    return;
  }
  shuttingDown = true;
  log.debug(`codedeep-mcp: ${reason}; flushing watcher before exit`);
  void (async () => {
    let code = 1;
    try {
      const work = (async () => {
        // Client disconnect is not urgent — let an in-flight startup
        // index finish (it persists internally) as the pre-watcher
        // server did. Signals skip the wait: the user wants out now.
        if (waitForStartup) await indexingPromise.catch(() => {});
        // Sync-fast: aborts in-flight git children. Never awaits the
        // analysis — the watchdog must not ride on a git subprocess.
        git.close();
        await watcher?.close();
      })();
      const watchdog = new Promise<"timeout">((resolve) => {
        const t = setTimeout(() => resolve("timeout"), SHUTDOWN_WATCHDOG_MS);
        t.unref();
      });
      const outcome = await Promise.race([
        work.then(() => "done" as const),
        watchdog,
      ]);
      if (outcome === "done") code = 0;
      else log.warn("codedeep-mcp: shutdown watchdog fired; exiting with flush incomplete");
    } catch (err) {
      log.warn(`codedeep-mcp: shutdown flush failed: ${errMsg(err)}`);
    } finally {
      process.exit(code);
    }
  })();
}
// `on`, not `once`: a REPEATED signal must reach the escalate path above
// instead of falling back to default disposition (uncontrolled kill).
process.on("SIGINT", () => shutdown("SIGINT received", false, true));
process.on("SIGTERM", () => shutdown("SIGTERM received", false, true));
// The PRIMARY MCP shutdown path is the client closing stdin — without
// this hook the unref'd watcher timer never fires again and the process
// exits with the last debounce batch unflushed and unsaved.
process.stdin.once("end", () => shutdown("stdin closed", true));
process.stdin.once("close", () => shutdown("stdin closed", true));

const server = createServer({ index, indexer, config, git, notes });
await server.connect(new StdioServerTransport());
