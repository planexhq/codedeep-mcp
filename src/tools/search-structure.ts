import type { CodeIndex } from '../indexer/code-index.js';
import { initParser, parseFile } from '../indexer/parser.js';
import type { Indexer } from '../indexer/pipeline.js';
import { compareShallowFirst } from '../indexer/scanner.js';
import { errMsg, log } from '../logger.js';
import type { FileInfo, GitMeta, ProbeConfig, Symbol } from '../types.js';

import {
  MODULE_LEVEL,
  displaySignature,
  innermostEnclosing,
  omittedSuffix,
  readinessBanner,
  safeReadIndexedFile,
  textResponse,
  type ToolResponse,
} from './common.js';

export interface SearchStructureArgs {
  query?: string;
  pattern?: string;
  language?: string;
  limit?: number;
}

export interface SearchStructureDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: ProbeConfig;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

// Git churn boost for query mode: recently active files float up. Capped
// at 1.5x — the same magnitude as the exported-symbol boost — so churn
// reorders near-ties but never outweighs MiniSearch's name relevance
// (name field boost is 3). log1p-scaled because commit counts are
// heavy-tailed: one 300-commit churner must not flatten the boost for
// the 1-30 range where most files live.
const GIT_BOOST_MAX_EXTRA = 0.5;

// Memoized on the GitMeta OBJECT IDENTITY: every path that changes the
// underlying commitFrequency data — applyGitAnalysis, load(), and
// clearGitData() — replaces (or nulls) the GitMeta instance, so keying
// on the object collapses cache validity into one invariant owned by
// CodeIndex itself. No generation counter, no cross-module guard.
const boostMemo = new WeakMap<GitMeta, ReadonlyMap<string, number> | undefined>();

function gitBoostMap(
  deps: SearchStructureDeps,
): ReadonlyMap<string, number> | undefined {
  const meta = deps.index.getGitMeta();
  if (meta === null) return undefined;
  if (boostMemo.has(meta)) return boostMemo.get(meta);

  const churned = deps.index
    .getAllFiles()
    .filter((f) => (f.commitFrequency ?? 0) > 0);
  let map: Map<string, number> | undefined;
  if (churned.length > 0) {
    // Plain loop, NOT Math.max(...spread): spreading throws RangeError
    // past ~125k elements, and an exception here would surface as an
    // in-band tool error caused purely by git enrichment.
    let maxLog = 0;
    for (const f of churned) {
      const lg = Math.log1p(f.commitFrequency!);
      if (lg > maxLog) maxLog = lg;
    }
    map = new Map(
      churned.map((f) => [
        f.path,
        1 + GIT_BOOST_MAX_EXTRA * (Math.log1p(f.commitFrequency!) / maxLog),
      ]),
    );
  }
  boostMemo.set(meta, map);
  return map;
}
// Pattern scans read every candidate file from disk; bound the worst case
// (zero matches on a huge repo) and tell the caller to narrow instead.
const PATTERN_FILE_CAP = 2000;
const MATCH_TEXT_CAP = 120;

// User-facing language names → index-internal language ids.
const LANGUAGE_ALIASES: Record<string, readonly string[]> = {
  typescript: ['typescript', 'tsx'],
  ts: ['typescript', 'tsx'],
  tsx: ['tsx'],
  javascript: ['javascript'],
  js: ['javascript'],
  python: ['python'],
  py: ['python'],
  java: ['java'],
  go: ['go'],
  golang: ['go'],
  rust: ['rust'],
  rs: ['rust'],
  swift: ['swift'],
  kotlin: ['kotlin'],
  kt: ['kotlin'],
};
const SUPPORTED_LANGUAGES = 'typescript, tsx, javascript, python, java, go, rust, swift, kotlin';

type AstGrep = typeof import('@ast-grep/napi');
// Type-only — erased at compile time, so it cannot trigger the native
// binding load that the lazy loader below guards against.
type AgLang = import('@ast-grep/napi').Lang;

// Loaded lazily and cached: the native binding is only touched when a
// `pattern` call arrives, and a load failure (unsupported platform)
// degrades pattern mode without affecting the rest of the server.
let astGrepLoad: Promise<AstGrep | null> | undefined;
function loadAstGrep(): Promise<AstGrep | null> {
  astGrepLoad ??= import('@ast-grep/napi').then(
    (m) => m,
    (err: unknown) => {
      log.warn(`search_structure: @ast-grep/napi unavailable: ${errMsg(err)}`);
      return null;
    },
  );
  return astGrepLoad;
}

