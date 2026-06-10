import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex, isCallerOf } from '../../src/indexer/code-index.js';
import type { CoChange, Reference, SymbolKind } from '../../src/types.js';
import {
  makeFileInfo,
  makeProjectDir,
  mkCoChange,
  mkGitMeta,
  mkImport,
  mkMemberRef,
  mkModuleRef,
  mkRef,
  mkSym,
  mkUnresolvedRef,
} from '../helpers.js';

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

  it('filters by scope (directory prefix when scope ends with /)', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'X', file: 'src/foo/a.ts' });
    const b = mkSym({ name: 'X', file: 'src/bar/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/foo/a.ts'), [a], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/bar/b.ts'), [b], [], []);

    expect(idx.findSymbolByName('X', undefined, 'src/foo/')).toEqual([a]);
    expect(idx.findSymbolByName('X', undefined, 'src/bar/')).toEqual([b]);
  });

  it('treats file-shaped scope as exact path in findSymbolByName', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.ts'),
      [mkSym({ name: 'shared', file: 'src/foo.ts' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.tsx'),
      [mkSym({ name: 'shared', file: 'src/foo.tsx' })],
      [],
      [],
    );
    const hits = idx.findSymbolByName('shared', undefined, 'src/foo.ts');
    expect(hits.map((s) => s.file)).toEqual(['src/foo.ts']);
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

  it('applies kind and scope filters during the prefix walk', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/a.ts'),
      [mkSym({ name: 'authA', file: 'src/auth/a.ts', kind: 'function' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/b.ts'),
      [mkSym({ name: 'authB', file: 'src/auth/b.ts', kind: 'class' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/other/c.ts'),
      [mkSym({ name: 'authC', file: 'src/other/c.ts', kind: 'function' })],
      [],
      [],
    );

    expect(
      idx.findSymbolsByPrefix('auth', 10, 'function').map((s) => s.name),
    ).toEqual(['authA', 'authC']);
    expect(
      idx
        .findSymbolsByPrefix('auth', 10, undefined, 'src/auth/')
        .map((s) => s.name),
    ).toEqual(['authA', 'authB']);
    expect(
      idx
        .findSymbolsByPrefix('auth', 10, 'function', 'src/auth/')
        .map((s) => s.name),
    ).toEqual(['authA']);
  });

  it('matches case-insensitively against PascalCase symbols for a lowercase prefix', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({ name: 'authenticate', file: 'src/a.ts', kind: 'function' }),
        mkSym({ name: 'AuthToken', file: 'src/a.ts', kind: 'type' }),
        mkSym({ name: 'Authentication', file: 'src/a.ts', kind: 'class' }),
      ],
      [],
      [],
    );
    const names = idx.findSymbolsByPrefix('auth', 10).map((s) => s.name).sort();
    expect(names).toEqual(['AuthToken', 'Authentication', 'authenticate']);
  });

  it('matches case-insensitively for an uppercase prefix', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({ name: 'authenticate', file: 'src/a.ts', kind: 'function' }),
        mkSym({ name: 'AuthToken', file: 'src/a.ts', kind: 'type' }),
      ],
      [],
      [],
    );
    const names = idx.findSymbolsByPrefix('AUTH', 10).map((s) => s.name).sort();
    expect(names).toEqual(['AuthToken', 'authenticate']);
  });

  it('treats file-shaped scope as exact path, not prefix', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.ts'),
      [mkSym({ name: 'fooA', file: 'src/foo.ts' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.tsx'),
      [mkSym({ name: 'fooB', file: 'src/foo.tsx' })],
      [],
      [],
    );
    expect(
      idx
        .findSymbolsByPrefix('foo', 10, undefined, 'src/foo.ts')
        .map((s) => s.name),
    ).toEqual(['fooA']);
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

  it('filters by kind so an in-kind match surfaces past higher-ranked out-of-kind hits', () => {
    const idx = new CodeIndex();
    // 30 functions named 'authentcate' (exact-name MiniSearch match,
    // highest score) outrank the single fuzzy 'authenticte' class. With
    // the prior implementation, the limit budget was spent on the 30
    // functions and the class never surfaced under kind='class'.
    for (let i = 0; i < 30; i++) {
      const file = `src/funcs/${i}.ts`;
      idx.addFile(
        makeFileInfo('typescript', file),
        [mkSym({ name: 'authentcate', file, kind: 'function' })],
        [],
        [],
      );
    }
    idx.addFile(
      makeFileInfo('typescript', 'src/cls.ts'),
      [mkSym({ name: 'authenticte', file: 'src/cls.ts', kind: 'class' })],
      [],
      [],
    );

    const results = idx.suggest('authentcate', 5, 'class');
    expect(results.map((s) => s.kind)).toEqual(['class']);
  });

  it('filters by scope so an in-scope match surfaces past higher-ranked out-of-scope hits', () => {
    const idx = new CodeIndex();
    for (let i = 0; i < 30; i++) {
      const file = `src/other/${i}/auth.ts`;
      idx.addFile(
        makeFileInfo('typescript', file),
        [mkSym({ name: 'authentcate', file, kind: 'function' })],
        [],
        [],
      );
    }
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/main.ts'),
      [mkSym({ name: 'authenticte', file: 'src/auth/main.ts', kind: 'function' })],
      [],
      [],
    );

    const results = idx.suggest('authentcate', 5, undefined, 'src/auth/');
    expect(results.map((s) => s.file)).toEqual(['src/auth/main.ts']);
  });
});

describe('CodeIndex.searchSymbols', () => {
  it('finds a symbol by a signature token its name lacks', () => {
    const idx = new CodeIndex();
    const handler = mkSym({
      name: 'handler',
      file: 'src/h.ts',
      signature: 'function handler(req: FastifyRequest): void',
    });
    idx.addFile(makeFileInfo('typescript', 'src/h.ts'), [handler], [], []);

    const { symbols } = idx.searchSymbols('FastifyRequest', { limit: 5 });
    expect(symbols.map((s) => s.name)).toContain('handler');
  });

  it('finds a symbol by a doc token its name lacks', () => {
    const idx = new CodeIndex();
    const auth = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      doc: 'Validates the JWT and attaches user to request',
    });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [auth], [], []);

    const { symbols } = idx.searchSymbols('JWT', { limit: 5 });
    expect(symbols.map((s) => s.name)).toContain('authenticate');
  });

  it('ranks an exported symbol above an equally relevant non-exported one', () => {
    const idx = new CodeIndex();
    const internal = mkSym({ name: 'parseConfig', file: 'src/a.ts' });
    const exported = mkSym({
      name: 'parseConfig',
      file: 'src/b.ts',
      exported: true,
    });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [internal], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [exported], [], []);

    const { symbols } = idx.searchSymbols('parseConfig', { limit: 5 });
    expect(symbols.length).toBeGreaterThanOrEqual(2);
    expect(symbols[0].file).toBe('src/b.ts');
  });

  it('filters results to the given languages', () => {
    const idx = new CodeIndex();
    const ts = mkSym({ name: 'validate', file: 'src/v.ts' });
    const py = mkSym({ name: 'validate', file: 'app/v.py', language: 'python' });
    idx.addFile(makeFileInfo('typescript', 'src/v.ts'), [ts], [], []);
    idx.addFile(makeFileInfo('python', 'app/v.py'), [py], [], []);

    const { symbols } = idx.searchSymbols('validate', {
      limit: 5,
      languages: new Set(['python']),
    });
    expect(symbols.map((s) => s.file)).toEqual(['app/v.py']);
  });

  it('respects the limit', () => {
    const idx = new CodeIndex();
    for (let i = 0; i < 5; i++) {
      const file = `src/${i}.ts`;
      idx.addFile(
        makeFileInfo('typescript', file),
        [mkSym({ name: 'validateInput', file })],
        [],
        [],
      );
    }
    const { symbols, total } = idx.searchSymbols('validateInput', { limit: 2 });
    expect(symbols).toHaveLength(2);
    expect(total).toBe(5);
  });

  it('returns [] for an empty query or non-positive limit', () => {
    const idx = new CodeIndex();
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );
    expect(idx.searchSymbols('', { limit: 10 })).toEqual({ symbols: [], total: 0 });
    expect(idx.searchSymbols('foo', { limit: 0 })).toEqual({ symbols: [], total: 0 });
  });

  it('does not leak doc/signature matches into suggest()', () => {
    const idx = new CodeIndex();
    const auth = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      signature: 'function authenticate(req: SessionRequest): User',
      doc: 'Validates the JWT and attaches user to request',
    });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [auth], [], []);

    // searchSymbols sees both extra fields...
    expect(idx.searchSymbols('JWT', { limit: 5 }).symbols).toHaveLength(1);
    expect(idx.searchSymbols('SessionRequest', { limit: 5 }).symbols).toHaveLength(1);
    // ...but suggest stays pinned to name+fqn (did-you-mean must not
    // surface doc-only hits).
    expect(idx.suggest('JWT', 5)).toEqual([]);
    expect(idx.suggest('SessionRequest', 5)).toEqual([]);
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

  it('hasFile reports true only for files added to the index', () => {
    const idx = new CodeIndex();
    idx.addFile(makeFileInfo('typescript', 'src/foo.ts'), [], [], []);
    expect(idx.hasFile('src/foo.ts')).toBe(true);
    expect(idx.hasFile('src/foo.tsx')).toBe(false);
    expect(idx.hasFile('.storybook')).toBe(false);

    idx.removeFile('src/foo.ts');
    expect(idx.hasFile('src/foo.ts')).toBe(false);
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

  it('returns false on malformed reference entries and unlinks cache', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 2,
        createdAt: 0,
        projectRoot: '',
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        // Missing required `file`, `line`, `kind` — would crash downstream
        // at `dirname(ref.file)`.
        references: [{ targetName: 'foo' }],
      }),
    );
    const idx = new CodeIndex();
    const ok = await idx.load(cachePath);
    expect(ok).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
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
    expect(data.version).toBe(5);
    expect(data.projectRoot).toBe(tmpRoot);
    expect(Array.isArray(data.symbols)).toBe(true);
    expect(Array.isArray(data.files)).toBe(true);
    expect(Array.isArray(data.imports)).toBe(true);
    expect(Array.isArray(data.callees)).toBe(true);
    expect(Array.isArray(data.callers)).toBe(true);
    expect(Array.isArray(data.references)).toBe(true);
    expect(Array.isArray(data.cochanges)).toBe(true);
    expect(Array.isArray(data.hotspots)).toBe(true);
    expect(data.gitMeta).toBeNull();
  });
});

