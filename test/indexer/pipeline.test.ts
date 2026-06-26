import {
  chmodSync,
  existsSync,
  promises as fs,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import * as extractorModule from '../../src/indexer/extractor.js';
import * as parserModule from '../../src/indexer/parser.js';
import { Indexer } from '../../src/indexer/pipeline.js';
import { toPosix } from '../../src/indexer/scanner.js';
import type { CodedeepConfig } from '../../src/types.js';
import {
  makeConfig,
  makeProjectDir,
  silenceStderr,
  skipOnWindows,
  writeTree,
} from '../helpers.js';

let root: string;
let config: CodedeepConfig;
let index: CodeIndex;
let indexer: Indexer;
let cachePath: string;

beforeAll(async () => {
  // Amortize WASM grammar load across the whole suite.
  await parserModule.initParser();
});

beforeEach(() => {
  delete process.env.CODEDEEP_CACHE_DIR;
  delete process.env.CODEDEEP_EXCLUDE;
  root = makeProjectDir('codedeep-pipeline-');
  config = makeConfig(root);
  index = new CodeIndex(config.projectRoot);
  indexer = new Indexer(config, index);
  cachePath = indexer.cachePath;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Indexer.indexAll', () => {
  it('handles an empty project and writes an empty cache', async () => {
    await indexer.indexAll();

    expect(index.getStats().totalFiles).toBe(0);
    expect(index.getStats().totalSymbols).toBe(0);
    expect(existsSync(cachePath)).toBe(true);
  });

  it('indexes TS and Python files end-to-end', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() { return 1; }\n',
      'src/b.py': 'def bar():\n    return 1\n',
    });

    await indexer.indexAll();

    expect(index.findSymbolByName('foo')).toHaveLength(1);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
    expect(index.getStats().totalFiles).toBe(2);
    expect(existsSync(cachePath)).toBe(true);
    expect(indexer.progress).toEqual({ done: 2, total: 2 });
    expect(indexer.isIndexing).toBe(false);
  });

  it('clears stale symbols when re-running indexAll after a rename', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toHaveLength(1);

    // Simulate a rename on disk between runs.
    rmSync(join(root, 'src/a.ts'));
    writeTree(root, { 'src/b.ts': 'export function bar() {}\n' });

    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
    expect(index.getAllFiles().map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('records unknown-language files but extracts no symbols', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() {}\n',
      'README.md': '# Hello\n',
      'package.json': '{"name": "test"}\n',
    });
    const parseSpy = vi.spyOn(parserModule, 'parseFile');

    await indexer.indexAll();

    const files = index.getAllFiles();
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get('README.md')?.language).toBe('unknown');
    expect(byPath.get('package.json')?.language).toBe('unknown');
    expect(byPath.get('README.md')?.symbolCount).toBe(0);
    expect(byPath.get('README.md')?.lastIndexed).toBeGreaterThan(0);
    expect(index.getSymbolsInFile('README.md')).toEqual([]);
    expect(index.getStats().filesByLanguage).toMatchObject({
      typescript: 1,
      unknown: 2,
    });

    // Parser must NOT have been invoked for unknown-language files.
    const parsedLangs = parseSpy.mock.calls.map((c) => c[1]);
    expect(parsedLangs).not.toContain('unknown');
  });

  it('save() failure is non-fatal and isIndexing returns to false', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    vi.spyOn(index, 'save').mockRejectedValue(new Error('disk full'));
    const stderr = silenceStderr();

    await expect(indexer.indexAll()).resolves.toBe(true);
    expect(indexer.isIndexing).toBe(false);
    expect(index.findSymbolByName('foo')).toHaveLength(1);

    const errored = stderr.mock.calls.some((c) =>
      String(c[0]).includes('failed to save cache'),
    );
    expect(errored).toBe(true);
  });
});

