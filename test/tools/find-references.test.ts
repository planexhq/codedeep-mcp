import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import {
  runFindReferences,
  type FindReferencesDeps,
} from '../../src/tools/find-references.js';
import { IMPORT_NAMESPACE } from '../../src/types.js';
import type { Reference, Symbol } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  mkImport,
  mkMemberRef,
  mkSym,
} from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('probe-find-refs-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(index: CodeIndex, ready = true): FindReferencesDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot),
  };
}

interface RefOpts {
  source: Symbol;
  targetName: string;
  targetId?: string | null;
  file?: string;
  line?: number;
}

function mkCallRef(opts: RefOpts): Reference {
  return {
    sourceId: opts.source.id,
    targetId: opts.targetId ?? null,
    targetName: opts.targetName,
    kind: 'calls',
    file: opts.file ?? opts.source.file,
    line: opts.line ?? opts.source.startLine,
  };
}

describe('runFindReferences — resolution', () => {
  it('returns the callers section for a uniquely-named symbol', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      kind: 'function',
      exported: true,
      startLine: 5,
    });
    const caller = mkSym({
      name: 'handler',
      file: 'src/api.ts',
      startLine: 10,
    });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      [mkCallRef({ source: caller, targetName: 'authenticate', line: 12 })],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate' }])],
    );

    const text = (
      await runFindReferences(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('## References for `authenticate` (src/auth.ts:5)');
    expect(text).toContain('### Callers (approximate — from AST name matching)');
    expect(text).toContain('src/api.ts:12 — handler()  [name match, unverified]');
  });

  it('uses line to disambiguate when multiple symbols share a name', async () => {
    const idx = new CodeIndex(tmpRoot);
    const a = mkSym({ name: 'foo', file: 'src/a.ts', startLine: 5, endLine: 10 });
    const b = mkSym({ name: 'foo', file: 'src/a.ts', startLine: 20, endLine: 25 });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [a, b], [], []);

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo', line: 22 },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('## References for `foo` (src/a.ts:20)');
  });

  it('returns disambiguation error when multiple matches and no line provided', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({ name: 'foo', file: 'src/a.ts', startLine: 5, endLine: 10 }),
        mkSym({ name: 'foo', file: 'src/a.ts', startLine: 20, endLine: 25 }),
      ],
      [],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain("Multiple symbols named 'foo' in src/a.ts:");
    expect(text).toContain('Pass `line` to disambiguate.');
  });
});

