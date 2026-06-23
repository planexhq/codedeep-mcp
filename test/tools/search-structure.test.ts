import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import {
  runSearchStructure,
  type SearchStructureDeps,
} from '../../src/tools/search-structure.js';
import type { CodedeepConfig } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  mkGitMeta,
  mkSym,
  silenceStderr,
  writeTree,
} from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('probe-search-structure-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(
  index: CodeIndex,
  ready = true,
  configOverrides: Partial<CodedeepConfig> = {},
): SearchStructureDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot, configOverrides),
  };
}

function text(result: { content: Array<{ text: string }> }): string {
  return result.content[0].text;
}

describe('runSearchStructure — query mode', () => {
  it('renders header, signature, and doc for a name match', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth.ts',
          exported: true,
          signature: 'async function authenticate(req: Request): Promise<User>',
          doc: 'Validates the JWT and attaches user to request',
          startLine: 5,
          endLine: 10,
        }),
      ],
      [],
      [],
    );

    const out = text(await runSearchStructure({ query: 'authenticate' }, makeDeps(idx)));
    expect(out).toContain('src/auth.ts:5-10 | function | exported');
    expect(out).toContain('async function authenticate(req: Request): Promise<User>');
    expect(out).toContain('Validates the JWT and attaches user to request');
  });

  it('finds symbols by docstring and signature tokens', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth.ts',
          doc: 'Validates the JWT and attaches user to request',
        }),
      ],
      [],
      [],
    );

    const out = text(await runSearchStructure({ query: 'JWT' }, makeDeps(idx)));
    expect(out).toContain('authenticate');
  });

  it('ranks exported symbols above non-exported ones', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'parseConfig', file: 'src/a.ts' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [mkSym({ name: 'parseConfig', file: 'src/b.ts', exported: true })],
      [],
      [],
    );

    const out = text(await runSearchStructure({ query: 'parseConfig' }, makeDeps(idx)));
    expect(out.indexOf('src/b.ts')).toBeLessThan(out.indexOf('src/a.ts'));
  });

  it('falls back to the symbol name when the signature is empty', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [mkSym({ name: 'configValue', file: 'src/c.ts', kind: 'variable', signature: '' })],
      [],
      [],
    );

    const out = text(await runSearchStructure({ query: 'configValue' }, makeDeps(idx)));
    const lines = out.split('\n');
    expect(lines[0]).toContain('src/c.ts');
    expect(lines[1]).toBe('configValue');
  });

  it("honors the language filter, expanding 'typescript' to include tsx", async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('tsx', 'src/App.tsx'),
      [mkSym({ name: 'renderWidget', file: 'src/App.tsx', language: 'tsx' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('python', 'app/w.py'),
      [mkSym({ name: 'renderWidget', file: 'app/w.py', language: 'python' })],
      [],
      [],
    );

    const ts = text(
      await runSearchStructure(
        { query: 'renderWidget', language: 'typescript' },
        makeDeps(idx),
      ),
    );
    expect(ts).toContain('src/App.tsx');
    expect(ts).not.toContain('app/w.py');

    const py = text(
      await runSearchStructure(
        { query: 'renderWidget', language: 'python' },
        makeDeps(idx),
      ),
    );
    expect(py).toContain('app/w.py');
    expect(py).not.toContain('src/App.tsx');
  });

  it('honors the cpp language filter', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('cpp', 'src/widget.cpp'),
      [mkSym({ name: 'renderWidget', file: 'src/widget.cpp', language: 'cpp' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('python', 'app/w.py'),
      [mkSym({ name: 'renderWidget', file: 'app/w.py', language: 'python' })],
      [],
      [],
    );
    const out = text(
      await runSearchStructure({ query: 'renderWidget', language: 'cpp' }, makeDeps(idx)),
    );
    expect(out).toContain('src/widget.cpp');
    expect(out).not.toContain('app/w.py');
  });

  it('returns an in-band error for an unknown language', async () => {
    const idx = new CodeIndex(tmpRoot);
    const out = text(
      await runSearchStructure({ query: 'x', language: 'cobol' }, makeDeps(idx)),
    );
    expect(out).toContain("Error: unknown language 'cobol'");
    expect(out).toContain('typescript, tsx, javascript, python');
  });

  it('notes omitted results when matches exceed the limit', async () => {
    const idx = new CodeIndex(tmpRoot);
    for (let i = 0; i < 4; i++) {
      const file = `src/${i}.ts`;
      idx.addFile(
        makeFileInfo('typescript', file),
        [mkSym({ name: 'validateInput', file })],
        [],
        [],
      );
    }

    const out = text(
      await runSearchStructure({ query: 'validateInput', limit: 2 }, makeDeps(idx)),
    );
    expect(out).toContain('(2 more omitted; raise `limit` to see all)');
    expect(out.match(/src\/\d\.ts/g)).toHaveLength(2);
  });

  it('reports no matches with the language filter mentioned', async () => {
    const idx = new CodeIndex(tmpRoot);
    const out = text(
      await runSearchStructure({ query: 'nothing', language: 'python' }, makeDeps(idx)),
    );
    expect(out).toBe("No matches for 'nothing' (language: python).");
  });

  it('returns an in-band error when neither query nor pattern is given', async () => {
    const idx = new CodeIndex(tmpRoot);
    for (const args of [{}, { query: '' }, { query: '   ' }]) {
      const out = text(await runSearchStructure(args, makeDeps(idx)));
      expect(out).toBe('Error: provide a non-empty `query` or an ast-grep `pattern`.');
    }
  });

  it('prepends the indexing banner when the index is not ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    const out = text(await runSearchStructure({ query: 'x' }, makeDeps(idx, false)));
    expect(out).toContain('⏳ Indexing in progress');
  });
});

