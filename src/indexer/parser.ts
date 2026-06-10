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
};

const parsers = new Map<string, Parser>();
let initPromise: Promise<void> | null = null;

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

  const tree = parser.parse(content);
  if (!tree) {
    log.warn(`parseFile: parser returned null for language "${language}"`);
    return null;
  }
  return tree;
}
