import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';

import { loadConfig } from '../src/config.js';
import { symbolId } from '../src/indexer/extractor.js';
import type {
  CoChange,
  FileInfo,
  GitMeta,
  ImportedName,
  ImportInfo,
  CodedeepConfig,
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
  overrides: Partial<CodedeepConfig> = {},
): CodedeepConfig {
  const base = loadConfig(root);
  return Object.freeze({
    projectRoot: overrides.projectRoot ?? base.projectRoot,
    exclude: Object.freeze([...(overrides.exclude ?? base.exclude)]),
    languages: Object.freeze([...(overrides.languages ?? base.languages)]),
    maxFiles: overrides.maxFiles ?? base.maxFiles,
    maxFileSize: overrides.maxFileSize ?? base.maxFileSize,
    cacheDir: overrides.cacheDir ?? base.cacheDir,
    watch: overrides.watch ?? base.watch,
    gitEnabled: overrides.gitEnabled ?? base.gitEnabled,
    gitWindow: overrides.gitWindow ?? base.gitWindow,
  }) as CodedeepConfig;
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
  complexity?: number;
  cognitiveComplexity?: number;
}

export function mkSym(opts: SymOpts): Symbol {
  const file = opts.file ?? 'src/test.ts';
  const kind = opts.kind ?? 'function';
  const signature = opts.signature ?? '';
  const fqn = opts.parent
    ? `${file}:${opts.parent}.${opts.name}`
    : `${file}:${opts.name}`;
  const sym: Symbol = {
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
  if (opts.complexity !== undefined) sym.complexity = opts.complexity;
  if (opts.cognitiveComplexity !== undefined)
    sym.cognitiveComplexity = opts.cognitiveComplexity;
  return sym;
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

// Member-expression call site (`receiver.targetName()`). Unresolved by
// default (targetId=null, the common cross-file case); pass targetId for
// extract-time-resolved member calls, and selfReceiver for this/self/cls
// call sites (the extractor records that flag, not the receiver token).
export function mkMemberRef(
  source: Symbol | null,
  targetName: string,
  receiver: string,
  opts: {
    targetId?: string | null;
    file?: string;
    line?: number;
    selfReceiver?: boolean;
  } = {},
): Reference {
  const ref: Reference = {
    sourceId: source?.id ?? null,
    targetId: opts.targetId ?? null,
    targetName,
    kind: 'calls',
    file: opts.file ?? source?.file ?? 'src/test.ts',
    line: opts.line ?? 1,
    receiver,
  };
  if (opts.selfReceiver) ref.selfReceiver = true;
  return ref;
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

// Disabled-git stub for tool deps: behaves like a non-git project (null /
// empty returns) so non-git assertions stay valid. Git-specific tests
// spread-override the methods they need. Satisfies every Pick<GitService>
// a tool dep declares.
export function makeGitStub(
  overrides: Partial<{
    branchSummary: () => Promise<import('../src/git/git-service.js').BranchSummary | null>;
    recentCommits: (
      path: string,
      n?: number,
    ) => Promise<import('../src/git/git-service.js').RecentCommit[]>;
    currentHead: () => Promise<string | null>;
    childGitRepos: readonly string[];
  }> = {},
) {
  return {
    branchSummary: async () => null,
    recentCommits: async () => [],
    currentHead: async () => null,
    childGitRepos: [] as readonly string[],
    ...overrides,
  };
}

// Builders for git-enrichment fixtures, mirroring mkSym/mkRef for the
// structural side. mkCoChange keeps the canonical fileA < fileB
// orientation the analyzer guarantees ONLY if callers pass it that way —
// tests deliberately pass both orientations to pin direction handling.
export function mkCoChange(
  fileA: string,
  fileB: string,
  shared = 3,
  overrides: Partial<CoChange> = {},
): CoChange {
  return {
    fileA,
    fileB,
    sharedCommits: shared,
    confidenceAB: 0.5,
    confidenceBA: 0.25,
    lastSeen: 1_000_000,
    ...overrides,
  };
}

export function mkGitMeta(overrides: Partial<GitMeta> = {}): GitMeta {
  return {
    head: 'h'.repeat(40),
    windowDays: 180,
    analyzedAt: Date.now(),
    ...overrides,
  };
}
