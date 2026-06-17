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
};

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

    const language = detectLanguage(relPath) ?? LANGUAGE_UNKNOWN;
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
