import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import {
  runFindSymbol,
  type FindSymbolDeps,
} from '../../src/tools/find-symbol.js';
import type { Symbol } from '../../src/types.js';
import { makeConfig, makeFileInfo, makeProjectDir, mkMemberRef, mkRef, mkSym } from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('probe-find-symbol-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(index: CodeIndex, ready = true): FindSymbolDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot),
  };
}

describe('runFindSymbol — exact match', () => {
  it('renders file:range, kind, exported tag, signature, doc, and references', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'authenticate',
      file: 'src/auth/middleware.ts',
      kind: 'function',
      exported: true,
      signature: 'async function authenticate(req: Request): Promise<void>',
      doc: 'Validates the JWT token and attaches user to request',
      startLine: 42,
      endLine: 67,
    });
    const caller = mkSym({
      name: 'handler',
      file: 'src/auth/middleware.ts',
      kind: 'function',
      startLine: 70,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [target, caller],
      [mkRef(caller, target)],
      [],
    );

    const result = await runFindSymbol({ name: 'authenticate' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('src/auth/middleware.ts:42-67 | function | exported');
    expect(text).toContain(
      'async function authenticate(req: Request): Promise<void>',
    );
    expect(text).toContain('Validates the JWT token and attaches user to request');
    expect(text).toContain('References: ~1');
  });

  it('counts each call site individually so References: ~N matches find_references line count', async () => {
    // One caller calling `target` three times: References: ~3, mirroring
    // what find_references would print (one line per call site).
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'target', file: 'src/a.ts', kind: 'function' });
    const caller = mkSym({ name: 'caller', file: 'src/a.ts', kind: 'function' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [target, caller],
      [mkRef(caller, target), mkRef(caller, target), mkRef(caller, target)],
      [],
    );

    const result = await runFindSymbol({ name: 'target' }, makeDeps(idx));
    expect(result.content[0].text).toContain('References: ~3');
  });

  it('omits the exported tag when symbol is not exported', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/util.ts'),
      [
        mkSym({
          name: 'helper',
          file: 'src/util.ts',
          kind: 'function',
          exported: false,
          signature: 'function helper()',
          startLine: 5,
          endLine: 8,
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'helper' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('src/util.ts:5-8 | function');
    expect(text).not.toContain('| exported');
  });

  it('omits the doc line entirely when doc is null', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/util.ts'),
      [
        mkSym({
          name: 'helper',
          file: 'src/util.ts',
          signature: 'function helper()',
          doc: null,
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'helper' }, makeDeps(idx));
    const lines = result.content[0].text.split('\n');

    expect(lines).toEqual([
      'src/util.ts:1-1 | function',
      'function helper()',
      'References: ~0',
      'Fan-out: 0',
    ]);
  });

  it('renders References: ~0 when there are no callers', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/util.ts'),
      [mkSym({ name: 'foo', file: 'src/util.ts' })],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    expect(result.content[0].text).toContain('References: ~0');
  });

  it('renders Fan-out as the resolved within-file callee count', async () => {
    const idx = new CodeIndex(tmpRoot);
    const foo = mkSym({ name: 'foo', file: 'src/util.ts', startLine: 1 });
    const a = mkSym({ name: 'a', file: 'src/util.ts', startLine: 2 });
    const b = mkSym({ name: 'b', file: 'src/util.ts', startLine: 3 });
    idx.addFile(
      makeFileInfo('typescript', 'src/util.ts'),
      [foo, a, b],
      [mkRef(foo, a), mkRef(foo, b)],
      [],
    );
    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    expect(result.content[0].text).toContain('Fan-out: 2');
  });
});

