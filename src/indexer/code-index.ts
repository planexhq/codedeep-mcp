import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import MiniSearch from 'minisearch';

import { errMsg, log } from '../logger.js';
import type {
  FileInfo,
  ImportInfo,
  IndexStats,
  Reference,
  Symbol,
  SymbolKind,
} from '../types.js';

const SCHEMA_VERSION = 1;

export const ENTRY_POINT_FILENAME_RE =
  /^(index|main|app|server|cli|__main__|__init__)\.(ts|tsx|js|mjs|cjs|jsx|py)$/i;

export const zeroSymbolsByKind = (): Record<SymbolKind, number> => ({
  function: 0,
  class: 0,
  interface: 0,
  type: 0,
  variable: 0,
  method: 0,
  module: 0,
});

interface PersistedSchema {
  version: number;
  createdAt: number;
  projectRoot: string;
  symbols: Array<[string, Symbol]>;
  files: Array<[string, FileInfo]>;
  imports: Array<[string, ImportInfo[]]>;
  callees: Array<[string, string[]]>;
  callers: Array<[string, string[]]>;
}

export class CodeIndex {
  private symbolById = new Map<string, Symbol>();
  private fileByPath = new Map<string, FileInfo>();
  private importsByFile = new Map<string, ImportInfo[]>();

  private symbolsByName = new Map<string, Symbol[]>();
  private symbolsByFile = new Map<string, Symbol[]>();
  private callees = new Map<string, Set<string>>();
  private callers = new Map<string, Set<string>>();

  private sortedNames: string[] = [];
  private sortedNamesLower: string[] = [];
  private namesDirty = true;
  private searchIndex: MiniSearch<Symbol> | null = null;

  private writeLock: Promise<unknown> = Promise.resolve();
  private readonly projectRoot: string;

  constructor(projectRoot = '') {
    this.projectRoot = projectRoot;
  }

  addFile(
    file: FileInfo,
    symbols: Symbol[],
    references: Reference[],
    imports: ImportInfo[],
  ): void {
    this.fileByPath.set(file.path, file);
    this.importsByFile.set(file.path, [...imports]);
    this.symbolsByFile.set(file.path, [...symbols]);

    for (const sym of symbols) {
      this.symbolById.set(sym.id, sym);
      pushOrInit(this.symbolsByName, sym.name, sym);
    }

    for (const ref of references) {
      addAdjacency(this.callees, ref.sourceId, ref.targetId);
      addAdjacency(this.callers, ref.targetId, ref.sourceId);
    }

    this.namesDirty = true;
  }

  removeFile(path: string): void {
    const symsInFile = this.symbolsByFile.get(path);
    if (!symsInFile) return;

    const deletedIds = new Set<string>();
    for (const sym of symsInFile) {
      deletedIds.add(sym.id);
      this.symbolById.delete(sym.id);
      const list = this.symbolsByName.get(sym.name);
      if (!list) continue;
      const filtered = list.filter((s) => s.id !== sym.id);
      if (filtered.length === 0) this.symbolsByName.delete(sym.name);
      else this.symbolsByName.set(sym.name, filtered);
    }

    for (const id of deletedIds) {
      this.callees.delete(id);
      this.callers.delete(id);
    }
    // TODO(phase2): replace these scans with a referencesBySourceFile index
    // when LSP cross-file refs land — see PLAN.md:577-578. Phase 1a refs are
    // within-file so the scans are no-ops, but the cleanup is correct.
    pruneAdjacency(this.callers, deletedIds);
    pruneAdjacency(this.callees, deletedIds);

    this.fileByPath.delete(path);
    this.importsByFile.delete(path);
    this.symbolsByFile.delete(path);
    this.namesDirty = true;
  }

  updateFile(
    file: FileInfo,
    symbols: Symbol[],
    references: Reference[],
    imports: ImportInfo[],
  ): void {
    this.removeFile(file.path);
    this.addFile(file, symbols, references, imports);
  }

  findSymbolByName(name: string, kind?: SymbolKind, scope?: string): Symbol[] {
    const list = this.symbolsByName.get(name);
    if (!list) return [];
    return list.filter((s) => matchesKindScope(s, kind, scope));
  }

  findSymbolsByPrefix(
    prefix: string,
    limit: number,
    kind?: SymbolKind,
    scope?: string,
  ): Symbol[] {
    if (!prefix || limit <= 0) return [];
    this.rebuildIndexesIfDirty();
    const prefixLower = prefix.toLowerCase();
    const start = lowerBound(this.sortedNamesLower, prefixLower);
    const out: Symbol[] = [];
    for (let i = start; i < this.sortedNamesLower.length && out.length < limit; i++) {
      if (!this.sortedNamesLower[i].startsWith(prefixLower)) break;
      const syms = this.symbolsByName.get(this.sortedNames[i]);
      if (!syms) continue;
      for (const s of syms) {
        if (out.length >= limit) break;
        if (!matchesKindScope(s, kind, scope)) continue;
        out.push(s);
      }
    }
    return out;
  }

