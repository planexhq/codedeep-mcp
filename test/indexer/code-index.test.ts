import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { symbolId } from '../../src/indexer/extractor.js';
import type {
  ImportInfo,
  Reference,
  Symbol,
  SymbolKind,
} from '../../src/types.js';
import { makeFileInfo, makeProjectDir } from '../helpers.js';

interface SymOpts {
  name: string;
  file?: string;
  kind?: SymbolKind;
  signature?: string;
  exported?: boolean;
  language?: string;
  startLine?: number;
  endLine?: number;
  doc?: string | null;
}

function mkSym(opts: SymOpts): Symbol {
  const file = opts.file ?? 'src/test.ts';
  const kind = opts.kind ?? 'function';
  const signature = opts.signature ?? '';
  return {
    id: symbolId(file, opts.name, kind, signature),
    name: opts.name,
    fqn: `${file}:${opts.name}`,
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

function mkRef(source: Symbol, target: Symbol): Reference {
  return {
    sourceId: source.id,
    targetId: target.id,
    kind: 'calls',
    file: source.file,
    line: 1,
  };
}

function mkImport(
  file: string,
  sourceModule: string,
  importedNames: ImportInfo['importedNames'] = [],
): ImportInfo {
  return { file, sourceModule, importedNames, line: 1 };
}

let tmpRoot: string;
let cachePath: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('probe-codeindex-');
  cachePath = join(tmpRoot, 'index.json');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('CodeIndex.addFile', () => {
  it('populates primary and secondary indexes', () => {
    const idx = new CodeIndex();
    const file = makeFileInfo('typescript', 'src/a.ts');
    const fooSym = mkSym({ name: 'foo', file: 'src/a.ts' });
    const barSym = mkSym({ name: 'bar', file: 'src/a.ts' });

    idx.addFile(file, [fooSym, barSym], [], [mkImport('src/a.ts', './x')]);

    expect(idx.findSymbolByName('foo')).toEqual([fooSym]);
    expect(idx.findSymbolByName('bar')).toEqual([barSym]);
    expect(idx.getSymbolsInFile('src/a.ts')).toHaveLength(2);
    expect(idx.getImports('src/a.ts')).toHaveLength(1);
    expect(idx.getStats().totalFiles).toBe(1);
    expect(idx.getStats().totalSymbols).toBe(2);
  });

  it('handles empty symbols/refs/imports', () => {
    const idx = new CodeIndex();
    expect(() =>
      idx.addFile(makeFileInfo('typescript', 'src/empty.ts'), [], [], []),
    ).not.toThrow();
    expect(idx.getStats().totalFiles).toBe(1);
    expect(idx.getStats().totalSymbols).toBe(0);
  });

  it('builds callees and callers symmetrically from references', () => {
    const idx = new CodeIndex();
    const caller = mkSym({ name: 'caller', file: 'src/a.ts' });
    const callee = mkSym({ name: 'callee', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [caller, callee],
      [mkRef(caller, callee)],
      [],
    );

    expect(idx.getCallees(caller.id).map((s) => s.name)).toEqual(['callee']);
    expect(idx.getCallers(callee.id).map((s) => s.name)).toEqual(['caller']);
    expect(idx.getCallers(caller.id)).toEqual([]);
  });

  it('deduplicates repeated reference edges', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'a', file: 'src/a.ts' });
    const b = mkSym({ name: 'b', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [a, b],
      [mkRef(a, b), mkRef(a, b), mkRef(a, b)],
      [],
    );
    expect(idx.getCallees(a.id)).toHaveLength(1);
    expect(idx.getCallers(b.id)).toHaveLength(1);
  });
});

describe('CodeIndex.removeFile', () => {
  it('cascade-deletes symbols, names, callees, callers, imports', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'a', file: 'src/a.ts' });
    const b = mkSym({ name: 'b', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [a, b],
      [mkRef(a, b)],
      [mkImport('src/a.ts', './x')],
    );

    idx.removeFile('src/a.ts');

    expect(idx.findSymbolByName('a')).toEqual([]);
    expect(idx.findSymbolByName('b')).toEqual([]);
    expect(idx.getSymbolsInFile('src/a.ts')).toEqual([]);
    expect(idx.getCallees(a.id)).toEqual([]);
    expect(idx.getCallers(b.id)).toEqual([]);
    expect(idx.getImports('src/a.ts')).toEqual([]);
    expect(idx.getStats().totalFiles).toBe(0);
    expect(idx.getStats().totalSymbols).toBe(0);
  });

  it('is idempotent and a no-op for unknown paths', () => {
    const idx = new CodeIndex();
    expect(() => idx.removeFile('does/not/exist.ts')).not.toThrow();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'a' })],
      [],
      [],
    );
    idx.removeFile('src/a.ts');
    expect(() => idx.removeFile('src/a.ts')).not.toThrow();
    expect(idx.getStats().totalSymbols).toBe(0);
  });

  it('keeps other files intact when removing one', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'a', file: 'src/a.ts' });
    const b = mkSym({ name: 'b', file: 'src/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [a], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [b], [], []);

    idx.removeFile('src/a.ts');

    expect(idx.findSymbolByName('a')).toEqual([]);
    expect(idx.findSymbolByName('b')).toEqual([b]);
    expect(idx.getStats().totalFiles).toBe(1);
  });
});

