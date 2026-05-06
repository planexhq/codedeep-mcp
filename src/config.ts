import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ProbeConfig } from './types.js';
import { log } from './logger.js';

const DEFAULT_EXCLUDES: readonly string[] = [
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

const DEFAULT_LANGUAGES: readonly string[] = ['typescript', 'javascript', 'python'];
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_FILE_SIZE = 1_048_576;

interface PartialFileConfig {
  exclude?: unknown;
  languages?: unknown;
  maxFiles?: unknown;
  maxFileSize?: unknown;
  cacheDir?: unknown;
}

function readFileConfig(root: string): PartialFileConfig {
  const path = join(root, '.probe', 'config.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    log.warn(`config: failed to read ${path}: ${(err as Error).message}; using defaults`);
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`config: failed to parse ${path}: ${(err as Error).message}; using defaults`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    log.warn(`config: ${path} is not a JSON object; using defaults`);
    return {};
  }
  return parsed as PartialFileConfig;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every((v) => typeof v === 'string')) return undefined;
  return value as string[];
}

function asNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}

function asNonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEnvExclude(): string[] {
  const raw = process.env.PROBE_EXCLUDE;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(projectRoot: string = process.cwd()): ProbeConfig {
  const root = resolve(projectRoot);
  const fileCfg = readFileConfig(root);

  const fileExclude = asStringArray(fileCfg.exclude) ?? [];
  const fileLanguages = asStringArray(fileCfg.languages);
  const fileMaxFiles = asNonNegativeInt(fileCfg.maxFiles);
  const fileMaxFileSize = asNonNegativeInt(fileCfg.maxFileSize);
  const fileCacheDir = asNonBlankString(fileCfg.cacheDir);

  const envCacheDir = asNonBlankString(process.env.PROBE_CACHE_DIR);
  const envExclude = parseEnvExclude();

  const merged = [...DEFAULT_EXCLUDES, ...fileExclude, ...envExclude]
    .map((s) => s.trim())
    .filter(Boolean);
  const exclude = Array.from(new Set(merged));
  const cacheDirRaw = envCacheDir ?? fileCacheDir ?? join(root, '.probe', 'cache');

  const cfg: ProbeConfig = {
    projectRoot: root,
    exclude: Object.freeze(exclude),
    languages: Object.freeze(fileLanguages ?? [...DEFAULT_LANGUAGES]),
    maxFiles: fileMaxFiles ?? DEFAULT_MAX_FILES,
    maxFileSize: fileMaxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    cacheDir: resolve(root, cacheDirRaw),
  };
  return Object.freeze(cfg);
}
