import { promises as fs } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';

import MiniSearch from 'minisearch';

import { errMsg, log } from '../logger.js';
import { IMPORT_DEFAULT, IMPORT_NAMESPACE, NON_CALLABLE_KINDS } from '../types.js';
import type {
  FileInfo,
  ImportedName,
  ImportInfo,
  IndexStats,
  Reference,
  Symbol,
  SymbolKind,
} from '../types.js';

// v3 adds the optional `kind` discriminator on ImportedName so non-value
// bindings (TS `import type`, `import * as`, Python `import x`) don't
// surface bare callee names as cross-file callers. Older caches lack
// the field — equivalent to kind='value' — so attribution silently
// degrades unless we re-extract; bumping forces a rebuild.
const SCHEMA_VERSION = 3;

// Below this length, names like `do`/`is`/`set` flood with false-positive
// AST name matches across files. find_references and getCallerCount both
// fall back to precise within-file resolution at or below this threshold.
export const SHORT_NAME_THRESHOLD = 4;

// Suffix candidates appended to a relative-import resolution to match an
// indexed file path. Order encodes language-specific resolution preference;
// each list is selected by `normalizeImportSpecifier` based on the
// importer's language and the specifier's explicit extension.

// Python imports cannot resolve to non-Python at runtime — strictly Python.
// Package directory wins over sibling module per CPython FileFinder
// semantics (`_find_spec` checks `_path_isdir(base)` before the suffix
// loop), so when both `pkg/b.py` and `pkg/b/__init__.py` exist,
// `from pkg import b` resolves to the package.
const PY_CANDIDATES: readonly string[] = ['/__init__.py', '.py'];

// JS importer: prefer JS-native; fall back to TS source for projects using
// allowJs/checkJs where the `.ts` is the canonical implementation.
const JS_CANDIDATES: readonly string[] = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '/index.js', '/index.jsx', '/index.mjs', '/index.cjs',
  '/index.ts', '/index.tsx',
];

// TS/TSX importer, no explicit JS-family extension or `.js` stripped:
// TS source first.
const TS_CANDIDATES: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '/index.mjs', '/index.cjs',
];

// TS/TSX importer with `.jsx` specifier: prefer `.tsx` (Node16/NodeNext
// emits `.jsx` for `.tsx` source), then `.jsx` (explicit user-written
// JSX target), then `.ts` fallback. The explicit `.jsx` extension is a
// strong user signal — it should beat an unrelated `.ts` sibling at the
// same stem.
const TS_FROM_JSX_CANDIDATES: readonly string[] = [
  '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs',
  '/index.tsx', '/index.jsx', '/index.ts', '/index.js',
  '/index.mjs', '/index.cjs',
];

// TS/TSX importer with `.js` specifier: prefer `.js` (explicit user
// signal — hand-written JS in mixed repos), then `.ts` (Node16/NodeNext
// emits `.js` for `.ts` source). Mirrors the `.jsx` precedence above.
const TS_FROM_JS_CANDIDATES: readonly string[] = [
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '/index.js', '/index.jsx', '/index.ts', '/index.tsx',
  '/index.mjs', '/index.cjs',
];

export const ENTRY_POINT_FILENAME_RE =
  /^(index|main|app|server|cli|__main__|__init__)\.(ts|tsx|js|mjs|cjs|jsx|py)$/i;

// `symbol` is set when the caller is a declared source symbol; absent for
// module-level call sites. Invariant: when `symbol` is set, `file` and
// `line` mirror its declaration; when absent, they point to the call site.
export interface CallerEdge {
  file: string;
  line: number;
  symbol?: Symbol;
}

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
  references: Reference[];
}

export class CodeIndex {
  private symbolById = new Map<string, Symbol>();
  private fileByPath = new Map<string, FileInfo>();
  private importsByFile = new Map<string, ImportInfo[]>();

  private symbolsByName = new Map<string, Symbol[]>();
  private symbolsByFile = new Map<string, Symbol[]>();
  private callees = new Map<string, Set<string>>();
  private callers = new Map<string, Set<string>>();

  // Indexed for find_references; covers both within-file and cross-file
  // (targetId=null) calls.
  private referencesByTargetName = new Map<string, Reference[]>();
  // Lets removeFile prune in O(refsInFile) instead of scanning by name.
  private referencesBySourceFile = new Map<string, Reference[]>();

  private sortedNames: string[] = [];
  private sortedNamesLower: string[] = [];
  private namesDirty = true;
  private searchIndex: MiniSearch<Symbol> | null = null;