describe('Indexer.indexChanged', () => {
  it('processes only new files', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();

    writeTree(root, { 'src/b.ts': 'export function bar() {}\n' });
    await indexer.indexChanged();

    expect(indexer.progress).toEqual({ done: 1, total: 1 });
    expect(index.findSymbolByName('foo')).toHaveLength(1);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
  });

  it('reprocesses files whose mtime changed', async () => {
    const aPath = join(root, 'src/a.ts');
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toHaveLength(1);
    expect(index.findSymbolByName('renamed')).toEqual([]);

    writeFileSync(aPath, 'export function renamed() {}\n');
    // Force a distinct mtime to dodge filesystem-resolution flakiness.
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(aPath, future, future);

    await indexer.indexChanged();

    expect(indexer.progress).toEqual({ done: 1, total: 1 });
    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('renamed')).toHaveLength(1);
  });

  it('reprocesses files when content changes but mtime is preserved', async () => {
    const aPath = join(root, 'src/a.ts');
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });

    // Pin a fixed past mtime so both writes share the exact same value
    // regardless of filesystem resolution. Mimics `cp -p` / archive
    // extraction / coarse-mtime same-tick edits.
    const fixed = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(aPath, fixed, fixed);

    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toHaveLength(1);

    // Different-length payload (24 → 28 bytes) so size differs even
    // though mtime is restored to the previous value.
    writeFileSync(aPath, 'export function renamed() {}\n');
    utimesSync(aPath, fixed, fixed);

    await indexer.indexChanged();

    expect(indexer.progress).toEqual({ done: 1, total: 1 });
    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('renamed')).toHaveLength(1);
  });

  it('drops symbols for files deleted on disk', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() {}\n',
      'src/b.ts': 'export function bar() {}\n',
    });
    await indexer.indexAll();
    expect(index.getStats().totalFiles).toBe(2);

    rmSync(join(root, 'src/a.ts'));
    await indexer.indexChanged();

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
    expect(index.getAllFiles().map((f) => f.path)).toEqual(['src/b.ts']);
  });

  it('is a no-op when nothing changed', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();

    const saveSpy = vi.spyOn(index, 'save');
    await indexer.indexChanged();

    expect(indexer.progress).toEqual({ done: 0, total: 0 });
    expect(saveSpy).not.toHaveBeenCalled();
    expect(index.findSymbolByName('foo')).toHaveLength(1);
  });

  it('round-trips a saved cache: load → indexChanged with no changes does nothing', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() {}\n',
      'src/b.ts': 'export function bar() {}\n',
    });
    await indexer.indexAll();

    // Simulate a fresh process: new index + indexer, load the saved cache.
    const fresh = new CodeIndex(config.projectRoot);
    const ok = await fresh.load(cachePath);
    expect(ok).toBe(true);
    const freshIndexer = new Indexer(config, fresh);

    await freshIndexer.indexChanged();
    expect(freshIndexer.progress).toEqual({ done: 0, total: 0 });
    expect(fresh.findSymbolByName('foo')).toHaveLength(1);
    expect(fresh.findSymbolByName('bar')).toHaveLength(1);
  });

  it('re-indexes unchanged files whose detected language changed (cache from an older build)', async () => {
    // An upgrade that teaches the scanner a new extension reclassifies
    // files an old cache recorded as 'unknown' — mtime+size still match,
    // so only the language comparison forces re-extraction.
    writeTree(root, { 'src/Widget.java': 'public class Widget { }\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('Widget')).toHaveLength(1);

    // Simulate the pre-Java cache entry: same stat fingerprint, language
    // 'unknown', no symbols, no content hash.
    const cached = index.getFile('src/Widget.java')!;
    index.updateFile(
      { ...cached, language: 'unknown', symbolCount: 0, contentHash: undefined },
      [],
      [],
      [],
    );
    expect(index.findSymbolByName('Widget')).toEqual([]);

    await indexer.indexChanged();

    expect(indexer.progress).toEqual({ done: 1, total: 1 });
    expect(index.findSymbolByName('Widget')).toHaveLength(1);
    expect(index.getFile('src/Widget.java')!.language).toBe('java');
  });

  it('drops stale symbols when extractSymbols throws on a modified file', async () => {
    const aPath = join(root, 'src/a.ts');
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toHaveLength(1);

    writeFileSync(aPath, 'export function foo() { /* changed */ }\n');
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(aPath, future, future);

    silenceStderr();
    vi.spyOn(extractorModule, 'extractSymbols').mockImplementation(() => {
      throw new Error('extractor boom');
    });

    await indexer.indexChanged();

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.getAllFiles().some((f) => f.path === 'src/a.ts')).toBe(false);
  });
});

