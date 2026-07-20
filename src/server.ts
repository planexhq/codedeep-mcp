// SDK v1.29 takes `inputSchema` as a RAW Zod shape ({ k: z.string() }), not
// `z.object({...})`. The v2 alpha uses the wrapped form — do not confuse them.

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { GitService } from "./git/git-service.js";
import type { CodeIndex } from "./indexer/code-index.js";
import type { Indexer } from "./indexer/pipeline.js";
import { errMsg, log } from "./logger.js";
import type { NoteStore } from "./notes/note-store.js";
import { runChanges } from "./tools/changes.js";
import { runFindReferences } from "./tools/find-references.js";
import { runFindSymbol } from "./tools/find-symbol.js";
import { runForget } from "./tools/forget.js";
import { runGetContext } from "./tools/get-context.js";
import { runImpact } from "./tools/impact.js";
import { runOverview } from "./tools/overview.js";
import { runRecall } from "./tools/recall.js";
import { runRemember } from "./tools/remember.js";
import { runSearchStructure } from "./tools/search-structure.js";
import type { CodedeepConfig } from "./types.js";

const SHARED_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// remember/forget write the .codedeep note store (never source). readOnlyHint
// is false so MCP clients surface the write; destructiveHint false (append /
// scoped single-note removal, no source touched). The store write is the only
// mutation in the server.
const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export interface ServerDeps {
  index: CodeIndex;
  indexer: Indexer;
  config: CodedeepConfig;
  // Required, not optional: git unavailability lives INSIDE the service
  // (null/empty returns), so tools never branch on a missing dep.
  git: GitService;
  // The agent-curated knowledge layer (remember/recall/forget).
  notes: NoteStore;
}

