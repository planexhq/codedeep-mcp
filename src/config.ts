import { createHash } from 'node:crypto';
import { constants as fsConstants, readFileSync, realpathSync, statSync } from 'node:fs';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { CodedeepConfig } from './types.js';
import { toPosix } from './fs-util.js';
import { errMsg, log } from './logger.js';

const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  '.codedeep',
  // MCP tool-artifact directory (Playwright MCP screenshots/traces) — never
  // source, and its dot prefix does NOT exempt it (picomatch runs {dot:true}).
  '.playwright-mcp',
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

const DEFAULT_LANGUAGES: readonly string[] = ['typescript', 'tsx', 'javascript', 'python', 'java', 'go', 'rust', 'swift', 'kotlin', 'dart', 'csharp', 'php', 'ruby', 'cpp', 'c', 'objc'];
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
  const path = join(root, '.codedeep', 'config.json');
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
  const raw = process.env.CODEDEEP_GIT_WINDOW?.trim();
  if (raw === undefined || raw === '') return undefined;
  const parsed = asPositiveInt(Number(raw));
  if (parsed === undefined) {
    log.warn(`config: CODEDEEP_GIT_WINDOW=${raw} not recognized; expected a positive integer (days)`);
  }
  return parsed;
}

function parseEnvExclude(): string[] {
  const raw = process.env.CODEDEEP_EXCLUDE;
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

// Resolves the project root the server should index: `--project <path>` /
// `--project=<path>` (last occurrence wins) beats CODEDEEP_ROOT beats
// process.cwd(). MCP clients don't reliably honor a per-server working
// directory, so an explicit override is the only dependable way to root a
// server at a workspace sub-repo (one server = one repo). Overrides are
// resolved against cwd, then realpath-canonicalized — git resolves symlinks
// when answering `rev-parse --show-prefix`, so a symlinked projectRoot would
// mismatch the prefix and silently kill enrichment — and must name an
// existing directory: resolveCacheDir's mkdir({recursive}) would otherwise
// materialize a typo'd root and serve a working-but-empty index with zero
// diagnostics. Fails loud (throw; index.ts exits) — never mkdir-discovers.
// The no-override path stays exactly process.cwd(): getcwd() is already
// symlink-free on POSIX, and re-canonicalizing it could shift projectRoot
// under existing caches (load() deletes on projectRoot mismatch).
export function resolveProjectRoot(
  argv: readonly string[] = process.argv.slice(2),
): string {
  let cli: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') {
      const next = argv[i + 1];
      // A following flag is a missing value, not a path — resolving it
      // would produce a confusing "--foo does not exist" error.
      if (next === undefined || next.startsWith('--')) {
        throw new Error('--project requires a path argument');
      }
      cli = next;
      i++;
    } else if (arg.startsWith('--project=')) {
      cli = arg.slice('--project='.length);
    }
  }

  let override: string;
  let source: string;
  if (cli !== undefined) {
    // An explicit flag with a blank value is a misconfig, not "unset".
    if (cli.trim().length === 0) {
      throw new Error('--project requires a non-empty path');
    }
    override = cli;
    source = '--project';
  } else {
    const env = asNonBlankString(process.env.CODEDEEP_ROOT);
    if (env === undefined) return process.cwd();
    override = env;
    source = 'CODEDEEP_ROOT';
  }

  const resolved = resolve(override);
  let root: string;
  try {
    root = realpathSync(resolved);
  } catch (err) {
    // realpath(3) throws for more than a typo — name the real fault so the
    // operator doesn't hunt for a misspelling of a path that actually exists.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      throw new Error(`${source} path "${resolved}" has a symlink cycle`);
    }
    if (code === 'EACCES') {
      throw new Error(`${source} path "${resolved}" is not accessible`);
    }
    // ENOENT (and ENOTDIR on a non-terminal component) both read as "does
    // not exist" to the operator; anything else surfaces the raw message.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`${source} path "${resolved}" does not exist`);
    }
    throw new Error(`${source} path "${resolved}" could not be resolved: ${errMsg(err)}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new Error(`${source} path "${resolved}" is not a directory`);
  }
  return root;
}

export function loadConfig(projectRoot: string = process.cwd()): CodedeepConfig {
  const root = resolve(projectRoot);
  const fileCfg = readFileConfig(root);

  const fileExclude = asStringArray(fileCfg.exclude) ?? [];
  const fileLanguages = asStringArray(fileCfg.languages);
  const fileMaxFiles = asNonNegativeInt(fileCfg.maxFiles);
  const fileMaxFileSize = asNonNegativeInt(fileCfg.maxFileSize);
  const fileCacheDir = asNonBlankString(fileCfg.cacheDir);

  const envCacheDir = asNonBlankString(process.env.CODEDEEP_CACHE_DIR);
  const envExclude = parseEnvExclude();

  const cacheDirRaw = envCacheDir ?? fileCacheDir ?? join(root, '.codedeep', 'cache');
  const resolvedCacheDir = resolve(root, cacheDirRaw);

  // cacheDir === root produces no excludes, so <root>/index.json is admitted
  // as an unknown source and re-indexed on every save (loop). Other invalid
  // inputs degrade to defaults; this one corrupts the index, so fail loud.
  // Default path is structurally non-root, guard only explicit input.
  if ((envCacheDir ?? fileCacheDir) && relative(root, resolvedCacheDir) === '') {
    throw new Error(
      `cacheDir resolves to the project root (${resolvedCacheDir}); ` +
        `set CODEDEEP_CACHE_DIR or .codedeep/config.json "cacheDir" to a subdirectory or external path`,
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

  const cfg: CodedeepConfig = {
    projectRoot: root,
    exclude: Object.freeze(exclude),
    languages: Object.freeze(fileLanguages ?? [...DEFAULT_LANGUAGES]),
    maxFiles: fileMaxFiles ?? DEFAULT_MAX_FILES,
    maxFileSize: fileMaxFileSize ?? DEFAULT_MAX_FILE_SIZE,
    cacheDir: resolvedCacheDir,
    watch: parseEnvBool('CODEDEEP_WATCH') ?? asBoolean(fileCfg.watch) ?? true,
    gitEnabled: parseEnvBool('CODEDEEP_GIT') ?? asBoolean(fileCfg.gitEnabled) ?? true,
    gitWindow: parseEnvGitWindow() ?? asPositiveInt(fileCfg.gitWindow) ?? DEFAULT_GIT_WINDOW,
  };
  return Object.freeze(cfg);
}

export function defaultCacheDir(projectRoot: string): string {
  return resolve(projectRoot, '.codedeep', 'cache');
}

export function fallbackCacheDir(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 16);
  return join(homedir(), '.cache', 'codedeep', hash);
}

// Ensures the configured cacheDir is writable. When the path equals the
// project-default and is not usable (read-only repo, EROFS mount, or a
// `.codedeep`-is-a-file FS conflict), falls back silently to
// ~/.cache/codedeep/<sha1(projectRoot)>/. Explicit user overrides fail loudly
// so they know their CODEDEEP_CACHE_DIR / cacheDir is broken instead of being
// silently ignored.
export async function resolveCacheDir(config: CodedeepConfig): Promise<string> {
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
    // ENOTDIR/EEXIST cover default-path FS conflicts (e.g. `.codedeep` is a
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
          `Set CODEDEEP_CACHE_DIR to a writable directory.`,
      ) as NodeJS.ErrnoException;
      wrapped.code = (fallbackErr as NodeJS.ErrnoException)?.code;
      wrapped.cause = fallbackErr;
      throw wrapped;
    }
    return fallback;
  }
}