describe('Indexer concurrency and resilience', () => {
  it('refuses concurrent runs (re-entrancy guard)', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    const stderr = silenceStderr();

    const p1 = indexer.indexAll();
    const p2 = indexer.indexAll();
    await Promise.all([p1, p2]);

    const warns = stderr.mock.calls.filter((c) =>
      String(c[0]).includes('already in progress'),
    );
    expect(warns).toHaveLength(1);
    expect(index.findSymbolByName('foo')).toHaveLength(1);
  });

  it('reports guard drops as false, completed runs as true', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    silenceStderr();

    // Dropped: indexFile while indexAll is still in flight.
    const all = indexer.indexAll();
    const dropped = indexer.indexFile('src/a.ts');
    await expect(dropped).resolves.toBe('dropped');
    await expect(all).resolves.toBe(true);

    // Standalone run after the guard clears.
    await expect(indexer.indexFile('src/a.ts')).resolves.toBe('noop');
  });

  it('continues past a read failure and indexes the rest', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() {}\n',
      'src/b.ts': 'export function bar() {}\n',
      'src/c.ts': 'export function baz() {}\n',
    });
    const stderr = silenceStderr();
    const realRead = fs.readFile;
    vi.spyOn(fs, 'readFile').mockImplementation((path, ...rest) => {
      // The indexer joins paths with the platform separator, so on Windows
      // the absolute path ends with `src\b.ts` — normalize via the canonical
      // toPosix helper before matching.
      if (typeof path === 'string' && toPosix(path).endsWith('src/b.ts')) {
        return Promise.reject(
          Object.assign(new Error('forced read failure'), { code: 'EACCES' }),
        );
      }
      // @ts-expect-error: forwarding rest args to the real implementation.
      return realRead(path, ...rest);
    });

    await indexer.indexAll();

    expect(index.findSymbolByName('foo')).toHaveLength(1);
    expect(index.findSymbolByName('bar')).toEqual([]);
    expect(index.findSymbolByName('baz')).toHaveLength(1);
    const warned = stderr.mock.calls.some((c) =>
      String(c[0]).includes('failed to read'),
    );
    expect(warned).toBe(true);
  });

  it('survives extractSymbols throwing for one file', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() {}\n',
      'src/b.ts': 'export function bar() {}\n',
    });
    const realExtract = extractorModule.extractSymbols;
    const stderr = silenceStderr();
    vi.spyOn(extractorModule, 'extractSymbols').mockImplementation(
      (tree, content, fileInfo) => {
        if (fileInfo.path === 'src/a.ts') throw new Error('extractor boom');
        return realExtract(tree, content, fileInfo);
      },
    );

    await expect(indexer.indexAll()).resolves.toBe(true);

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
    const warned = stderr.mock.calls.some((c) =>
      String(c[0]).includes('extractSymbols threw'),
    );
    expect(warned).toBe(true);
  });

  it('survives parseFile throwing for one file', async () => {
    writeTree(root, {
      'src/a.ts': 'export function foo() {}\n',
      'src/b.ts': 'export function bar() {}\n',
    });
    const realParse = parserModule.parseFile;
    const stderr = silenceStderr();
    vi.spyOn(parserModule, 'parseFile').mockImplementation(
      (content, language) => {
        if (content.includes('foo')) throw new Error('parser boom');
        return realParse(content, language);
      },
    );

    await expect(indexer.indexAll()).resolves.toBe(true);

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
    const warned = stderr.mock.calls.some((c) =>
      String(c[0]).includes('parseFile threw'),
    );
    expect(warned).toBe(true);
  });
});