// Single source of truth for the advertised server version: the package's own
// version field. Resolves from both src/ (tests) and dist/ (shipped) — each is
// one directory below the package root. A hardcoded copy here drifted silently
// (deferred v0.1.0 release note); reading it makes `npm version` sufficient.
// Guarded: a bundled/relocated dist (no package.json one level up — or a
// FOREIGN one that legally omits `version`, e.g. a private monorepo root) must
// fall back to a placeholder STRING, never crash at import time and never let
// `undefined` reach McpServer (serverInfo.version is required by the spec — an
// undefined field would be dropped from the initialize response and can fail
// client-side schema validation). The fallback is warned, not silent: a
// placeholder version in a bug report should be traceable to its cause.
const PACKAGE_VERSION: string = (() => {
  try {
    const version: unknown = (
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version?: unknown }
    ).version;
    if (typeof version === "string" && version.length > 0) return version;
    log.warn(
      "server: ../package.json has no usable `version` field (foreign/rootless " +
        "package.json?); advertising 0.0.0-unknown",
    );
  } catch (err) {
    log.warn(
      `server: could not read ../package.json for the server version ` +
        `(${errMsg(err)}); advertising 0.0.0-unknown`,
    );
  }
  return "0.0.0-unknown";
})();

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: "codedeep-mcp",
    version: PACKAGE_VERSION,
  });

  server.registerTool(
    "overview",
    {
      description:
        "Start here. 'What is this codebase?' — language breakdown, top-level structure, entry points, symbol counts, and remembered-knowledge counts; in a git repo, also branch/hotspots, risk ranking (churn × coupling × complexity), and index freshness. Orient with this before grepping; then drill in with find_symbol / get_context.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            "Sanity check only: must equal the server's configured project root if given (errors otherwise — one server indexes one root). Omit it; it does NOT scope the overview to a subdirectory.",
          ),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runOverview(args, deps),
  );

  server.registerTool(
    "find_symbol",
    {
      description:
        "'Where is X defined?' Use instead of grep when you want the definition of a named symbol (exact/prefix/fuzzy) with fan-in, fan-out, and cyclomatic+cognitive complexity — not every text occurrence. Then get_context for the body or find_references for callers. Optional kind/scope/limit filters.",
      inputSchema: {
        name: z.string().describe("Symbol name (exact, prefix, or fuzzy)"),
        kind: z
          .enum([
            "function",
            "class",
            "interface",
            "type",
            "variable",
            "method",
            "module",
            "enum",
          ])
          .optional()
          .describe("Filter by symbol kind"),
        scope: z
          .string()
          .optional()
          .describe("File path prefix to narrow search (e.g., 'src/auth/')"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results (default: 10)"),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runFindSymbol(args, deps),
  );

  server.registerTool(
    "get_context",
    {
      description:
        "'Tell me everything about this symbol.' Full body (verbatim), within-file callers/callees, coupling (fan-in/out, cyclomatic+cognitive complexity, blast radius), imports, and any remembered notes anchored here (staleness-tagged ✓/⚠) — plus co-change partners and recent commits when git is available. Reach for this after find_symbol instead of opening the file by hand.",
      inputSchema: {
        file: z.string().describe("File path (relative to project root)"),
        symbol: z
          .string()
          .optional()
          .describe("Symbol name within the file (omit for file-level context)"),
        line: z
          .number()
          .int()
          .optional()
          .describe("Disambiguate when multiple symbols share a name"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Soft response budget (default: 3000)"),
        include: z
          .array(z.string())
          .optional()
          .describe(
            "Sections to include: body, callers, callees, coupling, imports, notes, co_changes, git",
          ),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runGetContext(args, deps),
  );

  server.registerTool(
    "find_references",
    {
      description:
        "'Who uses X?' Cross-file callers ranked by confidence (directory + import proximity), not raw text matches like grep — each row tagged [name match] or the weaker [member call]. Rows are AST-derived and confidence-tiered, not compiler-verified — verify before asserting. For the transitive blast radius use impact.",
      inputSchema: {
        file: z.string().describe("File containing the symbol (relative to project root)"),
        symbol: z.string().describe("Symbol name"),
        line: z
          .number()
          .int()
          .optional()
          .describe("Disambiguate when multiple symbols share a name"),
        kind: z
          .enum(["callers", "callees", "all"])
          .optional()
          .describe("Result kind (default: 'all')"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results per section (default: 20, max: 100)"),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runFindReferences(args, deps),
  );

  server.registerTool(
    "impact",
    {
      description:
        "'What breaks if I change X?' Transitive upstream caller tree grouped by hop, with a distinct-caller blast count and git co-change partners — something grep can't compute. Each edge tagged by confidence. For direct callers only, use find_references. (Edges are AST name-matches, not compiler-verified — verify before asserting; downstream callees and inheritance are not traversed.)",
      inputSchema: {
        file: z
          .string()
          .describe("File containing the symbol (relative to project root)"),
        symbol: z.string().describe("Symbol name"),
        line: z
          .number()
          .int()
          .optional()
          .describe("Disambiguate when multiple symbols share a name"),
        depth: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Caller hops to trace upstream (default: 3, max: 5)"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Soft response budget (default: 3000); deeper hops drop first"),
        include_weak: z
          .boolean()
          .optional()
          .describe(
            "Expand weak edges — unresolved member calls (obj.method()) and low-confidence deep chains; noisier. Default: false",
          ),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runImpact(args, deps),
  );

  server.registerTool(
    "changes",
    {
      description:
        "'I changed these files — what breaks, and which of my notes are now suspect?' One call over the git working set (uncommitted by default; pass `ref` for committed changes vs a branch/commit). Per changed file: the highest fan-in symbols with their transitive blast radius, staleness-flagged anchored notes, and usual co-change partners missing from the changeset. Requires a git repository. For one symbol's full caller tree use impact; for full note text use recall.",
      inputSchema: {
        ref: z
          .string()
          .optional()
          .describe(
            "Compare committed changes against this ref (e.g. 'main'). Omit for the uncommitted working tree.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max changed files rendered (default: 10, max: 30)"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Soft response budget (default: 3000)"),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runChanges(args, deps),
  );

  server.registerTool(
    "search_structure",
    {
      description:
        "'Find code by keyword or shape.' Fuzzy search over symbol names, signatures, and docstrings (git-churn-boosted), or with `pattern` an ast-grep structural query (TS/TSX/JS only). Use over grep for symbol-aware or structural matches; use plain grep for arbitrary string/comment text. To locate a known symbol by name, find_symbol is more direct.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Keywords matched fuzzily against symbol names, signatures, and docstrings (required unless `pattern` is set)",
          ),
        pattern: z
          .string()
          .optional()
          .describe(
            "ast-grep pattern, e.g. 'app.use($HANDLER)'. Takes precedence over `query`. TS/TSX/JS only.",
          ),
        language: z
          .string()
          .optional()
          .describe("Filter to one language: typescript, tsx, javascript, python, java, go, rust, swift, kotlin, dart, csharp, php, ruby, cpp, c, objc"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max results (default: 10, max: 100)"),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runSearchStructure(args, deps),
  );

  server.registerTool(
    "remember",
    {
      description:
        "Write a durable note about code that grep/AST can't infer — a cross-file router chain, an invariant, a footgun, an architecture decision. Anchor it to the file(s)/symbol(s) it's about; codedeep then tracks STALENESS — recall flags the note when its anchors change (unlike memories that rot silently), and get_context surfaces anchored notes inline. Writes only to the .codedeep note store, never to source.",
      inputSchema: {
        note: z
          .string()
          .describe("The knowledge to store (markdown ok). Be specific."),
        anchors: z
          .array(z.string())
          .optional()
          .describe(
            "Files/symbols this note is about, e.g. 'src/auth.ts' or 'src/auth.ts:authenticate' (add ':<line>' to disambiguate). Strongly recommended — anchors are what make the note staleness-tracked.",
          ),
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async (args) => runRemember(args, deps),
  );

  server.registerTool(
    "recall",
    {
      description:
        "Retrieve previously-remembered notes, each tagged ✓ fresh / ⚠ stale / ? unverified by re-checking its anchors against the current source. Call before editing a file/symbol ('what do I already know here, and is it still true?'). Filter by `file`/`symbol` (what's anchored here) or `query` (keyword); omit all to list every note.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Keywords matched against note text and anchors"),
        file: z
          .string()
          .optional()
          .describe("Return notes anchored to this file (relative path)"),
        symbol: z
          .string()
          .optional()
          .describe("With `file`, narrow to notes anchored to this symbol"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max notes (default: 10, max: 50)"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Soft response budget (default: 3000)"),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runRecall(args, deps),
  );

  server.registerTool(
    "forget",
    {
      description:
        "Delete a note by its id (shown by recall) — for superseded or wrong notes. Writes only to the .codedeep note store.",
      inputSchema: {
        noteId: z.string().describe("The note id to delete (from recall)"),
      },
      // destructiveHint: a forget is an irreversible delete of stored data (not
      // additive like remember), so clients may gate it on confirmation.
      annotations: { ...WRITE_ANNOTATIONS, destructiveHint: true, idempotentHint: true },
    },
    async (args) => runForget(args, deps),
  );

  return server;
}
