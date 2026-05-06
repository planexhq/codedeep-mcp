// Step 0a spike: validate web-tree-sitter can load WASM grammars and parse
// strings for TypeScript / TSX / JavaScript / Python in Node.js ESM.
//
// Import shape resolved empirically: web-tree-sitter@0.26.8 ships as ESM
// with NAMED exports (`Parser`, `Language` as top-level classes). The 0.26
// WASM ABI matches grammars built with tree-sitter-cli >=0.25, supplied
// here by @repomix/tree-sitter-wasms@0.1.17 (built with tree-sitter-cli
// 0.26.3). The older 0.20.8 path used a CJS default export with nested
// `Parser.Language` — abandoned in favor of the modern ABI.

import { Parser, Language } from "web-tree-sitter";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
// Compiled layout: dist-spike/spike/parse.js → repo root is two levels up.
const grammarsDir = path.resolve(here, "..", "..", "grammars");

interface Case {
  lang: string;
  file: string;
  src: string;
}

const cases: Case[] = [
  {
    lang: "typescript",
    file: "tree-sitter-typescript.wasm",
    src: "export const x: number = 1;\nexport function add(a: number, b: number): number { return a + b; }\n",
  },
  {
    lang: "tsx",
    file: "tree-sitter-tsx.wasm",
    src: "import * as React from 'react';\nexport const Hello = (): JSX.Element => <div className=\"x\">hi</div>;\n",
  },
  {
    lang: "javascript",
    file: "tree-sitter-javascript.wasm",
    src: "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
  },
  {
    lang: "python",
    file: "tree-sitter-python.wasm",
    src: 'def add(a, b):\n    """Sum two numbers."""\n    return a + b\n',
  },
];

async function main(): Promise<void> {
  await Parser.init();

  for (const c of cases) {
    const wasmPath = path.join(grammarsDir, c.file);
    const Lang = await Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(Lang);

    const tree = parser.parse(c.src);
    if (!tree) {
      process.stderr.write(`[${c.lang}] FAIL parse returned null\n`);
      process.exit(1);
    }
    const root = tree.rootNode;
    const sexpHead = root.toString().slice(0, 140).replace(/\s+/g, " ");
    process.stderr.write(
      `[${c.lang}] OK rootType=${root.type} children=${root.namedChildCount} sexp=${sexpHead}\n`,
    );
  }

  process.stderr.write("SPIKE_0A_PASS\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  process.stderr.write(`SPIKE_0A_FAIL: ${msg}\n`);
  process.exit(1);
});