describe('Indexer.indexFile', () => {
  it('indexes a single file without persisting', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    const saveSpy = vi.spyOn(index, 'save');

    await indexer.indexFile('src/a.ts');

    expect(index.findSymbolByName('foo')).toHaveLength(1);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('treats a missing file as a deletion', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toHaveLength(1);

    rmSync(join(root, 'src/a.ts'));
    await indexer.indexFile('src/a.ts');

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.getAllFiles().map((f) => f.path)).toEqual([]);
  });

  it('canonicalizes an absolute path to the scanner cache key', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });

    await indexer.indexFile(join(root, 'src/a.ts'));

    expect(index.findSymbolByName('foo')).toHaveLength(1);
    expect(index.getAllFiles().map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('strips a leading ./ so updates do not duplicate the scanner entry', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    expect(index.getAllFiles().map((f) => f.path)).toEqual(['src/a.ts']);

    writeFileSync(join(root, 'src/a.ts'), 'export function bar() {}\n');
    await indexer.indexFile('./src/a.ts');

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.findSymbolByName('bar')).toHaveLength(1);
    expect(index.getAllFiles().map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('skips paths outside the project root', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    const before = index.getAllFiles().map((f) => f.path);

    await indexer.indexFile('/tmp/elsewhere.ts');
    await indexer.indexFile('../sibling/file.ts');

    expect(index.getAllFiles().map((f) => f.path)).toEqual(before);
    expect(index.findSymbolByName('foo')).toHaveLength(1);
  });

  it('skips files with binary extensions', async () => {
    writeTree(root, { 'logo.png': 'fake' });

    await indexer.indexFile('logo.png');

    expect(index.getStats().totalFiles).toBe(0);
  });

  it('records an unknown-language text file as language=unknown', async () => {
    writeTree(root, { 'README.md': '# hi' });

    await indexer.indexFile('README.md');

    const files = index.getAllFiles();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('README.md');
    expect(files[0].language).toBe('unknown');
    expect(index.getStats().totalSymbols).toBe(0);
  });

  it('removes an unknown-language file mutated to a binary blob', async () => {
    writeTree(root, { 'NOTES.txt': 'hello world\n' });
    await indexer.indexFile('NOTES.txt');
    expect(index.getAllFiles().map((f) => f.path)).toContain('NOTES.txt');

    writeFileSync(
      join(root, 'NOTES.txt'),
      Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]),
    );
    await indexer.indexFile('NOTES.txt');

    expect(index.getAllFiles().some((f) => f.path === 'NOTES.txt')).toBe(false);
  });

  it('treats a missing unknown-language file as a deletion', async () => {
    writeTree(root, { 'README.md': '# hi' });
    await indexer.indexFile('README.md');
    expect(index.getAllFiles().map((f) => f.path)).toContain('README.md');

    rmSync(join(root, 'README.md'));
    await indexer.indexFile('README.md');

    expect(index.getAllFiles().some((f) => f.path === 'README.md')).toBe(false);
  });

  it('drops stale symbols when extractSymbols throws', async () => {
    const aPath = join(root, 'src/a.ts');
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('foo')).toHaveLength(1);

    // Change the file so indexFile's no-change short-circuit doesn't skip
    // the (throwing) extraction.
    writeFileSync(aPath, 'export function foo() { /* changed */ }\n');
    const future = (Date.now() + 60_000) / 1000;
    utimesSync(aPath, future, future);

    silenceStderr();
    vi.spyOn(extractorModule, 'extractSymbols').mockImplementation(() => {
      throw new Error('extractor boom');
    });

    await indexer.indexFile('src/a.ts');

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.getAllFiles().some((f) => f.path === 'src/a.ts')).toBe(false);
  });

  it('skips re-extraction when mtime and size are unchanged', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await indexer.indexAll();

    const extractSpy = vi.spyOn(extractorModule, 'extractSymbols');
    await expect(indexer.indexFile('src/a.ts')).resolves.toBe('noop');

    expect(extractSpy).not.toHaveBeenCalled();
    expect(index.findSymbolByName('foo')).toHaveLength(1);
  });

  it('detects a same-size edit in the same coarse-mtime tick via content hash', async () => {
    // HFS+/FAT/NFS report whole-second mtimes: a second equal-length edit
    // can share the indexed (mtime, size) fingerprint. The fs event fired,
    // so the hash check must catch it instead of silently skipping.
    const aPath = join(root, 'src/a.ts');
    writeTree(root, { 'src/a.ts': 'export function before() {}\n' });
    const fixed = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(aPath, fixed, fixed);
    await indexer.indexAll();
    expect(index.findSymbolByName('before')).toHaveLength(1);

    // Same byte length ('before' → 'cafter'), same pinned mtime.
    writeFileSync(aPath, 'export function cafter() {}\n');
    utimesSync(aPath, fixed, fixed);

    await expect(indexer.indexFile('src/a.ts')).resolves.toBe('indexed');
    expect(index.findSymbolByName('before')).toEqual([]);
    expect(index.findSymbolByName('cafter')).toHaveLength(1);
  });

  it('reports cap-skipped for a new file when the index is at maxFiles', async () => {
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    const tinyConfig = makeConfig(root, { maxFiles: 1 });
    const tinyIndex = new CodeIndex(tinyConfig.projectRoot);
    const tinyIndexer = new Indexer(tinyConfig, tinyIndex);
    await tinyIndexer.indexAll();
    expect(tinyIndex.fileCount).toBe(1);

    writeTree(root, { 'src/b.ts': 'export function bar() {}\n' });
    await expect(tinyIndexer.indexFile('src/b.ts')).resolves.toBe('cap-skipped');
    expect(tinyIndex.hasFile('src/b.ts')).toBe(false);
  });

  it('drops a file that grew past maxFileSize', async () => {
    const tinyConfig = makeConfig(root, { maxFileSize: 50 });
    const tinyIndex = new CodeIndex(tinyConfig.projectRoot);
    const tinyIndexer = new Indexer(tinyConfig, tinyIndex);

    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });
    await tinyIndexer.indexAll();
    expect(tinyIndex.findSymbolByName('foo')).toHaveLength(1);

    writeFileSync(
      join(root, 'src/a.ts'),
      `export function foo() {}\n${'// padding '.repeat(20)}`,
    );
    await tinyIndexer.indexFile('src/a.ts');

    expect(tinyIndex.findSymbolByName('foo')).toEqual([]);
    expect(tinyIndex.getAllFiles().some((f) => f.path === 'src/a.ts')).toBe(
      false,
    );
  });

  it('skips paths matching config.exclude', async () => {
    writeTree(root, { 'extra/x.ts': 'export function vendored() {}\n' });
    const strictConfig = makeConfig(root, {
      exclude: [...config.exclude, 'extra'],
    });
    const strictIndex = new CodeIndex(strictConfig.projectRoot);
    const strictIndexer = new Indexer(strictConfig, strictIndex);

    await strictIndexer.indexFile('extra/x.ts');

    expect(strictIndex.findSymbolByName('vendored')).toEqual([]);
    expect(strictIndex.getStats().totalFiles).toBe(0);
  });

  it('drops a previously-indexed path that newly matches exclude', async () => {
    writeTree(root, { 'extra/x.ts': 'export function vendored() {}\n' });
    await indexer.indexAll();
    expect(index.findSymbolByName('vendored')).toHaveLength(1);

    const strictConfig = makeConfig(root, {
      exclude: [...config.exclude, 'extra'],
    });
    const strictIndexer = new Indexer(strictConfig, index);
    await strictIndexer.indexFile('extra/x.ts');

    expect(index.findSymbolByName('vendored')).toEqual([]);
    expect(index.getAllFiles().some((f) => f.path === 'extra/x.ts')).toBe(
      false,
    );
  });

  it('initializes parsers on first call', async () => {
    const initSpy = vi.spyOn(parserModule, 'initParser');
    writeTree(root, { 'src/a.ts': 'export function foo() {}\n' });

    await indexer.indexFile('src/a.ts');

    expect(initSpy).toHaveBeenCalled();
    expect(index.findSymbolByName('foo')).toHaveLength(1);
  });

  it.skipIf(skipOnWindows)('skips symlinked paths', async () => {
    writeTree(root, { 'src/real.ts': 'export function foo() {}\n' });
    symlinkSync(join(root, 'src/real.ts'), join(root, 'src/link.ts'));

    await indexer.indexFile('src/link.ts');

    expect(index.findSymbolByName('foo')).toEqual([]);
    expect(index.getStats().totalFiles).toBe(0);
  });

  it.skipIf(skipOnWindows)(
    'drops a previously-indexed path that became a symlink',
    async () => {
      writeTree(root, {
        'src/a.ts': 'export function foo() {}\n',
        'src/target.ts': 'export function bar() {}\n',
      });
      await indexer.indexFile('src/a.ts');
      expect(index.findSymbolByName('foo')).toHaveLength(1);

      rmSync(join(root, 'src/a.ts'));
      symlinkSync(join(root, 'src/target.ts'), join(root, 'src/a.ts'));
      await indexer.indexFile('src/a.ts');

      expect(index.findSymbolByName('foo')).toEqual([]);
      // Verify we didn't follow the symlink and index the target's symbols.
      expect(index.findSymbolByName('bar')).toEqual([]);
      expect(index.getAllFiles().some((f) => f.path === 'src/a.ts')).toBe(
        false,
      );
    },
  );
});

