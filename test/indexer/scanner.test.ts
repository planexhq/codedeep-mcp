import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';

import { loadConfig } from '../../src/config.js';
import {
  compileExcludeMatcher,
  depthOf,
  detectLanguage,
  isBinaryByExtension,
  scanProject,
} from '../../src/indexer/scanner.js';
import type { ProbeConfig } from '../../src/types.js';
import { makeProjectDir, writeTree } from '../helpers.js';

interface ConfigOverrides {
  exclude?: string[];
  languages?: string[];
  maxFiles?: number;
  maxFileSize?: number;
}

function makeConfig(root: string, overrides: ConfigOverrides = {}): ProbeConfig {
  const base = loadConfig(root);
  return Object.freeze({
    projectRoot: base.projectRoot,
    exclude: Object.freeze(overrides.exclude ?? [...base.exclude]),
    languages: Object.freeze(overrides.languages ?? [...base.languages]),
    maxFiles: overrides.maxFiles ?? base.maxFiles,
    maxFileSize: overrides.maxFileSize ?? base.maxFileSize,
    cacheDir: base.cacheDir,
  }) as ProbeConfig;
}

describe('scanner helpers', () => {
  describe('detectLanguage', () => {
    it('maps known TypeScript/JavaScript/Python extensions', () => {
      expect(detectLanguage('a.ts')).toBe('typescript');
      expect(detectLanguage('a.tsx')).toBe('typescript');
      expect(detectLanguage('a.js')).toBe('javascript');
      expect(detectLanguage('a.jsx')).toBe('javascript');
      expect(detectLanguage('a.mjs')).toBe('javascript');
      expect(detectLanguage('a.cjs')).toBe('javascript');
      expect(detectLanguage('a.py')).toBe('python');
    });

    it('is case-insensitive on the extension', () => {
      expect(detectLanguage('Foo.TS')).toBe('typescript');
      expect(detectLanguage('Bar.PY')).toBe('python');
    });

    it('returns null for unknown or absent extensions', () => {
      expect(detectLanguage('a.go')).toBeNull();
      expect(detectLanguage('a.rs')).toBeNull();
      expect(detectLanguage('Makefile')).toBeNull();
      expect(detectLanguage('LICENSE')).toBeNull();
    });
  });

  describe('isBinaryByExtension', () => {
    it('returns true for known binary extensions', () => {
      expect(isBinaryByExtension('logo.png')).toBe(true);
      expect(isBinaryByExtension('font.woff2')).toBe(true);
      expect(isBinaryByExtension('archive.tar.gz')).toBe(true);
      expect(isBinaryByExtension('grammar.wasm')).toBe(true);
    });

    it('returns false for source files', () => {
      expect(isBinaryByExtension('a.ts')).toBe(false);
      expect(isBinaryByExtension('a.py')).toBe(false);
    });
  });

  describe('depthOf', () => {
    it('counts directory separators on a posix path', () => {
      expect(depthOf('a.ts')).toBe(0);
      expect(depthOf('src/a.ts')).toBe(1);
      expect(depthOf('src/sub/a.ts')).toBe(2);
    });
  });

  describe('compileExcludeMatcher', () => {
    it('returns false for everything when patterns is empty', () => {
      const m = compileExcludeMatcher([]);
      expect(m('anything')).toBe(false);
      expect(m('node_modules/x.js')).toBe(false);
    });

    it('treats a bare name as a directory at any depth', () => {
      const m = compileExcludeMatcher(['node_modules']);
      expect(m('node_modules/foo.js')).toBe(true);
      expect(m('node_modules/sub/dir/foo.js')).toBe(true);
      expect(m('packages/a/node_modules/x.js')).toBe(true);
      expect(m('src/index.ts')).toBe(false);
    });

    it('matches dotfile directory patterns (dot: true)', () => {
      const m = compileExcludeMatcher(['.git', '.next']);
      expect(m('.git/HEAD')).toBe(true);
      expect(m('.next/cache/foo.js')).toBe(true);
      expect(m('src/.foo.ts')).toBe(false);
    });

    it('treats a bare glob like *.min.js as anchored at any depth', () => {
      const m = compileExcludeMatcher(['*.min.js']);
      expect(m('vendor.min.js')).toBe(true);
      expect(m('public/js/app.min.js')).toBe(true);
      expect(m('src/a.js')).toBe(false);
    });

    it('honors slash-anchored globs (e.g., vendor/**)', () => {
      const m = compileExcludeMatcher(['vendor/**']);
      expect(m('vendor/foo.js')).toBe(true);
      expect(m('vendor/sub/bar.js')).toBe(true);
      expect(m('packages/a/vendor/x.js')).toBe(false);
    });
  });
});

