import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Parser, Language } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';

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
  objc: 'tree-sitter-objc.wasm',
};

const parsers = new Map<string, Parser>();
// Split memoization: the tree-sitter WASM runtime loads once (coreInit);
// each language's grammar loads on demand (langLoads) — a repo that is pure
// Python must not pay the ~95MB RSS floor of all 16 grammars. Rejections
// self-reset (a transient EMFILE must not disable a language for the
// process lifetime).
let coreInit: Promise<void> | null = null;
const langLoads = new Map<string, Promise<void>>();

// A grammar load is retried IN PLACE with a short backoff before the promise
// rejects: transient failures (an EMFILE storm during the WASM read) clear in
// milliseconds, and retrying HERE — at the altitude where the failure lives —
// protects every caller identically (startup bulk scan, watcher single-file,
// pattern-mode validation) with no per-path retry bookkeeping anywhere else.
// (A per-path retry queue in the watcher was tried and removed: it could not
// cover the startup path, swallowed edits landing mid-budget, and its counters
// leaked across interleaved outcomes.) A failure that survives the attempts is
// treated as durable (corrupt/missing .wasm — needs user action); langLoads
// still self-resets, so a LATER call (next fs event / rescan / restart) probes
// again rather than latching the language off forever.
const GRAMMAR_LOAD_ATTEMPTS = 3;
const GRAMMAR_RETRY_BASE_MS = 50;
// After a full attempt budget fails, further ensures for that language FAIL
// FAST for this window instead of re-running the backoff sequence. Without
// it, the memo's self-reset composes badly with the serial batch path: a
// permanently corrupt .wasm would cost ~150ms of backoff PER FILE of that
// language (5,000 files ≈ 12+ minutes of stall inside one indexAll). With
// it, a batch sweeps at full speed (~one backoff sequence per TTL window)
// while a later probe — the next fs event / rescan after the window — still
// retries fresh, so the language is never latched off.
const GRAMMAR_FAILURE_TTL_MS = 5_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const langFailures = new Map<string, { at: number; err: unknown }>();

function ensureLanguage(lang: string): Promise<void> {
  const wasm = LANG_TO_WASM[lang];
  // Unknown/unsupported names are a no-op here (the scanner emits 'unknown'
  // for unrecognized extensions); parseFile still warns when asked to parse one.
  if (!wasm) return Promise.resolve();
  let p = langLoads.get(lang);
  if (!p) {
    const recent = langFailures.get(lang);
    if (recent !== undefined) {
      if (Date.now() - recent.at < GRAMMAR_FAILURE_TTL_MS) {
        return Promise.reject(recent.err); // fail fast inside the TTL window
      }
      langFailures.delete(lang); // window over → probe again for real
    }
    p = (async () => {
      let lastErr: unknown;
      for (let attempt = 1; attempt <= GRAMMAR_LOAD_ATTEMPTS; attempt++) {
        try {
          const language = await Language.load(path.join(grammarsDir, wasm));
          const parser = new Parser();
          parser.setLanguage(language);
          parsers.set(lang, parser);
          langFailures.delete(lang);
          return;
        } catch (err) {
          lastErr = err;
          if (attempt < GRAMMAR_LOAD_ATTEMPTS) {
            await delay(GRAMMAR_RETRY_BASE_MS * attempt);
          }
        }
      }
      langFailures.set(lang, { at: Date.now(), err: lastErr });
      throw lastErr;
    })();
    p.catch(() => {
      langLoads.delete(lang); // durable failure → a later call probes again
    });
    langLoads.set(lang, p);
  }
  return p;
}

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

// tree-sitter-objc cannot parse a bare `NS_ASSUME_NONNULL_BEGIN` (no trailing
// semicolon) before an `@interface` — it mis-parses the macro as a type and DROPS THE
// WHOLE interface (degrading to a labeled/expression statement, 0 symbols). That macro
// brackets virtually every modern ObjC header. We blank each `NS_ASSUME_NONNULL_BEGIN/
// END` LINE to equal-length whitespace (newlines untouched) so byte offsets + line
// numbers are preserved — the extractor's slices still match the on-disk file — while
// the interface now parses. Exactly the Swift `#if` pattern: applied by parseFile ONLY
// when the raw parse errors and the neutralized parse is clean (see call site).
// Fast-pathed when the file contains no such macro. (Residual NS_ENUM/NS_OPTIONS/
// FOUNDATION_EXPORT macro-opacity is a documented recall-only gap, not covered here.)
// Only a STANDALONE macro line (optionally followed by whitespace or a `//` line
// comment) is blanked — never a line that carries real code after the macro. This
// keeps the equal-length-blanking safe (it removes only the stray macro token, never
// shifts braces or drops a declaration sharing the line).
const OBJC_NULLABILITY_LINE = /^[ \t]*NS_ASSUME_NONNULL_(?:BEGIN|END)\b[ \t]*(?:\/\/.*)?$/gm;

