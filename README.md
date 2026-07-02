# codedeep-mcp

[![CI](https://github.com/planexhq/codedeep-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/planexhq/codedeep-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/codedeep-mcp.svg)](https://www.npmjs.com/package/codedeep-mcp)
[![MCP spec](https://img.shields.io/badge/MCP_spec-2025--11--25-0a7ea4.svg)](https://modelcontextprotocol.io/specification/2025-11-25)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

An MCP server that gives AI coding agents structural understanding of codebases.

**One tool call replaces 5-10 Grep-Read cycles.**

codedeep-mcp parses your code with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), builds a symbol index, and exposes 9 tools over the [Model Context Protocol](https://modelcontextprotocol.io/): 6 read-only structural tools that answer questions directly (find symbols, trace callers, assess blast radius, search by structure) plus a 3-tool agent-curated knowledge layer (`remember` / `recall` / `forget`) whose notes are **staleness-tracked** against your source — when anchored code changes, the note is flagged instead of rotting silently.

## Why

AI coding agents explore codebases with text tools (grep, file reads). This works but is expensive:

- "Find all callers of X" requires 5+ grep-read cycles and returns false positives
- "What breaks if I change this?" requires exhaustive manual search
- Grep can't tell `user` the variable from `User` the class from `user()` the function

codedeep-mcp solves this by parsing code into symbols and relationships, then answering structural questions in a single call.

## Tools

| Tool | Purpose | Example |
|------|---------|---------|
| `overview` | Orient in an unfamiliar codebase | Language breakdown, entry points, structure |
| `find_symbol` | AST-aware symbol lookup | Find function by name — matches definitions, not text |
| `get_context` | Full context for a symbol | Body + callers/callees + imports + co-change & complexity |
| `find_references` | Cross-file usage search | Who calls this function, and from where? |
| `impact` | Depth-N blast radius | Transitive upstream callers, grouped by hop |
| `search_structure` | Keyword and structural search | Find by name/signature (all languages), or AST pattern (TS/JS) |
| `remember` | Store a durable, anchored note | Cross-file invariants, footguns, decisions — anchored to files/symbols |
| `recall` | Retrieve notes with freshness | Each note tagged ✓ fresh / ⚠ stale by re-checking its anchors |
| `forget` | Delete a note | Remove superseded or wrong knowledge |

## Quick Start

### Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "codedeep-mcp": {
      "command": "npx",
      "args": ["codedeep-mcp"]
    }
  }
}
```

### Cursor / Windsurf / Other MCP Clients

Any MCP client that supports stdio transport works. Configure it to run `npx codedeep-mcp`.

> **Note:** `npx codedeep-mcp` is a stdio server — it won't produce visible
> output when run directly. It communicates via JSON-RPC with the MCP client.

## How It Works

```
Your Code  ──>  tree-sitter (parse)  ──>  In-Memory Index  ──>  MCP Tools
                                               │
                                          Git (optional)
```

**Structural index (always, instant):**
tree-sitter parses every file into an AST. Symbols, call relationships,
and imports are extracted and indexed in memory — with per-language call
resolution tuned for precision (an explicit 0-wrong-kind-edge goal), not
just text matching. Works on any repo with zero configuration.

**Complexity metrics (all 14 languages):**
Per-symbol cyclomatic and cognitive complexity, computed at index time and
pinned for behavioral comparability to McCabe / the Cognitive Complexity
whitepaper / open-source analyzers (SonarJS, sonar-java, gocyclo+gocognit,
rust-code-analysis, …). Shown on `find_symbol` / `get_context`.

**Git enrichment (when in a git repo):**
Commit frequency identifies hotspot files; co-change analysis reveals
behavioral coupling (files that change together); and a risk score
(churn × coupling × complexity) ranks the most change-prone, tangled hubs.

**Agent-curated knowledge layer (staleness-tracked):**
`remember` anchors durable notes to files/symbols and snapshots a content
baseline; `recall` re-checks each anchor against the current source and tags
every note ✓ fresh / ⚠ stale / ✗ missing — so an agent's accumulated knowledge
is verified at read time instead of rotting silently. Notes are stored in the
local `.codedeep` cache, never written into your source.

**Honest confidence, by design:**
Cross-file edges are AST-derived name-matches with confidence tiers, not
compiler-verified references — every approximate row is tagged (e.g.
`[name match, unverified]`, `[behavioral]`) so an agent knows what to
trust and what to verify before asserting.

## Example

````
> find_symbol({ name: "authenticate" })

src/auth/middleware.ts:42-67 | function | exported
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void>
Validates the JWT token and attaches user to request
References: ~5
Fan-out: 2
Complexity: cyc 3 / cog 1 [structural]

> get_context({ file: "src/auth/middleware.ts", symbol: "authenticate" })

src/auth/middleware.ts:42-67 | function | exported
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void>
Validates the JWT token and attaches user to request

### Body
```typescript
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  const payload = verify(token);
  req.user = payload as User;
  next();
}
```

### Callers
- src/routes/api.ts:67 — handleRequest() [structural]
- src/routes/webhook.ts:23 — verifyWebhook() [structural]

(get_context also emits ### Callees and ### Coupling sections here, omitted for brevity)

### Imports
- jsonwebtoken: verify, decode
- ./types: User, AuthToken

### Co-change Partners (2 behavioral)
- src/auth/types.ts  78% confidence (9 shared commits)
- tests/auth.test.ts  64% confidence (7 shared commits)
````

## Supported Languages

**14 languages**, each with tree-sitter symbol/reference extraction **and**
cyclomatic + cognitive complexity:

TypeScript / JS · Python · Java · Go · Rust · Swift · Kotlin · Dart · C# ·
PHP · Ruby · C++ · C · Objective-C

Cross-file references are AST name-matches with per-row confidence tags (see
*How It Works*) — precision-tuned per language against real-repo corpora with
an explicit 0-wrong-kind-edge goal.

## Configuration

Optional `.codedeep/config.json` in your project root:

```jsonc
{
  "exclude": ["vendor/**", "generated/**"],
  "languages": ["typescript", "python"],
  "maxFiles": 100000,
  "maxFileSize": 1048576,
  "watch": true,
  "gitEnabled": true,
  "gitWindow": 180
}
```

All fields are optional. Works with no config file.

Add `.codedeep/` to your `.gitignore` — the index cache is stored there.

Environment variables: `CODEDEEP_CACHE_DIR`, `CODEDEEP_EXCLUDE`, `CODEDEEP_GIT`, `CODEDEEP_GIT_WINDOW`, `CODEDEEP_WATCH`, `CODEDEEP_DEBUG`.

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