describe('runSearchStructure — pattern mode', () => {
  // Lines:            1                 2                  3  4 (fn start)        5                       6                      7
  const ROUTES_SRC = `import './cors';\napp.use(cors());\n\nexport function setupRoutes(app) {\n  app.use(errorHandler);\n  app.use(requestLogger);\n}\n`;

  function indexRoutesFixture(idx: CodeIndex): void {
    writeTree(tmpRoot, { 'src/routes.ts': ROUTES_SRC });
    idx.addFile(
      makeFileInfo('typescript', 'src/routes.ts'),
      [
        mkSym({
          name: 'setupRoutes',
          file: 'src/routes.ts',
          kind: 'function',
          exported: true,
          signature: 'function setupRoutes(app)',
          startLine: 4,
          endLine: 7,
        }),
      ],
      [],
      [],
    );
  }

  it('maps matches to enclosing symbols and module level', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);

    const out = text(
      await runSearchStructure({ pattern: 'app.use($H)' }, makeDeps(idx)),
    );
    expect(out).toContain('src/routes.ts:4-7 | function | exported');
    expect(out).toContain('function setupRoutes(app)');
    expect(out).toContain('match :5  app.use(errorHandler)');
    expect(out).toContain('match :6  app.use(requestLogger)');
    expect(out).toContain('src/routes.ts (module-level)');
    expect(out).toContain('match :2  app.use(cors())');
  });

  it('truncates at the limit with a note', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);

    const out = text(
      await runSearchStructure({ pattern: 'app.use($H)', limit: 1 }, makeDeps(idx)),
    );
    expect(out).toContain('match :2');
    expect(out).not.toContain('match :6');
    expect(out).toContain('(more matches exist; raise `limit` to see all)');
  });

  it('returns a capability note for non-TS/JS languages', async () => {
    const idx = new CodeIndex(tmpRoot);
    const out = text(
      await runSearchStructure(
        { pattern: 'hash($A)', language: 'python' },
        makeDeps(idx),
      ),
    );
    expect(out).toContain('Structural patterns are not supported for this language yet');
    expect(out).toContain('`query` mode works');
  });

  it('rejects a pattern that does not parse', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);

    const out = text(
      await runSearchStructure({ pattern: 'function ((' }, makeDeps(idx)),
    );
    expect(out).toContain("Error: invalid ast-grep pattern 'function (('");
  });

  it('skips files that cannot be read and says so', async () => {
    const idx = new CodeIndex(tmpRoot);
    // Indexed but never written to disk.
    idx.addFile(
      makeFileInfo('typescript', 'src/ghost.ts'),
      [mkSym({ name: 'phantom', file: 'src/ghost.ts' })],
      [],
      [],
    );

    const out = text(
      await runSearchStructure({ pattern: 'phantom($A)' }, makeDeps(idx)),
    );
    expect(out).toContain("No structural matches for pattern 'phantom($A)'");
    expect(out).toContain('(1 file could not be read and were skipped)');
  });

  it('skips files over maxFileSize via the safe-read guard', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);

    const out = text(
      await runSearchStructure(
        { pattern: 'app.use($H)' },
        makeDeps(idx, true, { maxFileSize: 10 }),
      ),
    );
    expect(out).toContain('No structural matches');
    expect(out).toContain('could not be read');
  });

  it('explains an empty index', async () => {
    const idx = new CodeIndex(tmpRoot);
    const out = text(
      await runSearchStructure({ pattern: 'app.use($H)' }, makeDeps(idx)),
    );
    expect(out).toContain('no TypeScript/TSX/JavaScript files are indexed');
  });

  it('does not claim "nothing indexed" when the language filter excluded the files', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx); // TS files ARE indexed

    const out = text(
      await runSearchStructure(
        { pattern: 'app.use($H)', language: 'javascript' },
        makeDeps(idx),
      ),
    );
    expect(out).not.toContain('no TypeScript/TSX/JavaScript files are indexed');
    expect(out).toContain('no indexed files match the scanned language(s) (javascript)');
  });

  it('rejects patterns that recover via zero-width MISSING tokens', async () => {
    // `function f() {` parses with a MISSING `}` and no ERROR node — an
    // ERROR-kind query would pass it and the pattern would silently
    // match nothing.
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);

    const out = text(
      await runSearchStructure({ pattern: 'function f() {' }, makeDeps(idx)),
    );
    expect(out).toContain("Error: invalid ast-grep pattern 'function f() {'");
  });

  it('prepends the indexing banner when not ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);
    const out = text(
      await runSearchStructure({ pattern: 'app.use($H)' }, makeDeps(idx, false)),
    );
    expect(out).toContain('⏳ Indexing in progress');
    expect(out).toContain('match :5');
  });

  it('prefers pattern over query when both are given', async () => {
    const idx = new CodeIndex(tmpRoot);
    indexRoutesFixture(idx);
    const out = text(
      await runSearchStructure(
        { query: 'setupRoutes', pattern: 'app.use($H)' },
        makeDeps(idx),
      ),
    );
    expect(out).toContain('match :5');
  });
});