  // Lazy-rebuilt cache for `getCallerCount` so find_symbol's
  // `References: ~N` doesn't re-walk all imports per result. Mirrors
  // the namesDirty/rebuildIndexesIfDirty pattern.
  private callerCountById = new Map<string, number>();
  private callerCountsDirty = true;

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

    this.referencesBySourceFile.set(file.path, [...references]);
    for (const ref of references) {
      pushOrInit(this.referencesByTargetName, ref.targetName, ref);
      // Module-level calls (sourceId=null) and cross-file unresolved refs
      // (targetId=null) skip the id-keyed adjacency; they're queried by name
      // via referencesByTargetName.
      if (ref.sourceId && ref.targetId) {
        addAdjacency(this.callees, ref.sourceId, ref.targetId);
        addAdjacency(this.callers, ref.targetId, ref.sourceId);
      }
    }

    this.namesDirty = true;
    this.callerCountsDirty = true;
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
    pruneAdjacency(this.callers, deletedIds);
    pruneAdjacency(this.callees, deletedIds);

    const refsFromFile = this.referencesBySourceFile.get(path);
    if (refsFromFile) {
      // Group by targetName so each by-name list is filtered once even when
      // a file has many refs to the same target.
      const toRemove = new Map<string, Set<Reference>>();
      for (const ref of refsFromFile) {
        let set = toRemove.get(ref.targetName);
        if (!set) {
          set = new Set();
          toRemove.set(ref.targetName, set);
        }
        set.add(ref);
      }
      for (const [name, set] of toRemove) {
        const list = this.referencesByTargetName.get(name);
        if (!list) continue;
        const kept = list.filter((r) => !set.has(r));
        if (kept.length === 0) this.referencesByTargetName.delete(name);
        else this.referencesByTargetName.set(name, kept);
      }
      this.referencesBySourceFile.delete(path);
    }

    this.fileByPath.delete(path);
    this.importsByFile.delete(path);
    this.symbolsByFile.delete(path);
    this.namesDirty = true;
    this.callerCountsDirty = true;
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

  // Symbol callers come from the id-keyed adjacency set (already deduped
  // by sourceId); same-file module-level call sites are deduped per file
  // by earliest line. Cross-file unresolved name-match refs live in
  // `getCallerCount`.
  getCallerEdges(symbolId: string): CallerEdge[] {
    const sym = this.symbolById.get(symbolId);
    if (!sym) return [];
    const out: CallerEdge[] = this.resolveIds(this.callers.get(symbolId)).map(
      (s) => ({ file: s.file, line: s.startLine, symbol: s }),
    );

    const refs = this.referencesByTargetName.get(sym.name);
    if (refs) {
      const moduleByFile = new Map<string, number>();
      for (const ref of refs) {
        if (ref.targetId !== symbolId || ref.sourceId !== null) continue;
        const existing = moduleByFile.get(ref.file);
        if (existing === undefined || ref.line < existing) {
          moduleByFile.set(ref.file, ref.line);
        }
      }
      for (const [file, line] of moduleByFile) {
        out.push({ file, line });
      }
    }
    return out;
  }

  // Approximate caller count surfaced by find_symbol's `References: ~N`.
  // Reference-granular: one count per call site / `new` / JSX usage.
  // O(1) lookup against a lazily rebuilt cache — `find_symbol` calls
  // this once per result, so a per-call walk would be O(results × files
  // × imports). The full rebuild runs at most once between index updates.
  getCallerCount(symbolId: string): number {
    this.rebuildCallerCountsIfDirty();
    return this.callerCountById.get(symbolId) ?? 0;
  }

  getReferencesByName(name: string): Reference[] {
    const list = this.referencesByTargetName.get(name);
    return list ? [...list] : [];
  }