describe('CodeIndex.updateFile', () => {
  it('replaces previous contents of the file', () => {
    const idx = new CodeIndex();
    const v1 = mkSym({ name: 'oldName', file: 'src/a.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [v1], [], []);

    const v2 = mkSym({ name: 'newName', file: 'src/a.ts' });
    idx.updateFile(makeFileInfo('typescript', 'src/a.ts'), [v2], [], []);

    expect(idx.findSymbolByName('oldName')).toEqual([]);
    expect(idx.findSymbolByName('newName')).toEqual([v2]);
    expect(idx.getStats().totalSymbols).toBe(1);
  });
});

describe('CodeIndex.findSymbolByName', () => {
  it('filters by kind', () => {
    const idx = new CodeIndex();
    const fn = mkSym({ name: 'X', kind: 'function', file: 'src/a.ts' });
    const cls = mkSym({ name: 'X', kind: 'class', file: 'src/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [fn], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [cls], [], []);

    expect(idx.findSymbolByName('X')).toHaveLength(2);
    expect(idx.findSymbolByName('X', 'class')).toEqual([cls]);
    expect(idx.findSymbolByName('X', 'function')).toEqual([fn]);
  });

  it('filters by scope (file path prefix)', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'X', file: 'src/foo/a.ts' });
    const b = mkSym({ name: 'X', file: 'src/bar/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/foo/a.ts'), [a], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/bar/b.ts'), [b], [], []);

    expect(idx.findSymbolByName('X', undefined, 'src/foo')).toEqual([a]);
    expect(idx.findSymbolByName('X', undefined, 'src/bar')).toEqual([b]);
  });

  it('returns [] for unknown name', () => {
    const idx = new CodeIndex();
    expect(idx.findSymbolByName('nope')).toEqual([]);
  });
});

describe('CodeIndex.findSymbolsByPrefix', () => {
  it('returns prefix matches up to limit, sorted', () => {
    const idx = new CodeIndex();
    const names = ['authA', 'authB', 'authC', 'banana', 'auth'];
    const syms = names.map((n, i) =>
      mkSym({ name: n, file: `src/f${i}.ts` }),
    );
    syms.forEach((s, i) =>
      idx.addFile(makeFileInfo('typescript', `src/f${i}.ts`), [s], [], []),
    );

    const got = idx.findSymbolsByPrefix('auth', 10).map((s) => s.name);
    expect(got).toEqual(['auth', 'authA', 'authB', 'authC']);

    const limited = idx.findSymbolsByPrefix('auth', 2).map((s) => s.name);
    expect(limited).toEqual(['auth', 'authA']);
  });

  it('returns [] when no match or empty prefix', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo' })],
      [],
      [],
    );
    expect(idx.findSymbolsByPrefix('zzz', 10)).toEqual([]);
    expect(idx.findSymbolsByPrefix('', 10)).toEqual([]);
    expect(idx.findSymbolsByPrefix('foo', 0)).toEqual([]);
  });
});

describe('CodeIndex.suggest', () => {
  it('returns fuzzy matches for misspellings', () => {
    const idx = new CodeIndex();
    const auth = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const user = mkSym({ name: 'getUser', file: 'src/user.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [auth], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/user.ts'), [user], [], []);

    const results = idx.suggest('authentcate', 5).map((s) => s.name);
    expect(results).toContain('authenticate');
  });

  it('returns prefix matches via MiniSearch defaults', () => {
    const idx = new CodeIndex();
    const auth = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [auth], [], []);

    const results = idx.suggest('authent', 5).map((s) => s.name);
    expect(results).toContain('authenticate');
  });

  it('returns [] for empty query', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo' })],
      [],
      [],
    );
    expect(idx.suggest('', 10)).toEqual([]);
  });
});

