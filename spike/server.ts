// Step 0b spike: validate @modelcontextprotocol/sdk v1.29 stdio server.
// Registers a single stub `overview` tool and connects via stdio.
//
// API note: SDK v1 takes `inputSchema` as a RAW Zod shape ({ k: z.string() }),
// NOT a wrapped `z.object({...})`. The v2 alpha (@modelcontextprotocol/server)
// uses the wrapped form — do not confuse them.
//
// Stderr-only logging: stdout is reserved for JSON-RPC.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "codedeep-mcp-spike",
  version: "0.0.0",
});

server.registerTool(
  "overview",
  {
    description: "Spike stub: returns a fixed overview message.",
    inputSchema: {
      path: z.string().optional().describe("Project root (ignored in stub)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => ({
    content: [
      {
        type: "text" as const,
        text: "## Overview\nSpike stub response.",
      },
    ],
  }),
);

const transport = new StdioServerTransport();

process.stderr.write("SPIKE_0B_READY\n");

await server.connect(transport);