describe('runFindReferences — ranking', () => {
  it('orders same-directory callers above other tiers', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'authenticate',
      file: 'src/auth/middleware.ts',
      startLine: 5,
    });
    const sameDir = mkSym({
      name: 'cSame',
      file: 'src/auth/handler.ts',
      startLine: 10,
    });
    const elsewhere = mkSym({
      name: 'bFar',
      file: 'lib/extras.ts',
      startLine: 10,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [target],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/handler.ts'),
      [sameDir],
      [mkCallRef({ source: sameDir, targetName: 'authenticate', line: 11 })],
      [mkImport('src/auth/handler.ts', './middleware', [{ name: 'authenticate' }])],
    );
    idx.addFile(
      makeFileInfo('typescript', 'lib/extras.ts'),
      [elsewhere],
      [mkCallRef({ source: elsewhere, targetName: 'authenticate', line: 11 })],
      [mkImport('lib/extras.ts', '../src/auth/middleware', [{ name: 'authenticate' }])],
    );

    const text = (
      await runFindReferences(
        { file: 'src/auth/middleware.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    const sameDirIdx = text.indexOf('src/auth/handler.ts');
    const farIdx = text.indexOf('lib/extras.ts');
    expect(sameDirIdx).toBeGreaterThan(-1);
    expect(farIdx).toBeGreaterThan(-1);
    expect(sameDirIdx).toBeLessThan(farIdx);
  });

  it('orders tier-2 callers by file path lexicographically', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'authenticate',
      file: 'src/auth/middleware.ts',
      startLine: 5,
    });
    const importer = mkSym({
      name: 'importerCall',
      file: 'pkg/billing/charge.ts',
      startLine: 10,
    });
    const parentMod = mkSym({
      name: 'parentCall',
      file: 'src/api.ts',
      startLine: 10,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth/middleware.ts'),
      [target],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'pkg/billing/charge.ts'),
      [importer],
      [mkCallRef({ source: importer, targetName: 'authenticate', line: 11 })],
      [mkImport('pkg/billing/charge.ts', '../../src/auth/middleware', ['authenticate'])],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [parentMod],
      [mkCallRef({ source: parentMod, targetName: 'authenticate', line: 11 })],
      // Unresolvable specifier (TS path alias) — admitted as best-effort
      // tier-2 rather than precisely-resolved tier-2; both tie on tier and
      // fall back to file-path sort.
      [mkImport('src/api.ts', '@/auth/middleware', [{ name: 'authenticate' }])],
    );

    const text = (
      await runFindReferences(
        { file: 'src/auth/middleware.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text.indexOf('pkg/billing/charge.ts')).toBeLessThan(
      text.indexOf('src/api.ts'),
    );
  });

  // Python `from .x import *` (alias===undefined) is a real import-binding;
  // primaryRefMatchesTarget already gated the ref via importResolvesTo.
  // The ranker should treat the wildcard as tier-2 so a wildcard caller
  // outranks an unrelated parent-dir homonym at small `limit`.
  it('promotes Python wildcard-import callers above parent-dir homonyms', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'helper',
      file: 'src/lib/helpers.py',
      startLine: 1,
      language: 'python',
    });
    const parentCall = mkSym({
      name: 'api',
      file: 'src/api.py',
      startLine: 5,
      language: 'python',
    });
    const wildCaller = mkSym({
      name: 'wild',
      file: 'far/wild.py',
      startLine: 5,
      language: 'python',
    });
    idx.addFile(
      makeFileInfo('python', 'src/lib/helpers.py'),
      [target],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('python', 'src/api.py'),
      [parentCall],
      [mkCallRef({ source: parentCall, targetName: 'helper', line: 6 })],
      [],
    );
    idx.addFile(
      makeFileInfo('python', 'far/wild.py'),
      [wildCaller],
      [mkCallRef({ source: wildCaller, targetName: 'helper', line: 6 })],
      [mkImport('far/wild.py', '..src.lib.helpers', [{ name: IMPORT_NAMESPACE }])],
    );

    const text = (
      await runFindReferences(
        { file: 'src/lib/helpers.py', symbol: 'helper', limit: 1 },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('far/wild.py');
    expect(text).not.toContain('src/api.py:6');
  });
});

describe('runFindReferences — noise reduction', () => {
  it('filters cross-file refs for short names (<4 chars)', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'do', file: 'src/x.ts', startLine: 1 });
    const homonym = mkSym({ name: 'caller', file: 'src/y.ts', startLine: 5 });
    idx.addFile(makeFileInfo('typescript', 'src/x.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/y.ts'),
      [homonym],
      // Unresolved cross-file ref (targetId=null) — should be filtered out
      // for short names.
      [mkCallRef({ source: homonym, targetName: 'do', line: 6 })],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/x.ts', symbol: 'do' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Callers (approximate — from AST name matching)');
    expect(text).toContain('(none)');
    expect(text).not.toContain('src/y.ts:6');
  });

  it('keeps within-file precise refs for short names', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'do', file: 'src/x.ts', startLine: 1 });
    const caller = mkSym({ name: 'caller', file: 'src/x.ts', startLine: 5 });
    idx.addFile(
      makeFileInfo('typescript', 'src/x.ts'),
      [target, caller],
      // Resolved within-file (targetId set) — should pass the short-name filter.
      [
        mkCallRef({
          source: caller,
          targetName: 'do',
          targetId: target.id,
          line: 6,
        }),
      ],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/x.ts', symbol: 'do' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/x.ts:6 — caller()  [name match, unverified]');
  });
});

describe('runFindReferences — kind handling', () => {
  it("renders Phase-2 placeholder for kind='implementations'", async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo', kind: 'implementations' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Implementations');
    expect(text).toContain('(none — ships with LSP in Phase 2)');
    expect(text).not.toContain('### Callers');
  });

  it("renders Phase-2 placeholder for kind='type_references'", async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo', kind: 'type_references' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Type References');
    expect(text).toContain('(none — ships with LSP in Phase 2)');
  });

  it("kind='callees' falls through to within-file adjacency", async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'caller', file: 'src/a.ts', startLine: 1 });
    const callee = mkSym({ name: 'helper', file: 'src/a.ts', startLine: 10 });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [target, callee],
      [
        mkCallRef({
          source: target,
          targetName: 'helper',
          targetId: callee.id,
          line: 2,
        }),
      ],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'caller', kind: 'callees' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Callees (within-file — from AST resolution)');
    expect(text).toContain('src/a.ts:10 — helper()');
    expect(text).not.toContain('### Callers');
  });

  it("kind='all' renders all sections", async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo', kind: 'all' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Callers');
    expect(text).toContain('### Callees');
    expect(text).toContain('### Implementations');
    expect(text).toContain('### Type References');
  });
});

