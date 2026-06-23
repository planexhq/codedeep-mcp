# codedeep-mcp

An MCP server that gives AI coding agents structural understanding of codebases.

**One tool call replaces 5-10 Grep-Read cycles.**

codedeep-mcp parses your code with [tree-sitter](https://tree-sitter.github.io/tree-sitter/), builds a symbol index, and exposes 6 tools over the [Model Context Protocol](https://modelcontextprotocol.io/) that answer structural questions directly: find symbols, trace callers, assess blast radius, search by structure.

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
                                          LSP (planned)
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

**Planned — LSP semantic tier:**
LSP integration (tsserver, pyright, gopls, …) for compiler-precise
cross-file references and type info is designed but **not yet shipped** —
cross-file edges today are AST name-matches.

## Example

```
> find_symbol({ name: "authenticate" })

src/auth/middleware.ts:42-67 | function | exported
async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void>
/** Validates the JWT token and attaches user to request */
References: ~5
Complexity: cyc 3 / cog 1

> get_context({ file: "src/auth/middleware.ts", symbol: "authenticate" })

## Symbol: authenticate
src/auth/middleware.ts:42-67 | function | exported

async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  const payload = verify(token);
  req.user = payload as User;
  next();
}

## Callers (2 structural)
- src/routes/api.ts:67         handleRequest()        [structural]
- src/routes/webhook.ts:23     verifyWebhook()        [structural]

## Imports
- jsonwebtoken: verify, decode
- ./types: User, AuthToken

## Co-change Partners (behavioral coupling from git)
- src/auth/types.ts (78% confidence, 9 shared commits)
- tests/auth.test.ts (64% confidence, 7 shared commits)
```

## Supported Languages

**14 languages**, each with tree-sitter symbol/reference extraction **and**
cyclomatic + cognitive complexity:

TypeScript / JS · Python · Java · Go · Rust · Swift · Kotlin · Dart · C# ·
PHP · Ruby · C++ · C · Objective-C

A planned LSP tier (see *How It Works*) will add compiler-precise cross-file
resolution per language.

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
