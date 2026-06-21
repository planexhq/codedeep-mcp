import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Parser, Language } from 'web-tree-sitter';
import type { Tree } from 'web-tree-sitter';

import { log } from '../logger.js';

export type { Tree } from 'web-tree-sitter';

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/indexer/parser.js or src/indexer/parser.ts → up two levels to repo root.
const grammarsDir = path.resolve(here, '..', '..', 'grammars');

const LANG_TO_WASM: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  java: 'tree-sitter-java.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  swift: 'tree-sitter-swift.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  dart: 'tree-sitter-dart.wasm',
  // @repomix ships this as tree-sitter-c_sharp.wasm (underscore), not -csharp.
  csharp: 'tree-sitter-c_sharp.wasm',
  php: 'tree-sitter-php.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  cpp: 'tree-sitter-cpp.wasm',
  // `.c` needs the dedicated C grammar (tree-sitter-cpp errors on K&R + C code
  // using C++ keywords as identifiers); the extractor is shared with cpp.
  c: 'tree-sitter-c.wasm',
};

const parsers = new Map<string, Parser>();
let initPromise: Promise<void> | null = null;

// Conditional-compilation directive lines (#if / #elseif / #else / #endif).
// `m` matches ^/$ per line; without `s`, `.*` stays within one line.
const SWIFT_DIRECTIVE_LINE = /^[ \t]*#(?:if|elseif|else|endif)\b.*$/gm;

// tree-sitter-swift cannot parse a #if/#endif conditional-compilation block
// INSIDE a type or function body — it emits ERROR nodes that drop the enclosing
// type AND its first guarded member, hoisting the rest to the top level with
// the wrong kind/FQN. We blank each directive LINE to equal-length whitespace
// (newlines untouched) before parsing: byte offsets and line numbers are
// preserved, so the extractor's signature slices and get_context body slices
// still match the on-disk file, while every #if branch's declarations now parse
// as ordinary consecutive members. A member defined in more than one branch is
// extracted from each — over-extraction (the symbol-id occurrence counter keeps
// ids unique), never the silent type loss the raw grammar produces. Fast-pathed
// when the file contains no #if at all. Invoked by parseFile ONLY when the raw
// parse errors and only adopted when the result parses clean (see call site).
function neutralizeSwiftDirectives(content: string): string {
  if (!content.includes('#if')) return content;
  return content.replace(SWIFT_DIRECTIVE_LINE, (line) => ' '.repeat(line.length));
}

export function initParser(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await Parser.init();
      const loaded = await Promise.all(
        Object.entries(LANG_TO_WASM).map(async ([lang, wasm]) => {
          const language = await Language.load(path.join(grammarsDir, wasm));
          const parser = new Parser();
          parser.setLanguage(language);
          return [lang, parser] as const;
        }),
      );
      for (const [lang, parser] of loaded) {
        parsers.set(lang, parser);
      }
    })();
    // A cached rejection would otherwise disable parsing (and pattern
    // validation) for the process lifetime after one transient failure
    // (EMFILE during the WASM reads) — reset so the next call retries.
    initPromise.catch(() => {
      initPromise = null;
    });
  }
  return initPromise;
}

// The returned Tree holds WASM memory; callers must call `tree.delete()` when
// finished — JS GC won't free it.
export function parseFile(content: string, language: string): Tree | null {
  if (parsers.size === 0) {
    throw new Error('parser not initialized; call initParser() first');
  }

  const parser = parsers.get(language);
  if (!parser) {
    log.warn(`parseFile: unsupported language "${language}"`);
    return null;
  }

  let tree = parser.parse(content);
  if (!tree) {
    log.warn(`parseFile: parser returned null for language "${language}"`);
    return null;
  }

  // Workaround for tree-sitter-swift's in-body #if mis-parse (see above), applied
  // CONDITIONALLY: only swap in the directive-neutralized parse when the original
  // ERRORS and neutralization yields a CLEAN parse. So a file that already parses
  // — including one with a `#if`-looking line inside a multi-line string literal —
  // is never rewritten, and a neutralization that unbalances braces (a guard
  // straddling an opening brace) is discarded rather than producing wrong nesting.
  // The neutralized tree's offsets stay aligned with the ORIGINAL content the
  // caller passes to extractSymbols (equal-length blanking).
  if (language === 'swift' && tree.rootNode.hasError && content.includes('#if')) {
    const neutralized = neutralizeSwiftDirectives(content);
    if (neutralized !== content) {
      const alt = parser.parse(neutralized);
      if (alt && !alt.rootNode.hasError) {
        tree.delete();
        tree = alt;
      } else {
        alt?.delete();
      }
    }
  }
  return tree;
}