describe('CodeIndex.getReferencesByName', () => {
  it('returns refs whose targetName matches (resolved within-file)', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'caller', file: 'src/a.ts' });
    const b = mkSym({ name: 'helper', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [a, b],
      [mkRef(a, b)],
      [],
    );

    const refs = idx.getReferencesByName('helper');
    expect(refs).toHaveLength(1);
    expect(refs[0].sourceId).toBe(a.id);
    expect(refs[0].targetId).toBe(b.id);
    expect(refs[0].targetName).toBe('helper');
  });

  it('returns cross-file unresolved refs (targetId=null)', () => {
    const idx = new CodeIndex();
    const caller = mkSym({ name: 'caller', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'externalFn', 'src/a.ts', 5)],
      [],
    );

    const refs = idx.getReferencesByName('externalFn');
    expect(refs).toHaveLength(1);
    expect(refs[0].targetId).toBeNull();
    expect(refs[0].targetName).toBe('externalFn');
    expect(refs[0].file).toBe('src/a.ts');
    expect(refs[0].line).toBe(5);
  });

  it('returns module-level refs (sourceId=null) without polluting callers adjacency', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [],
      [
        {
          sourceId: null,
          targetId: target.id,
          targetName: 'authenticate',
          kind: 'calls',
          file: 'src/api.ts',
          line: 2,
        },
      ],
      [],
    );

    const refs = idx.getReferencesByName('authenticate');
    expect(refs).toHaveLength(1);
    expect(refs[0].sourceId).toBeNull();
    expect(refs[0].targetId).toBe(target.id);
    // adjacency must reject null sourceId so getCallers stays clean.
    expect(idx.getCallers(target.id)).toEqual([]);
  });

  it('returns [] for unknown name', () => {
    const idx = new CodeIndex();
    expect(idx.getReferencesByName('nope')).toEqual([]);
  });

  it('returns a copy — mutation does not affect the index', () => {
    const idx = new CodeIndex();
    const a = mkSym({ name: 'a' });
    const b = mkSym({ name: 'b' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [a, b],
      [mkRef(a, b)],
      [],
    );

    const first = idx.getReferencesByName('b');
    first.length = 0;
    expect(idx.getReferencesByName('b')).toHaveLength(1);
  });
});

describe('CodeIndex cross-file ref cleanup on removeFile', () => {
  it('drops refs originating in the removed file', () => {
    const idx = new CodeIndex();
    const callerA = mkSym({ name: 'callerA', file: 'src/a.ts' });
    const callerB = mkSym({ name: 'callerB', file: 'src/b.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [callerA],
      [mkUnresolvedRef(callerA, 'shared', 'src/a.ts', 1)],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [callerB],
      [mkUnresolvedRef(callerB, 'shared', 'src/b.ts', 1)],
      [],
    );

    expect(idx.getReferencesByName('shared')).toHaveLength(2);

    idx.removeFile('src/a.ts');

    const remaining = idx.getReferencesByName('shared');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].file).toBe('src/b.ts');
  });

  it('preserves refs whose target was in the removed file', () => {
    // updateFile/removeFile must not orphan-delete refs from other files
    // pointing at names defined in the removed file. The cross-file caller
    // stays in the index — its targetId is still valid only as long as
    // the original symbol object is still in symbolById; but the ref by
    // *name* survives.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'shared', file: 'src/target.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/caller.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/target.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/caller.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'shared', 'src/caller.ts', 7)],
      [],
    );

    idx.removeFile('src/target.ts');

    const refs = idx.getReferencesByName('shared');
    expect(refs).toHaveLength(1);
    expect(refs[0].file).toBe('src/caller.ts');
  });
});

