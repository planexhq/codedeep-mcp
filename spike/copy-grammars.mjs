// Copies tree-sitter WASM grammars from tree-sitter-wasms/out → grammars/
// so the runtime parser can load them via filesystem path. Step 0 spike only —
// Step 1 will revisit packaging strategy.
//
// Stderr-only logging (project rule: never console.log).

import { existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const sourceDir = path.join(projectRoot, "node_modules", "@repomix", "tree-sitter-wasms", "out");
const targetDir = path.join(projectRoot, "grammars");

const wanted = [
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
];

if (!existsSync(sourceDir)) {
  process.stderr.write(`copy-grammars: source dir missing: ${sourceDir}\n`);
  process.stderr.write(`copy-grammars: did you run \`npm install\`?\n`);
  process.exit(1);
}

const present = new Set(readdirSync(sourceDir));
const missing = wanted.filter((f) => !present.has(f));
if (missing.length > 0) {
  process.stderr.write(`copy-grammars: missing in ${sourceDir}:\n`);
  for (const m of missing) process.stderr.write(`  - ${m}\n`);
  process.stderr.write(`copy-grammars: files actually present:\n`);
  for (const p of [...present].sort()) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
for (const f of wanted) {
  const src = path.join(sourceDir, f);
  const dst = path.join(targetDir, f);
  copyFileSync(src, dst);
  process.stderr.write(`copy-grammars: ${f} → grammars/\n`);
}
process.stderr.write(`copy-grammars: done (${wanted.length} files)\n`);