describe('runSearchStructure — binding unavailable', () => {
  afterEach(() => {
    vi.doUnmock('@ast-grep/napi');
    vi.resetModules();
  });

  it('degrades to an in-band message when @ast-grep/napi fails to load', async () => {
    silenceStderr();
    vi.resetModules();
    vi.doMock('@ast-grep/napi', () => {
      throw new Error('no binding for this platform');
    });
    // Fresh module instance so the cached loader promise is not reused.
    const fresh = await import('../../src/tools/search-structure.js');

    const idx = new CodeIndex(tmpRoot);
    const out = text(
      await fresh.runSearchStructure({ pattern: 'foo($A)' }, makeDeps(idx)),
    );
    expect(out).toContain('structural pattern matching is unavailable');
    expect(out).toContain('`query` mode still works');
  });
});

describe('runSearchStructure — git churn boost', () => {
  // Two files with the SAME symbol name so MiniSearch relevance ties and
  // only the churn boost can decide the order.
  async function tiedIndex(): Promise<CodeIndex> {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/cold.ts'),
      [mkSym({ name: 'handler', file: 'src/cold.ts', signature: 'function handler()' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/hot.ts'),
      [mkSym({ name: 'handler', file: 'src/hot.ts', signature: 'function handler()' })],
      [],
      [],
    );
    return idx;
  }

  async function applyChurn(
    idx: CodeIndex,
    counts: Array<[string, number]>,
  ): Promise<void> {
    await idx.applyGitAnalysis({
      counts: new Map(counts),
      cochanges: new Map(),
      hotspots: counts.map(([p]) => p),
      meta: mkGitMeta(),
    });
  }

  it('ranks the churned file above an equal-relevance cold file', async () => {
    const idx = await tiedIndex();
    await applyChurn(idx, [['src/hot.ts', 25]]);

    const out = text(
      await runSearchStructure({ query: 'handler' }, makeDeps(idx)),
    );
    expect(out.indexOf('src/hot.ts')).toBeGreaterThan(-1);
    expect(out.indexOf('src/hot.ts')).toBeLessThan(out.indexOf('src/cold.ts'));
  });

  it('does not reorder anything without git data', async () => {
    const idx = await tiedIndex();
    const out = text(
      await runSearchStructure({ query: 'handler' }, makeDeps(idx)),
    );
    // Both present; no churn data -> tie broken by MiniSearch insertion
    // order, which is cold.ts first here. The assertion pins "no boost",
    // not a particular tiebreak policy.
    expect(out.indexOf('src/cold.ts')).toBeLessThan(out.indexOf('src/hot.ts'));
  });

  it('a fresh analysis invalidates the memoized boost map (GitMeta identity key)', async () => {
    const idx = await tiedIndex();
    await applyChurn(idx, [['src/hot.ts', 25]]);

    let out = text(await runSearchStructure({ query: 'handler' }, makeDeps(idx)));
    expect(out.indexOf('src/hot.ts')).toBeLessThan(out.indexOf('src/cold.ts'));

    // Churn flips to cold.ts; applyGitAnalysis swaps the GitMeta object,
    // which is the memo key — the map must rebuild.
    await applyChurn(idx, [['src/cold.ts', 25]]);
    out = text(await runSearchStructure({ query: 'handler' }, makeDeps(idx)));
    expect(out.indexOf('src/cold.ts')).toBeLessThan(out.indexOf('src/hot.ts'));
  });
});