describe('runFindSymbol — filters', () => {
  it('applies the kind filter to exact matches', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({ name: 'Config', file: 'src/a.ts', kind: 'class' }),
        mkSym({ name: 'Config', file: 'src/a.ts', kind: 'type' }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'Config', kind: 'class' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('| class');
    expect(text).not.toContain('| type');
  });

  it('finds enum symbols and honors the enum kind filter', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/status.ts'),
      [
        mkSym({
          name: 'HttpStatus',
          file: 'src/status.ts',
          kind: 'enum',
          exported: true,
          signature: 'enum HttpStatus',
        }),
        mkSym({ name: 'HttpStatus', file: 'src/status.ts', kind: 'variable' }),
      ],
      [],
      [],
    );

    const text = (
      await runFindSymbol({ name: 'HttpStatus', kind: 'enum' }, makeDeps(idx))
    ).content[0].text;

    expect(text).toContain('| enum | exported');
    expect(text).toContain('enum HttpStatus');
    expect(text).not.toContain('| variable');
  });

  it('applies the scope filter and normalizes a missing trailing slash', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/handler.ts'),
      [mkSym({ name: 'check', file: 'src/auth/handler.ts' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/authority/policy.ts'),
      [mkSym({ name: 'check', file: 'src/authority/policy.ts' })],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'check', scope: 'src/auth' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/auth/handler.ts');
    expect(text).not.toContain('src/authority/');
  });

  it('honors a scope that is a file path with an extension', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.ts'),
      [mkSym({ name: 'foo', file: 'src/foo.ts' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/bar.ts'),
      [mkSym({ name: 'foo', file: 'src/bar.ts' })],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'foo', scope: 'src/foo.ts' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/foo.ts');
    expect(text).not.toContain('src/bar.ts');
  });
});

describe('runFindSymbol — prefix and dedupe', () => {
  it('fills with prefix matches when exact yields fewer than limit', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'auth',
          file: 'src/a.ts',
          signature: 'function auth()',
        }),
        mkSym({
          name: 'authenticate',
          file: 'src/a.ts',
          signature: 'function authenticate()',
        }),
        mkSym({
          name: 'authorize',
          file: 'src/a.ts',
          signature: 'function authorize()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'auth' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('function auth()');
    expect(text).toContain('function authenticate()');
    expect(text).toContain('function authorize()');
  });

  it('does not duplicate the exact match when prefix returns the same symbol', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo()',
          startLine: 1,
          endLine: 2,
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    const occurrences = result.content[0].text.split('src/a.ts:1-2').length - 1;
    expect(occurrences).toBe(1);
  });

  it('promotes an exported match over many earlier-alphabetical non-exported matches', async () => {
    const idx = new CodeIndex(tmpRoot);
    const internals: Symbol[] = [];
    for (let i = 0; i < 20; i++) {
      internals.push(
        mkSym({
          name: `auth0${i.toString().padStart(2, '0')}`,
          file: 'src/internal/a.ts',
          exported: false,
          signature: `function auth0${i.toString().padStart(2, '0')}()`,
        }),
      );
    }
    idx.addFile(
      makeFileInfo('typescript', 'src/internal/a.ts'),
      internals,
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth/middleware.ts',
          exported: true,
          signature: 'function authenticate()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'auth' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('function authenticate()');
    expect(text.indexOf('function authenticate()')).toBeLessThan(
      text.indexOf('function auth0'),
    );
  });

  it('finds an in-scope match when many out-of-scope share the prefix', async () => {
    const idx = new CodeIndex(tmpRoot);
    const outOfScope: Symbol[] = [];
    for (let i = 0; i < 60; i++) {
      outOfScope.push(
        mkSym({
          name: `auth${i.toString().padStart(2, '0')}`,
          file: 'src/api/a.ts',
          signature: `function auth${i.toString().padStart(2, '0')}()`,
        }),
      );
    }
    idx.addFile(makeFileInfo('typescript', 'src/api/a.ts'), outOfScope, [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth/middleware.ts',
          signature: 'function authenticate()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'auth', scope: 'src/auth/' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('function authenticate()');
    expect(text).not.toContain('src/api/');
  });

  it('surfaces PascalCase types when prefix is lowercase', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth/middleware.ts',
          exported: true,
          signature: 'function authenticate()',
        }),
        mkSym({
          name: 'AuthToken',
          file: 'src/auth/middleware.ts',
          kind: 'type',
          exported: true,
          signature: 'type AuthToken',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'auth' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('function authenticate()');
    expect(text).toContain('type AuthToken');
  });

  it('does not leak siblings sharing the filename prefix when scope is a file', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.ts'),
      [
        mkSym({
          name: 'render',
          file: 'src/foo.ts',
          signature: 'function render()',
        }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.tsx'),
      [
        mkSym({
          name: 'render',
          file: 'src/foo.tsx',
          signature: 'function renderTsx()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'render', scope: 'src/foo.ts' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/foo.ts:');
    expect(text).not.toContain('src/foo.tsx:');
  });

  it('surfaces an exported match buried behind alphabetically-earlier internals', async () => {
    const idx = new CodeIndex(tmpRoot);
    // 60 generated names that sort before 'authenticate' in lex order
    // ('0' (0x30) < 'a' (0x61)). With the old max(limit*5, 50) cap, the
    // exported match never entered the merged candidate list.
    const internals: Symbol[] = [];
    for (let i = 0; i < 60; i++) {
      const name = `auth${String(i).padStart(3, '0')}`;
      internals.push(
        mkSym({
          name,
          file: 'src/internal/a.ts',
          exported: false,
          signature: `function ${name}()`,
        }),
      );
    }
    idx.addFile(
      makeFileInfo('typescript', 'src/internal/a.ts'),
      internals,
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth/middleware.ts',
          exported: true,
          signature: 'function authenticate()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'auth' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('function authenticate()');
  });

  it('treats a dotted directory like .storybook as a directory scope', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', '.storybook/main.ts'),
      [
        mkSym({
          name: 'config',
          file: '.storybook/main.ts',
          signature: 'const config = {}',
        }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/app.ts'),
      [
        mkSym({
          name: 'config',
          file: 'src/app.ts',
          signature: 'const config = appConfig',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'config', scope: '.storybook' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('.storybook/main.ts');
    expect(text).not.toContain('src/app.ts');
  });
});

describe('runFindSymbol — sort', () => {
  it('orders exact-match before prefix-only', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foobar',
          file: 'src/a.ts',
          exported: true,
          signature: 'function foobar()',
        }),
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          exported: false,
          signature: 'function foo()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text.indexOf('function foo()')).toBeLessThan(
      text.indexOf('function foobar()'),
    );
  });

  it('orders exported before non-exported within a tier', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'fooInternal',
          file: 'src/a.ts',
          exported: false,
          signature: 'function fooInternal()',
        }),
        mkSym({
          name: 'fooExported',
          file: 'src/a.ts',
          exported: true,
          signature: 'function fooExported()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text.indexOf('function fooExported()')).toBeLessThan(
      text.indexOf('function fooInternal()'),
    );
  });

  it('orders shallower paths before deeper paths', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/deep/nested/a.ts'),
      [
        mkSym({
          name: 'fooDeep',
          file: 'src/deep/nested/a.ts',
          exported: true,
          signature: 'function fooDeep()',
        }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'fooShallow',
          file: 'src/a.ts',
          exported: true,
          signature: 'function fooShallow()',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text.indexOf('function fooShallow()')).toBeLessThan(
      text.indexOf('function fooDeep()'),
    );
  });
});

describe('runFindSymbol — limit', () => {
  it('defaults to 10 results', async () => {
    const idx = new CodeIndex(tmpRoot);
    const syms: Symbol[] = [];
    for (let i = 0; i < 20; i++) {
      syms.push(
        mkSym({
          name: `foo${i.toString().padStart(2, '0')}`,
          file: 'src/a.ts',
          signature: `function foo${i.toString().padStart(2, '0')}()`,
          startLine: i + 1,
          endLine: i + 1,
        }),
      );
    }
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), syms, [], []);

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    const blocks = result.content[0].text.trim().split('\n\n');
    expect(blocks).toHaveLength(10);
  });

  it('honors an explicit limit', async () => {
    const idx = new CodeIndex(tmpRoot);
    const syms: Symbol[] = [];
    for (let i = 0; i < 5; i++) {
      syms.push(
        mkSym({
          name: `foo${i}`,
          file: 'src/a.ts',
          signature: `function foo${i}()`,
          startLine: i + 1,
          endLine: i + 1,
        }),
      );
    }
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), syms, [], []);

    const result = await runFindSymbol(
      { name: 'foo', limit: 3 },
      makeDeps(idx),
    );
    const blocks = result.content[0].text.trim().split('\n\n');
    expect(blocks).toHaveLength(3);
  });

  it('clamps limits above 100 to 100', async () => {
    const idx = new CodeIndex(tmpRoot);
    const syms: Symbol[] = [];
    for (let i = 0; i < 150; i++) {
      syms.push(
        mkSym({
          name: `foo${i.toString().padStart(3, '0')}`,
          file: 'src/a.ts',
          signature: `function foo${i.toString().padStart(3, '0')}()`,
          startLine: i + 1,
          endLine: i + 1,
        }),
      );
    }
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), syms, [], []);

    const result = await runFindSymbol(
      { name: 'foo', limit: 1000 },
      makeDeps(idx),
    );
    const blocks = result.content[0].text.trim().split('\n\n');
    expect(blocks).toHaveLength(100);
  });
});

