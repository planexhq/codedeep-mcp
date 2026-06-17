import { mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");
const targetDir = path.join(projectRoot, "grammars");

const repomixDir = path.join(projectRoot, "node_modules", "@repomix", "tree-sitter-wasms", "out");
const kotlinDir = path.join(projectRoot, "node_modules", "@tree-sitter-grammars", "tree-sitter-kotlin");
// Dart is sourced from a VENDORED, committed wasm, not node_modules: it must be
// the nielsenko/tree-sitter-dart grammar (clean call_expression/member_expression
// AST), which is GitHub-only and not on npm in a loadable form. The @repomix
// bundle DOES ship a tree-sitter-dart.wasm, but it is the Benjamin-Sobel grammar
// (flat selector chains, no call_expression node) — a poor engine fit — so we
// must NOT source dart from repomixDir. Rebuild the vendored wasm from
// nielsenko/tree-sitter-dart @ b57d734c84f510bbd524097902cab671e4dbfca9 with
// `npx tree-sitter-cli@0.26.8 build --wasm` (ABI 15; loads in web-tree-sitter 0.26.8).
const vendorDir = path.join(projectRoot, "vendor", "grammars");

// Most grammars ship in the @repomix bundle; Kotlin is sourced from its own
// @tree-sitter-grammars package (the bundle has no Kotlin); Dart from the
// committed vendor/ wasm (see above). Each entry: { srcDir, file }.
const wanted = [
  { srcDir: repomixDir, file: "tree-sitter-typescript.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-tsx.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-javascript.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-python.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-java.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-go.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-rust.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-swift.wasm" },
  { srcDir: kotlinDir, file: "tree-sitter-kotlin.wasm" },
  { srcDir: vendorDir, file: "tree-sitter-dart.wasm" },
  { srcDir: repomixDir, file: "tree-sitter-c_sharp.wasm" },
];

// Cache directory listings so each source dir is read at most once.
const listings = new Map();
function present(dir) {
  let entries = listings.get(dir);
  if (entries) return entries;
  try {
    entries = new Set(readdirSync(dir));
  } catch (err) {
    if (err.code === "ENOENT") {
      process.stderr.write(`copy-grammars: ${dir} missing — run \`npm install\` first\n`);
      process.exit(1);
    }
    throw err;
  }
  listings.set(dir, entries);
  return entries;
}

const missing = wanted.filter(({ srcDir, file }) => !present(srcDir).has(file));
if (missing.length > 0) {
  const detail = missing.map(({ srcDir, file }) => `${path.join(srcDir, file)}`).join(", ");
  process.stderr.write(`copy-grammars: missing: ${detail}\n`);
  process.exit(1);
}

function dstMtime(p) {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

mkdirSync(targetDir, { recursive: true });
let copied = 0;
for (const { srcDir, file } of wanted) {
  const src = path.join(srcDir, file);
  const dst = path.join(targetDir, file);
  if (statSync(src).mtimeMs <= dstMtime(dst)) continue;
  copyFileSync(src, dst);
  copied++;
  process.stderr.write(`copy-grammars: ${file} → grammars/\n`);
}
process.stderr.write(`copy-grammars: done (${copied}/${wanted.length} updated)\n`);
