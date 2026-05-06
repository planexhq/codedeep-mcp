// Step 0b verification: spawns the spike server, drives it with a real
// JSON-RPC handshake (initialize → tools/list → tools/call), asserts the
// `overview` tool exists and returns the stub text. Stderr-only logging.
//
// This avoids needing the MCP Inspector web UI for a yes/no on 0b.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.resolve(here, "..", "dist-spike", "spike", "server.js");

const proc = spawn("node", [serverEntry], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
const pendingResponses = new Map(); // id → resolve function

proc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString("utf8");
  // Newline-delimited JSON.
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingResponses.has(msg.id)) {
        pendingResponses.get(msg.id)(msg);
        pendingResponses.delete(msg.id);
      } else {
        process.stderr.write(`(unsolicited): ${line}\n`);
      }
    } catch (e) {
      process.stderr.write(`!! non-JSON on stdout: ${line}\n`);
    }
  }
});

proc.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk.toString("utf8")}`);
});

proc.on("exit", (code) => {
  if (code !== 0 && code !== null) {
    process.stderr.write(`server exited with code ${code}\n`);
    process.exit(1);
  }
});

let nextId = 1;
function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingResponses.set(id, resolve);
    const payload = { jsonrpc: "2.0", id, method, params };
    proc.stdin.write(JSON.stringify(payload) + "\n");
    setTimeout(() => {
      if (pendingResponses.has(id)) {
        pendingResponses.delete(id);
        reject(new Error(`timeout waiting for response to ${method}`));
      }
    }, 5000);
  });
}

function notify(method, params) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function assert(cond, msg) {
  if (!cond) {
    process.stderr.write(`SPIKE_0B_FAIL: ${msg}\n`);
    proc.kill();
    process.exit(1);
  }
}

try {
  // 1. initialize
  const initRes = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "probe-spike-tester", version: "0.0.0" },
  });
  assert(initRes.result, "initialize: no result");
  assert(initRes.result.serverInfo?.name === "probe-mcp-spike", "initialize: wrong server name");
  process.stderr.write(`[test] initialize OK — server=${initRes.result.serverInfo.name}@${initRes.result.serverInfo.version}\n`);

  // 2. notifications/initialized
  notify("notifications/initialized", {});

  // 3. tools/list
  const listRes = await send("tools/list", {});
  assert(listRes.result, "tools/list: no result");
  assert(Array.isArray(listRes.result.tools), "tools/list: tools not array");
  const overview = listRes.result.tools.find((t) => t.name === "overview");
  assert(overview, "tools/list: 'overview' tool not registered");
  assert(overview.description?.length > 0, "tools/list: overview has no description");
  assert(overview.annotations?.readOnlyHint === true, "tools/list: readOnlyHint not propagated");
  process.stderr.write(`[test] tools/list OK — found ${listRes.result.tools.length} tool(s), 'overview' present with annotations\n`);

  // 4. tools/call overview
  const callRes = await send("tools/call", {
    name: "overview",
    arguments: { path: "/tmp/example" },
  });
  assert(callRes.result, "tools/call: no result");
  assert(Array.isArray(callRes.result.content), "tools/call: content not array");
  const textBlock = callRes.result.content.find((c) => c.type === "text");
  assert(textBlock, "tools/call: no text content block");
  assert(textBlock.text.includes("Spike stub response"), `tools/call: unexpected text: ${textBlock.text}`);
  process.stderr.write(`[test] tools/call OK — got text: ${JSON.stringify(textBlock.text)}\n`);

  process.stderr.write("SPIKE_0B_PASS\n");
  proc.kill();
  process.exit(0);
} catch (e) {
  process.stderr.write(`SPIKE_0B_FAIL: ${e instanceof Error ? e.message : String(e)}\n`);
  proc.kill();
  process.exit(1);
}
