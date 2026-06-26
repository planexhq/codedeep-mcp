import { rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { runOverview, type OverviewDeps } from '../../src/tools/overview.js';
import {
  makeConfig,
  makeFileInfo,
  makeGitStub,
  makeProjectDir,
  mkGitMeta,
  mkRef,
  mkSym,
  silenceStderr,
  writeTree,
} from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('codedeep-overview-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(
  index: CodeIndex,
  ready = true,
  git: OverviewDeps['git'] = makeGitStub(),
): OverviewDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot),
    git,
  };
}

function entryBullets(text: string): string[] {
  const section = text.split('### Entry Points')[1].split('### Symbols')[0];
  return section
    .trim()
    .split('\n')
    .filter((l) => l.startsWith('- '));
}

describe('runOverview — basic rendering', () => {
  it('renders header, languages with percentages, structure, and totals', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/api/a.ts'),
      [
        mkSym({ name: 'foo', file: 'src/api/a.ts', kind: 'function' }),
        mkSym({ name: 'Bar', file: 'src/api/a.ts', kind: 'class' }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/api/b.ts'),
      [mkSym({ name: 'baz', file: 'src/api/b.ts', kind: 'function' })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('python', 'pkg/main.py'),
      [
        mkSym({
          name: 'main',
          file: 'pkg/main.py',
          kind: 'function',
          language: 'python',
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain(`## Project: ${basename(tmpRoot)}`);
    expect(text).toContain('### Languages');
    expect(text).toContain('- TypeScript: 2 files (67%)');
    expect(text).toContain('- Python: 1 file (33%)');
    expect(text).toContain('### Structure');
    expect(text).toContain('- src/api/ — 2 files (2 functions, 1 class)');
    expect(text).toContain('- pkg/ — 1 file (1 function)');
    expect(text).toContain('### Symbols');
    expect(text).toContain('- 3 functions, 1 class');
    expect(text).toContain('- 3 files indexed, 4 total symbols');
  });

  it('tallies and pluralizes enum symbols', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/status.ts'),
      [
        mkSym({ name: 'HttpStatus', file: 'src/status.ts', kind: 'enum' }),
        mkSym({ name: 'Method', file: 'src/status.ts', kind: 'enum' }),
        mkSym({ name: 'parse', file: 'src/status.ts', kind: 'function' }),
      ],
      [],
      [],
    );

    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    expect(text).toContain('- 2 enums, 1 function');
    expect(text).toContain('- src/ — 1 file (2 enums, 1 function)');
  });

  it("excludes 'unknown' files from language percentages and reports them in Other files", async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );
    idx.addFile(makeFileInfo('python', 'pkg/main.py'), [], [], []);
    idx.addFile(makeFileInfo('unknown', 'README.md'), [], [], []);
    idx.addFile(makeFileInfo('unknown', 'package.json'), [], [], []);
    idx.addFile(makeFileInfo('unknown', 'pnpm-lock.yaml'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    // % computed over recognized files only (1 ts + 1 py = 2 source files).
    expect(text).toContain('- TypeScript: 1 file (50%)');
    expect(text).toContain('- Python: 1 file (50%)');
    expect(text).not.toMatch(/Unknown:/);

    expect(text).toContain('### Other files');
    expect(text).toMatch(/- 3 files not parsed \(.+\)/);
    expect(text).toContain('.md');
    expect(text).toContain('.json');
    expect(text).toContain('.yaml');
  });

  it('omits the Other files section when no unknown-language files exist', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).not.toContain('### Other files');
  });

  it("renders '(no source files indexed)' when only unknown files exist", async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('unknown', 'README.md'), [], [], []);
    idx.addFile(makeFileInfo('unknown', 'LICENSE'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- (no source files indexed)');
    expect(text).toContain('### Other files');
    expect(text).toMatch(/- 2 files not parsed/);
    expect(text).toContain('(no ext)');
  });

  it('uses singular forms when counts are 1', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/only.ts'),
      [mkSym({ name: 'foo', file: 'src/only.ts' })],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- TypeScript: 1 file (100%)');
    expect(text).toContain('- 1 file indexed, 1 total symbol');
  });

  it('lists entry-named files alone when they have no exports', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/index.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('### Entry Points');
    expect(text).toMatch(/^- src\/index\.ts$/m);
  });

  it('treats entry-named files with only non-exported symbols as having no exports', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/index.ts'),
      [
        mkSym({ name: 'helper', file: 'src/index.ts', exported: false }),
        mkSym({ name: 'internal', file: 'src/index.ts', exported: false }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toMatch(/^- src\/index\.ts$/m);
    expect(text).not.toContain('exports 2');
  });

  it('annotates entry-named files with a single exported symbol', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/index.ts'),
      [
        mkSym({
          name: 'startServer',
          file: 'src/index.ts',
          kind: 'function',
          exported: true,
          startLine: 12,
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('### Entry Points');
    expect(text).toContain('- src/index.ts:12 — startServer');
  });

  it('summarises entry-named files with multiple exports as one slot', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/index.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/index.ts',
          kind: 'function',
          exported: true,
          startLine: 5,
        }),
        mkSym({
          name: 'bar',
          file: 'src/index.ts',
          kind: 'function',
          exported: true,
          startLine: 10,
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- src/index.ts — exports 2 symbols');
    const matches = text.match(/src\/index\.ts/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('treats server, app, and cli files as entry points', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/server.ts'), [], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/app.ts'), [], [], []);
    idx.addFile(makeFileInfo('javascript', 'cli.js'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toMatch(/^- src\/app\.ts$/m);
    expect(text).toMatch(/^- src\/server\.ts$/m);
    expect(text).toMatch(/^- cli\.js$/m);
  });

  it('counts only top-level exports, not inherited class members', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/index.ts'),
      [
        mkSym({
          name: 'App',
          file: 'src/index.ts',
          kind: 'class',
          exported: true,
          startLine: 1,
        }),
        mkSym({
          name: 'start',
          file: 'src/index.ts',
          kind: 'method',
          exported: true,
          startLine: 2,
          parent: 'App',
        }),
        mkSym({
          name: 'stop',
          file: 'src/index.ts',
          kind: 'method',
          exported: true,
          startLine: 3,
          parent: 'App',
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- src/index.ts:1 — App');
    expect(text).not.toContain('exports ');
  });

  it('keeps high-priority entry files when barrel markers saturate the cap', async () => {
    const idx = new CodeIndex(tmpRoot);
    for (let i = 0; i < 15; i++) {
      idx.addFile(
        makeFileInfo('typescript', `packages/pkg${i}/index.ts`),
        [],
        [],
        [],
      );
    }
    idx.addFile(makeFileInfo('typescript', 'src/server.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    const bullets = entryBullets(text);
    expect(bullets.length).toBe(15);
    expect(bullets[0]).toMatch(/^- src\/server\.ts(\s|:|$)/);
  });

  it('keeps shallow non-barrel entry over deeper non-barrels at the cap', async () => {
    const idx = new CodeIndex(tmpRoot);
    for (let i = 0; i < 15; i++) {
      idx.addFile(
        makeFileInfo('typescript', `packages/pkg${i}/server.ts`),
        [],
        [],
        [],
      );
    }
    idx.addFile(makeFileInfo('typescript', 'src/server.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const bullets = entryBullets(result.content[0].text);

    expect(bullets.length).toBe(15);
    expect(bullets[0]).toMatch(/^- src\/server\.ts(\s|:|$)/);
  });
});

describe('runOverview — empty index', () => {
  it('returns a non-crashing message when no files are indexed', async () => {
    const idx = new CodeIndex(tmpRoot);
    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('### Languages');
    expect(text).toContain('- (no files indexed)');
    expect(text).toContain('### Structure');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('- (none detected)');
    expect(text).toContain('- 0 files indexed, 0 total symbols');
  });
});

describe('runOverview — readiness flag', () => {
  it('prepends the ⏳ note when indexer is not ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx, false));
    const text = result.content[0].text;

    expect(text.startsWith('⏳ Indexing in progress.')).toBe(true);
    expect(text).toContain('## Project:');
  });

  it('omits the ⏳ note when indexer is ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx, true));
    const text = result.content[0].text;

    expect(text.startsWith('## Project:')).toBe(true);
    expect(text).not.toContain('⏳');
  });
});

describe('runOverview — path arg', () => {
  it('returns an in-band error when path arg differs from configured root', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runOverview(
      { path: '/some/other/place' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text.startsWith('Error:')).toBe(true);
    expect(text).toMatch(/does not match configured project root/);
    expect(text).not.toContain('## Project:');
  });
});

describe('runOverview — package.json entry points', () => {
  it('includes package.json main if the resolved path is indexed', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: './lib/entry.js' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('javascript', 'lib/entry.js'),
      [],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- lib/entry.js');
  });

  it('skips package.json main when the path is not indexed', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: 'dist/index.js' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/x.ts'),
      [],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).not.toContain('dist/index.js');
  });

  it('includes bin string and bin object values', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({
        bin: { foo: './lib/foo.js', bar: 'lib/bar.js' },
      }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('javascript', 'lib/foo.js'), [], [], []);
    idx.addFile(makeFileInfo('javascript', 'lib/bar.js'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- lib/foo.js');
    expect(text).toContain('- lib/bar.js');
  });

  it('does not duplicate when filename match and package.json point to the same file', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: 'src/index.ts' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/index.ts'),
      [
        mkSym({
          name: 'run',
          file: 'src/index.ts',
          kind: 'function',
          exported: true,
          startLine: 7,
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    const matches = text.match(/src\/index\.ts/g) ?? [];
    expect(matches.length).toBe(1);
    expect(text).toContain('- src/index.ts:7 — run');
  });

  it('ignores malformed package.json without crashing', async () => {
    silenceStderr();
    writeFileSync(join(tmpRoot, 'package.json'), '{ not valid json', 'utf8');

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('## Project:');
    expect(text).toContain('### Symbols');
  });

  it('keeps package.json entries when heuristic matches saturate the cap', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: 'lib/authoritative.js' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('javascript', 'lib/authoritative.js'), [], [], []);
    for (let i = 0; i < 15; i++) {
      idx.addFile(makeFileInfo('javascript', `pkg${i}/index.js`), [], [], []);
    }

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- lib/authoritative.js');
    const bullets = entryBullets(text);
    expect(bullets.length).toBe(15);
  });

  it('resolves extensionless package.json main against indexed source', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: 'lib/entry' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('javascript', 'lib/entry.js'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- lib/entry.js');
  });

  it('resolves directory-style package.json main to its index file', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: 'lib' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('javascript', 'lib/index.js'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- lib/index.js');
  });

  it('resolves "." package.json main to root index file', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: '.' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('javascript', 'index.js'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- index.js');
  });
});

describe('runOverview — package.json exports field', () => {
  it('reads exports as a string', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ exports: './src/client.ts' }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/client.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- src/client.ts');
  });

  it('reads exports subpath object', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ exports: { '.': './src/client.ts' } }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/client.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- src/client.ts');
  });

  it('reads exports with conditional entries', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({
        exports: {
          '.': { import: './esm/index.js', require: './cjs/index.js' },
        },
      }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('javascript', 'esm/index.js'), [], [], []);
    idx.addFile(makeFileInfo('javascript', 'cjs/index.js'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;
    expect(text).toContain('- esm/index.js');
    expect(text).toContain('- cjs/index.js');
  });

  it('skips types condition pointing to .d.ts', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({
        exports: {
          '.': {
            types: './dist/index.d.ts',
            import: './src/index.ts',
          },
        },
      }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'dist/index.d.ts'), [], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/index.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;
    expect(text).toContain('- src/index.ts');
    expect(text).not.toContain('dist/index.d.ts');
  });

  it('reads exports when main is absent', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ exports: { '.': './src/api.ts' } }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/api.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- src/api.ts');
  });

  it('does not duplicate when exports and main point to same file', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({
        main: './src/index.ts',
        exports: { '.': './src/index.ts' },
      }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/index.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;
    const matches = text.match(/src\/index\.ts/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does not surface package.json itself when exports self-reference it', async () => {
    // Common Node pattern: `"./package.json": "./package.json"` lets
    // consumers `require('pkg/package.json')`. The resolver must not
    // match package.json against itself and list it as an entry point.
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({
        main: './src/index.ts',
        exports: {
          '.': './src/index.ts',
          './package.json': './package.json',
        },
      }),
      'utf8',
    );
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('unknown', 'package.json'), [], [], []);
    idx.addFile(makeFileInfo('typescript', 'src/index.ts'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const bullets = entryBullets(result.content[0].text);
    expect(bullets.some((b) => b.includes('package.json'))).toBe(false);
    expect(bullets.some((b) => b.includes('src/index.ts'))).toBe(true);
  });
});

