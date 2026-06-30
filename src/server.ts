// SDK v1.29 takes `inputSchema` as a RAW Zod shape ({ k: z.string() }), not
// `z.object({...})`. The v2 alpha uses the wrapped form — do not confuse them.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { GitService } from "./git/git-service.js";
import type { CodeIndex } from "./indexer/code-index.js";
import type { Indexer } from "./indexer/pipeline.js";
import { runFindReferences } from "./tools/find-references.js";
import { runFindSymbol } from "./tools/find-symbol.js";
import { runGetContext } from "./tools/get-context.js";
import { runImpact } from "./tools/impact.js";
import { runOverview } from "./tools/overview.js";
import { runSearchStructure } from "./tools/search-structure.js";
import type { CodedeepConfig } from "./types.js";

const SHARED_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface ServerDeps {
  index: CodeIndex;
  indexer: Indexer;
  config: CodedeepConfig;
  // Required, not optional: git unavailability lives INSIDE the service
  // (null/empty returns), so tools never branch on a missing dep.
  git: GitService;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: "codedeep-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "overview",
    {
      description:
        "Start here. 'What is this codebase?' — language breakdown, top-level structure, entry points, symbol counts; in a git repo, also branch/hotspots, risk ranking (churn × coupling × complexity), and index freshness. Orient with this before grepping; then drill in with find_symbol / get_context.",
      inputSchema: {
        path: z.string().optional().describe("Project root (default: cwd)"),
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
        "'Tell me everything about this symbol.' Full body (verbatim), within-file callers/callees, coupling (fan-in/out, cyclomatic+cognitive complexity, blast radius), and imports — plus co-change partners and recent commits when git is available. Reach for this after find_symbol instead of opening the file by hand.",
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
            "Sections to include: body, callers, callees, coupling, imports, co_changes, git",
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
        "'Who uses X?' Cross-file callers ranked by confidence (directory + import proximity), not raw text matches like grep — each row tagged [name match] or the weaker [member call] (both unverified — verify before asserting). For the transitive blast radius use impact. (LSP-precise tiers ship in Phase 2.)",
      inputSchema: {
        file: z.string().describe("File containing the symbol (relative to project root)"),
        symbol: z.string().describe("Symbol name"),
        line: z
          .number()
          .int()
          .optional()
          .describe("Disambiguate when multiple symbols share a name"),
        kind: z
          .enum([
            "callers",
            "callees",
            "implementations",
            "type_references",
            "all",
          ])
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
        "'What breaks if I change X?' Transitive upstream caller tree grouped by hop, with a distinct-caller blast count and git co-change partners — something grep can't compute. Each edge tagged by confidence. For direct callers only, use find_references. (Edges are AST name-matches, not compiler-verified; downstream callees and inheritance ship with LSP in Phase 2.)",
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

  return server;
}