describe('runFindSymbol — no-match', () => {
  it('shows "Did you mean" suggestions when fuzzy returns results', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth/middleware.ts',
          kind: 'function',
          exported: true,
          startLine: 42,
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'authntcate' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain("No symbol 'authntcate' found.");
    expect(text).toContain('Did you mean:');
    expect(text).toContain(
      '- authenticate (function, src/auth/middleware.ts:42) [exported]',
    );
  });

  it('renders only the no-symbol line when fuzzy returns nothing', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'unrelated', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'xyzabcqwerty' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toBe("No symbol 'xyzabcqwerty' found.");
  });

  it('drops out-of-scope suggestions when scope is set', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/other/util.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/other/util.ts',
          kind: 'function',
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'authntcate', scope: 'src/auth/' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toBe("No symbol 'authntcate' found.");
  });

  it('surfaces an in-scope misspelling buried behind 25+ out-of-scope fuzzy hits', async () => {
    const idx = new CodeIndex(tmpRoot);
    // 30 decoys with the *exact* query name in src/other/ outrank the
    // in-scope fuzzy target by MiniSearch score. With the prior 25-cap,
    // the limit budget was spent on out-of-scope hits before the
    // in-scope match could be considered.
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
      [
        mkSym({
          name: 'authenticte',
          file: 'src/auth/main.ts',
          kind: 'function',
          startLine: 10,
        }),
      ],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'authentcate', scope: 'src/auth/' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('Did you mean:');
    expect(text).toContain('src/auth/main.ts');
  });
});