describe('CodeIndex query helpers', () => {
  it('getSymbolsInFile returns a copy', () => {
    const idx = new CodeIndex();
    const sym = mkSym({ name: 'x' });
    idx.addFile(makeFileInfo('typescript', 'src/test.ts'), [sym], [], []);
    const got = idx.getSymbolsInFile('src/test.ts');
    got.push(mkSym({ name: 'leak' }));
    expect(idx.getSymbolsInFile('src/test.ts')).toHaveLength(1);
  });

  it('getCallees / getCallers return [] for unknown id', () => {
    const idx = new CodeIndex();
    expect(idx.getCallees('deadbeef')).toEqual([]);
    expect(idx.getCallers('deadbeef')).toEqual([]);
  });

  it('getImports returns a copy', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [],
      [],
      [mkImport('src/a.ts', './lib', [{ name: 'foo' }])],
    );
    const got = idx.getImports('src/a.ts');
    got.push(mkImport('src/a.ts', './evil'));
    expect(idx.getImports('src/a.ts')).toHaveLength(1);
  });

  it('getExporters returns only exported symbols', () => {
    const idx = new CodeIndex();
    const exp = mkSym({ name: 'X', file: 'src/a.ts', exported: true });
    const priv = mkSym({ name: 'X', file: 'src/b.ts', exported: false });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [exp], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [priv], [], []);
    expect(idx.getExporters('X')).toEqual([exp]);
  });
});

describe('CodeIndex.getStats', () => {
  it('counts files by language and symbols by kind', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({ name: 'f', kind: 'function', file: 'src/a.ts' }),
        mkSym({ name: 'C', kind: 'class', file: 'src/a.ts' }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('python', 'src/b.py'),
      [mkSym({ name: 'g', kind: 'function', file: 'src/b.py', language: 'python' })],
      [],
      [],
    );

    const stats = idx.getStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalSymbols).toBe(3);
    expect(stats.filesByLanguage).toEqual({ typescript: 1, python: 1 });
    expect(stats.symbolsByKind.function).toBe(2);
    expect(stats.symbolsByKind.class).toBe(1);
    expect(stats.symbolsByKind.method).toBe(0);
  });

  it('detects entry points by filename pattern', () => {
    const idx = new CodeIndex();
    const main = mkSym({ name: 'main', file: 'src/index.ts', exported: true });
    const pyMain = mkSym({ name: 'run', file: 'pkg/__main__.py', exported: true, language: 'python' });
    const pkgInit = mkSym({ name: 'API', file: 'pkg/__init__.py', exported: true, language: 'python' });
    const buried = mkSym({ name: 'helper', file: 'src/util/index.ts', exported: true });
    const notExported = mkSym({ name: 'priv', file: 'src/main.ts', exported: false });
    const notMain = mkSym({ name: 'foo', file: 'src/other.ts', exported: true });

    idx.addFile(makeFileInfo('typescript', 'src/index.ts'), [main], [], []);
    idx.addFile(makeFileInfo('python', 'pkg/__main__.py'), [pyMain], [], []);
    idx.addFile(makeFileInfo('python', 'pkg/__init__.py'), [pkgInit], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/util/index.ts'), [buried], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/main.ts'), [notExported], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/other.ts'), [notMain], [], []);

    const entryFiles = idx.getStats().entryPoints.map((e) => e.file);
    expect(entryFiles).toEqual(
      expect.arrayContaining([
        'src/index.ts',
        'pkg/__main__.py',
        'pkg/__init__.py',
        'src/util/index.ts',
      ]),
    );
    expect(entryFiles).not.toContain('src/main.ts');
    expect(entryFiles).not.toContain('src/other.ts');
  });
});