  suggest(
    query: string,
    limit: number,
    kind?: SymbolKind,
    scope?: string,
  ): Symbol[] {
    if (!query || limit <= 0) return [];
    this.rebuildIndexesIfDirty();
    if (!this.searchIndex) return [];
    const results = this.searchIndex.search(query);
    const out: Symbol[] = [];
    for (const r of results) {
      if (out.length >= limit) break;
      const sym = this.symbolById.get(r.id as string);
      if (!sym) continue;
      if (!matchesKindScope(sym, kind, scope)) continue;
      out.push(sym);
    }
    return out;
  }

  getSymbolsInFile(path: string): Symbol[] {
    const list = this.symbolsByFile.get(path);
    return list ? [...list] : [];
  }

  getAllFiles(): FileInfo[] {
    return [...this.fileByPath.values()];
  }

  hasFile(path: string): boolean {
    return this.fileByPath.has(path);
  }

  getCallees(symbolId: string): Symbol[] {
    return this.resolveIds(this.callees.get(symbolId));
  }

  getCallers(symbolId: string): Symbol[] {
    return this.resolveIds(this.callers.get(symbolId));
  }

  getCallerCount(symbolId: string): number {
    return this.callers.get(symbolId)?.size ?? 0;
  }

  getImports(filePath: string): ImportInfo[] {
    const list = this.importsByFile.get(filePath);
    return list ? [...list] : [];
  }

  getExporters(symbolName: string): Symbol[] {
    const list = this.symbolsByName.get(symbolName);
    if (!list) return [];
    return list.filter((s) => s.exported);
  }

  getStats(): IndexStats {
    const filesByLanguage: Record<string, number> = {};
    for (const fi of this.fileByPath.values()) {
      filesByLanguage[fi.language] = (filesByLanguage[fi.language] ?? 0) + 1;
    }

    const symbolsByKind = zeroSymbolsByKind();
    const entries: IndexStats['entryPoints'] = [];
    for (const sym of this.symbolById.values()) {
      symbolsByKind[sym.kind]++;
      if (sym.exported && ENTRY_POINT_FILENAME_RE.test(basename(sym.file))) {
        entries.push({ file: sym.file, symbol: sym.name, line: sym.startLine });
      }
    }
    entries.sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
    );