describe('runFindSymbol — empty index', () => {
  it('returns the no-match line when the index has no symbols', async () => {
    const idx = new CodeIndex(tmpRoot);
    const result = await runFindSymbol({ name: 'anything' }, makeDeps(idx));
    expect(result.content[0].text).toBe("No symbol 'anything' found.");
  });
});

describe('runFindSymbol — banner and validation', () => {
  it('prepends the indexing banner when indexer is not ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runFindSymbol(
      { name: 'foo' },
      makeDeps(idx, false),
    );
    const text = result.content[0].text;

    expect(text.startsWith('⏳ Indexing in progress')).toBe(true);
  });

  it('returns an in-band error when name is empty after trimming', async () => {
    const idx = new CodeIndex(tmpRoot);

    const result = await runFindSymbol({ name: '   ' }, makeDeps(idx));
    expect(result.content[0].text).toBe('Error: name must be non-empty.');
  });

  it('returns an in-band error when an index method throws', async () => {
    const idx = new CodeIndex(tmpRoot);
    vi.spyOn(idx, 'findSymbolByName').mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await runFindSymbol({ name: 'foo' }, makeDeps(idx));
    expect(result.content[0].text).toBe('Error: boom');
  });
});

describe('runFindSymbol — member-call reference counts', () => {
  it('counts cross-file member refs in References: ~N for methods', async () => {
    const idx = new CodeIndex(tmpRoot);
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

    const text = (await runFindSymbol({ name: 'save' }, makeDeps(idx)))
      .content[0].text;
    expect(text).toContain('References: ~1');
  });
});
