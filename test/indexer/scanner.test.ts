import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import {
  compileExcludeMatcher,
  depthOf,
  detectLanguage,
  isBinaryByContent,
  isBinaryByExtension,
  refineHeaderLanguage,
  scanProject,
  toPosix,
} from '../../src/indexer/scanner.js';
import {
  makeConfig,
  makeProjectDir,
  silenceStderr,
  skipOnWindows,
  withChmod,
  writeTree,
} from '../helpers.js';

describe('scanner helpers', () => {
  describe('detectLanguage', () => {
    it('maps known TypeScript/JavaScript/Python extensions', () => {
      expect(detectLanguage('a.ts')).toBe('typescript');
      expect(detectLanguage('a.tsx')).toBe('tsx');
      expect(detectLanguage('a.js')).toBe('javascript');
      expect(detectLanguage('a.jsx')).toBe('javascript');
      expect(detectLanguage('a.mjs')).toBe('javascript');
      expect(detectLanguage('a.cjs')).toBe('javascript');
      expect(detectLanguage('a.py')).toBe('python');
    });

    it('maps C++ source and header extensions to cpp (incl. ambiguous .h)', () => {
      expect(detectLanguage('main.cpp')).toBe('cpp');
      expect(detectLanguage('a.cc')).toBe('cpp');
      expect(detectLanguage('a.cxx')).toBe('cpp');
      expect(detectLanguage('a.hpp')).toBe('cpp');
      expect(detectLanguage('a.hh')).toBe('cpp');
      expect(detectLanguage('a.hxx')).toBe('cpp');
      expect(detectLanguage('a.ipp')).toBe('cpp');
      expect(detectLanguage('a.tpp')).toBe('cpp');
      expect(detectLanguage('greeter.h')).toBe('cpp');
    });

    it('maps the .c source extension to c (its own grammar; .h stays cpp)', () => {
      expect(detectLanguage('util.c')).toBe('c');
      expect(detectLanguage('a.c')).toBe('c');
    });

    it('maps the Objective-C .m extension to objc; .mm (ObjC++) stays unmapped', () => {
      expect(detectLanguage('main.m')).toBe('objc');
      expect(detectLanguage('AppDelegate.m')).toBe('objc');
      expect(detectLanguage('View.mm')).toBeNull();
    });

    it('is case-insensitive on the extension', () => {
      expect(detectLanguage('Foo.TS')).toBe('typescript');
      expect(detectLanguage('Bar.PY')).toBe('python');
      expect(detectLanguage('Main.GO')).toBe('go');
      expect(detectLanguage('Widget.HPP')).toBe('cpp');
    });

    it('returns null for unknown or absent extensions', () => {
      expect(detectLanguage('a.xyz')).toBeNull();
      expect(detectLanguage('Makefile')).toBeNull();
      expect(detectLanguage('LICENSE')).toBeNull();
    });
  });

  describe('isBinaryByContent', () => {
    let root: string;

    beforeEach(() => {
      root = makeProjectDir('probe-isbinary-test-');
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('returns true when the first 8KB contains a null byte', async () => {
      const buf = Buffer.from('hello\0world');
      writeFileSync(join(root, 'fake.bin'), buf);
      expect(await isBinaryByContent(join(root, 'fake.bin'))).toBe(true);
    });

    it('returns false for plain UTF-8 text', async () => {
      writeFileSync(join(root, 'plain.txt'), 'hello world\n');
      expect(await isBinaryByContent(join(root, 'plain.txt'))).toBe(false);
    });

    it('returns false for an empty file', async () => {
      writeFileSync(join(root, 'empty.txt'), '');
      expect(await isBinaryByContent(join(root, 'empty.txt'))).toBe(false);
    });

    it('only inspects the first 8KB; null bytes past the prefix are ignored', async () => {
      const head = Buffer.alloc(8192, 0x61); // 8KB of 'a'
      const tail = Buffer.from([0]);
      writeFileSync(join(root, 'late-null.txt'), Buffer.concat([head, tail]));
      expect(await isBinaryByContent(join(root, 'late-null.txt'))).toBe(false);
    });
  });

  describe('refineHeaderLanguage (.h content-sniff)', () => {
    let root: string;
    const OBJC_ENABLED = new Set(['cpp', 'objc']);

    beforeEach(() => {
      root = makeProjectDir('probe-objc-sniff-test-');
    });
    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const sniff = async (content: string, lang = 'cpp', langSet = OBJC_ENABLED) => {
      const p = join(root, 'header.h');
      writeFileSync(p, content);
      return refineHeaderLanguage(p, lang, langSet);
    };

    it('routes an ObjC header (#import / @interface / NS_ASSUME_NONNULL) to objc', async () => {
      expect(await sniff('#import <Foundation/Foundation.h>\n@interface C : NSObject\n@end\n')).toBe('objc');
      expect(await sniff('@protocol P\n- (void)x;\n@end\n')).toBe('objc');
      expect(await sniff('NS_ASSUME_NONNULL_BEGIN\n@interface C\n@end\nNS_ASSUME_NONNULL_END\n')).toBe('objc');
      expect(await sniff('typedef NS_ENUM(NSInteger, E) { A, B };\n')).toBe('objc');
    });

    it('keeps a C++ header as cpp (the critical mixed-repo regression)', async () => {
      expect(await sniff('#pragma once\nnamespace ns { template <class T> class Box {}; }\n')).toBe('cpp');
      expect(await sniff('#include <vector>\nclass Foo { public: int bar(); };\n')).toBe('cpp');
      expect(await sniff('#include "util.h"\nstruct Point { int x, y; };\n')).toBe('cpp');
    });

    it('is not fooled by ObjC markers in comments or strings, or by C++23 `import std;`', async () => {
      expect(await sniff('// @interface is documented here\nclass Foo {};\n')).toBe('cpp');
      expect(await sniff('const char *s = "#import not real";\nclass Foo {};\n')).toBe('cpp');
      expect(await sniff('import std;\nint main() { return 0; }\n')).toBe('cpp');
      // a NS_ASSUME_NONNULL_* mention in a comment must not flip the header.
      expect(await sniff('// guarded by NS_ASSUME_NONNULL_BEGIN elsewhere\nclass Foo {};\n')).toBe('cpp');
    });

    it('only sniffs the ambiguous .h extension; unambiguous .cpp/.hpp stay cpp even with markers', async () => {
      // The sniff must not pay the read (or risk a misroute) on unambiguous C++ files.
      const objcLike = '#import <Foundation/Foundation.h>\n@interface C\n@end\n';
      for (const ext of ['cc', 'cpp', 'hpp', 'hh', 'cxx']) {
        const p = join(root, `file.${ext}`);
        writeFileSync(p, objcLike);
        expect(await refineHeaderLanguage(p, 'cpp', OBJC_ENABLED)).toBe('cpp');
      }
    });

    it('does not flip when objc is not a configured language', async () => {
      const cppOnly = new Set(['cpp']);
      expect(await sniff('#import <Foundation/Foundation.h>\n@interface C\n@end\n', 'cpp', cppOnly)).toBe('cpp');
    });

    it('passes a non-cpp language through unchanged (only `.h`→cpp is ambiguous)', async () => {
      expect(await refineHeaderLanguage(join(root, 'x.swift'), 'swift', OBJC_ENABLED)).toBe('swift');
      expect(await refineHeaderLanguage(join(root, 'x.m'), 'objc', OBJC_ENABLED)).toBe('objc');
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

  describe('toPosix', () => {
    it('returns POSIX paths unchanged', () => {
      // The Windows branch (sep === '\\' → split/join) isn't exercisable
      // from POSIX without mocking node:path; this guards the export and
      // contract for the platform we're on.
      expect(toPosix('src/a.ts')).toBe('src/a.ts');
      expect(toPosix('a')).toBe('a');
      expect(toPosix('')).toBe('');
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
    const { files } = await scanProject(cfg);

    const byPath = new Map(files.map((f) => [f.path, f.language]));
    expect(byPath.get('a.ts')).toBe('typescript');
    expect(byPath.get('b.tsx')).toBe('tsx');
    expect(byPath.get('c.js')).toBe('javascript');
    expect(byPath.get('d.jsx')).toBe('javascript');
    expect(byPath.get('e.mjs')).toBe('javascript');
    expect(byPath.get('f.cjs')).toBe('javascript');
    expect(byPath.get('g.py')).toBe('python');
    expect(files).toHaveLength(7);
  });

  it("records unknown-extension files with language='unknown'", async () => {
    writeTree(root, {
      'a.ts': '',
      'Makefile': '',
      'README': '',
      'lib.xyz': '',
    });
    const { files } = await scanProject(makeConfig(root));
    const byPath = new Map(files.map((f) => [f.path, f.language]));
    expect(byPath.get('a.ts')).toBe('typescript');
    expect(byPath.get('Makefile')).toBe('unknown');
    expect(byPath.get('README')).toBe('unknown');
    expect(byPath.get('lib.xyz')).toBe('unknown');
    expect(files).toHaveLength(4);
  });

  it('skips unknown-extension files containing a null byte', async () => {
    writeTree(root, {
      'a.ts': '',
      'image.bin': Buffer.from('he\0llo'),
    });
    const { files } = await scanProject(makeConfig(root));
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['a.ts']);
  });

  it('records non-binary unknown files alongside null-byte files being skipped', async () => {
    writeTree(root, {
      'README.md': '# Hello\n',
      'data.bin': Buffer.from([0x00, 0xff, 0xff]),
    });
    const { files } = await scanProject(makeConfig(root));
    const paths = files.map((f) => f.path).sort();
    expect(paths).toEqual(['README.md']);
    expect(files[0].language).toBe('unknown');
  });

  it('skips files with binary extensions', async () => {
    writeTree(root, {
      'a.ts': '',
      'logo.png': 'fake',
      'font.woff2': 'fake',
    });
    const { files } = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path)).toEqual(['a.ts']);
  });

  it('skips files exceeding maxFileSize', async () => {
    writeTree(root, {
      'small.ts': 'x'.repeat(500),
      'big.ts': 'x'.repeat(2048),
    });
    const cfg = makeConfig(root, { maxFileSize: 1024 });
    const { files } = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['small.ts']);
  });

  it('respects the default node_modules exclude on deeply nested files', async () => {
    writeTree(root, {
      'src/index.ts': '',
      'node_modules/foo/bar.ts': '',
      'packages/a/node_modules/dep/x.ts': '',
    });
    const { files } = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path)).toEqual(['src/index.ts']);
  });

  it('respects the default *.min.js exclude at root and nested', async () => {
    writeTree(root, {
      'app.js': '',
      'app.min.js': '',
      'public/js/widget.min.js': '',
    });
    const { files } = await scanProject(makeConfig(root));
    expect(files.map((f) => f.path).sort()).toEqual(['app.js']);
  });

  it('honors a user-supplied slash-anchored glob like vendor/**', async () => {
    writeTree(root, {
      'src/a.ts': '',
      'vendor/lib.ts': '',
      'vendor/sub/lib.ts': '',
    });
    const cfg = makeConfig(root, { exclude: ['vendor/**'] });
    const { files } = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('languages config filter drops files of other languages', async () => {
    writeTree(root, {
      'a.ts': '',
      'b.py': '',
      'c.js': '',
    });
    const cfg = makeConfig(root, { languages: ['typescript'] });
    const { files } = await scanProject(cfg);
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
    const { files } = await scanProject(cfg);

    expect(files).toHaveLength(2);
    const warnCalls = stderr.mock.calls.filter((c) =>
      String(c[0]).includes('maxFiles=2'),
    );
    expect(warnCalls).toHaveLength(1);

    stderr.mockRestore();
  });

  it('treats maxFiles=0 as unlimited (documented schema)', async () => {
    writeTree(root, {
      'a.ts': '',
      'b.ts': '',
      'c.ts': '',
      'd.ts': '',
      'e.ts': '',
    });
    const stderr = silenceStderr();

    const cfg = makeConfig(root, { maxFiles: 0 });
    const result = await scanProject(cfg);

    expect(result.files).toHaveLength(5);
    expect(result.complete).toBe(true);
    const capWarns = stderr.mock.calls.filter((c) =>
      String(c[0]).includes('reached maxFiles='),
    );
    expect(capWarns).toHaveLength(0);
  });

  it('prefers parseable files over unknowns when maxFiles is tight', async () => {
    // Mixed unknowns at root + a parseable nested in src/ — regardless of
    // readdir order, the one budget slot must go to the parseable source.
    writeTree(root, {
      'README.md': '# hello\n',
      'NOTICE': 'note\n',
      'CHANGELOG': 'log\n',
      'src/a.ts': 'export const x = 1;\n',
    });
    silenceStderr();
    const cfg = makeConfig(root, { maxFiles: 1 });
    const { files } = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('admits unknowns into remaining budget after parseable', async () => {
    writeTree(root, {
      'src/a.ts': 'export const x = 1;\n',
      'README.md': '# hi\n',
    });
    const cfg = makeConfig(root, { maxFiles: 2 });
    const { files } = await scanProject(cfg);
    expect(files.map((f) => f.path)).toEqual(['README.md', 'src/a.ts']);
  });

  it('caps total when parseable is small but unknown count is large', async () => {
    const tree: Record<string, string> = {
      'src/a.ts': 'export const x = 1;\n',
    };
    for (let i = 0; i < 10; i++) tree[`unknown${i}.txt`] = 'text';
    writeTree(root, tree);
    silenceStderr();
    const cfg = makeConfig(root, { maxFiles: 5 });
    const { files } = await scanProject(cfg);
    expect(files).toHaveLength(5);
    expect(files.map((f) => f.path)).toContain('src/a.ts');
  });

  it('FileInfo.path uses forward slashes regardless of platform', async () => {
    writeTree(root, { 'src/sub/deep/a.ts': '' });
    const { files } = await scanProject(makeConfig(root));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/sub/deep/a.ts');
    expect(files[0].path).not.toContain('\\');
  });

  it('FileInfo.path is relative to projectRoot with no leading slash', async () => {
    writeTree(root, { 'src/a.ts': '' });
    const { files } = await scanProject(makeConfig(root));
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
    const { files } = await scanProject(makeConfig(root));
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
    const { files } = await scanProject(makeConfig(root));
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
    const { files } = await scanProject(makeConfig(root));
    expect(files).toEqual([]);
  });

  it('handles a single file at root', async () => {
    writeTree(root, { 'only.ts': '' });
    const { files } = await scanProject(makeConfig(root));
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('only.ts');
  });

  it.skipIf(skipOnWindows)(
    'skips symlinks instead of following them',
    async () => {
      writeTree(root, { 'real.ts': 'export const x = 1;' });
      symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'));

      const { files } = await scanProject(makeConfig(root));
      expect(files.map((f) => f.path)).toEqual(['real.ts']);
    },
  );

  it.skipIf(skipOnWindows)(
    'prunes excluded directories instead of traversing them',
    async () => {
      writeTree(root, {
        'src/a.ts': '',
        'node_modules/foo.ts': '',
      });
      const stderr = silenceStderr();

      await withChmod(join(root, 'node_modules'), 0o000, async () => {
        const { files } = await scanProject(makeConfig(root));
        expect(files.map((f) => f.path)).toEqual(['src/a.ts']);

        const readdirFailures = stderr.mock.calls.filter((c) => {
          const s = String(c[0]);
          return s.includes('readdir failed') && s.includes('node_modules');
        });
        expect(readdirFailures).toHaveLength(0);
      });
    },
  );

  it('reports complete:true on a clean scan', async () => {
    writeTree(root, { 'src/a.ts': '' });
    const result = await scanProject(makeConfig(root));
    expect(result.complete).toBe(true);
  });

  it.skipIf(skipOnWindows)(
    'reports complete:false when byte check fails on an unknown-extension file',
    async () => {
      writeTree(root, {
        'a.ts': '',
        'unreadable.bin': Buffer.from('plain'),
      });
      silenceStderr();

      await withChmod(join(root, 'unreadable.bin'), 0o000, async () => {
        const result = await scanProject(makeConfig(root));
        expect(result.complete).toBe(false);
        expect(result.files.map((f) => f.path)).toEqual(['a.ts']);
      });
    },
  );

  it.skipIf(skipOnWindows)(
    'reports complete:false when readdir fails on a non-excluded dir',
    async () => {
      writeTree(root, {
        'src/a.ts': '',
        'extra/b.ts': '',
      });
      silenceStderr();

      await withChmod(join(root, 'extra'), 0o000, async () => {
        const result = await scanProject(makeConfig(root));
        expect(result.complete).toBe(false);
        expect(result.files.map((f) => f.path)).toEqual(['src/a.ts']);
      });
    },
  );

  it('does not index files inside an in-project cacheDir', async () => {
    // Without auto-excluding the configured cacheDir, scanProject admits
    // cache/index.json as an unknown-language file. The indexer would then
    // record its mtime, persist() would bump that mtime, and every later
    // indexChanged() would re-index the cache forever.
    writeTree(root, {
      'src/a.ts': 'export const x = 1;\n',
      'cache/index.json': '{"junk":true}\n',
      'cache/index.json.tmp.123.456': '{}\n',
    });
    vi.stubEnv('PROBE_CACHE_DIR', 'cache');
    try {
      const cfg = makeConfig(root);
      const { files } = await scanProject(cfg);
      const paths = files.map((f) => f.path);
      expect(paths).toContain('src/a.ts');
      expect(paths.find((p) => p.startsWith('cache/'))).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
