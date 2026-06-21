import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import picomatch from 'picomatch';

import { LANGUAGE_UNKNOWN, type FileInfo, type ProbeConfig } from '../types.js';
import { log } from '../logger.js';

const BYTE_CHECK_BUF_SIZE = 8192;

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.dart': 'dart',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.rake': 'ruby',
  '.gemspec': 'ruby',
  // C: `.c` source files use the dedicated tree-sitter-c grammar — NOT
  // tree-sitter-cpp, which errors on K&R old-style functions and mis-parses C
  // code that uses C++ keywords as identifiers (`int new;`, `int class;`).
  // `'c'` then dispatches to the C++ extractor (tree-sitter-c and -cpp produce
  // byte-identical ASTs for the C subset — see extractor.ts).
  '.c': 'c',
  // C++: the C++-specific source/header extensions plus `.h`. `.h` is
  // ambiguous (C or C++) but C++ is the dominant case for this tool's
  // audience and tree-sitter-cpp parses C headers fine as a superset — so a C
  // header maps to 'cpp', not 'c' (only `.c` is C-specific).
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.ipp': 'cpp',
  '.tpp': 'cpp',
  '.h': 'cpp',
  // Objective-C: `.m` is unambiguous ObjC. `.h` stays mapped to 'cpp' above and is
  // content-sniffed (refineHeaderLanguage) — ObjC headers are also `.h` and hold the
  // bulk of the API (@protocol + @property are header-exclusive). `.mm` (ObjC++) is
  // intentionally UNMAPPED (it needs a separate grammar; tree-sitter-objc errors on
  // the C++ parts) — it falls through to LANGUAGE_UNKNOWN.
  '.m': 'objc',
};

// Line-anchored Objective-C markers used to refine an ambiguous `.h` from cpp→objc.
// Anchoring kills the false positives a substring match would hit: `//@interface`
// comments, a `"#import"` string literal, and C++23's bare `import std;` (which has
// neither the leading `#` of `#import` nor the `@` of `@import`). `#import` is
// ObjC-exclusive and present in essentially every ObjC header.
const OBJC_HEADER_MARKERS: readonly RegExp[] = [
  // `#import` is the dominant ObjC header signal (also a niche MSVC C++ directive, so
  // not strictly ObjC-exclusive — but a C++ `.h` using MSVC `#import` is rare and the
  // mis-route is recall-only). All markers are LINE-ANCHORED so a `//@interface`
  // comment or a `"#import"` string literal never matches.
  /^\s*#\s*import\b/m,
  /^\s*@(?:interface|protocol|implementation|class|import)\b/m,
  /^\s*NS_ASSUME_NONNULL_(?:BEGIN|END)\b/m,
  // `typedef NS_ENUM(NSInteger, Foo)` is the real shape, so allow a leading
  // `typedef` (still line-anchored — a `// NS_ENUM(...)` comment stays excluded).
  /^\s*(?:typedef\s+)?NS_(?:ENUM|OPTIONS)\s*\(/m,
];

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4',
  '.zip', '.tar', '.gz',
  '.wasm', '.pdf',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.class', '.pyc', '.pyo', '.jar', '.war',
]);

const GLOB_CHARS = /[*?[\]{}!]/;

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

export function detectLanguage(filename: string): string | null {
  const ext = posix.extname(toPosix(filename)).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? null;
}

