#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "./config.js";
import { CodeIndex } from "./indexer/code-index.js";
import { Indexer } from "./indexer/pipeline.js";
import { errMsg, log } from "./logger.js";
import { createServer } from "./server.js";

const config = loadConfig();
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

const server = createServer();
await server.connect(new StdioServerTransport());
