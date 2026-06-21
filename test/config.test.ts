import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  defaultCacheDir,
  fallbackCacheDir,
  loadConfig,
  resolveCacheDir,
} from '../src/config.js';
import {
  makeProjectDir,
  silenceStderr,
  skipOnWindows,
  withChmod,
} from './helpers.js';

// The last two entries (`.probe/cache`, `.probe/cache/**`) are derived by
// loadConfig from the default cacheDir, not hard-coded in DEFAULT_EXCLUDES.
const EXPECTED_DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
  '.probe',
  '__pycache__',
  '.venv',
  'dist',
  'build',
  'vendor',
  '.next',
  '.nuxt',
  'target',
  '__generated__',
  '*.min.js',
  '*.bundle.js',
  '.probe/cache',
  '.probe/cache/**',
];

const EXPECTED_DEFAULT_LANGUAGES = ['typescript', 'tsx', 'javascript', 'python', 'java', 'go', 'rust', 'swift', 'kotlin', 'dart', 'csharp', 'php', 'ruby', 'cpp', 'c', 'objc'];

function writeConfig(root: string, contents: string): void {
  mkdirSync(join(root, '.probe'), { recursive: true });
  writeFileSync(join(root, '.probe', 'config.json'), contents, 'utf8');
}

describe('loadConfig', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectDir('probe-config-test-');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(root);

    expect(cfg.projectRoot).toBe(resolve(root));
    expect(cfg.exclude).toEqual(EXPECTED_DEFAULT_EXCLUDES);
    expect(cfg.exclude).toHaveLength(EXPECTED_DEFAULT_EXCLUDES.length);
    expect(cfg.languages).toEqual(EXPECTED_DEFAULT_LANGUAGES);
    expect(cfg.maxFiles).toBe(100_000);
    expect(cfg.maxFileSize).toBe(1_048_576);
    expect(cfg.cacheDir).toBe(resolve(root, '.probe', 'cache'));
    expect(cfg.watch).toBe(true);
    expect(cfg.gitEnabled).toBe(true);
    expect(cfg.gitWindow).toBe(180);
  });

  it('file watch flag overrides the default', () => {
    writeConfig(root, JSON.stringify({ watch: false }));
    expect(loadConfig(root).watch).toBe(false);

    writeConfig(root, JSON.stringify({ watch: true }));
    expect(loadConfig(root).watch).toBe(true);
  });

  it('ignores a non-boolean file watch value', () => {
    writeConfig(root, JSON.stringify({ watch: 'no' }));
    expect(loadConfig(root).watch).toBe(true);
  });

  it.each([
    ['0', false],
    ['false', false],
    ['1', true],
    ['true', true],
  ])('PROBE_WATCH=%s sets watch to %s', (raw, expected) => {
    vi.stubEnv('PROBE_WATCH', raw);
    expect(loadConfig(root).watch).toBe(expected);
  });

  it('PROBE_WATCH overrides the file watch flag', () => {
    writeConfig(root, JSON.stringify({ watch: false }));
    vi.stubEnv('PROBE_WATCH', '1');
    expect(loadConfig(root).watch).toBe(true);
  });

  it('warns and keeps the default for an unrecognized PROBE_WATCH', () => {
    const spy = silenceStderr();
    vi.stubEnv('PROBE_WATCH', 'maybe');
    expect(loadConfig(root).watch).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain('PROBE_WATCH');
  });

  it('file gitEnabled flag overrides the default', () => {
    writeConfig(root, JSON.stringify({ gitEnabled: false }));
    expect(loadConfig(root).gitEnabled).toBe(false);

    writeConfig(root, JSON.stringify({ gitEnabled: true }));
    expect(loadConfig(root).gitEnabled).toBe(true);
  });

  it('ignores a non-boolean file gitEnabled value', () => {
    writeConfig(root, JSON.stringify({ gitEnabled: 'off' }));
    expect(loadConfig(root).gitEnabled).toBe(true);
  });

  it.each([
    ['0', false],
    ['false', false],
    ['1', true],
    ['true', true],
  ])('PROBE_GIT=%s sets gitEnabled to %s', (raw, expected) => {
    vi.stubEnv('PROBE_GIT', raw);
    expect(loadConfig(root).gitEnabled).toBe(expected);
  });

  it('PROBE_GIT overrides the file gitEnabled flag', () => {
    writeConfig(root, JSON.stringify({ gitEnabled: false }));
    vi.stubEnv('PROBE_GIT', '1');
    expect(loadConfig(root).gitEnabled).toBe(true);
  });

  it('warns and keeps the default for an unrecognized PROBE_GIT', () => {
    // The stderr spy accumulates across tests (afterEach unstubs envs, not
    // mocks), so scan all calls instead of asserting on calls[0].
    const spy = silenceStderr();
    vi.stubEnv('PROBE_GIT', 'maybe');
    expect(loadConfig(root).gitEnabled).toBe(true);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('PROBE_GIT=maybe')),
    ).toBe(true);
  });

  it('file gitWindow overrides the default and floors to an integer', () => {
    writeConfig(root, JSON.stringify({ gitWindow: 90.9 }));
    expect(loadConfig(root).gitWindow).toBe(90);
  });

  it('ignores zero, negative, and non-numeric file gitWindow values', () => {
    writeConfig(root, JSON.stringify({ gitWindow: 0 }));
    expect(loadConfig(root).gitWindow).toBe(180);

    writeConfig(root, JSON.stringify({ gitWindow: -5 }));
    expect(loadConfig(root).gitWindow).toBe(180);

    writeConfig(root, JSON.stringify({ gitWindow: '30' }));
    expect(loadConfig(root).gitWindow).toBe(180);
  });

  it('PROBE_GIT_WINDOW overrides the file gitWindow', () => {
    writeConfig(root, JSON.stringify({ gitWindow: 30 }));
    vi.stubEnv('PROBE_GIT_WINDOW', '365');
    expect(loadConfig(root).gitWindow).toBe(365);
  });

  it('warns and keeps the default for an invalid PROBE_GIT_WINDOW', () => {
    const spy = silenceStderr();
    vi.stubEnv('PROBE_GIT_WINDOW', 'soon');
    expect(loadConfig(root).gitWindow).toBe(180);
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('PROBE_GIT_WINDOW=soon')),
    ).toBe(true);
  });

  it('full config file overrides each scalar field and unions excludes', () => {
    writeConfig(
      root,
      JSON.stringify({
        exclude: ['vendor/**', 'generated/**'],
        languages: ['go', 'rust'],
        maxFiles: 42,
        maxFileSize: 1024,
        cacheDir: '/custom/cache',
      }),
    );

    const cfg = loadConfig(root);

    expect(cfg.exclude).toContain('node_modules');
    expect(cfg.exclude).toContain('vendor/**');
    expect(cfg.exclude).toContain('generated/**');
    expect(cfg.languages).toEqual(['go', 'rust']);
    expect(cfg.maxFiles).toBe(42);
    expect(cfg.maxFileSize).toBe(1024);
    expect(cfg.cacheDir).toBe(resolve('/custom/cache'));
  });

  it('partial config — only maxFiles set; other fields use defaults', () => {
    writeConfig(root, JSON.stringify({ maxFiles: 50 }));

    const cfg = loadConfig(root);

    expect(cfg.maxFiles).toBe(50);
    expect(cfg.maxFileSize).toBe(1_048_576);
    expect(cfg.languages).toEqual(EXPECTED_DEFAULT_LANGUAGES);
    expect(cfg.exclude).toContain('node_modules');
  });

  it('PROBE_EXCLUDE appends to default + file excludes', () => {
    writeConfig(root, JSON.stringify({ exclude: ['file-pattern/**'] }));
    vi.stubEnv('PROBE_EXCLUDE', 'foo,bar,baz');

    const cfg = loadConfig(root);

    expect(cfg.exclude).toContain('node_modules');
    expect(cfg.exclude).toContain('file-pattern/**');
    expect(cfg.exclude).toContain('foo');
    expect(cfg.exclude).toContain('bar');
    expect(cfg.exclude).toContain('baz');
  });

  it('PROBE_CACHE_DIR overrides config-file cacheDir', () => {
    writeConfig(root, JSON.stringify({ cacheDir: '/from-file' }));
    vi.stubEnv('PROBE_CACHE_DIR', '/from-env');

    const cfg = loadConfig(root);

    expect(cfg.cacheDir).toBe(resolve('/from-env'));
  });

  it('returns a frozen config; arrays are also frozen', () => {
    const cfg = loadConfig(root);

    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.exclude)).toBe(true);
    expect(Object.isFrozen(cfg.languages)).toBe(true);

    expect(() => {
      (cfg as { maxFiles: number }).maxFiles = 1;
    }).toThrow();
    expect(() => {
      (cfg.exclude as string[]).push('hacked');
    }).toThrow();
  });

  it('malformed JSON falls back to defaults without throwing', () => {
    writeConfig(root, '{ this is not json');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => loadConfig(root)).not.toThrow();
    const cfg = loadConfig(root);
    expect(cfg.maxFiles).toBe(100_000);
    expect(cfg.exclude).toContain('node_modules');
    expect(stderr).toHaveBeenCalled();

    stderr.mockRestore();
  });

  it('empty PROBE_EXCLUDE is treated as no value', () => {
    vi.stubEnv('PROBE_EXCLUDE', '');

    const cfg = loadConfig(root);

    expect(cfg.exclude).toHaveLength(EXPECTED_DEFAULT_EXCLUDES.length);
  });

  it('dedups overlapping exclude entries', () => {
    writeConfig(
      root,
      JSON.stringify({ exclude: ['node_modules', 'vendor/**'] }),
    );

    const cfg = loadConfig(root);

    const nodeModulesCount = cfg.exclude.filter((e) => e === 'node_modules').length;
    expect(nodeModulesCount).toBe(1);
  });

  it('drops blank and whitespace-only exclude entries from file config', () => {
    writeConfig(
      root,
      JSON.stringify({ exclude: ['', '   ', 'vendor/**'] }),
    );

    const cfg = loadConfig(root);

    expect(cfg.exclude).not.toContain('');
    expect(cfg.exclude).not.toContain('   ');
    expect(cfg.exclude).toContain('vendor/**');
    expect(cfg.exclude).toContain('node_modules');
  });

  it('ignores unknown fields in the config file (e.g., gitWindow, lsp)', () => {
    writeConfig(
      root,
      JSON.stringify({
        gitWindow: 365,
        lsp: { '.py': 'pylsp' },
        lspTimeout: 9000,
        maxFiles: 7,
      }),
    );

    const cfg = loadConfig(root);

    expect(cfg.maxFiles).toBe(7);
    expect(cfg.languages).toEqual(EXPECTED_DEFAULT_LANGUAGES);
  });

  it('config that is an array (not an object) falls back to defaults', () => {
    writeConfig(root, JSON.stringify(['not', 'an', 'object']));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const cfg = loadConfig(root);

    expect(cfg.maxFiles).toBe(100_000);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('config field with wrong type is ignored, others honored', () => {
    writeConfig(
      root,
      JSON.stringify({ exclude: 'not-an-array', maxFiles: 99 }),
    );

    const cfg = loadConfig(root);

    expect(cfg.maxFiles).toBe(99);
    expect(cfg.exclude).toEqual(EXPECTED_DEFAULT_EXCLUDES);
  });

  it('empty PROBE_CACHE_DIR falls back to file or default', () => {
    writeConfig(root, JSON.stringify({ cacheDir: '/from-file' }));
    vi.stubEnv('PROBE_CACHE_DIR', '');

    const cfg = loadConfig(root);

    expect(cfg.cacheDir).toBe(resolve('/from-file'));
  });

  it('whitespace-only PROBE_CACHE_DIR falls back to default', () => {
    vi.stubEnv('PROBE_CACHE_DIR', '   ');

    const cfg = loadConfig(root);

    expect(cfg.cacheDir).toBe(resolve(root, '.probe', 'cache'));
  });

  it('empty cacheDir in config file falls back to default', () => {
    writeConfig(root, JSON.stringify({ cacheDir: '' }));

    const cfg = loadConfig(root);

    expect(cfg.cacheDir).toBe(resolve(root, '.probe', 'cache'));
  });

  it('PROBE_CACHE_DIR with surrounding whitespace is trimmed', () => {
    vi.stubEnv('PROBE_CACHE_DIR', '  /custom/cache  ');

    const cfg = loadConfig(root);

    expect(cfg.cacheDir).toBe(resolve('/custom/cache'));
  });

  it('PROBE_CACHE_DIR inside projectRoot is added to the exclude list', () => {
    vi.stubEnv('PROBE_CACHE_DIR', 'cache');
    const cfg = loadConfig(root);
    expect(cfg.exclude).toContain('cache');
    expect(cfg.exclude).toContain('cache/**');
  });

  it('nested in-project cacheDir produces both literal and /** patterns', () => {
    vi.stubEnv('PROBE_CACHE_DIR', 'tmp/probe-cache');
    const cfg = loadConfig(root);
    expect(cfg.exclude).toContain('tmp/probe-cache');
    expect(cfg.exclude).toContain('tmp/probe-cache/**');
  });

  it('outside-root cacheDir does not pollute the exclude list', () => {
    vi.stubEnv('PROBE_CACHE_DIR', '/tmp/elsewhere');
    const cfg = loadConfig(root);
    expect(cfg.exclude).not.toContain('/tmp/elsewhere');
    expect(cfg.exclude).not.toContain('/tmp/elsewhere/**');
    expect(cfg.exclude.filter((e) => e.startsWith('/'))).toEqual([]);
  });

  it('throws when PROBE_CACHE_DIR resolves to projectRoot', () => {
    vi.stubEnv('PROBE_CACHE_DIR', '.');
    expect(() => loadConfig(root)).toThrow(/resolves to the project root/);
  });

  it('throws when cacheDir in config file resolves to projectRoot', () => {
    writeConfig(root, JSON.stringify({ cacheDir: '.' }));
    expect(() => loadConfig(root)).toThrow(/resolves to the project root/);
  });
});