  // Alias-aware: includes refs whose `targetName` is a local alias of `name`
  // in the importing file (`import { name as alias }`; `alias()` site). The
  // extractor records the call-site identifier, so plain by-name lookup misses
  // these.
  //
  // When `targetFile` is provided, both alias refs AND unresolved primary
  // refs are scoped by import resolution — preventing cross-file leakage
  // when two files define a symbol with the same name. Within-file resolved
  // refs (targetId !== null) flow through; the caller's `isCallerOf` filter
  // rejects refs that precisely resolve to a different homonym.
  getReferencesByNameOrAlias(name: string, targetFile?: string): Reference[] {
    const primary = this.referencesByTargetName.get(name) ?? [];
    const filteredPrimary =
      targetFile === undefined
        ? primary
        : primary.filter((ref) => this.primaryRefMatchesTarget(ref, name, targetFile));
    const out = filteredPrimary.slice();
    const seen = new Set<Reference>(filteredPrimary);
    for (const [filePath, imports] of this.importsByFile) {
      for (const imp of imports) {
        for (const named of imp.importedNames) {
          if (named.name !== name || !named.alias || named.alias === name) {
            continue;
          }
          // Renaming type-only aliases (`import type { X as Y }`) are
          // erased at runtime; their alias-named call sites can't bind
          // through the import.
          if (!isValueBinding(named)) continue;
          if (targetFile !== undefined) {
            const importingFile = this.fileByPath.get(filePath);
            if (!importingFile) continue;
            const resolved = this.resolveImportTarget(importingFile, imp.sourceModule);
            // Skip ONLY when the specifier resolves to a known different
            // file. null (unresolvable specifier — TS path alias, workspace
            // pkg, Python absolute import) falls through to best-effort
            // include; same policy as primaryRefMatchesTarget.
            if (resolved !== null && resolved !== targetFile) continue;
          }
          const aliasRefs = this.referencesByTargetName.get(named.alias);
          if (!aliasRefs) continue;
          for (const ref of aliasRefs) {
            if (ref.file !== filePath) continue;
            if (seen.has(ref)) continue;
            seen.add(ref);
            out.push(ref);
          }
        }
      }
    }
    return out;
  }

  getSymbolById(id: string): Symbol | undefined {
    return this.symbolById.get(id);
  }