describe('CodeIndex.getReferencesByNameOrAlias', () => {
  it('includes refs whose targetName is a local alias of the target', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const caller = mkSym({ name: 'handler', file: 'src/api.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      // Call site uses the alias `auth`; targetName matches the alias.
      [mkUnresolvedRef(caller, 'auth', 'src/api.ts', 12)],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate', alias: 'auth' }])],
    );

    const refs = idx.getReferencesByNameOrAlias('authenticate');
    expect(refs).toHaveLength(1);
    expect(refs[0].targetName).toBe('auth');
    expect(refs[0].file).toBe('src/api.ts');
  });

  it('skips imports whose alias equals the original name (no double count)', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'foo', file: 'src/a.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/b.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'foo', 'src/b.ts', 1)],
      [mkImport('src/b.ts', './a', [{ name: 'foo', alias: 'foo' }])],
    );

    expect(idx.getReferencesByNameOrAlias('foo')).toHaveLength(1);
  });

  it('excludes alias refs that originate in a different file from the import', () => {
    // src/api.ts imports `authenticate as auth`. src/other.ts has its own
    // unrelated `auth(...)` call. Only refs from src/api.ts should be picked
    // up via the alias mapping.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const apiCaller = mkSym({ name: 'apiHandler', file: 'src/api.ts' });
    const otherCaller = mkSym({ name: 'otherHandler', file: 'src/other.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [apiCaller],
      [mkUnresolvedRef(apiCaller, 'auth', 'src/api.ts', 5)],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate', alias: 'auth' }])],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/other.ts'),
      [otherCaller],
      [mkUnresolvedRef(otherCaller, 'auth', 'src/other.ts', 8)],
      [],
    );

    const refs = idx.getReferencesByNameOrAlias('authenticate');
    expect(refs).toHaveLength(1);
    expect(refs[0].file).toBe('src/api.ts');
  });

  it('returns [] for unknown name with no aliases', () => {
    expect(new CodeIndex().getReferencesByNameOrAlias('nope')).toEqual([]);
  });

  it('scopes alias refs to imports whose sourceModule resolves to targetFile', () => {
    // Two same-named symbols in different files; a third file imports one of
    // them under an alias and calls the alias. Without targetFile scoping the
    // alias call leaks into both targets.
    const idx = new CodeIndex();
    const aService = mkSym({ name: 'Service', kind: 'class', file: 'src/a/Service.ts' });
    const bService = mkSym({ name: 'Service', kind: 'class', file: 'src/b/Service.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a/Service.ts'), [aService], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b/Service.ts'), [bService], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/app.ts', 5)],
      [mkImport('src/app.ts', './b/Service', [{ name: 'Service', alias: 'MyService' }])],
    );

    const aRefs = idx.getReferencesByNameOrAlias('Service', aService.file);
    expect(aRefs).toHaveLength(0);

    const bRefs = idx.getReferencesByNameOrAlias('Service', bService.file);
    expect(bRefs).toHaveLength(1);
    expect(bRefs[0].targetName).toBe('MyService');

    const noScope = idx.getReferencesByNameOrAlias('Service');
    expect(noScope).toHaveLength(1);
  });

  // Bare specifiers (workspace packages, TS path aliases) can't be resolved
  // without project config. The alias loop falls through to best-effort
  // include so codebases that rely on path aliases still surface callers.
  it('includes alias refs from files with bare-specifier imports as best-effort', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/svc.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/svc.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/app.ts', 3)],
      [mkImport('src/app.ts', 'shared-pkg', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service')).toHaveLength(1);
  });

  it('resolves an import to a directory index file', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/lib/index.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/lib/index.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/app.ts', 4)],
      [mkImport('src/app.ts', './lib', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  // Node ESM/CJS layouts can place the entry at index.mjs / index.cjs.
  // The scanner indexes both, so directory imports must include them in
  // the candidate suffix lists or aliased refs are dropped.
  it.each([
    ['typescript', 'src/lib/index.mjs', 'javascript'],
    ['typescript', 'src/lib/index.cjs', 'javascript'],
    ['javascript', 'src/lib/index.mjs', 'javascript'],
    ['javascript', 'src/lib/index.cjs', 'javascript'],
  ])(
    'resolves a directory import from %s importer to %s',
    (importerLang, indexFile, indexLang) => {
      const idx = new CodeIndex();
      const target = mkSym({
        name: 'Service',
        kind: 'class',
        file: indexFile,
        language: indexLang,
      });
      const importerFile =
        importerLang === 'typescript' ? 'src/app.ts' : 'src/app.js';
      const caller = mkSym({ name: 'caller', file: importerFile, language: importerLang });
      idx.addFile(makeFileInfo(indexLang, indexFile), [target], [], []);
      idx.addFile(
        makeFileInfo(importerLang, importerFile),
        [caller],
        [mkUnresolvedRef(caller, 'MyService', importerFile, 4)],
        [mkImport(importerFile, './lib', [{ name: 'Service', alias: 'MyService' }])],
      );

      expect(
        idx.getReferencesByNameOrAlias('Service', target.file),
      ).toHaveLength(1);
    },
  );

  it('resolves a parent-relative import (`../shared/B`)', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/shared/B.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/sub/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/shared/B.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/sub/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/sub/c.ts', 7)],
      [mkImport('src/sub/c.ts', '../shared/B', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  // Node16/NodeNext: `./foo.js` is the import form for `foo.ts`.
  it('resolves a Node16 `.js` specifier to its `.ts` source', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/b/Service.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/b/Service.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/app.ts', 5)],
      [mkImport('src/app.ts', './b/Service.js', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  it('resolves a Node16 `.mjs` specifier to its `.mjs` source', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/lib/Service.mjs' });
    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(makeFileInfo('javascript', 'src/lib/Service.mjs'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/app.ts', 3)],
      [mkImport('src/app.ts', './lib/Service.mjs', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  it('resolves a Python same-package relative import (`from .b`)', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/pkg/b.py', language: 'python' });
    const other = mkSym({ name: 'Service', kind: 'class', file: 'src/other/b.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'src/pkg/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'src/pkg/b.py'), [target], [], []);
    idx.addFile(makeFileInfo('python', 'src/other/b.py'), [other], [], []);
    idx.addFile(
      makeFileInfo('python', 'src/pkg/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/pkg/c.py', 4)],
      [mkImport('src/pkg/c.py', '.b', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', other.file)).toHaveLength(0);
  });

  it('resolves a Python parent-package relative import (`from ..shared.b`)', () => {
    // 2 dots = parent package of `src/pkg/sub/` is `src/pkg/`, so
    // `..shared.b` resolves to `src/pkg/shared/b.py`.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/pkg/shared/b.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'src/pkg/sub/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'src/pkg/shared/b.py'), [target], [], []);
    idx.addFile(
      makeFileInfo('python', 'src/pkg/sub/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/pkg/sub/c.py', 6)],
      [mkImport('src/pkg/sub/c.py', '..shared.b', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  it('resolves a Python relative import to a package `__init__.py`', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/pkg/__init__.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'src/main.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'src/pkg/__init__.py'), [target], [], []);
    idx.addFile(
      makeFileInfo('python', 'src/main.py'),
      [caller],
      [mkUnresolvedRef(caller, 'MyService', 'src/main.py', 2)],
      [mkImport('src/main.py', '.pkg', [{ name: 'Service', alias: 'MyService' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  // CPython's FileFinder picks the package directory before falling
  // through to the suffix loop, so `from .b import Service` binds to
  // `pkg/b/__init__.py` even when `pkg/b.py` exists at the same stem.
  it('Python package `__init__.py` wins over sibling `.py` when both exist', () => {
    const idx = new CodeIndex();
    const pkgService = mkSym({
      name: 'Service',
      kind: 'class',
      file: 'pkg/b/__init__.py',
      language: 'python',
    });
    const siblingService = mkSym({
      name: 'Service',
      kind: 'class',
      file: 'pkg/b.py',
      language: 'python',
    });
    const caller = mkSym({ name: 'caller', file: 'pkg/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'pkg/b/__init__.py'), [pkgService], [], []);
    idx.addFile(makeFileInfo('python', 'pkg/b.py'), [siblingService], [], []);
    idx.addFile(
      makeFileInfo('python', 'pkg/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'Service', 'pkg/c.py', 2)],
      [mkImport('pkg/c.py', '.b', [{ name: 'Service' }])],
    );

    expect(
      idx.getReferencesByNameOrAlias('Service', 'pkg/b/__init__.py'),
    ).toHaveLength(1);
    expect(
      idx.getReferencesByNameOrAlias('Service', 'pkg/b.py'),
    ).toHaveLength(0);
  });

  // Python absolute imports (no leading dot) can't be resolved without
  // project config — but the file has positive evidence (it imports `join`),
  // so the alias loop falls through to best-effort include.
  it('includes alias refs from Python absolute imports as best-effort', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'join', kind: 'function', file: 'src/utils.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'src/app.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'src/utils.py'), [target], [], []);
    idx.addFile(
      makeFileInfo('python', 'src/app.py'),
      [caller],
      [mkUnresolvedRef(caller, 'MyJoin', 'src/app.py', 3)],
      [mkImport('src/app.py', 'os.path', [{ name: 'join', alias: 'MyJoin' }])],
    );

    expect(idx.getReferencesByNameOrAlias('join', target.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('join')).toHaveLength(1);
  });

  // `from . import x` resolves to the package's __init__.py via the
  // imported NAME, not via sourceModule alone — normalizeImportSpecifier
  // returns null for the bare-`.` form, so this falls through to
  // best-effort include like other unresolvable specifiers.
  it('includes alias refs from Python bare-`.` imports as best-effort', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'utils', kind: 'function', file: 'src/pkg/utils.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'src/pkg/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'src/pkg/utils.py'), [target], [], []);
    idx.addFile(
      makeFileInfo('python', 'src/pkg/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'u', 'src/pkg/c.py', 2)],
      [mkImport('src/pkg/c.py', '.', [{ name: 'utils', alias: 'u' }])],
    );

    expect(idx.getReferencesByNameOrAlias('utils', target.file)).toHaveLength(1);
  });

  it('resolves a JS importer with explicit `.js` to its `.js` source', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.js' });
    const caller = mkSym({ name: 'caller', file: 'src/bar.js' });
    idx.addFile(makeFileInfo('javascript', 'src/foo.js'), [target], [], []);
    idx.addFile(
      makeFileInfo('javascript', 'src/bar.js'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'src/bar.js', 2)],
      [mkImport('src/bar.js', './foo.js', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(1);
  });

  // JS files cannot import TS source at runtime; explicit `.js` must be
  // literal. Without this scoping the alias call leaks to the TS sibling.
  it('does not leak a JS-imported alias to a TS sibling at the same path stem', () => {
    const idx = new CodeIndex();
    const jsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.js' });
    const tsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/bar.js' });
    idx.addFile(makeFileInfo('javascript', 'src/foo.js'), [jsTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/foo.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('javascript', 'src/bar.js'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'src/bar.js', 2)],
      [mkImport('src/bar.js', './foo.js', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', jsTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', tsTarget.file)).toHaveLength(0);
  });

  // Explicit `.js` specifier in a TS importer is a strong user signal —
  // the `.js` sibling wins over a `.ts` sibling at the same stem
  // (hand-written JS in mixed repos). The Node16/NodeNext emit case
  // where only the `.ts` is indexed still falls back to the source.
  it('prefers a `.js` sibling over a `.ts` sibling for a TS importer with explicit `.js` specifier', () => {
    const idx = new CodeIndex();
    const tsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.ts' });
    const jsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.js' });
    const caller = mkSym({ name: 'caller', file: 'src/bar.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/foo.ts'), [tsTarget], [], []);
    idx.addFile(makeFileInfo('javascript', 'src/foo.js'), [jsTarget], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/bar.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'src/bar.ts', 2)],
      [mkImport('src/bar.ts', './foo.js', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', jsTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', tsTarget.file)).toHaveLength(0);
  });

  // `.mjs`/`.cjs` are emitted forms of `.mts`/`.cts`, which the scanner
  // doesn't index — so they're always literal JS targets, not stems to
  // re-extension. Stripping would misroute to a TS sibling at the same stem.
  it('does not leak a TS importer\'s explicit `.mjs` to a TS sibling at the same stem', () => {
    const idx = new CodeIndex();
    const mjsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.mjs' });
    const tsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/bar.ts' });
    idx.addFile(makeFileInfo('javascript', 'src/foo.mjs'), [mjsTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/foo.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/bar.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'src/bar.ts', 2)],
      [mkImport('src/bar.ts', './foo.mjs', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', mjsTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', tsTarget.file)).toHaveLength(0);
  });

  it('does not leak a TS importer\'s explicit `.cjs` to a TS sibling at the same stem', () => {
    const idx = new CodeIndex();
    const cjsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.cjs' });
    const tsTarget = mkSym({ name: 'Service', kind: 'class', file: 'src/foo.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/bar.ts' });
    idx.addFile(makeFileInfo('javascript', 'src/foo.cjs'), [cjsTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/foo.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/bar.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'src/bar.ts', 2)],
      [mkImport('src/bar.ts', './foo.cjs', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', cjsTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', tsTarget.file)).toHaveLength(0);
  });

  // Non-aliased named imports must scope by import resolution too — otherwise
  // a bare `Service()` call from a file that imports Service from `./b`
  // attributes to every same-named symbol, including the one in `./a`.
  it('does not leak a non-aliased named import to a same-named symbol in another file', () => {
    const idx = new CodeIndex();
    const aSrv = mkSym({ name: 'Service', file: 'src/a.ts' });
    const bSrv = mkSym({ name: 'Service', file: 'src/b.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [aSrv], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [bSrv], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'Service', 'src/c.ts', 2)],
      [mkImport('src/c.ts', './b', [{ name: 'Service' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', aSrv.file)).toHaveLength(0);
    expect(idx.getReferencesByNameOrAlias('Service', bSrv.file)).toHaveLength(1);
    expect(idx.getCallerCount(aSrv.id)).toBe(0);
    expect(idx.getCallerCount(bSrv.id)).toBe(1);
  });

  // A bare `Service()` call in a file with NO matching named import binds
  // to a parameter, local, nested-function, or global — not to an exported
  // `Service` in another file. Attributing it to every homonym overcounts
  // (e.g., the parameter shadow `function wrapper(Service) { Service() }`
  // would inflate every same-named export's References count).
  it('drops unresolved refs from files with no matching named import', () => {
    const idx = new CodeIndex();
    const aSrv = mkSym({ name: 'Service', file: 'src/a.ts' });
    const bSrv = mkSym({ name: 'Service', file: 'src/b.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [aSrv], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [bSrv], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'Service', 'src/c.ts', 2)],
      [],
    );

    expect(idx.getCallerCount(aSrv.id)).toBe(0);
    expect(idx.getCallerCount(bSrv.id)).toBe(0);
  });

  // Python imports cannot resolve to non-Python — the candidate list for a
  // Python importer must not even try `.ts`/`.tsx`. Otherwise a TS sibling
  // at the same stem steals the alias attribution.
  it('resolves a Python alias to its `.py` source even when a `.ts` sibling exists', () => {
    const idx = new CodeIndex();
    const pyTarget = mkSym({ name: 'Service', kind: 'function', file: 'pkg/b.py', language: 'python' });
    const tsTarget = mkSym({ name: 'Service', kind: 'function', file: 'pkg/b.ts' });
    const caller = mkSym({ name: 'caller', file: 'pkg/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'pkg/b.py'), [pyTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'pkg/b.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('python', 'pkg/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'pkg/c.py', 2)],
      [mkImport('pkg/c.py', '.b', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', pyTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', tsTarget.file)).toHaveLength(0);
  });

  // JS importer with extensionless specifier should prefer JS-native source
  // over a TS sibling at the same stem. The TS fallback in JS_CANDIDATES
  // applies only when no JS sibling is indexed.
  it('prefers a `.js` sibling over a `.ts` sibling for an extensionless JS import', () => {
    const idx = new CodeIndex();
    const jsTarget = mkSym({ name: 'Service', kind: 'function', file: 'src/foo.js', language: 'javascript' });
    const tsTarget = mkSym({ name: 'Service', kind: 'function', file: 'src/foo.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/bar.js', language: 'javascript' });
    idx.addFile(makeFileInfo('javascript', 'src/foo.js'), [jsTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/foo.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('javascript', 'src/bar.js'),
      [caller],
      [mkUnresolvedRef(caller, 'S', 'src/bar.js', 2)],
      [mkImport('src/bar.js', './foo', [{ name: 'Service', alias: 'S' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', jsTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', tsTarget.file)).toHaveLength(0);
  });

  // Node16/NodeNext emits `.jsx` for `.tsx` source — a TSX importer using
  // the `.jsx` specifier must resolve to `.tsx`, not `.ts`.
  it('prefers `.tsx` over `.ts` for a TSX importer with `.jsx` specifier', () => {
    const idx = new CodeIndex();
    const tsxTarget = mkSym({ name: 'Widget', kind: 'function', file: 'src/Widget.tsx', language: 'tsx' });
    const tsTarget = mkSym({ name: 'Widget', kind: 'function', file: 'src/Widget.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/Foo.tsx', language: 'tsx' });
    idx.addFile(makeFileInfo('tsx', 'src/Widget.tsx'), [tsxTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/Widget.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('tsx', 'src/Foo.tsx'),
      [caller],
      [mkUnresolvedRef(caller, 'W', 'src/Foo.tsx', 2)],
      [mkImport('src/Foo.tsx', './Widget.jsx', [{ name: 'Widget', alias: 'W' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Widget', tsxTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Widget', tsTarget.file)).toHaveLength(0);
  });

  // Explicit `.jsx` extension is a strong user signal — when only `.jsx`
  // and `.ts` siblings are indexed (no `.tsx`), the `.jsx` target wins.
  // Otherwise an unrelated TS sibling steals attribution from the actual
  // user-written JSX file.
  it('prefers `.jsx` over `.ts` for a TSX importer with `.jsx` specifier when no `.tsx` exists', () => {
    const idx = new CodeIndex();
    const jsxTarget = mkSym({ name: 'Widget', kind: 'function', file: 'src/Widget.jsx' });
    const tsTarget = mkSym({ name: 'Widget', kind: 'function', file: 'src/Widget.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/Foo.tsx', language: 'tsx' });
    idx.addFile(makeFileInfo('javascript', 'src/Widget.jsx'), [jsxTarget], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/Widget.ts'), [tsTarget], [], []);
    idx.addFile(
      makeFileInfo('tsx', 'src/Foo.tsx'),
      [caller],
      [mkUnresolvedRef(caller, 'W', 'src/Foo.tsx', 2)],
      [mkImport('src/Foo.tsx', './Widget.jsx', [{ name: 'Widget', alias: 'W' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Widget', jsxTarget.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Widget', tsTarget.file)).toHaveLength(0);
  });

  // A renaming alias (`import { X as name }`) binds bare `name()` calls
  // to X, not name. The primary loop must not attribute these refs to
  // any same-named (but unrelated) target — the alias loop already
  // attributes them to the X-named target via importResolvesTo.
  it('does not leak a renaming alias to a same-named symbol in another file', () => {
    const idx = new CodeIndex();
    const utilsHash = mkSym({ name: 'hash', file: 'src/utils.ts' });
    const utilsAuth = mkSym({ name: 'authenticate', file: 'src/utils.ts' });
    const otherAuth = mkSym({ name: 'authenticate', file: 'src/other.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/utils.ts'), [utilsHash, utilsAuth], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/other.ts'), [otherAuth], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'authenticate', 'src/c.ts', 2)],
      [mkImport('src/c.ts', './utils', [{ name: 'hash', alias: 'authenticate' }])],
    );

    expect(idx.getReferencesByNameOrAlias('authenticate', utilsAuth.file)).toHaveLength(0);
    expect(idx.getReferencesByNameOrAlias('authenticate', otherAuth.file)).toHaveLength(0);
    expect(idx.getReferencesByNameOrAlias('hash', utilsHash.file)).toHaveLength(1);
  });

  // Default imports (`import name from './m'`) bind bare `name()` calls
  // to `./m`'s default export. The primary path scopes by resolution:
  // the call attributes only to a same-named target whose file the
  // import resolves to.
  it('scopes a default import to the resolved target file', () => {
    const idx = new CodeIndex();
    const aAuth = mkSym({ name: 'authenticate', file: 'src/a.ts' });
    const bAuth = mkSym({ name: 'authenticate', file: 'src/b.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [aAuth], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [bAuth], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'authenticate', 'src/c.ts', 2)],
      [mkImport('src/c.ts', './a', [{ name: 'default', alias: 'authenticate' }])],
    );

    expect(idx.getReferencesByNameOrAlias('authenticate', aAuth.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('authenticate', bAuth.file)).toHaveLength(0);
  });

  // `import { name as name }` is an identity alias — the local binding
  // equals the export name, so the renaming-alias short-circuit must
  // not fire. Behavior matches a non-aliased named import: scope by
  // resolution.
  it('treats an identity alias (`import { Service as Service }`) as non-aliased', () => {
    const idx = new CodeIndex();
    const aSrv = mkSym({ name: 'Service', file: 'src/a.ts' });
    const bSrv = mkSym({ name: 'Service', file: 'src/b.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [aSrv], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [bSrv], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'Service', 'src/c.ts', 2)],
      [mkImport('src/c.ts', './b', [{ name: 'Service', alias: 'Service' }])],
    );

    expect(idx.getReferencesByNameOrAlias('Service', bSrv.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('Service', aSrv.file)).toHaveLength(0);
  });

  it('scopes a Python wildcard import to its source module', () => {
    const idx = new CodeIndex();
    const helpersSym = mkSym({ name: 'helper', file: 'pkg/helpers.py', language: 'python' });
    const otherSym = mkSym({ name: 'helper', file: 'pkg/other.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'pkg/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'pkg/helpers.py'), [helpersSym], [], []);
    idx.addFile(makeFileInfo('python', 'pkg/other.py'), [otherSym], [], []);
    idx.addFile(
      makeFileInfo('python', 'pkg/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'helper', 'pkg/c.py', 3)],
      [mkImport('pkg/c.py', '.helpers', [{ name: '*' }])],
    );

    expect(idx.getReferencesByNameOrAlias('helper', helpersSym.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('helper', otherSym.file)).toHaveLength(0);
    expect(idx.getReferencesByNameOrAlias('helper')).toHaveLength(1);
  });

  it('attributes a multi-wildcard call to every imported source module', () => {
    const idx = new CodeIndex();
    const aSym = mkSym({ name: 'helper', file: 'pkg/a.py', language: 'python' });
    const bSym = mkSym({ name: 'helper', file: 'pkg/b.py', language: 'python' });
    const dSym = mkSym({ name: 'helper', file: 'pkg/d.py', language: 'python' });
    const caller = mkSym({ name: 'caller', file: 'pkg/c.py', language: 'python' });
    idx.addFile(makeFileInfo('python', 'pkg/a.py'), [aSym], [], []);
    idx.addFile(makeFileInfo('python', 'pkg/b.py'), [bSym], [], []);
    idx.addFile(makeFileInfo('python', 'pkg/d.py'), [dSym], [], []);
    idx.addFile(
      makeFileInfo('python', 'pkg/c.py'),
      [caller],
      [mkUnresolvedRef(caller, 'helper', 'pkg/c.py', 4)],
      [
        mkImport('pkg/c.py', '.a', [{ name: '*' }]),
        mkImport('pkg/c.py', '.b', [{ name: '*' }]),
      ],
    );

    expect(idx.getReferencesByNameOrAlias('helper', aSym.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('helper', bSym.file)).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('helper', dSym.file)).toHaveLength(0);
  });

  it('does not treat a TS namespace import (`import * as ns`) as a wildcard binding', () => {
    const idx = new CodeIndex();
    const aSym = mkSym({ name: 'helper', file: 'src/a.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [aSym], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'helper', 'src/c.ts', 2)],
      [mkImport('src/c.ts', './x', [{ name: '*', alias: 'ns', kind: 'namespace' }])],
    );

    // TS `import * as ns` exposes member access only — bare `helper()` does
    // not bind through it, so the file has no matching named import for
    // `helper`. The ref is dropped (parameter/local/global), not admitted
    // as a wildcard caller.
    expect(idx.getReferencesByNameOrAlias('helper', aSym.file)).toHaveLength(0);
  });

  it('drops attribution when `import type { X }` shadows a bare X() in the same file', () => {
    // `import type` is erased at runtime; bare `Service()` here binds to
    // the parameter, not the type-only import.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', file: 'src/types.ts' });
    const wrap = mkSym({ name: 'wrap', file: 'src/auth.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/types.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [wrap],
      [mkUnresolvedRef(wrap, 'Service', 'src/auth.ts', 2)],
      [mkImport('src/auth.ts', './types', [{ name: 'Service', kind: 'type' }])],
    );
    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(0);
  });

  it('drops attribution for a bare ns() call when ns is a TS namespace import', () => {
    // `import * as ns` binds a namespace object; calling `ns()` directly
    // is a TypeError, never a real call into the source module.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'ns', file: 'src/m.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/m.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'ns', 'src/c.ts', 2)],
      [mkImport('src/c.ts', './m', [{ name: '*', alias: 'ns', kind: 'namespace' }])],
    );
    expect(idx.getReferencesByNameOrAlias('ns', target.file)).toHaveLength(0);
  });

  it('drops attribution for a bare utils() call when utils is a Python module import', () => {
    // Python `import utils` binds the module object; `utils()` is a
    // TypeError. The cross-file caller list shouldn't surface it.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'utils', file: 'pkg/utils.py' });
    const caller = mkSym({ name: 'caller', file: 'pkg/main.py' });
    idx.addFile(makeFileInfo('python', 'pkg/utils.py'), [target], [], []);
    idx.addFile(
      makeFileInfo('python', 'pkg/main.py'),
      [caller],
      [mkUnresolvedRef(caller, 'utils', 'pkg/main.py', 2)],
      [mkImport('pkg/main.py', 'utils', [{ name: 'utils', kind: 'module' }])],
    );
    expect(idx.getReferencesByNameOrAlias('utils', target.file)).toHaveLength(0);
  });

  it('drops attribution for `from . import utils` followed by bare utils()', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'utils', file: 'pkg/utils.py' });
    const caller = mkSym({ name: 'caller', file: 'pkg/main.py' });
    idx.addFile(makeFileInfo('python', 'pkg/utils.py'), [target], [], []);
    idx.addFile(
      makeFileInfo('python', 'pkg/main.py'),
      [caller],
      [mkUnresolvedRef(caller, 'utils', 'pkg/main.py', 2)],
      [mkImport('pkg/main.py', '.', [{ name: 'utils', kind: 'module' }])],
    );
    expect(idx.getReferencesByNameOrAlias('utils', target.file)).toHaveLength(0);
  });

  it('keeps Y but drops X when `import { type X, Y }` mixes type-only and value', () => {
    const idx = new CodeIndex();
    const xTarget = mkSym({ name: 'X', file: 'src/m.ts' });
    const yTarget = mkSym({ name: 'Y', file: 'src/m.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/m.ts'), [xTarget, yTarget], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      [
        mkUnresolvedRef(caller, 'X', 'src/c.ts', 2),
        mkUnresolvedRef(caller, 'Y', 'src/c.ts', 3),
      ],
      [
        mkImport('src/c.ts', './m', [
          { name: 'X', kind: 'type' },
          { name: 'Y' },
        ]),
      ],
    );
    expect(idx.getReferencesByNameOrAlias('X', xTarget.file)).toHaveLength(0);
    expect(idx.getReferencesByNameOrAlias('Y', yTarget.file)).toHaveLength(1);
  });

  it('drops alias attribution when `import type { X as Y }` is renaming type-only', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'Service', file: 'src/m.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/c.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/m.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [caller],
      // Reference targets the local alias 'S'.
      [mkUnresolvedRef(caller, 'S', 'src/c.ts', 2)],
      [
        mkImport('src/c.ts', './m', [
          { name: 'Service', alias: 'S', kind: 'type' },
        ]),
      ],
    );
    expect(idx.getReferencesByNameOrAlias('Service', target.file)).toHaveLength(0);
  });
});

describe('CodeIndex.getCallerEdges', () => {
  it('returns symbol callers from the id-keyed adjacency', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'target', file: 'src/u.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/u.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [target, caller],
      [mkRef(caller, target)],
      [],
    );

    const edges = idx.getCallerEdges(target.id);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ file: caller.file, line: caller.startLine, symbol: caller });
  });

  it('returns same-file resolved module-level callers', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'target', file: 'src/u.ts', startLine: 5 });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [target],
      [mkModuleRef(target, 1)],
      [],
    );

    expect(idx.getCallerEdges(target.id)).toEqual([
      { file: 'src/u.ts', line: 1 },
    ]);
  });

  it('combines symbol callers and module-level entries', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'target', file: 'src/u.ts' });
    const caller = mkSym({ name: 'caller', file: 'src/u.ts', startLine: 4 });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [target, caller],
      [mkRef(caller, target), mkModuleRef(target, 8)],
      [],
    );

    const edges = idx.getCallerEdges(target.id);
    expect(edges).toEqual(
      expect.arrayContaining([
        { file: caller.file, line: caller.startLine, symbol: caller },
        { file: 'src/u.ts', line: 8 },
      ]),
    );
    expect(edges).toHaveLength(2);
  });

  it('dedupes module-level callers per file using the earliest line', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'target', file: 'src/u.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [target],
      [mkModuleRef(target, 12), mkModuleRef(target, 5)],
      [],
    );

    expect(idx.getCallerEdges(target.id)).toEqual([
      { file: 'src/u.ts', line: 5 },
    ]);
  });

  it('excludes cross-file unresolved name-match refs', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'target', file: 'src/u.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/u.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [],
      // sourceId=null AND targetId=null: cross-file module-level approximation.
      [{
        sourceId: null,
        targetId: null,
        targetName: 'target',
        kind: 'calls',
        file: 'src/api.ts',
        line: 2,
      }],
      [],
    );

    expect(idx.getCallerEdges(target.id)).toEqual([]);
  });

  it('returns [] for an unknown symbol id', () => {
    expect(new CodeIndex().getCallerEdges('deadbeef')).toEqual([]);
  });
});

describe('CodeIndex.getCallerCount with cross-file refs', () => {
  it('counts within-file callers plus name-matching cross-file refs', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const localCaller = mkSym({ name: 'wrap', file: 'src/auth.ts' });
    const remoteCaller = mkSym({ name: 'handler', file: 'src/api.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [target, localCaller],
      [mkRef(localCaller, target)],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [remoteCaller],
      [mkUnresolvedRef(remoteCaller, 'authenticate', 'src/api.ts', 12)],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate' }])],
    );

    expect(idx.getCallerCount(target.id)).toBe(2);
  });

  it('does not count self-references in the cross-file tally', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'recur', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [target],
      [mkUnresolvedRef(target, 'recur', 'src/a.ts', 5)],
      [],
    );

    expect(idx.getCallerCount(target.id)).toBe(0);
  });

  it('short-circuits for short names (<4 chars) to within-file only', () => {
    // Mirror the suppression find_references applies for names like `do`/`is`,
    // so the `References: ~N` line in find_symbol agrees.
    const idx = new CodeIndex();
    const target = mkSym({ name: 'do', file: 'src/x.ts' });
    const remoteCaller = mkSym({ name: 'caller', file: 'src/y.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/x.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/y.ts'),
      [remoteCaller],
      [mkUnresolvedRef(remoteCaller, 'do', 'src/y.ts', 3)],
      [],
    );

    expect(idx.getCallerCount(target.id)).toBe(0);
  });

  it('counts a cross-file caller that imports the target under an alias', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const aliasCaller = mkSym({ name: 'handler', file: 'src/api.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [aliasCaller],
      [mkUnresolvedRef(aliasCaller, 'auth', 'src/api.ts', 12)],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate', alias: 'auth' }])],
    );

    expect(idx.getCallerCount(target.id)).toBe(1);
  });

  it('returns 0 for unknown symbol id', () => {
    const idx = new CodeIndex();
    expect(idx.getCallerCount('unknown-id')).toBe(0);
  });

  it('counts module-level same-file resolved calls (sourceId=null, targetId=symbolId)', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'boot', file: 'src/main.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/main.ts'),
      [target],
      [mkModuleRef(target, 5)],
      [],
    );

    expect(idx.getCallerCount(target.id)).toBe(1);
  });

  it('counts module-level same-file resolved calls even for short names', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'run', file: 'src/main.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/main.ts'),
      [target],
      [mkModuleRef(target, 5)],
      [],
    );

    expect(idx.getCallerCount(target.id)).toBe(1);
  });

  it('counts multi-call same-file and cross-file callers at the same granularity', () => {
    // One caller invoking `target` three times must produce the same count
    // whether the caller is in the same file or another file. Reference
    // granularity matches what renderCallers prints (one line per call site),
    // so find_symbol's `~N` and find_references's caller list agree.
    const idxSame = new CodeIndex();
    const targetSame = mkSym({ name: 'target', file: 'src/a.ts' });
    const callerSame = mkSym({ name: 'caller', file: 'src/a.ts' });
    idxSame.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [targetSame, callerSame],
      [
        mkRef(callerSame, targetSame),
        mkRef(callerSame, targetSame),
        mkRef(callerSame, targetSame),
      ],
      [],
    );

    const idxCross = new CodeIndex();
    const targetCross = mkSym({ name: 'target', file: 'src/a.ts' });
    const remoteCaller = mkSym({ name: 'caller', file: 'src/b.ts' });
    idxCross.addFile(makeFileInfo('typescript', 'src/a.ts'), [targetCross], [], []);
    idxCross.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [remoteCaller],
      [
        mkUnresolvedRef(remoteCaller, 'target', 'src/b.ts', 1),
        mkUnresolvedRef(remoteCaller, 'target', 'src/b.ts', 2),
        mkUnresolvedRef(remoteCaller, 'target', 'src/b.ts', 3),
      ],
      [mkImport('src/b.ts', './a', [{ name: 'target' }])],
    );

    expect(idxSame.getCallerCount(targetSame.id)).toBe(3);
    expect(idxCross.getCallerCount(targetCross.id)).toBe(3);
  });

  // The lazy rebuild caches results until an index update marks them
  // dirty; back-to-back queries must return the same value.
  it('returns a stable count across repeated queries with no index changes', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const caller = mkSym({ name: 'handler', file: 'src/api.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'authenticate', 'src/api.ts', 12)],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate' }])],
    );

    const first = idx.getCallerCount(target.id);
    const second = idx.getCallerCount(target.id);
    expect(first).toBe(1);
    expect(second).toBe(first);
  });

  // updateFile must mark the cache dirty so a subsequent query sees the
  // new ref count instead of the stale cached value.
  it('reflects new refs after updateFile invalidates the cache', () => {
    const idx = new CodeIndex();
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts' });
    const caller = mkSym({ name: 'handler', file: 'src/api.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'authenticate', 'src/api.ts', 12)],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate' }])],
    );
    expect(idx.getCallerCount(target.id)).toBe(1);

    // Add a second call site by re-adding the file with two refs.
    idx.updateFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      [
        mkUnresolvedRef(caller, 'authenticate', 'src/api.ts', 12),
        mkUnresolvedRef(caller, 'authenticate', 'src/api.ts', 18),
      ],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate' }])],
    );
    expect(idx.getCallerCount(target.id)).toBe(2);
  });
});

describe('CodeIndex persistence — references round-trip', () => {
  it('persists and restores cross-file (unresolved) references', async () => {
    const idx = new CodeIndex(tmpRoot);
    const caller = mkSym({ name: 'caller', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'externalFn', 'src/a.ts', 9)],
      [],
    );
    await idx.save(cachePath);

    const loaded = new CodeIndex(tmpRoot);
    expect(await loaded.load(cachePath)).toBe(true);

    const refs = loaded.getReferencesByName('externalFn');
    expect(refs).toHaveLength(1);
    expect(refs[0].targetId).toBeNull();
    expect(refs[0].targetName).toBe('externalFn');
    expect(refs[0].line).toBe(9);
  });

  it('invalidates v1 caches written by Phase 1a', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 1,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('rejects v2 cache that is missing the references field', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 2,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        // references field intentionally missing
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
  });

  it('invalidates v3 caches, which lack member-expression refs', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 3,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        references: [],
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('persists and restores the receiver on member refs', async () => {
    const idx = new CodeIndex(tmpRoot);
    const caller = mkSym({ name: 'caller', file: 'src/a.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'repo', { line: 7 })],
      [],
    );
    await idx.save(cachePath);

    const loaded = new CodeIndex(tmpRoot);
    expect(await loaded.load(cachePath)).toBe(true);

    const refs = loaded.getReferencesByName('save');
    expect(refs).toHaveLength(1);
    expect(refs[0].receiver).toBe('repo');
    expect(refs[0].targetId).toBeNull();
    expect(refs[0].line).toBe(7);
  });

  it('invalidates v4 caches, which lack the git enrichment sections', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 4,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        references: [],
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('rejects a cache whose reference carries a non-string receiver', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 5,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        references: [
          {
            sourceId: null,
            targetId: null,
            targetName: 'save',
            kind: 'calls',
            file: 'src/a.ts',
            line: 1,
            receiver: 42,
          },
        ],
        cochanges: [],
        hotspots: [],
        gitMeta: null,
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
  });
});

describe('isCallerOf', () => {
  // Methods, interfaces, and types are excluded from the extractor's precise
  // call resolution (NON_CALLABLE_KINDS). A name-only match for these kinds
  // is by definition spurious — bare `save()` calls a top-level function,
  // not `C.prototype.save`; `AuthToken()` calls a function, not the
  // interface; `type X` is never invoked at runtime.
  it.each<SymbolKind>(['method', 'interface', 'type'])(
    'rejects name-only matches for %s targets',
    (kind) => {
      const target = mkSym({ name: 'AuthToken', kind, parent: kind === 'method' ? 'C' : undefined });
      const ref: Reference = {
        sourceId: 'sourceid0000000a',
        targetId: null,
        targetName: 'AuthToken',
        kind: 'calls',
        file: 'src/other.ts',
        line: 10,
      };
      expect(isCallerOf(ref, target)).toBe(false);
    },
  );

  // Callable kinds still accept name-only matches — regression guard.
  it.each<SymbolKind>(['function', 'class', 'variable'])(
    'accepts name-only matches for %s targets',
    (kind) => {
      const target = mkSym({ name: 'AuthToken', kind });
      const ref: Reference = {
        sourceId: 'sourceid0000000a',
        targetId: null,
        targetName: 'AuthToken',
        kind: 'calls',
        file: 'src/other.ts',
        line: 10,
      };
      expect(isCallerOf(ref, target)).toBe(true);
    },
  );

  it('accepts unresolved member refs for exported method targets', () => {
    const target = mkSym({
      name: 'save',
      kind: 'method',
      parent: 'Repo',
      file: 'src/repo.ts',
      exported: true,
    });
    const caller = mkSym({ name: 'caller', file: 'src/other.ts' });
    expect(isCallerOf(mkMemberRef(caller, 'save', 'repo'), target)).toBe(true);
  });

  it.each<SymbolKind>(['interface', 'type'])(
    'rejects member refs for %s targets',
    (kind) => {
      const target = mkSym({ name: 'Serializer', kind, exported: true });
      const caller = mkSym({ name: 'caller', file: 'src/other.ts' });
      expect(isCallerOf(mkMemberRef(caller, 'Serializer', 'lib'), target)).toBe(false);
    },
  );

  it.each(['this', 'self', 'cls'])(
    'rejects unresolved %s-receiver refs (inherited methods are LSP territory)',
    (receiver) => {
      const target = mkSym({
        name: 'render',
        kind: 'method',
        parent: 'Base',
        file: 'src/base.ts',
        exported: true,
      });
      const caller = mkSym({ name: 'update', kind: 'method', parent: 'Child', file: 'src/child.ts' });
      const ref = mkMemberRef(caller, 'render', receiver, { selfReceiver: true });
      expect(isCallerOf(ref, target)).toBe(false);
    },
  );

  it('admits refs whose receiver is merely NAMED self (extractor did not flag it)', () => {
    // TS: `import * as self from './telemetry'; self.record()` or
    // `const self = this; self.flush()` — the receiver token is 'self'
    // but the extractor's isSelf is false, so the ref must NOT be
    // rejected as an inherited-method call.
    const target = mkSym({
      name: 'record',
      file: 'src/telemetry.ts',
      exported: true,
    });
    const caller = mkSym({ name: 'boot', file: 'src/app.ts' });
    expect(isCallerOf(mkMemberRef(caller, 'record', 'self'), target)).toBe(true);
  });

  it('rejects member refs for short method names', () => {
    const target = mkSym({
      name: 'get',
      kind: 'method',
      parent: 'Store',
      file: 'src/store.ts',
      exported: true,
    });
    const caller = mkSym({ name: 'caller', file: 'src/other.ts' });
    expect(isCallerOf(mkMemberRef(caller, 'get', 'store'), target)).toBe(false);
  });

  it('rejects cross-file member refs to non-exported targets, accepts same-file', () => {
    const target = mkSym({
      name: 'persist',
      kind: 'method',
      parent: 'Repo',
      file: 'src/repo.ts',
      exported: false,
    });
    const sameFile = mkSym({ name: 'local', file: 'src/repo.ts' });
    const otherFile = mkSym({ name: 'remote', file: 'src/other.ts' });
    expect(isCallerOf(mkMemberRef(sameFile, 'persist', 'repo'), target)).toBe(true);
    expect(isCallerOf(mkMemberRef(otherFile, 'persist', 'repo'), target)).toBe(false);
  });

  it('accepts precisely-resolved member refs regardless of receiver kind', () => {
    const target = mkSym({
      name: 'helper',
      kind: 'method',
      parent: 'C',
      file: 'src/c.ts',
    });
    const run = mkSym({ name: 'run', kind: 'method', parent: 'C', file: 'src/c.ts' });
    const ref = mkMemberRef(run, 'helper', 'this', { targetId: target.id });
    expect(isCallerOf(ref, target)).toBe(true);
  });
});

describe('CodeIndex.getReferencesByNameOrAlias — member-ref scoping', () => {
  it('admits namespace-import member refs whose specifier resolves to the target file', () => {
    const idx = new CodeIndex();
    const helper = mkSym({ name: 'helper', file: 'src/utils.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'src/utils.ts'), [helper], [], []);
    const homonym = mkSym({ name: 'helper', file: 'src/other.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'src/other.ts'), [homonym], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'helper', 'u')],
      [mkImport('src/app.ts', './utils', [{ name: '*', alias: 'u', kind: 'namespace' }])],
    );

    // `u` names ./utils — admit for utils.ts, drop for the homonym.
    expect(idx.getReferencesByNameOrAlias('helper', 'src/utils.ts')).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('helper', 'src/other.ts')).toHaveLength(0);
  });

  it('resolves Python `from . import x` submodule receivers', () => {
    const idx = new CodeIndex();
    const auth = mkSym({
      name: 'authenticate',
      file: 'app/auth.py',
      language: 'python',
      exported: true,
    });
    idx.addFile(makeFileInfo('python', 'app/auth.py'), [auth], [], []);
    const homonym = mkSym({
      name: 'authenticate',
      file: 'app/legacy.py',
      language: 'python',
      exported: true,
    });
    idx.addFile(makeFileInfo('python', 'app/legacy.py'), [homonym], [], []);

    const caller = mkSym({ name: 'login', file: 'app/service.py', language: 'python' });
    idx.addFile(
      makeFileInfo('python', 'app/service.py'),
      [caller],
      [mkMemberRef(caller, 'authenticate', 'auth')],
      [mkImport('app/service.py', '.', [{ name: 'auth', kind: 'module' }])],
    );

    expect(idx.getReferencesByNameOrAlias('authenticate', 'app/auth.py')).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('authenticate', 'app/legacy.py')).toHaveLength(0);
  });

  it('weakly includes member refs through unresolvable absolute Python imports', () => {
    const idx = new CodeIndex();
    const helper = mkSym({
      name: 'format_date',
      file: 'app/utils.py',
      language: 'python',
      exported: true,
    });
    idx.addFile(makeFileInfo('python', 'app/utils.py'), [helper], [], []);

    const caller = mkSym({ name: 'render', file: 'app/view.py', language: 'python' });
    idx.addFile(
      makeFileInfo('python', 'app/view.py'),
      [caller],
      [mkMemberRef(caller, 'format_date', 'utils')],
      [mkImport('app/view.py', 'utils', [{ name: 'utils', kind: 'module' }])],
    );

    // `import utils` is absolute — unresolvable without sys.path; best effort.
    expect(idx.getReferencesByNameOrAlias('format_date', 'app/utils.py')).toHaveLength(1);
  });

  it('drops member refs through type-only namespace imports', () => {
    const idx = new CodeIndex();
    const helper = mkSym({ name: 'helper', file: 'src/utils.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'src/utils.ts'), [helper], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'helper', 'T')],
      [mkImport('src/app.ts', './utils', [{ name: '*', alias: 'T', kind: 'type' }])],
    );

    expect(idx.getReferencesByNameOrAlias('helper', 'src/utils.ts')).toHaveLength(0);
  });

  it('drops namespace-receiver refs for class-member targets', () => {
    // `utils.save()` through `import * as utils` reaches only TOP-LEVEL
    // exports of utils.ts — it can never invoke Cache.prototype.save.
    const idx = new CodeIndex();
    const methodSave = mkSym({
      name: 'save',
      kind: 'method',
      parent: 'Cache',
      file: 'src/utils.ts',
      exported: true,
    });
    idx.addFile(makeFileInfo('typescript', 'src/utils.ts'), [methodSave], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'u')],
      [mkImport('src/app.ts', './utils', [{ name: '*', alias: 'u', kind: 'namespace' }])],
    );

    // Member target (Cache.save): the namespace ref is out of reach.
    expect(
      idx.getReferencesByNameOrAlias('save', 'src/utils.ts', true),
    ).toHaveLength(0);
    // Top-level target in the same file: admitted.
    expect(
      idx.getReferencesByNameOrAlias('save', 'src/utils.ts', false),
    ).toHaveLength(1);
  });

  it("resolves `import * as pkg from '.'` without mangling the specifier", () => {
    // The namespace sentinel '*' must not be appended to the dots —
    // the specifier is '.' itself, resolving to the directory's index.
    const idx = new CodeIndex();
    const helper = mkSym({ name: 'helper', file: 'src/index.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'src/index.ts'), [helper], [], []);
    const homonym = mkSym({ name: 'helper', file: 'lib/other.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'lib/other.ts'), [homonym], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'helper', 'pkg')],
      [mkImport('src/app.ts', '.', [{ name: '*', alias: 'pkg', kind: 'namespace' }])],
    );

    // Precise resolution to src/index.ts: admit there, drop the homonym.
    expect(idx.getReferencesByNameOrAlias('helper', 'src/index.ts')).toHaveLength(1);
    expect(idx.getReferencesByNameOrAlias('helper', 'lib/other.ts')).toHaveLength(0);
  });

  it('weakly includes member refs with unknown receivers', () => {
    const idx = new CodeIndex();
    const save = mkSym({
      name: 'save',
      kind: 'method',
      parent: 'Repo',
      file: 'src/repo.ts',
      exported: true,
    });
    idx.addFile(makeFileInfo('typescript', 'src/repo.ts'), [save], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'repo')],
      [],
    );

    expect(idx.getReferencesByNameOrAlias('save', 'src/repo.ts')).toHaveLength(1);
  });

  it('weakly includes member refs whose receiver is a value import', () => {
    const idx = new CodeIndex();
    const save = mkSym({
      name: 'save',
      kind: 'method',
      parent: 'Repo',
      file: 'src/repo.ts',
      exported: true,
    });
    idx.addFile(makeFileInfo('typescript', 'src/repo.ts'), [save], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'repo')],
      // `import { repo } from './instances'` — the object may be of any
      // class; weak include.
      [mkImport('src/app.ts', './instances', ['repo'])],
    );

    expect(idx.getReferencesByNameOrAlias('save', 'src/repo.ts')).toHaveLength(1);
  });

  it('does not pull member refs in through the import-alias path', () => {
    const idx = new CodeIndex();
    const hash = mkSym({ name: 'hash', file: 'src/utils.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'src/utils.ts'), [hash], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [
        // Bare alias call h() — binds through the import, included.
        mkUnresolvedRef(caller, 'h'),
        // obj.h() — the property coincides with the alias but never
        // binds through a top-level import; excluded.
        mkMemberRef(caller, 'h', 'obj'),
      ],
      [mkImport('src/app.ts', './utils', [{ name: 'hash', alias: 'h' }])],
    );

    const refs = idx.getReferencesByNameOrAlias('hash', 'src/utils.ts');
    expect(refs).toHaveLength(1);
    expect(refs[0].receiver).toBeUndefined();
  });
});

describe('CodeIndex member-ref adjacency and counts', () => {
  it('builds caller/callee edges from extract-time-resolved this.x() refs', () => {
    const idx = new CodeIndex();
    const helper = mkSym({ name: 'helper', kind: 'method', parent: 'C', file: 'src/c.ts' });
    const run = mkSym({ name: 'run', kind: 'method', parent: 'C', file: 'src/c.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [helper, run],
      [mkMemberRef(run, 'helper', 'this', { targetId: helper.id })],
      [],
    );

    expect(idx.getCallers(helper.id).map((s) => s.id)).toEqual([run.id]);
    expect(idx.getCallees(run.id).map((s) => s.id)).toEqual([helper.id]);
    expect(idx.getCallerEdges(helper.id)).toHaveLength(1);
  });

  it('counts cross-file member refs in getCallerCount for methods', () => {
    const idx = new CodeIndex();
    const save = mkSym({
      name: 'save',
      kind: 'method',
      parent: 'Repo',
      file: 'src/repo.ts',
      exported: true,
    });
    idx.addFile(makeFileInfo('typescript', 'src/repo.ts'), [save], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'repo')],
      [],
    );

    expect(idx.getCallerCount(save.id)).toBe(1);
  });

  it('cascade-deletes member refs when their source file is removed', () => {
    const idx = new CodeIndex();
    const caller = mkSym({ name: 'caller', file: 'src/app.ts' });
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'repo')],
      [],
    );
    expect(idx.getReferencesByName('save')).toHaveLength(1);

    idx.removeFile('src/app.ts');
    expect(idx.getReferencesByName('save')).toHaveLength(0);
  });
});

describe('CodeIndex git enrichment (schema v5)', () => {
  function seededIndex(): CodeIndex {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [mkSym({ name: 'a', file: 'src/a.ts' })], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/b.ts'), [mkSym({ name: 'b', file: 'src/b.ts' })], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/c.ts'), [], [], []);
    return idx;
  }

  const META = mkGitMeta({ head: 'abc123', analyzedAt: 1_700_000_000_000 });

  async function applySample(idx: CodeIndex): Promise<void> {
    const ab = mkCoChange('src/a.ts', 'src/b.ts', 5);
    const aYaml = mkCoChange('config/x.yaml', 'src/a.ts', 3);
    await idx.applyGitAnalysis({
      counts: new Map([
        ['src/a.ts', 10],
        ['src/b.ts', 7],
        ['config/x.yaml', 4],
      ]),
      cochanges: new Map([
        ['src/a.ts', [ab, aYaml]],
        ['src/b.ts', [ab]],
        // Key not in the index — must be dropped on apply.
        ['gone/old.ts', [mkCoChange('gone/old.ts', 'src/a.ts')]],
      ]),
      hotspots: ['src/a.ts', 'src/b.ts', 'gone/old.ts'],
      meta: META,
    });
  }

  it('applyGitAnalysis sets commitFrequency for every indexed file (0 when uncommitted)', async () => {
    const idx = seededIndex();
    expect(idx.getFile('src/a.ts')?.commitFrequency).toBeUndefined();
    await applySample(idx);
    expect(idx.getFile('src/a.ts')?.commitFrequency).toBe(10);
    expect(idx.getFile('src/b.ts')?.commitFrequency).toBe(7);
    expect(idx.getFile('src/c.ts')?.commitFrequency).toBe(0);
  });

  it('applyGitAnalysis filters cochange keys and hotspots to indexed files', async () => {
    const idx = seededIndex();
    await applySample(idx);
    expect(idx.getCoChanges('gone/old.ts')).toEqual([]);
    expect(idx.getCoChanges('src/a.ts')).toHaveLength(2);
    expect(idx.getHotspots().map((h) => h.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(idx.getGitMeta()).toEqual(META);
  });

  it('getHotspots joins live commit counts and respects the limit', async () => {
    const idx = seededIndex();
    await applySample(idx);
    expect(idx.getHotspots(1)).toEqual([{ path: 'src/a.ts', commits: 10 }]);
    expect(idx.getHotspots()).toEqual([
      { path: 'src/a.ts', commits: 10 },
      { path: 'src/b.ts', commits: 7 },
    ]);
  });

  it('a second applyGitAnalysis replaces prior results wholesale', async () => {
    const idx = seededIndex();
    await applySample(idx);
    await idx.applyGitAnalysis({
      counts: new Map([['src/b.ts', 2]]),
      cochanges: new Map(),
      hotspots: ['src/b.ts'],
      meta: { ...META, head: 'def456' },
    });
    expect(idx.getCoChanges('src/a.ts')).toEqual([]);
    expect(idx.getFile('src/a.ts')?.commitFrequency).toBe(0);
    expect(idx.getFile('src/b.ts')?.commitFrequency).toBe(2);
    expect(idx.getHotspots().map((h) => h.path)).toEqual(['src/b.ts']);
    expect(idx.getGitMeta()?.head).toBe('def456');
  });

  it('removeFile prunes the own cochange key and hotspot entry but keeps partner-side records', async () => {
    const idx = seededIndex();
    await applySample(idx);

    expect(idx.removeFile('src/a.ts')).toBe(true);

    expect(idx.getCoChanges('src/a.ts')).toEqual([]);
    expect(idx.getHotspots().map((h) => h.path)).toEqual(['src/b.ts']);
    // b's record naming a as partner is retained: a fresh analysis would
    // re-derive it (partner values may be non-indexed paths).
    expect(idx.getCoChanges('src/b.ts')).toHaveLength(1);
  });

  it('updateFile preserves commitFrequency, cochange key, and hotspot membership', async () => {
    const idx = seededIndex();
    await applySample(idx);

    const fresh = makeFileInfo('typescript', 'src/a.ts');
    expect(fresh.commitFrequency).toBeUndefined();
    idx.updateFile(fresh, [mkSym({ name: 'a2', file: 'src/a.ts' })], [], []);

    expect(idx.getFile('src/a.ts')?.commitFrequency).toBe(10);
    expect(idx.getCoChanges('src/a.ts')).toHaveLength(2);
    expect(idx.getHotspots().map((h) => h.path)).toContain('src/a.ts');
  });

  it('round-trips git data through save/load', async () => {
    const idx = seededIndex();
    await applySample(idx);
    await idx.save(cachePath);

    const loaded = new CodeIndex(tmpRoot);
    expect(await loaded.load(cachePath)).toBe(true);

    expect(loaded.getGitMeta()).toEqual(META);
    expect(loaded.getFile('src/a.ts')?.commitFrequency).toBe(10);
    expect(loaded.getFile('src/c.ts')?.commitFrequency).toBe(0);
    expect(loaded.getCoChanges('src/a.ts')).toEqual(idx.getCoChanges('src/a.ts'));
    expect(loaded.getHotspots()).toEqual(idx.getHotspots());
  });

  it('rejects a cache with a malformed cochange record', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 5,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        references: [],
        cochanges: [['src/a.ts', [{ fileA: 'src/a.ts' }]]],
        hotspots: [],
        gitMeta: null,
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('rejects a cache with a malformed gitMeta', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        version: 5,
        createdAt: 0,
        projectRoot: tmpRoot,
        symbols: [],
        files: [],
        imports: [],
        callees: [],
        callers: [],
        references: [],
        cochanges: [],
        hotspots: [],
        gitMeta: { head: 42 },
      }),
    );
    const idx = new CodeIndex(tmpRoot);
    expect(await idx.load(cachePath)).toBe(false);
  });

  it('save chained after applyGitAnalysis persists the applied data (write lock ordering)', async () => {
    const idx = seededIndex();
    // Do not await apply before save — the lock must serialize them.
    const applied = applySample(idx);
    const saved = idx.save(cachePath);
    await Promise.all([applied, saved]);

    const loaded = new CodeIndex(tmpRoot);
    expect(await loaded.load(cachePath)).toBe(true);
    expect(loaded.getGitMeta()).toEqual(META);
    expect(loaded.getFile('src/a.ts')?.commitFrequency).toBe(10);
  });

  it('searchSymbols boostByFile reorders equal-relevance results and composes with the export boost', () => {
    const idx = new CodeIndex();
    // Same name in two files — identical relevance; only file boost differs.
    const cold = mkSym({ name: 'handler', file: 'src/cold.ts' });
    const hot = mkSym({ name: 'handler', file: 'src/hot.ts' });
    idx.addFile(makeFileInfo('typescript', 'src/cold.ts'), [cold], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/hot.ts'), [hot], [], []);

    const plain = idx.searchSymbols('handler', { limit: 5 });
    expect(plain.symbols).toHaveLength(2);

    const boosted = idx.searchSymbols('handler', {
      limit: 5,
      boostByFile: new Map([['src/hot.ts', 1.5]]),
    });
    expect(boosted.symbols[0].file).toBe('src/hot.ts');

    // An exported cold symbol at 1.5x ties the hot boost; raising the file
    // boost beyond it wins again — multiplicative composition.
    const exportedCold = mkSym({ name: 'handler', file: 'src/cold2.ts', exported: true });
    idx.addFile(makeFileInfo('typescript', 'src/cold2.ts'), [exportedCold], [], []);
    const composed = idx.searchSymbols('handler', {
      limit: 5,
      boostByFile: new Map([['src/hot.ts', 1.6]]),
    });
    expect(composed.symbols[0].file).toBe('src/hot.ts');
  });
});
