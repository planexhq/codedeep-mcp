import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FileInfo } from '../src/types.js';

export function makeProjectDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

export function makeFileInfo(language: string, path = 'src/test.x'): FileInfo {
  return { path, language, size: 0, lastModified: 0, lastIndexed: 0, symbolCount: 0 };
}