describe('scanProject', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectDir('probe-scanner-test-');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('detects all configured language extensions', async () => {
    writeTree(root, {
      'a.ts': '',
      'b.tsx': '',
      'c.js': '',
      'd.jsx': '',
      'e.mjs': '',
      'f.cjs': '',
      'g.py': '',
    });
    const cfg = makeConfig(root);
    const files = await scanProject(cfg);

    const byPath = new Map(files.map((f) => [f.path, f.language]));
    expect(byPath.get('a.ts')).toBe('typescript');
    expect(byPath.get('b.tsx')).toBe('typescript');
    expect(byPath.get('c.js')).toBe('javascript');
    expect(byPath.get('d.jsx')).toBe('javascript');
    expect(byPath.get('e.mjs')).toBe('javascript');
    expect(byPath.get('f.cjs')).toBe('javascript');
    expect(byPath.get('g.py')).toBe('python');
    expect(files).toHaveLength(7);
  });

  it('skips files with no extension or unknown extension', async () => {
    writeTree(root, {
      'a.ts': '',
      'Makefile': '',
      'README': '',
      'main.go': '',
      'lib.rs': '',
    });
    const files = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('skips files with binary extensions', async () => {
    writeTree(root, {
      'a.ts': '',
      'logo.png': 'fake',
      'font.woff2': 'fake',
    });
    const files = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('skips files exceeding maxFileSize', async () => {
    writeTree(root, {
      'small.ts': 'x'.repeat(500),
      'big.ts': 'x'.repeat(2048),
    });
    const cfg = makeConfig(root, { maxFileSize: 1024 });
    const files = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['small.ts']);
  });

  it('respects the default node_modules exclude on deeply nested files', async () => {
    writeTree(root, {
      'src/index.ts': '',
      'node_modules/foo/bar.ts': '',
      'packages/a/node_modules/dep/x.ts': '',
    });
    const files = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path)).toEqual(['src/index.ts']);
  });

  it('respects the default *.min.js exclude at root and nested', async () => {
    writeTree(root, {
      'app.js': '',
      'app.min.js': '',
      'public/js/widget.min.js': '',
    });
    const files = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path).sort()).toEqual(['app.js']);
  });

  it('honors a user-supplied slash-anchored glob like vendor/**', async () => {
    writeTree(root, {
      'src/a.ts': '',
      'vendor/lib.ts': '',
      'vendor/sub/lib.ts': '',
    });
    const cfg = makeConfig(root, { exclude: ['vendor/**'] });
    const files = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('languages config filter drops files of other languages', async () => {
    writeTree(root, {
      'a.ts': '',
      'b.py': '',
      'c.js': '',
    });
    const cfg = makeConfig(root, { languages: ['typescript'] });
    const files = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('enforces maxFiles and emits a single warn', async () => {
    writeTree(root, {
      'a.ts': '',
      'b.ts': '',
      'c.ts': '',
      'd.ts': '',
      'e.ts': '',
    });
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    const cfg = makeConfig(root, { maxFiles: 2 });
    const files = await scanProject(cfg);

    expect(files).toHaveLength(2);
    const warnCalls = stderr.mock.calls.filter((c) =>
      String(c[0]).includes('maxFiles=2'),
    );
    expect(warnCalls).toHaveLength(1);

    stderr.mockRestore();
  });

  it('FileInfo.path uses forward slashes regardless of platform', async () => {
    writeTree(root, { 'src/sub/deep/a.ts': '' });
    const files = await scanProject(makeConfig(root));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/sub/deep/a.ts');
    expect(files[0].path).not.toContain('\\');
  });

  it('FileInfo.path is relative to projectRoot with no leading slash', async () => {
    writeTree(root, { 'src/a.ts': '' });
    const files = await scanProject(makeConfig(root));
    expect(files[0].path.startsWith('/')).toBe(false);
    expect(files[0].path.startsWith(sep)).toBe(false);
    expect(files[0].path).toBe('src/a.ts');
  });

  it('sorts shallow-first, then alphabetical within depth', async () => {
    writeTree(root, {
      'src/zoo.ts': '',
      'b.ts': '',
      'a.ts': '',
      'src/api/h.ts': '',
      'src/foo.ts': '',
    });
    const files = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path)).toEqual([
      'a.ts',
      'b.ts',
      'src/foo.ts',
      'src/zoo.ts',
      'src/api/h.ts',
    ]);
  });

  it('populates FileInfo from stat with symbolCount=0 and lastIndexed=0', async () => {
    writeTree(root, { 'a.ts': 'hello' });
    const files = await scanProject(makeConfig(root));
    expect(files).toHaveLength(1);
    const f = files[0];
    expect(f.symbolCount).toBe(0);
    expect(f.lastIndexed).toBe(0);
    expect(f.size).toBe(5);
    expect(typeof f.lastModified).toBe('number');
    expect(f.lastModified).toBeGreaterThan(0);
    expect(f.language).toBe('typescript');
  });

  it('returns empty array for an empty project', async () => {
    const files = await scanProject(makeConfig(root));
    expect(files).toEqual([]);
  });

  it('handles a single file at root', async () => {
    writeTree(root, { 'only.ts': '' });
    const files = await scanProject(makeConfig(root));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('only.ts');
  });

  it.skipIf(process.platform === 'win32')(
    'skips symlinks instead of following them',
    async () => {
      writeTree(root, { 'real.ts': 'export const x = 1;' });
      symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'));

      const files = await scanProject(makeConfig(root));
      expect(files.map((f) => f.path)).toEqual(['real.ts']);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'prunes excluded directories instead of traversing them',
    async () => {
      writeTree(root, {
        'src/a.ts': '',
        'node_modules/foo.ts': '',
      });
      const blocked = join(root, 'node_modules');
      const originalMode = statSync(blocked).mode;
      chmodSync(blocked, 0o000);
      const stderr = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);

      try {
        const files = await scanProject(makeConfig(root));
        expect(files.map((f) => f.path)).toEqual(['src/a.ts']);

        const readdirFailures = stderr.mock.calls.filter((c) => {
          const s = String(c[0]);
          return s.includes('readdir failed') && s.includes('node_modules');
        });
        expect(readdirFailures).toHaveLength(0);
      } finally {
        chmodSync(blocked, originalMode);
        stderr.mockRestore();
      }
    },
  );
});
