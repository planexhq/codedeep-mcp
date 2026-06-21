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
import type { ProbeConfig } from "./types.js";

const SHARED_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export interface ServerDeps {
  index: CodeIndex;
  indexer: Indexer;
  config: ProbeConfig;
  // Required, not optional: git unavailability lives INSIDE the service
  // (null/empty returns), so tools never branch on a missing dep.
  git: GitService;
}

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({
    name: "probe-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "overview",
    {
      description:
        "Get a structural overview of the codebase: language breakdown, top-level directories, entry points, and symbol counts — plus branch summary, git hotspots, and risk hotspots (churn × call-graph coupling) when in a git repo.",
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
        "AST-aware symbol lookup. Returns definitions matching a name (exact, prefix, or fuzzy), each with fan-in (references), fan-out (callees), and complexity — cyclomatic (TS/JS, Python, Go, Java, Rust, Swift, Kotlin, Dart, C#, PHP) plus cognitive (Java, TS/JS, Go, Python, Rust, Swift, Kotlin, Dart, C#, PHP). Optional kind/scope/limit filters.",
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
        "Return everything needed to understand a symbol: full body, within-file callers/callees, coupling (fan-in/fan-out/cyclomatic+cognitive complexity/blast radius), and imports — plus co-change partners and recent commits when git is available.",
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
        "Cross-file usage navigation. Returns approximate AST name-matched callers for a symbol, ranked by directory and import proximity — plus co-change partners from git history when available. LSP-precise tiers ship in Phase 2.",
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
        "Trace the transitive blast radius of changing a symbol: upstream callers grouped by hop (depth 1, 2, …), with co-change partners from git history. Edges are AST name-matches, not compiler-verified; downstream callees and inheritance ship with LSP in Phase 2.",
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
        "Keyword and structural code search. Fuzzy-matches symbol names, signatures, and docstrings; with `pattern`, runs an ast-grep structural query instead (TypeScript/TSX/JavaScript only for now).",
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
          .describe("Filter to one language: typescript, tsx, javascript, python, java, go, rust, swift, kotlin, dart, csharp, php"),
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