function neutralizeObjcDirectives(content: string): string {
  if (!content.includes('NS_ASSUME_NONNULL_')) return content;
  return content.replace(OBJC_NULLABILITY_LINE, (line) => ' '.repeat(line.length));
}

// Counts ERROR + MISSING nodes in a tree. Used to decide whether the ObjC
// nullability-neutralized parse is strictly better than the raw one: an ObjC header
// commonly retains OTHER macro-opacity (NS_ENUM/FOUNDATION_EXPORT) after the
// NS_ASSUME_NONNULL fix, so the bar is "fewer errors", not "zero" (unlike Swift's
// brace-sensitive #if, where only a fully clean reparse is safe to adopt). Prunes
// clean subtrees via `hasError` so the walk stays cheap.
function countParseErrors(root: Node): number {
  let count = 0;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === 'ERROR' || node.isMissing) count++;
    for (const c of node.children) {
      if (c.hasError || c.isMissing) stack.push(c);
    }
  }
  return count;
}

// Initialize the runtime and load grammars. With `languages`, loads ONLY those
// grammars (the pipeline passes the scan-found set, so a repo pays memory for
// exactly the languages it contains); with no argument, loads ALL grammars
// (test harnesses and callers that can't know the set up front). Idempotent
// and incremental: each grammar loads at most once, and later calls with new
// languages top up what's already loaded.
export async function initParser(languages?: Iterable<string>): Promise<void> {
  if (!coreInit) {
    coreInit = Parser.init();
    // A cached rejection would otherwise disable parsing (and pattern
    // validation) for the process lifetime after one transient failure —
    // reset so the next call retries.
    coreInit.catch(() => {
      coreInit = null;
    });
  }
  await coreInit;
  const langs = languages ? [...new Set(languages)] : Object.keys(LANG_TO_WASM);
  await Promise.all(langs.map(ensureLanguage));
}

// The returned Tree holds WASM memory; callers must call `tree.delete()` when
// finished — JS GC won't free it.
export function parseFile(content: string, language: string): Tree | null {
  const parser = parsers.get(language);
  if (!parser) {
    if (!(language in LANG_TO_WASM)) {
      log.warn(`parseFile: unsupported language "${language}"`);
      return null;
    }
    // Supported but not loaded — a caller-ordering bug (every parse path must
    // initParser([language]) first). Throw loudly (the pipeline catches and
    // warns per file) rather than silently skipping the file.
    throw new Error(
      `parser not initialized for "${language}"; call initParser(["${language}"]) first`,
    );
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

  // tree-sitter-objc's NS_ASSUME_NONNULL_BEGIN mis-parse (see above), applied the same
  // CONDITIONALLY: adopt the neutralized parse only when the raw one ERRORS and
  // neutralization does NOT increase the error count. A header may carry other
  // unfixable macro-opacity (NS_ENUM etc.), so the bar is no-more-errors, not zero
  // (unlike Swift). Crucially `<=`, not `<`: when the raw mis-parse buries a whole
  // @interface inside ONE giant ERROR node and the neutralized parse hoists that
  // interface cleanly but still errors on an intervening NS_ENUM, the error-NODE counts
  // tie — yet the neutralized parse is strictly better. Blanking a balanced STANDALONE
  // macro line only removes a stray token (never adds one or shifts braces), so the
  // neutralized parse is never structurally worse; adopting an equal-count tie is safe.
  if (language === 'objc' && tree.rootNode.hasError && content.includes('NS_ASSUME_NONNULL_')) {
    const neutralized = neutralizeObjcDirectives(content);
    if (neutralized !== content) {
      const alt = parser.parse(neutralized);
      if (alt && countParseErrors(alt.rootNode) <= countParseErrors(tree.rootNode)) {
        tree.delete();
        tree = alt;
      } else {
        alt?.delete();
      }
    }
  }
  return tree;
}