  getImports(filePath: string): ImportInfo[] {
    const list = this.importsByFile.get(filePath);
    return list ? [...list] : [];
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
      const allRefs: Reference[] = [];
      for (const refs of this.referencesBySourceFile.values()) {
        for (const ref of refs) allRefs.push(ref);
      }
      const data: PersistedSchema = {
        version: SCHEMA_VERSION,
        createdAt: Date.now(),
        projectRoot: this.projectRoot,
        symbols: [...this.symbolById.entries()],
        files: [...this.fileByPath.entries()],
        imports: [...this.importsByFile.entries()],
        callees: adjacencyToEntries(this.callees),
        callers: adjacencyToEntries(this.callers),
        references: allRefs,
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
    const referencesByTargetName = new Map<string, Reference[]>();
    const referencesBySourceFile = new Map<string, Reference[]>();

    try {
      for (const [id, sym] of parsed.symbols) symbolById.set(id, sym);
      for (const [path, fi] of parsed.files) fileByPath.set(path, fi);
      for (const [path, imps] of parsed.imports) importsByFile.set(path, imps);
      for (const [src, targets] of parsed.callees) callees.set(src, new Set(targets));
      for (const [tgt, sources] of parsed.callers) callers.set(tgt, new Set(sources));
      for (const ref of parsed.references) {
        if (!isPersistedReference(ref)) {
          throw new Error('persisted reference has invalid shape');
        }
        pushOrInit(referencesByTargetName, ref.targetName, ref);
        pushOrInit(referencesBySourceFile, ref.file, ref);
      }

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
    this.referencesByTargetName = referencesByTargetName;
    this.referencesBySourceFile = referencesBySourceFile;
    // Derived caches: reset; rebuild*IfDirty repopulates lazily.
    this.sortedNames = [];
    this.sortedNamesLower = [];
    this.searchIndex = null;
    this.namesDirty = true;
    this.callerCountById.clear();
    this.callerCountsDirty = true;

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

  private rebuildCallerCountsIfDirty(): void {
    if (!this.callerCountsDirty) return;
    this.callerCountById.clear();
    for (const sym of this.symbolById.values()) {
      let count = 0;
      for (const ref of this.getReferencesByNameOrAlias(sym.name, sym.file)) {
        if (isCallerOf(ref, sym)) count++;
      }
      // Skip zero-count entries — getCallerCount returns `?? 0`, so the
      // observable behavior is identical and we save one Map slot per
      // never-called helper (common for leaf utilities).
      if (count > 0) this.callerCountById.set(sym.id, count);
    }
    this.callerCountsDirty = false;
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

  // Decides whether a primary ref should be attributed to `targetFile`.
  // Resolved refs (targetId !== null) always flow through — `isCallerOf`
  // filters precise mismatches downstream. For unresolved refs the policy
  // distinguishes four states of the source file's matching imports:
  //
  // - resolves to targetFile → include (precise match);
  // - resolves to a different indexed file → drop (binds elsewhere);
  // - matches but specifier is unresolvable (TS path alias, workspace
  //   pkg, Python absolute) → fall through to best-effort include;
  // - no matching import at all → drop. The bare `name()` call binds
  //   to a parameter, local, nested-function, or global — attributing
  //   it to every same-named export is wrong.
  private primaryRefMatchesTarget(
    ref: Reference,
    name: string,
    targetFile: string,
  ): boolean {
    if (ref.targetId !== null) return true;
    const importingFile = this.fileByPath.get(ref.file);
    if (!importingFile) return true;
    const imports = this.importsByFile.get(ref.file) ?? [];
    let hasUnresolvableMatch = false;
    for (const imp of imports) {
      for (const named of imp.importedNames) {
        if (isWildcardImport(named)) {
          const resolved = this.resolveImportTarget(importingFile, imp.sourceModule);
          if (resolved === null) {
            hasUnresolvableMatch = true;
          } else if (resolved === targetFile) {
            return true;
          }
          continue;
        }
        const localName = named.alias ?? named.name;
        if (localName !== name) continue;
        if (!isValueBinding(named)) continue;
        // The local binding `name` is an alias for a different export.
        // The alias loop attributes via resolveImportTarget; skip here
        // so the ref isn't double-attributed to a same-named homonym.
        if (isRenamingNamedAlias(named)) return false;
        const resolved = this.resolveImportTarget(importingFile, imp.sourceModule);
        if (resolved === null) {
          hasUnresolvableMatch = true;
          continue;
        }
        if (resolved === targetFile) return true;
        // Specifier resolves to a different indexed file: bare `name`
        // binds elsewhere. JS/TS forbids duplicate top-level bindings,
        // so no other matching import can change that.
        return false;
      }
    }
    return hasUnresolvableMatch;
  }

  // Returns the indexed file the specifier resolves to, or null if the
  // specifier is unrecognized (TS path alias, workspace pkg, Python
  // absolute import) or if no candidate is indexed. Picks the FIRST
  // indexed candidate (direct match, then suffix candidates in
  // language-specific order) — when the same stem is indexed under
  // multiple extensions (`foo.ts` AND `foo.js`), this disambiguates to
  // one. The candidate list and order come from `normalizeImportSpecifier`
  // and depend on the importer's language and the specifier's explicit
  // extension — see the *_CANDIDATES constants.
  private resolveImportTarget(
    importingFile: FileInfo,
    sourceModule: string,
  ): string | null {
    const norm = normalizeImportSpecifier(importingFile, sourceModule);
    if (norm === null) return null;
    const baseDir = posix.dirname(importingFile.path);
    const resolved = posix.join(baseDir, norm.specifier);
    if (this.fileByPath.has(resolved)) return resolved;
    for (const suffix of norm.candidates) {
      const candidate = resolved + suffix;
      if (this.fileByPath.has(candidate)) return candidate;
    }
    return null;
  }
}

interface NormalizedSpecifier {
  // Resolved stem to which `candidates` are appended (relative to the
  // importing file's directory). May be the original specifier, a stripped
  // form, or a Python-translated path.
  specifier: string;
  // Candidate suffixes tried in order after a direct-match miss. Selected
  // per importer language so the loop never tries impossible targets
  // (e.g., `.ts` for a Python importer).
  candidates: readonly string[];
}

// Translates a raw import specifier into a POSIX relative path plus the
// candidate-suffix order that should follow. Returns null for specifiers
// that can't be resolved without project config (bare specifiers, TS path
// aliases, Python absolute imports, bare-package Python imports like
// `from . import x` whose target is reached via the imported NAME).
function normalizeImportSpecifier(
  importingFile: FileInfo,
  sourceModule: string,
): NormalizedSpecifier | null {
  // Python relative imports use dot-prefix syntax with no slashes:
  // `.utils`, `..pkg.sub`. n leading dots = (n-1) levels up; remaining
  // dots in the module path are package separators → '/'.
  if (importingFile.language === 'python') {
    const m = sourceModule.match(/^(\.+)(.*)$/);
    if (!m) return null;
    const [, dots, rest] = m;
    if (rest.length === 0) return null;
    const upParts = Array(dots.length - 1).fill('..');
    return {
      specifier: posix.join(...upParts, rest.replace(/\./g, '/')),
      candidates: PY_CANDIDATES,
    };
  }
  if (!sourceModule.startsWith('.')) return null;
  // JS importers can't resolve to TS source at runtime — keep explicit
  // extensions exact so the resolution returns the actual JS file. The
  // JS candidate list still includes `.ts/.tsx` as a fallback for the
  // extensionless case (`./foo`) under allowJs/checkJs projects.
  if (importingFile.language === 'javascript') {
    return { specifier: sourceModule, candidates: JS_CANDIDATES };
  }
  // TS/TSX with `.jsx` specifier: Node16/NodeNext emits `.jsx` for `.tsx`
  // source. Strip and use TS_FROM_JSX_CANDIDATES so `.tsx` wins over
  // `.ts` at the same stem.
  if (sourceModule.endsWith('.jsx')) {
    return {
      specifier: sourceModule.slice(0, -'.jsx'.length),
      candidates: TS_FROM_JSX_CANDIDATES,
    };
  }
  // TS/TSX with `.js` specifier: strip and use TS_FROM_JS_CANDIDATES so
  // explicit `.js` siblings beat `.ts` at the same stem (hand-written JS
  // in mixed repos), while still falling back to `.ts` when only the
  // source is indexed (Node16/NodeNext emit case). `.mjs`/`.cjs` are
  // literal JS targets — `endsWith('.js')` doesn't match them, so they
  // fall through to direct match. Direct `.ts`/`.tsx` specifiers also
  // fall through. (Add `.mts`/`.cts` to scanner + candidate lists if
  // those source kinds are ever supported.)
  if (sourceModule.endsWith('.js')) {
    return {
      specifier: sourceModule.slice(0, -'.js'.length),
      candidates: TS_FROM_JS_CANDIDATES,
    };
  }
  return { specifier: sourceModule, candidates: TS_CANDIDATES };
}

// `import { X as Y }` where X is a regular identifier (not default or
// namespace) and X !== Y. The local binding Y points to export X — bare
// `Y()` calls bind to X, so same-name scoping by Y would misattribute.
function isRenamingNamedAlias(named: ImportedName): boolean {
  return (
    named.alias !== undefined &&
    named.alias !== named.name &&
    named.name !== IMPORT_DEFAULT &&
    named.name !== IMPORT_NAMESPACE
  );
}

// Python `from .x import *` — `alias === undefined` distinguishes it from
// TS `import * as ns from './x'`, which carries alias='ns' and exposes
// member access only (bare callees don't bind through it).
export function isWildcardImport(named: ImportedName): boolean {
  return named.name === IMPORT_NAMESPACE && named.alias === undefined;
}

// Bindings where bare `localName()` is a legitimate value-callable site.
// kind='type' (TS `import type`), 'namespace' (TS `import * as ns`), and
// 'module' (Python `import x` / `from . import x`) all bind something
// that throws TypeError when invoked directly, so they shouldn't be
// admitted as evidence that a bare call resolves through the import.
// Absent kind defaults to 'value' for legacy persisted indexes.
function isValueBinding(named: ImportedName): boolean {
  return named.kind === undefined || named.kind === 'value';
}

// Filters refs to those that should be surfaced as callers of `target`.
// Used by both find_references's renderCallers and getCallerCount so the
// rendered list and `References: ~N` always agree.
export function isCallerOf(ref: Reference, target: Symbol): boolean {
  // Recursion: target calling itself.
  if (ref.sourceId === target.id) return false;
  // Homonym already resolved precisely to a different same-named symbol.
  if (ref.targetId !== null && ref.targetId !== target.id) return false;
  // method/interface/type are excluded from precise call resolution (the
  // extractor's resolver skips these kinds when building `nameToId` —
  // see NON_CALLABLE_KINDS in types.ts), so any name-only match is by
  // definition not a real call to this target — bare `save()` calls a
  // top-level function, not `C.prototype.save`; `AuthToken()` calls a
  // function, not the interface; a `type X` is never invoked.
  if (ref.targetId === null && NON_CALLABLE_KINDS.has(target.kind)) {
    return false;
  }
  // Short names like `do`/`is` flood with cross-file false matches; only
  // count precisely-resolved refs (targetId === target.id).
  if (target.name.length < SHORT_NAME_THRESHOLD && ref.targetId === null) {
    return false;
  }
  return true;
}

export function isClassMember(s: Symbol): boolean {
  // FQNs use `<file>:<name>` for top-level and `<file>:<Class>.<method>`
  // for class members. File paths can contain dots, so check for a dot
  // *after* the colon, not anywhere in the FQN.
  const colonIdx = s.fqn.indexOf(':');
  return colonIdx !== -1 && s.fqn.indexOf('.', colonIdx) !== -1;
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

function isPersistedReference(ref: unknown): ref is Reference {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  return (
    (r.sourceId === null || typeof r.sourceId === 'string') &&
    (r.targetId === null || typeof r.targetId === 'string') &&
    typeof r.targetName === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.file === 'string' &&
    typeof r.line === 'number'
  );
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
    Array.isArray(d.callers) &&
    Array.isArray(d.references)
  );
}