describe('runFindReferences — limit', () => {
  it('caps at the explicit limit and reports omitted count', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts', startLine: 1 });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);

    for (let i = 0; i < 5; i++) {
      const caller = mkSym({
        name: `c${i}`,
        file: `src/api${i}.ts`,
        startLine: 10,
      });
      idx.addFile(
        makeFileInfo('typescript', `src/api${i}.ts`),
        [caller],
        [mkCallRef({ source: caller, targetName: 'authenticate', line: 11 })],
        [mkImport(`src/api${i}.ts`, './auth', [{ name: 'authenticate' }])],
      );
    }

    const text = (
      await runFindReferences(
        { file: 'src/auth.ts', symbol: 'authenticate', limit: 2 },
        makeDeps(idx),
      )
    ).content[0].text;

    const callerLines = text
      .split('\n')
      .filter((l) => l.includes('[name match, unverified]'));
    expect(callerLines).toHaveLength(2);
    expect(text).toContain('(3 more omitted; raise `limit` to see all)');
  });
});

describe('runFindReferences — errors and validation', () => {
  it('errors when file is not in the index', async () => {
    const idx = new CodeIndex(tmpRoot);
    const text = (
      await runFindReferences(
        { file: 'src/missing.ts', symbol: 'foo' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toBe("Error: file 'src/missing.ts' not found in index.");
  });

  it('errors with suggestions when symbol is not in the file', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/a.ts',
          kind: 'function',
          startLine: 5,
        }),
      ],
      [],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'authntcate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain("Error: no symbol 'authntcate' in 'src/a.ts'.");
    expect(text).toContain('Did you mean:');
    expect(text).toContain('authenticate');
  });

  it('errors when symbol is empty after trimming', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );
    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: '   ' },
        makeDeps(idx),
      )
    ).content[0].text;
    expect(text).toBe('Error: symbol must be non-empty.');
  });

  it('errors when file path escapes project root', async () => {
    const idx = new CodeIndex(tmpRoot);
    const text = (
      await runFindReferences(
        { file: '../outside.ts', symbol: 'foo' },
        makeDeps(idx),
      )
    ).content[0].text;
    expect(text).toContain('outside the project root');
  });

  it('returns indexer-not-ready banner when indexing is in progress', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );
    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo' },
        makeDeps(idx, false),
      )
    ).content[0].text;
    expect(text.startsWith('⏳ Indexing in progress')).toBe(true);
  });

  it('returns in-band error when an index method throws', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );
    vi.spyOn(idx, 'getReferencesByNameOrAlias').mockImplementation(() => {
      throw new Error('boom');
    });

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo' },
        makeDeps(idx),
      )
    ).content[0].text;
    expect(text).toBe('Error: boom');
  });
});

