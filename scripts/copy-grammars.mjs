import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
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
  "tree-sitter-java.wasm",
  "tree-sitter-go.wasm",
];

let present;
try {
  present = new Set(readdirSync(sourceDir));
} catch (err) {
  if (err.code === "ENOENT") {
    process.stderr.write(`copy-grammars: ${sourceDir} missing — run \`npm install\` first\n`);
    process.exit(1);
  }
  throw err;
}

const missing = wanted.filter((f) => !present.has(f));
if (missing.length > 0) {
  process.stderr.write(`copy-grammars: missing in ${sourceDir}: ${missing.join(", ")}\n`);
  process.exit(1);
}

function dstMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

mkdirSync(targetDir, { recursive: true });
let copied = 0;
for (const f of wanted) {
  const src = path.join(sourceDir, f);
  const dst = path.join(targetDir, f);
  if (statSync(src).mtimeMs <= dstMtime(dst)) continue;
  copyFileSync(src, dst);
  copied++;
  process.stderr.write(`copy-grammars: ${f} → grammars/\n`);
}
process.stderr.write(`copy-grammars: done (${copied}/${wanted.length} updated)\n`);
