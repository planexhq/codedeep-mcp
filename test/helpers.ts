import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { symbolId } from '../src/indexer/extractor.js';
import type { FileInfo, ProbeConfig, Symbol, SymbolKind } from '../src/types.js';

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

export const skipOnWindows = process.platform === 'win32';

export function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

export function makeConfig(
  root: string,
  overrides: Partial<ProbeConfig> = {},
): ProbeConfig {
  const base = loadConfig(root);
  return Object.freeze({
    projectRoot: overrides.projectRoot ?? base.projectRoot,
    exclude: Object.freeze([...(overrides.exclude ?? base.exclude)]),
    languages: Object.freeze([...(overrides.languages ?? base.languages)]),
    maxFiles: overrides.maxFiles ?? base.maxFiles,
    maxFileSize: overrides.maxFileSize ?? base.maxFileSize,
    cacheDir: overrides.cacheDir ?? base.cacheDir,
  }) as ProbeConfig;
}

export interface SymOpts {
  name: string;
  file?: string;
  kind?: SymbolKind;
  signature?: string;
  exported?: boolean;
  language?: string;
  startLine?: number;
  endLine?: number;
  doc?: string | null;
  parent?: string;
}

export function mkSym(opts: SymOpts): Symbol {
  const file = opts.file ?? 'src/test.ts';
  const kind = opts.kind ?? 'function';
  const signature = opts.signature ?? '';
  const fqn = opts.parent
    ? `${file}:${opts.parent}.${opts.name}`
    : `${file}:${opts.name}`;
  return {
    id: symbolId(file, opts.name, kind, signature, opts.parent ?? ''),
    name: opts.name,
    fqn,
    kind,
    file,
    startLine: opts.startLine ?? 1,
    endLine: opts.endLine ?? 1,
    signature,
    doc: opts.doc ?? null,
    exported: opts.exported ?? false,
    language: opts.language ?? 'typescript',
  };
}
