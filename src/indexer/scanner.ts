import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep, posix } from 'node:path';
import picomatch from 'picomatch';

import type { FileInfo, ProbeConfig } from '../types.js';
import { log } from '../logger.js';

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4',
  '.zip', '.tar', '.gz',
  '.wasm', '.pdf',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
  '.class', '.pyc', '.pyo',
]);

const GLOB_CHARS = /[*?[\]{}!]/;

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

export function detectLanguage(filename: string): string | null {
  const ext = posix.extname(toPosix(filename)).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? null;
}

export function isBinaryByExtension(filename: string): boolean {
  return BINARY_EXT.has(posix.extname(toPosix(filename)).toLowerCase());
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

async function* walk(
  root: string,
  dir: string,
  matchExclude: (relPath: string) => boolean,
): AsyncGenerator<{ absPath: string; relPath: string }> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (dir === root) throw err;
    log.warn(`scanner: readdir failed for ${dir}: ${(err as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absPath = join(dir, entry.name);
    const relPath = toPosix(relative(root, absPath));
    if (entry.isDirectory()) {
      if (matchExclude(relPath)) continue;
      yield* walk(root, absPath, matchExclude);
    } else if (entry.isFile()) {
      yield { absPath, relPath };
    }
  }
}

export async function scanProject(config: ProbeConfig): Promise<FileInfo[]> {
  const matchExclude = compileExcludeMatcher(config.exclude);
  const langSet = new Set(config.languages);
  const root = config.projectRoot;

  const results: FileInfo[] = [];

  for await (const { absPath, relPath } of walk(root, root, matchExclude)) {
    if (results.length >= config.maxFiles) {
      log.warn(
        `scanner: reached maxFiles=${config.maxFiles}; remaining files skipped`,
      );
      break;
    }

    if (matchExclude(relPath)) continue;
    if (isBinaryByExtension(relPath)) continue;

    const language = detectLanguage(relPath);
    if (language === null) continue;
    if (!langSet.has(language)) continue;

    let stats;
    try {
      stats = await stat(absPath);
    } catch (err) {
      log.warn(`scanner: stat failed for ${relPath}: ${(err as Error).message}`);
      continue;
    }

    if (stats.size > config.maxFileSize) {
      log.debug(
        `scanner: skip ${relPath} (size ${stats.size} > maxFileSize ${config.maxFileSize})`,
      );
      continue;
    }

    results.push({
      path: relPath,
      language,
      size: stats.size,
      lastModified: stats.mtimeMs,
      lastIndexed: 0,
      symbolCount: 0,
    });
  }

  results.sort((a, b) => {
    const da = depthOf(a.path);
    const db = depthOf(b.path);
    if (da !== db) return da - db;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return results;
}