// A `.h` file is ambiguous: a C/C++ header maps to 'cpp' (above), but an Objective-C
// header is also `.h` and holds the public API (@protocol + @property are
// header-exclusive). tree-sitter-cpp errors on every ObjC header, and tree-sitter-objc
// wrecks C++ headers, so a blanket route is wrong either way. Refine the detected
// language by content: ONLY a `.h`-that-resolved-to-'cpp', and ONLY when 'objc' is a
// configured language (so disabling objc keeps `.h`→cpp), read the first 8KB and route
// to 'objc' iff a line-anchored ObjC marker matches. Self-heals: `isUnchanged` compares
// the stored language, so a later heuristic tweak re-indexes a re-classified `.h` with
// no schema bump. Everything else returns `language` unchanged (one I/O-free fast path).
export async function refineHeaderLanguage(
  absPath: string,
  language: string,
  langSet: ReadonlySet<string>,
): Promise<string> {
  // Only the ambiguous `.h` extension is sniffed. `.cpp`/`.hpp`/`.cc`/… also map to
  // 'cpp' but are unambiguously C++ — they must NOT pay the read or risk a misroute.
  if (
    language !== 'cpp' ||
    !langSet.has('objc') ||
    posix.extname(toPosix(absPath)).toLowerCase() !== '.h'
  ) {
    return language;
  }
  let head: string;
  try {
    const fh = await open(absPath, 'r');
    try {
      const buf = Buffer.alloc(BYTE_CHECK_BUF_SIZE);
      const { bytesRead } = await fh.read(buf, 0, BYTE_CHECK_BUF_SIZE, 0);
      head = buf.toString('utf8', 0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    // A read failure here is non-fatal for routing — keep the path-based 'cpp'.
    return language;
  }
  return OBJC_HEADER_MARKERS.some((re) => re.test(head)) ? 'objc' : language;
}

export function isBinaryByExtension(filename: string): boolean {
  return BINARY_EXT.has(posix.extname(toPosix(filename)).toLowerCase());
}

// Reads up to 8KB from absPath and returns true on the first null byte.
// Mirrors git's "any NUL in the prefix means binary" heuristic. Used only
// for unknown-extension files; trusted source extensions skip this I/O.
export async function isBinaryByContent(absPath: string): Promise<boolean> {
  const fh = await open(absPath, 'r');
  try {
    const buf = Buffer.alloc(BYTE_CHECK_BUF_SIZE);
    const { bytesRead } = await fh.read(buf, 0, BYTE_CHECK_BUF_SIZE, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } finally {
    await fh.close();
  }
}

export function compileExcludeMatcher(
  patterns: readonly string[],
): (relPath: string) => boolean {
  const expanded: string[] = [];
  for (const p of patterns) {
    const hasSlash = p.includes('/');
    const hasGlob = GLOB_CHARS.test(p);
    if (!hasSlash && !hasGlob) {
      expanded.push(p, `${p}/**`, `**/${p}`, `**/${p}/**`);
    } else if (!hasSlash && hasGlob) {
      expanded.push(p, `**/${p}`);
    } else {
      expanded.push(p);
    }
  }
  const isMatch = picomatch(expanded, { dot: true });
  return (relPath: string) => isMatch(relPath);
}

export function depthOf(relPath: string): number {
  let n = 0;
  for (let i = 0; i < relPath.length; i++) {
    if (relPath.charCodeAt(i) === 47 /* '/' */) n++;
  }
  return n;
}

export function compareShallowFirst<T extends { path: string }>(
  a: T,
  b: T,
): number {
  const da = depthOf(a.path);
  const db = depthOf(b.path);
  if (da !== db) return da - db;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function* walk(
  root: string,
  dir: string,
  matchExclude: (relPath: string) => boolean,
  state: { complete: boolean },
): AsyncGenerator<{ absPath: string; relPath: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (dir === root) throw err;
    // A transient failure here (EACCES/EMFILE/network FS) hides files
    // from this scan. Mark the scan incomplete so callers don't
    // mistake the omission for a deletion.
    state.complete = false;
    log.warn(`scanner: readdir failed for ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absPath = join(dir, entry.name);
    const relPath = toPosix(relative(root, absPath));
    if (entry.isDirectory()) {
      if (matchExclude(relPath)) continue;
      yield* walk(root, absPath, matchExclude, state);
    } else if (entry.isFile()) {
      yield { absPath, relPath };
    }
  }
}

export interface ScanResult {
  files: FileInfo[];
  // False if any non-root readdir or per-file stat failed mid-scan,
  // so callers can avoid pruning cached entries that may still exist.
  // The maxFiles cap is intentional truncation and does NOT flip this.
  complete: boolean;
}

export async function scanProject(config: ProbeConfig): Promise<ScanResult> {
  const matchExclude = compileExcludeMatcher(config.exclude);
  const langSet = new Set(config.languages);
  const root = config.projectRoot;
  const cap =
    config.maxFiles > 0 ? config.maxFiles : Number.MAX_SAFE_INTEGER;

  // parseable claims every cap slot first; unknowns fill residual budget.
  // Without this split, readdir order alone could let overview-only files
  // exhaust a tight maxFiles before src/ is even walked.
  const parseable: FileInfo[] = [];
  const unknown: FileInfo[] = [];
  const state = { complete: true };

  for await (const { absPath, relPath } of walk(root, root, matchExclude, state)) {
    if (parseable.length >= cap) {
      log.warn(
        `scanner: reached maxFiles=${cap}; remaining files skipped`,
      );
      break;
    }

    if (matchExclude(relPath)) continue;
    if (isBinaryByExtension(relPath)) continue;

    let language = detectLanguage(relPath) ?? LANGUAGE_UNKNOWN;
    // A `.h` mapped to 'cpp' may be an Objective-C header — content-sniff it (no-op
    // unless the ext is `.h` AND objc is configured). Done before the langSet gate so
    // a refined 'objc' is kept iff objc is enabled (refineHeaderLanguage self-gates).
    if (language === 'cpp') language = await refineHeaderLanguage(absPath, language, langSet);
    // Recognized-but-unconfigured languages are dropped; unknown files are
    // kept (subject to residual budget) so overview can surface them.
    if (language !== LANGUAGE_UNKNOWN && !langSet.has(language)) continue;

    if (language === LANGUAGE_UNKNOWN) {
      if (unknown.length >= cap - parseable.length) continue;
      try {
        if (await isBinaryByContent(absPath)) continue;
      } catch (err) {
        state.complete = false;
        log.warn(
          `scanner: byte check failed for ${relPath}: ${(err as Error).message}`,
        );
        continue;
      }
    }

    let stats;
    try {
      stats = await stat(absPath);
    } catch (err) {
      state.complete = false;
      log.warn(`scanner: stat failed for ${relPath}: ${(err as Error).message}`);
      continue;
    }

    if (stats.size > config.maxFileSize) {
      log.debug(
        `scanner: skip ${relPath} (size ${stats.size} > maxFileSize ${config.maxFileSize})`,
      );
      continue;
    }

    const fileInfo: FileInfo = {
      path: relPath,
      language,
      size: stats.size,
      lastModified: stats.mtimeMs,
      lastIndexed: 0,
      symbolCount: 0,
    };
    if (language === LANGUAGE_UNKNOWN) unknown.push(fileInfo);
    else parseable.push(fileInfo);
  }

  const remaining = Math.max(0, cap - parseable.length);
  const results = parseable.concat(unknown.slice(0, remaining));
  results.sort(compareShallowFirst);

  return { files: results, complete: state.complete };
}