describe('Indexer partial-scan resilience', () => {
  it.skipIf(skipOnWindows)(
    'indexChanged preserves cached entries when scan is incomplete',
    async () => {
      writeTree(root, {
        'src/a.ts': 'export function foo() {}\n',
        'keep_me/b.ts': 'export function bar() {}\n',
      });
      await indexer.indexAll();
      expect(index.findSymbolByName('foo')).toHaveLength(1);
      expect(index.findSymbolByName('bar')).toHaveLength(1);

      const blocked = join(root, 'keep_me');
      const originalMode = statSync(blocked).mode;
      chmodSync(blocked, 0o000);
      silenceStderr();

      try {
        await indexer.indexChanged();
        expect(index.findSymbolByName('foo')).toHaveLength(1);
        expect(index.findSymbolByName('bar')).toHaveLength(1);
      } finally {
        chmodSync(blocked, originalMode);
      }
    },
  );

  it.skipIf(skipOnWindows)(
    'indexAll preserves cached entries when scan is incomplete',
    async () => {
      writeTree(root, {
        'src/a.ts': 'export function foo() {}\n',
        'keep_me/b.ts': 'export function bar() {}\n',
      });
      await indexer.indexAll();
      expect(index.findSymbolByName('bar')).toHaveLength(1);

      const blocked = join(root, 'keep_me');
      const originalMode = statSync(blocked).mode;
      chmodSync(blocked, 0o000);
      silenceStderr();

      try {
        await indexer.indexAll();
        expect(index.findSymbolByName('foo')).toHaveLength(1);
        expect(index.findSymbolByName('bar')).toHaveLength(1);
      } finally {
        chmodSync(blocked, originalMode);
      }
    },
  );
});
