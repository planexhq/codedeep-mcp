import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.js';

const EXPECTED_DEFAULT_EXCLUDES = [
  'node_modules',
  '.git',
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
];

const EXPECTED_DEFAULT_LANGUAGES = ['typescript', 'javascript', 'python'];

function makeProjectDir(): string {
  return mkdtempSync(join(tmpdir(), 'probe-config-test-'));
}

function writeConfig(root: string, contents: string): void {
  mkdirSync(join(root, '.probe'), { recursive: true });
  writeFileSync(join(root, '.probe', 'config.json'), contents, 'utf8');
}

describe('loadConfig', () => {
  let root: string;

  beforeEach(() => {
    root = makeProjectDir();
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
});