    return {
      totalFiles: this.fileByPath.size,
      totalSymbols: this.symbolById.size,
      filesByLanguage,
      symbolsByKind,
      entryPoints: entries.slice(0, 20),
    };
  }

  save(cachePath: string): Promise<void> {
    return this.runLocked(async () => {
      const data: PersistedSchema = {
        version: SCHEMA_VERSION,
        createdAt: Date.now(),
        projectRoot: this.projectRoot,
        symbols: [...this.symbolById.entries()],
        files: [...this.fileByPath.entries()],
        imports: [...this.importsByFile.entries()],
        callees: adjacencyToEntries(this.callees),
        callers: adjacencyToEntries(this.callers),
      };
      const json = JSON.stringify(data);
      const tmp = `${cachePath}.tmp.${process.pid}.${Date.now()}`;

      await fs.mkdir(dirname(cachePath), { recursive: true });

      try {
        const fh = await fs.open(tmp, 'w');
        try {
          await fh.writeFile(json);
          await fh.sync();
        } finally {
          await fh.close();
        }
        try {
          await fs.rename(tmp, cachePath);
        } catch {
          // Windows can't rename over an existing file; retry after unlink.
          await fs.unlink(cachePath).catch(() => undefined);
          await fs.rename(tmp, cachePath);
        }
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
    });
  }

  async load(cachePath: string): Promise<boolean> {
    await this.cleanupStaleTmp(cachePath);

    let raw: string;
    try {
      raw = await fs.readFile(cachePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        log.warn(
          `CodeIndex.load: failed to read cache at ${cachePath}: ${errMsg(err)}`,
        );
      }
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`CodeIndex.load: cache is malformed at ${cachePath}; deleting`);
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }

    if (!isValidPersisted(parsed, SCHEMA_VERSION)) {
      log.warn(
        `CodeIndex.load: cache failed validation at ${cachePath}; deleting`,
      );
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }
    if (this.projectRoot && parsed.projectRoot !== this.projectRoot) {
      log.warn(
        `CodeIndex.load: cache projectRoot mismatch (cache=${parsed.projectRoot}, ` +
          `expected=${this.projectRoot}); deleting`,
      );
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }

    const symbolById = new Map<string, Symbol>();
    const fileByPath = new Map<string, FileInfo>();
    const importsByFile = new Map<string, ImportInfo[]>();
    const symbolsByName = new Map<string, Symbol[]>();
    const symbolsByFile = new Map<string, Symbol[]>();
    const callees = new Map<string, Set<string>>();
    const callers = new Map<string, Set<string>>();

    try {
      for (const [id, sym] of parsed.symbols) symbolById.set(id, sym);
      for (const [path, fi] of parsed.files) fileByPath.set(path, fi);
      for (const [path, imps] of parsed.imports) importsByFile.set(path, imps);
      for (const [src, targets] of parsed.callees) callees.set(src, new Set(targets));
      for (const [tgt, sources] of parsed.callers) callers.set(tgt, new Set(sources));

      // Seed entries for zero-symbol files so removeFile's symsInFile guard fires (mirrors addFile).
      for (const path of fileByPath.keys()) symbolsByFile.set(path, []);
      for (const sym of symbolById.values()) {
        pushOrInit(symbolsByName, sym.name, sym);
        pushOrInit(symbolsByFile, sym.file, sym);
      }
    } catch (err) {
      log.warn(
        `CodeIndex.load: cache failed validation at ${cachePath} (${errMsg(
          err,
        )}); deleting`,
      );
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }

    this.symbolById = symbolById;
    this.fileByPath = fileByPath;
    this.importsByFile = importsByFile;
    this.symbolsByName = symbolsByName;
    this.symbolsByFile = symbolsByFile;
    this.callees = callees;
    this.callers = callers;
    // Derived caches: reset; rebuildIndexesIfDirty repopulates lazily.
    this.sortedNames = [];
    this.sortedNamesLower = [];
    this.searchIndex = null;
    this.namesDirty = true;

    return true;
  }

  private async cleanupStaleTmp(cachePath: string): Promise<void> {
    try {
      const dir = dirname(cachePath);
      const base = basename(cachePath);
      const entries = await fs.readdir(dir);
      const tmpPrefix = `${base}.tmp.`;
      await Promise.all(
        entries
          .filter((e) => e.startsWith(tmpPrefix))
          .map((e) => fs.unlink(join(dir, e)).catch(() => undefined)),
      );
    } catch {
      // ignore: parent dir may not exist yet
    }
  }

  private rebuildIndexesIfDirty(): void {
    if (!this.namesDirty) return;
    const names = [...this.symbolsByName.keys()];
    const pairs: Array<[string, string]> = names.map((n) => [n, n.toLowerCase()]);
    // Codepoint compare (not localeCompare) so sort order matches `lowerBound`'s `<`.
    pairs.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    this.sortedNames = pairs.map((p) => p[0]);
    this.sortedNamesLower = pairs.map((p) => p[1]);
    this.searchIndex = new MiniSearch<Symbol>({
      fields: ['name', 'fqn'],
      idField: 'id',
      searchOptions: { fuzzy: 0.2, prefix: true, boost: { name: 2 } },
    });
    this.searchIndex.addAll([...this.symbolById.values()]);
    this.namesDirty = false;
  }

  private resolveIds(ids: Iterable<string> | undefined): Symbol[] {
    if (!ids) return [];
    const out: Symbol[] = [];
    for (const id of ids) {
      const sym = this.symbolById.get(id);
      if (sym) out.push(sym);
    }
    return out;
  }

  private runLocked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(work);
    // Swallow rejections on the lock chain so one failed save doesn't block
    // future ones; the original promise still rejects to the caller.
    this.writeLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function matchesKindScope(
  s: Symbol,
  kind?: SymbolKind,
  scope?: string,
): boolean {
  if (kind && s.kind !== kind) return false;
  if (!scope) return true;
  return scope.endsWith('/') ? s.file.startsWith(scope) : s.file === scope;
}

function pushOrInit<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addAdjacency(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function pruneAdjacency(
  map: Map<string, Set<string>>,
  deleted: Set<string>,
): void {
  for (const [key, set] of map) {
    for (const id of deleted) set.delete(id);
    if (set.size === 0) map.delete(key);
  }
}

function adjacencyToEntries(
  map: Map<string, Set<string>>,
): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const [k, set] of map) out.push([k, [...set]]);
  return out;
}

function lowerBound(arr: string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isValidPersisted(
  data: unknown,
  expectedVersion: number,
): data is PersistedSchema {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === expectedVersion &&
    typeof d.createdAt === 'number' &&
    typeof d.projectRoot === 'string' &&
    Array.isArray(d.symbols) &&
    Array.isArray(d.files) &&
    Array.isArray(d.imports) &&
    Array.isArray(d.callees) &&
    Array.isArray(d.callers)
  );
}