describe('CodeIndex persistence', () => {
  it('round-trips primary data and queries via save/load', async () => {
    const idx = new CodeIndex(tmpRoot);
    const a = mkSym({ name: 'a', file: 'src/a.ts', exported: true });
    const b = mkSym({ name: 'b', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [a, b],
      [mkRef(a, b)],
      [mkImport('src/a.ts', './x', [{ name: 'foo' }])],
    );
    await idx.save(cachePath);
    expect(existsSync(cachePath)).toBe(true);

    const loaded = new CodeIndex(tmpRoot);
    const ok = await loaded.load(cachePath);
    expect(ok).toBe(true);

    expect(loaded.getStats().totalFiles).toBe(1);
    expect(loaded.getStats().totalSymbols).toBe(2);
    expect(loaded.findSymbolByName('a')).toEqual([a]);
    expect(loaded.findSymbolByName('b')).toEqual([b]);
    expect(loaded.getCallees(a.id).map((s) => s.id)).toEqual([b.id]);
    expect(loaded.getCallers(b.id).map((s) => s.id)).toEqual([a.id]);
    expect(loaded.getImports('src/a.ts')).toHaveLength(1);
    expect(loaded.getExporters('a')).toEqual([a]);
    expect(loaded.findSymbolsByPrefix('a', 5)).toEqual([a]);
  });

  it('load returns false when cache file is missing', async () => {
    const idx = new CodeIndex();
    const ok = await idx.load(cachePath);
    expect(ok).toBe(false);
  });

  it('load deletes and returns false on malformed JSON', async () => {
    writeFileSync(cachePath, 'this is not json {');
    const idx = new CodeIndex();
    const ok = await idx.load(cachePath);
    expect(ok).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('load deletes and returns false on version mismatch', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 999,
        createdAt: 0,
        projectRoot: '',
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
      }),
    );
    const idx = new CodeIndex();
    const ok = await idx.load(cachePath);
    expect(ok).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('load deletes and returns false on projectRoot mismatch', async () => {
    const writer = new CodeIndex('/some/project');
    await writer.save(cachePath);

    const reader = new CodeIndex('/different/project');
    const ok = await reader.load(cachePath);
    expect(ok).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('save leaves no .tmp.* siblings on success', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'a' })],
      [],
      [],
    );
    await idx.save(cachePath);

    const siblings = readdirSync(tmpRoot).filter((n) =>
      n.startsWith('index.json.tmp.'),
    );
    expect(siblings).toEqual([]);
  });

  it('cleans up stale .tmp.* siblings on next load', async () => {
    writeFileSync(join(tmpRoot, 'index.json.tmp.99999.0'), 'leftover');
    writeFileSync(join(tmpRoot, 'index.json.tmp.99999.1'), 'leftover');
    const idx = new CodeIndex();
    await idx.load(cachePath);

    const remaining = readdirSync(tmpRoot).filter((n) =>
      n.startsWith('index.json.tmp.'),
    );
    expect(remaining).toEqual([]);
  });

  it('preserves removeFile contract for files with zero symbols', async () => {
    const writer = new CodeIndex(tmpRoot);
    writer.addFile(
      makeFileInfo('typescript', 'src/empty.ts'),
      [],
      [],
      [mkImport('src/empty.ts', './lib')],
    );
    writer.addFile(
      makeFileInfo('typescript', 'src/other.ts'),
      [mkSym({ name: 'x', file: 'src/other.ts' })],
      [],
      [],
    );
    await writer.save(cachePath);

    const loaded = new CodeIndex(tmpRoot);
    expect(await loaded.load(cachePath)).toBe(true);
    expect(loaded.getStats().totalFiles).toBe(2);

    loaded.removeFile('src/empty.ts');

    expect(loaded.getStats().totalFiles).toBe(1);
    expect(loaded.getImports('src/empty.ts')).toEqual([]);
    expect(loaded.findSymbolByName('x')).toHaveLength(1);
  });

  it('returns false on malformed entry tuples and unlinks cache', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        createdAt: 0,
        projectRoot: '',
        symbols: [42],
        files: [],
        imports: [],
        callees: [],
        callers: [],
      }),
    );
    const idx = new CodeIndex();
    const ok = await idx.load(cachePath);
    expect(ok).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
    expect(idx.getStats().totalFiles).toBe(0);
    expect(idx.getStats().totalSymbols).toBe(0);
  });
});

describe('CodeIndex edge cases', () => {
  it('keeps same-named symbols in different files separate', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'parse', file: 'src/a.ts' });
    const b = mkSym({ name: 'parse', file: 'src/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [a], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [b], [], []);

    expect(idx.findSymbolByName('parse')).toHaveLength(2);
  });

  it('handles self-recursive function in both callers and callees', () => {
    const idx = new CodeIndex();
    const recur = mkSym({ name: 'fact', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [recur],
      [mkRef(recur, recur)],
      [],
    );

    expect(idx.getCallees(recur.id).map((s) => s.id)).toEqual([recur.id]);
    expect(idx.getCallers(recur.id).map((s) => s.id)).toEqual([recur.id]);
  });

  it('rebuilds prefix index after removeFile so stale names are gone', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'apple', file: 'src/a.ts' });
    const b = mkSym({ name: 'apricot', file: 'src/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [a], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [b], [], []);
    expect(idx.findSymbolsByPrefix('ap', 10)).toHaveLength(2);

    idx.removeFile('src/a.ts');
    expect(idx.findSymbolsByPrefix('ap', 10).map((s) => s.name)).toEqual([
      'apricot',
    ]);
  });

  it('rebuildIndexesIfDirty is idempotent — repeated queries do not re-add', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo' })],
      [],
      [],
    );
    expect(idx.suggest('foo', 5)).toHaveLength(1);
    expect(idx.suggest('foo', 5)).toHaveLength(1);
    expect(idx.findSymbolsByPrefix('foo', 5)).toHaveLength(1);
  });

  it('persisted file is valid JSON with the documented schema', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'a' })],
      [],
      [],
    );
    await idx.save(cachePath);

    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(data.version).toBe(1);
    expect(data.projectRoot).toBe(tmpRoot);
    expect(Array.isArray(data.symbols)).toBe(true);
    expect(Array.isArray(data.files)).toBe(true);
    expect(Array.isArray(data.imports)).toBe(true);
    expect(Array.isArray(data.callees)).toBe(true);
    expect(Array.isArray(data.callers)).toBe(true);
  });
});