export async function runSearchStructure(
  args: SearchStructureArgs,
  deps: SearchStructureDeps,
): Promise<ToolResponse> {
  try {
    const banner = readinessBanner(deps.indexer.ready);
    const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    let languages: ReadonlySet<string> | undefined;
    if (args.language !== undefined) {
      const expanded = LANGUAGE_ALIASES[args.language.trim().toLowerCase()];
      if (!expanded) {
        return textResponse(
          `Error: unknown language '${args.language}'. Supported: ${SUPPORTED_LANGUAGES}.`,
        );
      }
      languages = new Set(expanded);
    }

    const pattern = args.pattern?.trim();
    if (pattern) {
      return textResponse(
        banner + (await runPatternMode(pattern, languages, limit, deps)),
      );
    }

    const query = args.query?.trim();
    if (!query) {
      return textResponse(
        'Error: provide a non-empty `query` or an ast-grep `pattern`.',
      );
    }
    return textResponse(banner + runQueryMode(query, languages, limit, deps, args.language));
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

function runQueryMode(
  query: string,
  languages: ReadonlySet<string> | undefined,
  limit: number,
  deps: SearchStructureDeps,
  languageArg: string | undefined,
): string {
  const { symbols, total } = deps.index.searchSymbols(query, {
    limit,
    languages,
    boostByFile: gitBoostMap(deps),
  });
  if (symbols.length === 0) {
    const filterNote = languageArg ? ` (language: ${languageArg})` : '';
    return `No matches for '${query}'${filterNote}.`;
  }
  const blocks = symbols.map(renderSymbolBlock);
  if (total > symbols.length) {
    blocks.push(omittedSuffix(total - symbols.length));
  }
  return blocks.join('\n\n');
}

function symbolHeader(sym: Symbol): string {
  const exportedSuffix = sym.exported ? ' | exported' : '';
  return `${sym.file}:${sym.startLine}-${sym.endLine} | ${sym.kind}${exportedSuffix}`;
}

function renderSymbolBlock(sym: Symbol): string {
  const lines: string[] = [symbolHeader(sym), displaySignature(sym)];
  if (sym.doc && sym.doc.length > 0) lines.push(sym.doc);
  return lines.join('\n');
}

interface PatternMatch {
  file: string;
  line: number;
  text: string;
}

async function runPatternMode(
  pattern: string,
  languages: ReadonlySet<string> | undefined,
  limit: number,
  deps: SearchStructureDeps,
): Promise<string> {
  const ag = await loadAstGrep();
  if (!ag) {
    return (
      'Error: structural pattern matching is unavailable — the ' +
      '@ast-grep/napi native binding failed to load on this platform. ' +
      'Keyword `query` mode still works.'
    );
  }

  // Pattern matching ships for the ast-grep built-in languages only;
  // other indexed languages would need the pre-1.0 @ast-grep/lang-*
  // packages.
  const patternLangs = new Map<string, AgLang>([
    ['typescript', ag.Lang.TypeScript],
    ['tsx', ag.Lang.Tsx],
    ['javascript', ag.Lang.JavaScript],
  ]);
  const targets = new Map(
    [...patternLangs].filter(([id]) => !languages || languages.has(id)),
  );
  if (targets.size === 0) {
    return (
      'Structural patterns are not supported for this language yet — ' +
      'this phase covers TypeScript/TSX/JavaScript only. ' +
      'Keyword `query` mode works for all indexed languages.'
    );
  }

  // ast-grep does not reject malformed patterns (they silently match
  // nothing), so validate by parsing the pattern as code with our own
  // tree-sitter grammars. `hasError` covers both ERROR nodes and
  // zero-width MISSING-token recovery (e.g. `function f() {`), which an
  // ERROR-kind query would let through.
  await initParser();
  const invalidLangs: string[] = [];
  for (const id of targets.keys()) {
    if (!patternParses(id, pattern)) {
      invalidLangs.push(id);
      targets.delete(id);
    }
  }
  if (targets.size === 0) {
    return `Error: invalid ast-grep pattern '${pattern}' — it does not parse as ${invalidLangs.join('/')} code.`;
  }

  const files = deps.index
    .getAllFiles()
    .filter((f) => targets.has(f.language))
    .sort(compareShallowFirst);

  const { matches, skipped, fileCapHit } = await scanPattern(
    ag,
    pattern,
    targets,
    files,
    limit,
    deps.config,
  );

  const blocks = renderPatternMatches(matches.slice(0, limit), deps.index);
  if (blocks.length === 0) {
    if (files.length > 0) {
      blocks.push(`No structural matches for pattern '${pattern}'.`);
    } else if (languages !== undefined || invalidLangs.length > 0) {
      // A blanket "nothing is indexed" claim would be false here — the
      // emptiness came from the language filter / pattern validation.
      blocks.push(
        `No structural matches for pattern '${pattern}' — no indexed files match the scanned language(s) (${[...targets.keys()].join('/')}).`,
      );
    } else {
      blocks.push(
        `No structural matches for pattern '${pattern}' — no TypeScript/TSX/JavaScript files are indexed.`,
      );
    }
  }

  const notes: string[] = [];
  if (matches.length > limit) notes.push('(more matches exist; raise `limit` to see all)');
  if (fileCapHit) {
    notes.push(
      `(stopped after scanning ${PATTERN_FILE_CAP} files; pass \`language\` to narrow the scan)`,
    );
  }
  if (skipped > 0) notes.push(`(${skipped} file${skipped === 1 ? '' : 's'} could not be read and were skipped)`);
  if (invalidLangs.length > 0) {
    notes.push(`(pattern does not parse as ${invalidLangs.join('/')}; those files were skipped)`);
  }
  return [...blocks, ...notes].join('\n\n');
}

// Validates the pattern by parsing it as code with OUR web-tree-sitter
// grammar for the index language id. Requires initParser() to have run
// (the caller awaits it). No catch: an unexpected parser throw must reach
// runSearchStructure's outer in-band handler as the REAL error, not be
// mislabeled as an invalid pattern.
function patternParses(languageId: string, pattern: string): boolean {
  const tree = parseFile(pattern, languageId);
  if (!tree) return false;
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

interface ScanResult {
  matches: PatternMatch[];
  skipped: number;
  fileCapHit: boolean;
}

// Reads and scans each candidate file, collecting up to limit+1 matches
// (the sentinel detects truncation). Per-file failures are skipped and
// counted, never thrown.
async function scanPattern(
  ag: AstGrep,
  pattern: string,
  targets: ReadonlyMap<string, AgLang>,
  files: FileInfo[],
  limit: number,
  config: ProbeConfig,
): Promise<ScanResult> {
  const matches: PatternMatch[] = [];
  let scanned = 0;
  let skipped = 0;
  let fileCapHit = false;
  for (const file of files) {
    if (matches.length > limit) break;
    if (scanned >= PATTERN_FILE_CAP) {
      fileCapHit = true;
      break;
    }
    scanned++;
    try {
      const content = await safeReadIndexedFile(file.path, config);
      // parseAsync offloads parsing to the threadpool, so long scans
      // keep yielding to the event loop between files.
      const root = (await ag.parseAsync(targets.get(file.language)!, content)).root();
      for (const node of root.findAll(pattern)) {
        matches.push({
          file: file.path,
          line: node.range().start.line + 1,
          text: firstLine(node.text()),
        });
        if (matches.length > limit) break;
      }
    } catch (err) {
      skipped++;
      log.debug(`search_structure: skipped ${file.path}: ${errMsg(err)}`);
    }
  }
  return { matches, skipped, fileCapHit };
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  const line = nl === -1 ? text : text.slice(0, nl);
  return line.length > MATCH_TEXT_CAP ? `${line.slice(0, MATCH_TEXT_CAP)}…` : line;
}

// Groups matches by (file, enclosing symbol); module-level matches get a
// `file (module level)` header. Insertion order follows scan order, so
// output stays shallow-first and in-document-order.
function renderPatternMatches(matches: PatternMatch[], index: CodeIndex): string[] {
  interface Group {
    header: string;
    signature: string | null;
    rows: string[];
  }
  const groups = new Map<string, Group>();
  for (const m of matches) {
    const sym = innermostEnclosing(index.getSymbolsInFile(m.file), m.line);
    const key = `${m.file}\0${sym?.id ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = sym
        ? { header: symbolHeader(sym), signature: displaySignature(sym), rows: [] }
        : { header: `${m.file} ${MODULE_LEVEL}`, signature: null, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(`  match :${m.line}  ${m.text}`);
  }
  const blocks: string[] = [];
  for (const g of groups.values()) {
    const lines = g.signature ? [g.header, g.signature, ...g.rows] : [g.header, ...g.rows];
    blocks.push(lines.join('\n'));
  }
  return blocks;
}
