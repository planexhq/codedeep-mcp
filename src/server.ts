// SDK v1.29 takes `inputSchema` as a RAW Zod shape ({ k: z.string() }), not
// `z.object({...})`. The v2 alpha uses the wrapped form — do not confuse them.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { CodeIndex } from "./indexer/code-index.js";
import type { Indexer } from "./indexer/pipeline.js";
import { runFindSymbol } from "./tools/find-symbol.js";
import { runGetContext } from "./tools/get-context.js";
import { runOverview } from "./tools/overview.js";
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
        "Get a structural overview of the codebase: language breakdown, top-level directories, entry points, and symbol counts.",
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
        "AST-aware symbol lookup. Returns definitions matching a name (exact, prefix, or fuzzy). Optional kind/scope/limit filters.",
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
        "Return everything needed to understand a symbol: full body, within-file callers/callees, and imports.",
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
            "Sections to include: body, callers, callees, imports",
          ),
      },
      annotations: SHARED_ANNOTATIONS,
    },
    async (args) => runGetContext(args, deps),
  );

  return server;
}
