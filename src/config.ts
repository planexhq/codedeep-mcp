import { createHash } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProbeConfig } from './types.js';
import { toPosix } from './indexer/scanner.js';
import { errMsg, log } from './logger.js';

const DEFAULT_EXCLUDES: readonly string[] = [
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
];

const DEFAULT_LANGUAGES: readonly string[] = ['typescript', 'tsx', 'javascript', 'python', 'java', 'go', 'rust', 'swift', 'kotlin', 'dart', 'csharp', 'php', 'ruby'];
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_FILE_SIZE = 1_048_576;
const DEFAULT_GIT_WINDOW = 180;

interface PartialFileConfig {
  exclude?: unknown;
  languages?: unknown;
  maxFiles?: unknown;
  maxFileSize?: unknown;
  cacheDir?: unknown;
  watch?: unknown;
  gitEnabled?: unknown;
  gitWindow?: unknown;
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

// A 0-day git window is meaningless (empty analysis marked fresh), so the
// git window requires >= 1, unlike maxFiles/maxFileSize where 0 is valid.
function asPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function asNonBlankString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function parseEnvBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  log.warn(`config: ${name}=${raw} not recognized; expected 0/1/true/false`);
  return undefined;
}

function parseEnvGitWindow(): number | undefined {
  const raw = process.env.PROBE_GIT_WINDOW?.trim();
  if (raw === undefined || raw === '') return undefined;
  const parsed = asPositiveInt(Number(raw));
  if (parsed === undefined) {
    log.warn(`config: PROBE_GIT_WINDOW=${raw} not recognized; expected a positive integer (days)`);
  }
  return parsed;
}

function parseEnvExclude(): string[] {
  const raw = process.env.PROBE_EXCLUDE;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// When cacheDir lives inside projectRoot, the scanner must skip it.
// Otherwise persist() bumps cache/index.json's mtime, the next
// indexChanged() sees the divergence, re-indexes the cache, and writes
// it again — a self-feeding loop. Push both `<rel>` (so walk()'s
// dir-prune triggers) and `<rel>/**` (so file-level matchExclude in
// scanner.ts and indexer.indexFile catches children of multi-segment
// paths picomatch wouldn't auto-expand).
function computeCacheDirExcludes(root: string, cacheDir: string): string[] {
  const rel = relative(root, cacheDir);
  if (rel.length === 0) return [];
  if (rel === '..' || rel.startsWith(`..${sep}`)) return [];
  if (isAbsolute(rel)) return [];
  const posixRel = toPosix(rel);
  return [posixRel, `${posixRel}/**`];
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

  const cacheDirRaw = envCacheDir ?? fileCacheDir ?? join(root, '.probe', 'cache');
  const resolvedCacheDir = resolve(root, cacheDirRaw);

  // cacheDir === root produces no excludes, so <root>/index.json is admitted
  // as an unknown source and re-indexed on every save (loop). Other invalid
  // inputs degrade to defaults; this one corrupts the index, so fail loud.
  // Default path is structurally non-root, guard only explicit input.
  if ((envCacheDir ?? fileCacheDir) && relative(root, resolvedCacheDir) === '') {
    throw new Error(
      `cacheDir resolves to the project root (${resolvedCacheDir}); ` +
        `set PROBE_CACHE_DIR or .probe/config.json "cacheDir" to a subdirectory or external path`,
    );
  }

  const cacheDirExcludes = computeCacheDirExcludes(root, resolvedCacheDir);

  const merged = [
    ...DEFAULT_EXCLUDES,
    ...fileExclude,
    ...envExclude,
    ...cacheDirExcludes,
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const exclude = Array.from(new Set(merged));

  const cfg: ProbeConfig = {
    projectRoot: root,
    exclude: Object.freeze(exclude),
    languages: Object.freeze(fileLanguages ?? [...DEFAULT_LANGUAGES]),
    maxFiles: fileMaxFiles ?? DEFAULT_MAX_FILES,
    maxFileSize: fileMaxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    cacheDir: resolvedCacheDir,
    watch: parseEnvBool('PROBE_WATCH') ?? asBoolean(fileCfg.watch) ?? true,
    gitEnabled: parseEnvBool('PROBE_GIT') ?? asBoolean(fileCfg.gitEnabled) ?? true,
    gitWindow: parseEnvGitWindow() ?? asPositiveInt(fileCfg.gitWindow) ?? DEFAULT_GIT_WINDOW,
  };
  return Object.freeze(cfg);
}

export function defaultCacheDir(projectRoot: string): string {
  return resolve(projectRoot, '.probe', 'cache');
}

export function fallbackCacheDir(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return join(homedir(), '.cache', 'probe', hash);
}

// Ensures the configured cacheDir is writable. When the path equals the
// project-default and is not usable (read-only repo, EROFS mount, or a
// `.probe`-is-a-file FS conflict), falls back silently to
// ~/.cache/probe/<sha1(projectRoot)>/. Explicit user overrides fail loudly
// so they know their PROBE_CACHE_DIR / cacheDir is broken instead of being
// silently ignored.
export async function resolveCacheDir(config: ProbeConfig): Promise<string> {
  const isDefault = config.cacheDir === defaultCacheDir(config.projectRoot);

  try {
    await mkdir(config.cacheDir, { recursive: true });
    // mkdir({recursive:true}) is idempotent, so a pre-existing cacheDir can
    // slip through with restrictive permissions. Probe W+X explicitly:
    // creating files inside a dir requires both bits per POSIX, so W alone
    // admits modes like 0o200 / 0o600 where open(O_CREAT) still fails.
    await access(config.cacheDir, fsConstants.W_OK | fsConstants.X_OK);
    return config.cacheDir;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOTDIR/EEXIST cover default-path FS conflicts (e.g. `.probe` is a
    // regular file). Explicit overrides still throw so misconfig surfaces.
    const canFallback =
      code === 'EACCES' ||
      code === 'EROFS' ||
      code === 'EPERM' ||
      code === 'ENOTDIR' ||
      code === 'EEXIST';
    if (!canFallback || !isDefault) throw err;

    const fallback = fallbackCacheDir(config.projectRoot);
    log.warn(
      `config: ${config.cacheDir} not usable (${code}); falling back to ${fallback}`,
    );
    try {
      await mkdir(fallback, { recursive: true });
      await access(fallback, fsConstants.W_OK | fsConstants.X_OK);
    } catch (fallbackErr) {
      const wrapped = new Error(
        `Cache fallback ${fallback} is also not writable: ${errMsg(fallbackErr)}. ` +
          `Set PROBE_CACHE_DIR to a writable directory.`,
      ) as NodeJS.ErrnoException;
      wrapped.code = (fallbackErr as NodeJS.ErrnoException)?.code;
      wrapped.cause = fallbackErr;
      throw wrapped;
    }
    return fallback;
  }
}