describe('runFindReferences — edge cases', () => {
  it('renders (module-level) when caller is at file scope (no sourceId)', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'authenticate', file: 'src/auth.ts', startLine: 5 });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    const moduleRef: Reference = {
      sourceId: null,
      targetId: null,
      targetName: 'authenticate',
      kind: 'calls',
      file: 'src/api.ts',
      line: 1,
    };
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [],
      [moduleRef],
      [mkImport('src/api.ts', './auth', [{ name: 'authenticate' }])],
    );

    const text = (
      await runFindReferences(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/api.ts:1 — (module-level)  [name match, unverified]');
  });

  it('filters recursive self-calls', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'fib',
      file: 'src/math.ts',
      startLine: 5,
    });
    // Recursive call: source and target are the same symbol.
    const selfRef: Reference = {
      sourceId: target.id,
      targetId: target.id,
      targetName: 'fib',
      kind: 'calls',
      file: 'src/math.ts',
      line: 6,
    };
    idx.addFile(
      makeFileInfo('typescript', 'src/math.ts'),
      [target],
      [selfRef],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/math.ts', symbol: 'fib' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Callers');
    expect(text).toContain('(none)');
  });

  it('keeps a same-line caller declared next to the target', async () => {
    // Compact `function a(){ b() } function b(){}` puts both declarations
    // and the call on line 1 — verify the recursion filter doesn't lose `a`.
    const idx = new CodeIndex(tmpRoot);
    const caller = mkSym({
      name: 'a',
      file: 'src/compact.ts',
      startLine: 1,
      endLine: 1,
    });
    const target = mkSym({
      name: 'b',
      file: 'src/compact.ts',
      startLine: 1,
      endLine: 1,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/compact.ts'),
      [caller, target],
      [
        mkCallRef({
          source: caller,
          targetName: 'b',
          targetId: target.id,
          line: 1,
        }),
      ],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/compact.ts', symbol: 'b', line: 1 },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/compact.ts:1 — a()  [name match, unverified]');
  });

  it('finds callers that import the target under an alias', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      startLine: 5,
    });
    const aliasCaller = mkSym({
      name: 'handler',
      file: 'src/api.ts',
      startLine: 10,
    });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [aliasCaller],
      // The call site uses the local alias `auth`, so targetName is `auth`.
      [mkCallRef({ source: aliasCaller, targetName: 'auth', line: 12 })],
      [
        mkImport('src/api.ts', './auth', [
          { name: 'authenticate', alias: 'auth' },
        ]),
      ],
    );

    const text = (
      await runFindReferences(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/api.ts:12 — handler()  [name match, unverified]');
  });

  it('renders empty callers section when no references exist', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'orphan', file: 'src/a.ts' })],
      [],
      [],
    );
    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'orphan' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Callers (approximate — from AST name matching)');
    expect(text).toContain('(none)');
  });

  it('drops refs precisely resolved to a homonymous symbol in another file', async () => {
    // Two files declare a local `authenticate`. B's caller is precisely
    // resolved to B's symbol, so it must not surface for A despite the name.
    const idx = new CodeIndex(tmpRoot);
    const targetA = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      startLine: 5,
    });
    const targetB = mkSym({
      name: 'authenticate',
      file: 'src/other.ts',
      startLine: 8,
    });
    const callerA = mkSym({
      name: 'handlerA',
      file: 'src/auth.ts',
      startLine: 20,
    });
    const callerB = mkSym({
      name: 'handlerB',
      file: 'src/other.ts',
      startLine: 25,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [targetA, callerA],
      [
        mkCallRef({
          source: callerA,
          targetName: 'authenticate',
          targetId: targetA.id,
          line: 21,
        }),
      ],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/other.ts'),
      [targetB, callerB],
      [
        mkCallRef({
          source: callerB,
          targetName: 'authenticate',
          targetId: targetB.id,
          line: 26,
        }),
      ],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/auth.ts', symbol: 'authenticate', line: 5 },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/auth.ts:21 — handlerA()  [name match, unverified]');
    expect(text).not.toContain('handlerB');
    expect(text).not.toContain('src/other.ts');
  });
});

describe('runFindReferences — readiness banner', () => {
  const BANNER = '⏳ Indexing in progress. Results may be incomplete.';

  it('prepends the banner on a hasFile miss while indexing', async () => {
    const idx = new CodeIndex(tmpRoot);
    const text = (
      await runFindReferences(
        { file: 'src/missing.ts', symbol: 'foo' },
        makeDeps(idx, false),
      )
    ).content[0].text;

    expect(text.startsWith(BANNER)).toBe(true);
    expect(text).toContain("Error: file 'src/missing.ts' not found in index.");
  });

  it('prepends the banner on a no-symbol miss while indexing', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'other', file: 'src/a.ts' })],
      [],
      [],
    );
    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'missing' },
        makeDeps(idx, false),
      )
    ).content[0].text;

    expect(text.startsWith(BANNER)).toBe(true);
    expect(text).toContain("Error: no symbol 'missing' in 'src/a.ts'.");
  });

  it('prepends the banner on an ambiguous match while indexing', async () => {
    const idx = new CodeIndex(tmpRoot);
    const a = mkSym({ name: 'foo', file: 'src/a.ts', startLine: 5 });
    const b = mkSym({ name: 'foo', file: 'src/a.ts', startLine: 20 });
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [a, b], [], []);

    const text = (
      await runFindReferences(
        { file: 'src/a.ts', symbol: 'foo' },
        makeDeps(idx, false),
      )
    ).content[0].text;

    expect(text.startsWith(BANNER)).toBe(true);
    expect(text).toContain("Multiple symbols named 'foo'");
  });

  it('does not prepend the banner on validation errors', async () => {
    const idx = new CodeIndex(tmpRoot);
    const text = (
      await runFindReferences(
        { file: '/etc/passwd', symbol: 'foo' },
        makeDeps(idx, false),
      )
    ).content[0].text;

    expect(text.startsWith(BANNER)).toBe(false);
    expect(text).toContain('outside the project root');
  });
});