describe('resolveCacheDir', () => {
  let root: string;
  let createdFallbacks: string[] = [];

  beforeEach(() => {
    root = makeProjectDir('probe-resolvecache-');
    createdFallbacks = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const dir of createdFallbacks) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.unstubAllEnvs();
  });

  it('returns the configured cacheDir when it is writable', async () => {
    const cfg = loadConfig(root);
    const resolved = await resolveCacheDir(cfg);
    expect(resolved).toBe(cfg.cacheDir);
    expect(existsSync(cfg.cacheDir)).toBe(true);
  });

  it('exposes a stable hash-based fallback path for the project', () => {
    const expected = join(
      homedir(),
      '.cache',
      'probe',
      createHash('sha1').update(resolve(root)).digest('hex').slice(0, 16),
    );
    expect(fallbackCacheDir(resolve(root))).toBe(expected);
  });

  it.skipIf(skipOnWindows)(
    'falls back to ~/.cache/probe/<hash>/ when the default path is not writable',
    async () => {
      const probeDir = join(root, '.probe');
      mkdirSync(probeDir, { recursive: true });
      silenceStderr();

      // Read+execute but NOT write — mkdir of cache/ subdir will fail.
      await withChmod(probeDir, 0o500, async () => {
        const cfg = loadConfig(root);
        expect(cfg.cacheDir).toBe(defaultCacheDir(resolve(root)));

        const resolved = await resolveCacheDir(cfg);
        const expectedFallback = fallbackCacheDir(resolve(root));
        createdFallbacks.push(expectedFallback);

        expect(resolved).toBe(expectedFallback);
        expect(existsSync(expectedFallback)).toBe(true);
      });
    },
  );

  it.skipIf(skipOnWindows)(
    'throws when an explicit PROBE_CACHE_DIR override is not writable',
    async () => {
      const blocked = join(root, 'blocked');
      mkdirSync(blocked, { recursive: true });
      vi.stubEnv('PROBE_CACHE_DIR', join(blocked, 'cache'));
      silenceStderr();

      await withChmod(blocked, 0o500, async () => {
        const cfg = loadConfig(root);
        await expect(resolveCacheDir(cfg)).rejects.toMatchObject({
          code: expect.stringMatching(/^EACCES|EROFS|EPERM$/),
        });
      });
    },
  );

  it('rethrows non-permission errors unchanged for explicit overrides', async () => {
    // Pointing cacheDir at a path under an existing FILE makes mkdir fail
    // with ENOTDIR. For an explicit PROBE_CACHE_DIR override, this must
    // surface so the user notices their misconfig — not silently fall back.
    const blockingFile = join(root, 'not-a-dir');
    writeFileSync(blockingFile, 'x', 'utf8');
    vi.stubEnv('PROBE_CACHE_DIR', join(blockingFile, 'cache'));

    const cfg = loadConfig(root);
    await expect(resolveCacheDir(cfg)).rejects.toMatchObject({
      code: 'ENOTDIR',
    });
  });

  it('falls back when the default .probe path is a regular file (ENOTDIR)', async () => {
    // `.probe` as a regular file produces ENOTDIR; default-path policy
    // is to fall back rather than die.
    writeFileSync(join(root, '.probe'), 'i-am-a-file', 'utf8');
    silenceStderr();

    const cfg = loadConfig(root);
    expect(cfg.cacheDir).toBe(defaultCacheDir(resolve(root)));

    const resolved = await resolveCacheDir(cfg);
    const expectedFallback = fallbackCacheDir(resolve(root));
    createdFallbacks.push(expectedFallback);

    expect(resolved).toBe(expectedFallback);
    expect(existsSync(expectedFallback)).toBe(true);
  });

  it.skipIf(skipOnWindows)(
    'falls back when the default cacheDir already exists but is not writable',
    async () => {
      // mkdir({ recursive: true }) is idempotent — without an explicit
      // writability probe it returns success on a pre-existing 0o500
      // directory and the next save() fails. Cover that case.
      const cacheDir = defaultCacheDir(resolve(root));
      mkdirSync(cacheDir, { recursive: true });
      silenceStderr();

      await withChmod(cacheDir, 0o500, async () => {
        const cfg = loadConfig(root);
        const resolved = await resolveCacheDir(cfg);
        const expectedFallback = fallbackCacheDir(resolve(root));
        createdFallbacks.push(expectedFallback);

        expect(resolved).toBe(expectedFallback);
        expect(existsSync(expectedFallback)).toBe(true);
      });
    },
  );

  it.skipIf(skipOnWindows)(
    'falls back when the default cacheDir exists with write but no search permission',
    async () => {
      // POSIX requires X on a dir to create files inside it. A W-only dir
      // (mode 0o200) passes a bare W_OK probe but fails open(O_CREAT) in
      // CodeIndex.save. resolveCacheDir must probe both bits.
      const cacheDir = defaultCacheDir(resolve(root));
      mkdirSync(cacheDir, { recursive: true });
      silenceStderr();

      await withChmod(cacheDir, 0o200, async () => {
        const cfg = loadConfig(root);
        const resolved = await resolveCacheDir(cfg);
        const expectedFallback = fallbackCacheDir(resolve(root));
        createdFallbacks.push(expectedFallback);

        expect(resolved).toBe(expectedFallback);
        expect(existsSync(expectedFallback)).toBe(true);
      });
    },
  );

  it.skipIf(skipOnWindows)(
    'wraps the error when the fallback path exists but is not writable',
    async () => {
      const probeDir = join(root, '.probe');
      mkdirSync(probeDir, { recursive: true });

      const fallback = fallbackCacheDir(resolve(root));
      mkdirSync(fallback, { recursive: true });
      createdFallbacks.push(fallback);
      silenceStderr();

      await withChmod(probeDir, 0o500, async () => {
        await withChmod(fallback, 0o500, async () => {
          const cfg = loadConfig(root);
          await expect(resolveCacheDir(cfg)).rejects.toMatchObject({
            message: expect.stringContaining('Cache fallback'),
            code: expect.stringMatching(/^EACCES|EROFS|EPERM$/),
          });
        });
      });
    },
  );
});