describe('runOverview — Python entry points', () => {
  it('detects Python files with __main__ guard', async () => {
    writeFileSync(
      join(tmpRoot, 'manage.py'),
      'import sys\n\ndef main():\n    pass\n\nif __name__ == "__main__":\n    main()\n',
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('python', 'manage.py'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- manage.py');
  });

  it('does not flag Python files without a main guard', async () => {
    writeFileSync(
      join(tmpRoot, 'helpers.py'),
      'def helper():\n    pass\n',
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('python', 'helpers.py'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const bullets = entryBullets(result.content[0].text);
    expect(bullets.some((b) => b.includes('helpers.py'))).toBe(false);
  });

  it('does not double-count when a Python file matches both filename and main guard', async () => {
    writeFileSync(
      join(tmpRoot, 'app.py'),
      'if __name__ == "__main__":\n    pass\n',
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('python', 'app.py'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const text = result.content[0].text;
    const matches = text.match(/app\.py/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('ignores indented (non-module-level) main guards', async () => {
    writeFileSync(
      join(tmpRoot, 'nested.py'),
      'def wrapper():\n    if __name__ == "__main__":\n        pass\n',
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('python', 'nested.py'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    const bullets = entryBullets(result.content[0].text);
    expect(bullets.some((b) => b.includes('nested.py'))).toBe(false);
  });

  it('finds shallow main-guard files even when index order puts them late', async () => {
    // Simulates post-incremental-reindex Map order: deeper Python files
    // were inserted first; the root manage.py was updated and re-added
    // last. Without shallow-first sorting, the cap would skip it.
    const tree: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      tree[`lib/m${i}.py`] = '# no guard\n';
    }
    tree['manage.py'] = 'if __name__ == "__main__":\n    pass\n';
    writeTree(tmpRoot, tree);

    const idx = new CodeIndex(tmpRoot);
    for (let i = 0; i < 100; i++) {
      idx.addFile(makeFileInfo('python', `lib/m${i}.py`), [], [], []);
    }
    idx.addFile(makeFileInfo('python', 'manage.py'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- manage.py');
  });

  it('finds Python main-guard files when 15+ __init__.py files saturate the cap', async () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 15; i++) {
      tree[`pkg${i}/__init__.py`] = '# barrel\n';
    }
    tree['manage.py'] = 'if __name__ == "__main__":\n    pass\n';
    writeTree(tmpRoot, tree);

    const idx = new CodeIndex(tmpRoot);
    for (let i = 0; i < 15; i++) {
      idx.addFile(makeFileInfo('python', `pkg${i}/__init__.py`), [], [], []);
    }
    idx.addFile(makeFileInfo('python', 'manage.py'), [], [], []);

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- manage.py');
  });
});

describe('runOverview — exported-symbol fallback', () => {
  it('surfaces files with exports when no other tier matches', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/client.ts'),
      [
        mkSym({
          name: 'Client',
          file: 'src/client.ts',
          kind: 'class',
          exported: true,
          startLine: 5,
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- src/client.ts:5 — Client');
  });

  it('ranks files by top-level export count, alphabetical on tie', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/few.ts'),
      [mkSym({ name: 'one', file: 'src/few.ts', exported: true })],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/many.ts'),
      [
        mkSym({ name: 'a', file: 'src/many.ts', exported: true }),
        mkSym({ name: 'b', file: 'src/many.ts', exported: true }),
        mkSym({ name: 'c', file: 'src/many.ts', exported: true }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const bullets = entryBullets(result.content[0].text);
    const manyIdx = bullets.findIndex((b) => b.includes('src/many.ts'));
    const fewIdx = bullets.findIndex((b) => b.includes('src/few.ts'));
    expect(manyIdx).toBeGreaterThanOrEqual(0);
    expect(fewIdx).toBeGreaterThanOrEqual(0);
    expect(manyIdx).toBeLessThan(fewIdx);
  });

  it('skips files with no top-level exports', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/internal.ts'),
      [mkSym({ name: 'helper', file: 'src/internal.ts', exported: false })],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    expect(result.content[0].text).toContain('- (none detected)');
  });

  it('does not count class members toward the export ranking', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/one-class.ts'),
      [
        mkSym({
          name: 'App',
          file: 'src/one-class.ts',
          kind: 'class',
          exported: true,
          startLine: 1,
        }),
        mkSym({
          name: 'start',
          file: 'src/one-class.ts',
          kind: 'method',
          exported: true,
          parent: 'App',
        }),
        mkSym({
          name: 'stop',
          file: 'src/one-class.ts',
          kind: 'method',
          exported: true,
          parent: 'App',
        }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/two-funcs.ts'),
      [
        mkSym({ name: 'a', file: 'src/two-funcs.ts', exported: true }),
        mkSym({ name: 'b', file: 'src/two-funcs.ts', exported: true }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const bullets = entryBullets(result.content[0].text);
    const twoIdx = bullets.findIndex((b) => b.includes('src/two-funcs.ts'));
    const oneIdx = bullets.findIndex((b) => b.includes('src/one-class.ts'));
    expect(twoIdx).toBeLessThan(oneIdx);
  });

  it('does not duplicate entries already added by other tiers', async () => {
    writeFileSync(
      join(tmpRoot, 'package.json'),
      JSON.stringify({ main: 'src/index.ts' }),
      'utf8',
    );

    const idx = new CodeIndex(tmpRoot);
    idx.addFile(
      makeFileInfo('typescript', 'src/index.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/index.ts',
          exported: true,
          startLine: 3,
        }),
        mkSym({
          name: 'bar',
          file: 'src/index.ts',
          exported: true,
          startLine: 7,
        }),
      ],
      [],
      [],
    );

    const result = await runOverview({}, makeDeps(idx));
    const matches = result.content[0].text.match(/src\/index\.ts/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('runOverview — git sections', () => {
  async function applyHotspots(
    idx: CodeIndex,
    entries: Array<[string, number]>,
  ): Promise<void> {
    for (const [path] of entries) {
      idx.addFile(makeFileInfo('typescript', path), [], [], []);
    }
    await idx.applyGitAnalysis({
      counts: new Map(entries),
      cochanges: new Map(),
      hotspots: entries.map(([p]) => p),
      meta: mkGitMeta(),
    });
  }

  it('renders the branch line with ahead count and changed files', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);
    const git = makeGitStub({
      branchSummary: async () => ({
        branch: 'feature/git-enrichment',
        defaultBranch: 'main',
        ahead: 3,
        changedFiles: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
      }),
    });
    const text = (await runOverview({}, makeDeps(idx, true, git))).content[0].text;

    expect(text).toContain('### Branch [behavioral]');
    expect(text).toContain(
      '- feature/git-enrichment — 3 commits ahead of main, 7 files changed on branch',
    );
  });

  it('renders "(default branch)" when on the default branch', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);
    const git = makeGitStub({
      branchSummary: async () => ({
        branch: 'main',
        defaultBranch: 'main',
        ahead: 0,
        changedFiles: [],
      }),
    });
    const text = (await runOverview({}, makeDeps(idx, true, git))).content[0].text;
    expect(text).toContain('- main (default branch)');
  });

  it('renders the bare branch name when no default branch resolves', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);
    const git = makeGitStub({
      branchSummary: async () => ({
        branch: 'trunk',
        defaultBranch: null,
        ahead: null,
        changedFiles: null,
      }),
    });
    const text = (await runOverview({}, makeDeps(idx, true, git))).content[0].text;
    expect(text).toContain('### Branch [behavioral]');
    expect(text).toContain('- trunk');
    expect(text).not.toContain('ahead of');
  });

  it('renders top-10 hotspots with window label and commit counts, strongest first', async () => {
    const idx = new CodeIndex(tmpRoot);
    const entries: Array<[string, number]> = [];
    for (let i = 0; i < 11; i++) {
      entries.push([`src/f${String(i).padStart(2, '0')}.ts`, 30 - i]);
    }
    await applyHotspots(idx, entries);
    const text = (await runOverview({}, makeDeps(idx))).content[0].text;

    expect(text).toContain('### Hotspots (last 180 days) [behavioral]');
    expect(text).toContain('- src/f00.ts — 30 commits');
    expect(text).toContain('- src/f09.ts — 21 commits');
    expect(text).not.toContain('src/f10.ts'); // 11th hotspot clipped at 10
    const f0 = text.indexOf('src/f00.ts');
    const f9 = text.indexOf('src/f09.ts');
    expect(f0).toBeGreaterThan(-1);
    expect(f0).toBeLessThan(f9);
  });

  it('singular commit count renders without the plural s', async () => {
    const idx = new CodeIndex(tmpRoot);
    await applyHotspots(idx, [['src/once.ts', 1]]);
    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    expect(text).toContain('- src/once.ts — 1 commit');
    expect(text).not.toContain('1 commits');
  });

  it('omits both git sections entirely outside git repos', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);
    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    expect(text).not.toContain('### Branch');
    expect(text).not.toContain('Hotspots');
    expect(text).not.toContain('[behavioral]');
  });

  it('renders the Risk Hotspots section ranked by churn × coupling, offender named', async () => {
    const idx = new CodeIndex(tmpRoot);
    // hub.ts: a 5-caller hub with high churn. cold.ts: a 5-caller hub with low
    // churn. The product ranks hub.ts first and names the offending symbol.
    const seedHub = (file: string, hubName: string) => {
      const hub = mkSym({ name: hubName, file, startLine: 1 });
      const callers = Array.from({ length: 5 }, (_, i) =>
        mkSym({ name: `${hubName}_c${i}`, file, startLine: 10 + i }),
      );
      idx.addFile(
        makeFileInfo('typescript', file),
        [hub, ...callers],
        callers.map((c) => mkRef(c, hub)),
        [],
      );
    };
    seedHub('src/hub.ts', 'hub');
    seedHub('src/cold.ts', 'coldhub');
    await idx.applyGitAnalysis({
      counts: new Map([
        ['src/hub.ts', 50],
        ['src/cold.ts', 1],
      ]),
      cochanges: new Map(),
      hotspots: ['src/hub.ts', 'src/cold.ts'],
      meta: mkGitMeta(),
    });

    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    expect(text).toContain('### Risk Hotspots (churn × coupling × complexity) [behavioral]');
    expect(text).toContain(
      '- src/hub.ts — hub — 50 commits × 5 references (blast radius 5 across 1 file)',
    );
    // Scope ordering to the risk section — 'src/hub.ts —' also appears in the
    // earlier plain Hotspots section, so an unscoped indexOf would test nothing.
    const riskSection = text.slice(text.indexOf('### Risk Hotspots'));
    expect(riskSection.indexOf('src/hub.ts —')).toBeLessThan(
      riskSection.indexOf('src/cold.ts —'),
    );
    // Trivial offenders → no complexity segment appended to the rows, and no
    // dangling separator after the blast clause (the omit-when-null guard).
    expect(riskSection).not.toContain('— cyc');
    expect(riskSection).not.toContain('— cog');
    expect(riskSection).not.toContain('1 file) — ');
  });

  // Seed one churny 5-caller hub whose offender carries the given complexity,
  // then render the overview. Returns the rendered text.
  async function renderHubWithComplexity(cx: {
    complexity?: number;
    cognitiveComplexity?: number;
  }): Promise<string> {
    const idx = new CodeIndex(tmpRoot);
    const hub = mkSym({ name: 'hub', file: 'src/hub.ts', startLine: 1, ...cx });
    const callers = Array.from({ length: 5 }, (_, i) =>
      mkSym({ name: `c${i}`, file: 'src/hub.ts', startLine: 10 + i }),
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/hub.ts'),
      [hub, ...callers],
      callers.map((c) => mkRef(c, hub)),
      [],
    );
    await idx.applyGitAnalysis({
      counts: new Map([['src/hub.ts', 50]]),
      cochanges: new Map(),
      hotspots: ['src/hub.ts'],
      meta: mkGitMeta(),
    });
    return (await runOverview({}, makeDeps(idx))).content[0].text;
  }

  it('appends the offender complexity (cyc + cog) to a Risk Hotspots row', async () => {
    const text = await renderHubWithComplexity({ complexity: 4, cognitiveComplexity: 6 });
    expect(text).toContain('### Risk Hotspots (churn × coupling × complexity) [behavioral]');
    expect(text).toContain('(blast radius 5 across 1 file) — cyc 4 / cog 6');
  });

  it('appends cognitive only when cyclomatic is absent', async () => {
    const text = await renderHubWithComplexity({ cognitiveComplexity: 6 });
    expect(text).toContain('(blast radius 5 across 1 file) — cog 6');
    expect(text.slice(text.indexOf('### Risk Hotspots'))).not.toContain('cyc');
  });

  it('appends cyclomatic only when cognitive is absent', async () => {
    const text = await renderHubWithComplexity({ complexity: 4 });
    expect(text).toContain('(blast radius 5 across 1 file) — cyc 4');
    expect(text.slice(text.indexOf('### Risk Hotspots'))).not.toContain('cog');
  });

  it('appends no [structural] tag to the risk row (the [behavioral] heading covers it)', async () => {
    const text = await renderHubWithComplexity({ complexity: 4, cognitiveComplexity: 6 });
    expect(text.slice(text.indexOf('### Risk Hotspots'))).not.toContain('[structural]');
  });

  it('Risk Hotspots order is the churn×coupling score, not the plain churn order', async () => {
    const idx = new CodeIndex(tmpRoot);
    const seedHub = (file: string, hubName: string, callerCount: number) => {
      const hub = mkSym({ name: hubName, file, startLine: 1 });
      const callers = Array.from({ length: callerCount }, (_, i) =>
        mkSym({ name: `${hubName}_c${i}`, file, startLine: 10 + i }),
      );
      idx.addFile(
        makeFileInfo('typescript', file),
        [hub, ...callers],
        callers.map((c) => mkRef(c, hub)),
        [],
      );
    };
    // cold.ts has MORE commits (leads the plain Hotspots section) but FEWER
    // callers; churn×coupling must still rank hub.ts first in Risk Hotspots —
    // so the two sections disagree and the assertion can't be satisfied by Hotspots.
    seedHub('src/hub.ts', 'hub', 20);
    seedHub('src/cold.ts', 'coldhub', 1);
    await idx.applyGitAnalysis({
      counts: new Map([['src/hub.ts', 10], ['src/cold.ts', 40]]),
      cochanges: new Map(),
      // Hotspots render in churn order (cold leads) — as the analyzer produces.
      hotspots: ['src/cold.ts', 'src/hub.ts'],
      meta: mkGitMeta(),
    });

    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    // Plain Hotspots: cold.ts (40 commits) leads hub.ts (10).
    const hotspots = text.slice(text.indexOf('### Hotspots'), text.indexOf('### Risk Hotspots'));
    expect(hotspots.indexOf('src/cold.ts')).toBeLessThan(hotspots.indexOf('src/hub.ts'));
    // Risk: log1p(10)*log1p(20) ≈ 7.18 > log1p(40)*log1p(1) ≈ 2.56 → hub.ts leads.
    const risk = text.slice(text.indexOf('### Risk Hotspots'));
    expect(risk.indexOf('src/hub.ts —')).toBeLessThan(risk.indexOf('src/cold.ts —'));
  });

  it('omits the Risk Hotspots section outside git repos', async () => {
    const idx = new CodeIndex(tmpRoot);
    const hub = mkSym({ name: 'hub', file: 'src/a.ts', startLine: 1 });
    const caller = mkSym({ name: 'caller', file: 'src/a.ts', startLine: 2 });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [hub, caller],
      [mkRef(caller, hub)],
      [],
    );
    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    expect(text).not.toContain('Risk Hotspots');
  });

  it('a rejecting branchSummary never breaks the response', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);
    const git = makeGitStub({
      branchSummary: async () => {
        throw new Error('boom');
      },
    });
    const text = (await runOverview({}, makeDeps(idx, true, git))).content[0].text;
    expect(text).toContain('## Project:');
    expect(text).not.toContain('### Branch');
    expect(text).not.toContain('Error:');
  });
});

describe('runOverview — hotspot window label provenance', () => {
  it('labels hotspots with the window that produced the data, not the live config', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/a.ts'), [], [], []);
    await idx.applyGitAnalysis({
      counts: new Map([['src/a.ts', 4]]),
      cochanges: new Map(),
      hotspots: ['src/a.ts'],
      // Persisted analysis ran with a 90-day window; config now says 180.
      meta: mkGitMeta({ windowDays: 90 }),
    });
    const text = (await runOverview({}, makeDeps(idx))).content[0].text;
    expect(text).toContain('### Hotspots (last 90 days) [behavioral]');
    expect(text).not.toContain('last 180 days');
  });
});
