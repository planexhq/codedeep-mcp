import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { symbolId } from '../src/indexer/extractor.js';
import type {
  FileInfo,
  ImportedName,
  ImportInfo,
  ProbeConfig,
  Reference,
  Symbol,
  SymbolKind,
} from '../src/types.js';

export function makeProjectDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function writeTree(
  root: string,
  files: Record<string, string | Buffer>,
): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function makeFileInfo(language: string, path = 'src/test.x'): FileInfo {
  return { path, language, size: 0, lastModified: 0, lastIndexed: 0, symbolCount: 0 };
}

export const skipOnWindows = process.platform === 'win32';

export function silenceStderr() {
  return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
}

export async function withChmod<T>(
  path: string,
  mode: number,
  fn: () => Promise<T>,
): Promise<T> {
  const original = statSync(path).mode;
  chmodSync(path, mode);
  try {
    return await fn();
  } finally {
    chmodSync(path, original);
  }
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

export function mkRef(source: Symbol, target: Symbol): Reference {
  return {
    sourceId: source.id,
    targetId: target.id,
    targetName: target.name,
    kind: 'calls',
    file: source.file,
    line: source.startLine,
  };
}

// File-scope (module-level) call site: `sourceId === null`, target precisely
// resolved to a same-file symbol id. Anchored at `target.file`.
export function mkModuleRef(target: Symbol, line = 1): Reference {
  return {
    sourceId: null,
    targetId: target.id,
    targetName: target.name,
    kind: 'calls',
    file: target.file,
    line,
  };
}

// Cross-file call site whose target name failed to resolve to an id
// (typical of imported names before/without LSP). Source symbol is known.
export function mkUnresolvedRef(
  source: Symbol,
  targetName: string,
  file = source.file,
  line = 1,
): Reference {
  return {
    sourceId: source.id,
    targetId: null,
    targetName,
    kind: 'calls',
    file,
    line,
  };
}

export function mkImport(
  file: string,
  sourceModule: string,
  names: Array<string | ImportedName> = [],
): ImportInfo {
  return {
    file,
    sourceModule,
    importedNames: names.map((n) => (typeof n === 'string' ? { name: n } : n)),
    line: 1,
  };
}