describe('runFindReferences — member-expression refs', () => {
  function memberSetup() {
    const idx = new CodeIndex(tmpRoot);
    const save = mkSym({
      name: 'save',
      kind: 'method',
      parent: 'Repo',
      file: 'src/repo.ts',
      exported: true,
      startLine: 5,
    });
    idx.addFile(makeFileInfo('typescript', 'src/repo.ts'), [save], [], []);
    return { idx, save };
  }

  it('tags unresolved member rows with [member call, unverified]', async () => {
    const { idx } = memberSetup();
    const caller = mkSym({ name: 'handler', file: 'src/api.ts', startLine: 3 });
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      [mkMemberRef(caller, 'save', 'repo', { line: 4 })],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/repo.ts', symbol: 'save' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/api.ts:4 — handler()  [member call, unverified]');
    expect(text).not.toContain('src/api.ts:4 — handler()  [name match, unverified]');
  });

  it('keeps the name-match tag for extract-time-resolved member rows', async () => {
    const idx = new CodeIndex(tmpRoot);
    const helper = mkSym({
      name: 'helper',
      kind: 'method',
      parent: 'C',
      file: 'src/c.ts',
      startLine: 2,
    });
    const run = mkSym({
      name: 'run',
      kind: 'method',
      parent: 'C',
      file: 'src/c.ts',
      startLine: 5,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [helper, run],
      [mkMemberRef(run, 'helper', 'this', { targetId: helper.id, line: 6 })],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/c.ts', symbol: 'helper' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('src/c.ts:6 — run()  [name match, unverified]');
  });

  it('ranks import-connected receivers above unknown receivers', async () => {
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({
      name: 'formatDate',
      file: 'src/utils.ts',
      exported: true,
      startLine: 1,
    });
    idx.addFile(makeFileInfo('typescript', 'src/utils.ts'), [target], [], []);

    // Unknown receiver in a same-directory file would out-rank by
    // directory if member refs used directory tiers; it must not.
    const noisy = mkSym({ name: 'noisy', file: 'src/near.ts', startLine: 1 });
    idx.addFile(
      makeFileInfo('typescript', 'src/near.ts'),
      [noisy],
      [mkMemberRef(noisy, 'formatDate', 'obj', { line: 2 })],
      [],
    );

    const connected = mkSym({ name: 'svc', file: 'lib/deep/svc.ts', startLine: 1 });
    idx.addFile(
      makeFileInfo('typescript', 'lib/deep/svc.ts'),
      [connected],
      [mkMemberRef(connected, 'formatDate', 'u', { line: 3 })],
      [
        mkImport('lib/deep/svc.ts', '../../src/utils', [
          { name: IMPORT_NAMESPACE, alias: 'u', kind: 'namespace' },
        ]),
      ],
    );

    const text = (
      await runFindReferences(
        { file: 'src/utils.ts', symbol: 'formatDate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text.indexOf('lib/deep/svc.ts:3')).toBeLessThan(
      text.indexOf('src/near.ts:2'),
    );
  });

  it('excludes member matches for short method names', async () => {
    const idx = new CodeIndex(tmpRoot);
    const get = mkSym({
      name: 'get',
      kind: 'method',
      parent: 'Store',
      file: 'src/store.ts',
      exported: true,
      startLine: 2,
    });
    idx.addFile(makeFileInfo('typescript', 'src/store.ts'), [get], [], []);

    const caller = mkSym({ name: 'caller', file: 'src/api.ts', startLine: 1 });
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [caller],
      [mkMemberRef(caller, 'get', 'store', { line: 2 })],
      [],
    );

    const text = (
      await runFindReferences(
        { file: 'src/store.ts', symbol: 'get' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Callers');
    expect(text).toContain('(none)');
  });
});
