# Step 0 Spike — Results

Both halves of the spike validated successfully on darwin (macOS) with Node v22.19.0.
This document records what was empirically resolved so Step 1 can proceed without
re-derisking.

## 0a — Tree-sitter WASM grammars: PASS

```
[typescript] OK rootType=program children=2 sexp=(program (export_statement ...
[tsx]        OK rootType=program children=2 sexp=(program (import_statement ...
[javascript] OK rootType=program children=2 sexp=(program (function_declaration ...
[python]     OK rootType=module  children=1 sexp=(module (function_definition ...
SPIKE_0A_PASS
```

### Key findings

1. **ABI alignment matters; both sides of the parser/grammar pair must come from
   the same tree-sitter generation.** The first attempt — `web-tree-sitter@^0.26.8`
   + `tree-sitter-wasms@^0.1.13` — failed at `Language.load` with a dylink/abort
   error: `tree-sitter-wasms@0.1.13` was built with `tree-sitter-cli@^0.20.8`
   (confirmed in its devDependencies), and the WASM dylink format changed between
   the 0.20 and 0.25 generations. Resolution: switched the grammar source to
   `@repomix/tree-sitter-wasms@^0.1.17` — a fork that publishes prebuilt grammars
   built with `tree-sitter-cli@^0.26.3`, matching the parser's expected ABI.
   Both `web-tree-sitter` and grammars are now on the latest line.

2. **Working import shape (web-tree-sitter@0.26.8).** The 0.26 release ships as
   ESM (`"type": "module"`, full `exports` map) with **named** top-level exports —
   `Parser`, `Language`, `Tree`, `Node`, `Query`, etc. all as top-level classes.
   The working pattern is:
   ```ts
   import { Parser, Language } from "web-tree-sitter";
   await Parser.init();
   const Lang = await Language.load(wasmPath);
   const parser = new Parser();
   parser.setLanguage(Lang);
   ```
   (The older 0.20.x line used a CJS default export with nested `Parser.Language` —
   abandoned.)

3. **Grammar file naming.** `@repomix/tree-sitter-wasms` ships files under
   `node_modules/@repomix/tree-sitter-wasms/out/` named `tree-sitter-<lang>.wasm`.
   All four required files (`tree-sitter-typescript.wasm`, `tree-sitter-tsx.wasm`,
   `tree-sitter-javascript.wasm`, `tree-sitter-python.wasm`) are present.

4. **Path resolution from compiled output.** With `outDir: dist-spike` and
   `rootDir: .`, the compiled `dist-spike/spike/parse.js` reaches `grammars/` via
   `path.resolve(__here, "..", "..", "grammars")`. Confirmed working.

### Implications for Step 1

- `src/indexer/parser.ts` should use the named-import form
  (`import { Parser, Language } from "web-tree-sitter"`). PLAN.md Step 4's snippet
  uses the older default-import shape — update it during Step 4 implementation.
- `@repomix/tree-sitter-wasms` is the grammar source going forward. If it falls
  out of maintenance, fallback options: (a) Microsoft's `@vscode/tree-sitter-wasm`
  (built with tree-sitter-cli 0.25.10 — also ABI-compatible with web-tree-sitter
  0.26.x), or (b) build grammars from source via `tree-sitter-cli@^0.26.x`
  (since 0.26.1, no Emscripten dep — bundles wasi-sdk on first build).
- The ABI alignment requirement applies equally to any future grammars we add
  (Phase 1b: Go, Rust, Java) — confirm they're built with a compatible CLI.

## 0b — MCP SDK stdio server: PASS

```
[server] SPIKE_0B_READY
[test] initialize OK — server=probe-mcp-spike@0.0.0
[test] tools/list OK — found 1 tool(s), 'overview' present with annotations
[test] tools/call OK — got text: "## Overview\nSpike stub response."
SPIKE_0B_PASS
```

### Key findings

