#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, resolveCacheDir } from "./config.js";
import { CodeIndex } from "./indexer/code-index.js";
import { Indexer } from "./indexer/pipeline.js";
import { errMsg, log } from "./logger.js";
import { createServer } from "./server.js";
import type { ProbeConfig } from "./types.js";

let initial: ProbeConfig;
try {
  initial = loadConfig();
} catch (err) {
  log.error(`probe-mcp: invalid config: ${errMsg(err)}`);
  process.exit(1);
}
let cacheDir: string;
try {
  cacheDir = await resolveCacheDir(initial);
} catch (err) {
  log.error(`probe-mcp: failed to resolve cache directory: ${errMsg(err)}`);
  process.exit(1);
}
const config = Object.freeze({ ...initial, cacheDir });
const index = new CodeIndex(config.projectRoot);
const indexer = new Indexer(config, index);

const indexingPromise = (async () => {
  const loaded = await index.load(indexer.cachePath);
  if (loaded) {
    log.debug("Indexer: cache loaded; running indexChanged");
    await indexer.indexChanged();
  } else {
    log.debug("Indexer: no cache; running indexAll");
    await indexer.indexAll();
  }
})();
// Attach .catch synchronously so a rejection during indexing can't crash the
// process under --unhandled-rejections=throw. The server stays up either way.
indexingPromise.catch((err) => {
  log.error(`Indexer top-level failure: ${errMsg(err)}`);
});

const server = createServer({ index, indexer, config });
await server.connect(new StdioServerTransport());
