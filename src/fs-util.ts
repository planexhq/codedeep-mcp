// Neutral filesystem helpers with no layer above them: used by the indexer
// (scanner/pipeline/watcher), config resolution, the tools layer, AND the
// notes layer. They live here — not in tools/common.ts or indexer/scanner.ts —
// so lower layers (notes/, config.ts) never import from a higher one just to
// read a file or normalize a separator.

import { promises as fs } from 'node:fs';
import { join, sep } from 'node:path';

import type { CodedeepConfig } from './types.js';

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

// projectRoot is fixed for the process lifetime, so its realpath is too —
// caching it spares one syscall per safeReadIndexedFile call (pattern
// scans call this once per candidate file).
const realRootCache = new Map<string, string>();
async function realProjectRoot(projectRoot: string): Promise<string> {
  let cached = realRootCache.get(projectRoot);
  if (cached === undefined) {
    cached = await fs.realpath(projectRoot);
    realRootCache.set(projectRoot, cached);
  }
  return cached;
}

// Re-check scanner admission rules at read time so stale on-disk
// state (symlink-swap, growth past cap, became-directory) can't
// bypass the indexer's contract.
export async function safeReadIndexedFile(
  relPath: string,
  config: CodedeepConfig,
): Promise<string> {
  const abs = join(config.projectRoot, relPath);
  const stats = await fs.lstat(abs);
  if (stats.isSymbolicLink()) {
    throw new Error('refusing to follow symlink');
  }
  if (!stats.isFile()) {
    throw new Error('not a regular file');
  }
  if (stats.size > config.maxFileSize) {
    throw new Error(
      `exceeds maxFileSize (${stats.size} > ${config.maxFileSize})`,
    );
  }
  // lstat only checks the final component. Resolve parent-directory
  // symlinks so a swap higher up in the path can't escape projectRoot.
  const [real, realRoot] = await Promise.all([
    fs.realpath(abs),
    realProjectRoot(config.projectRoot),
  ]);
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new Error('path escapes project root');
  }
  return fs.readFile(abs, 'utf8');
}