1. **SDK package + version confirmed.** `@modelcontextprotocol/sdk@1.29.0` from the
   stable v1 line. (The `@modelcontextprotocol/server` package on npm is the v2
   pre-alpha — `2.0.0-alpha.2` at time of spike — and uses a different API. Do not
   use until v2 stabilizes.)

2. **Working API shape (v1.29) — locked in for Step 1:**
   ```ts
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
   import { z } from "zod";

   const server = new McpServer({ name: "...", version: "..." });
   server.registerTool(
     "toolName",
     {
       description: "...",
       inputSchema: { path: z.string().optional() },  // raw shape — z.object also OK
       annotations: { readOnlyHint: true, destructiveHint: false,
                      idempotentHint: true, openWorldHint: false },
     },
     async (args) => ({ content: [{ type: "text", text: "..." }] }),
   );
   await server.connect(new StdioServerTransport());
   ```

3. **Annotations propagate.** The four hint flags (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint`) are returned in `tools/list` responses
   verbatim — clients can rely on them for auto-approval logic.

4. **Zod v4 works (corrected from initial assumption).** The SDK declares
   `"zod": "^3.25 || ^4.0"` as both a direct and peer dep, and ships a dedicated
   `dist/esm/server/zod-compat.js` that detects v3 vs v4 schemas at runtime
   (`isZ4Schema` checks the `_zod` property). Verified empirically by upgrading to
   `zod@4.4.3` and re-running the spike — `tools/call` still returns the stub text.
   Both `inputSchema: { path: z.string() }` (raw shape) and
   `inputSchema: z.object({ path: z.string() })` (wrapped) compile and work under
   Zod v4. Pinning to `^4.0.0` for forward-looking code.

5. **Programmatic stdio testing works.** `spike/test-server.mjs` drives the server
   without the Inspector UI by sending JSON-RPC messages over stdin and asserting
   responses on stdout. This pattern is reusable for Step 12 (integration tests)
   if we want a no-browser smoke test alongside vitest.

### Implications for Step 1

- `src/server.ts` can adopt the snippet above directly. PLAN.md Step 1's snippet is
  correct as written (no changes needed to the planned API).
- `package.json` deps (v1 SDK + Zod v4 + web-tree-sitter v0.26 + @repomix grammars)
  are proven; Step 1 just adds `minisearch`, `picomatch`, and `vitest`.

## Versions locked in by this spike

```jsonc
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.29.0",
  "web-tree-sitter": "^0.26.8",
  "zod": "^4.0.0"
},
"devDependencies": {
  "@repomix/tree-sitter-wasms": "^0.1.17",
  "typescript": "^5.6.3",
  "@types/node": "^22.9.0"
}
```

Resolved at the time of the spike: `@modelcontextprotocol/sdk@1.29.0`,
`web-tree-sitter@0.26.8`, `@repomix/tree-sitter-wasms@0.1.17`, `zod@4.4.3`,
`typescript@5.9.3`. All on the latest line.

## How to re-run

```bash
cd /Users/dahn/Researchs/explore-mcp
npm install
npm run copy:grammars                                      # populate grammars/
npx tsc -p tsconfig.spike.json                             # compile to dist-spike/
node dist-spike/spike/parse.js                             # 0a
node spike/test-server.mjs                                 # 0b (no browser)
npx @modelcontextprotocol/inspector node dist-spike/spike/server.js  # 0b via Inspector UI
```

## Files used by the spike

- `scripts/copy-grammars.mjs` — populates `grammars/` from `node_modules/@repomix/tree-sitter-wasms/out` (used by both spike and production builds)
- `tsconfig.spike.json` — extends root `tsconfig.json` to compile `spike/` → `dist-spike/`
- `spike/parse.ts` — 0a entry
- `spike/server.ts` — 0b entry (real stdio server)
- `spike/test-server.mjs` — 0b verifier (drives the server via JSON-RPC handshake)
- `grammars/*.wasm` — generated, 4 files
