import { promises as fs } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

import {
  type CodeIndex,
  ENTRY_POINT_FILENAME_RE,
  type RiskRow,
  isClassMember,
  zeroSymbolsByKind,
} from '../indexer/code-index.js';
import type { BranchSummary, GitService } from '../git/git-service.js';
import type { Indexer } from '../indexer/pipeline.js';
import { compareShallowFirst } from '../indexer/scanner.js';
import { errMsg, log } from '../logger.js';
import {
  LANGUAGE_UNKNOWN,
  type FileInfo,
  type ProbeConfig,
  type Symbol,
  type SymbolKind,
} from '../types.js';

import {
  BEHAVIORAL_TAG,
  formatComplexityMetrics,
  INDEXING_BANNER,
  plural,
  textResponse,
  type ToolResponse,
} from './common.js';

export interface OverviewArgs {
  path?: string;
}

export interface OverviewDeps {
  index: CodeIndex;
  indexer: Pick<Indexer, 'ready'>;
  config: ProbeConfig;
  git: Pick<GitService, 'branchSummary'>;
}

const MAX_DIR_GROUPS = 7;
const MAX_KINDS_PER_GROUP = 3;
const MAX_ENTRY_POINTS = 15;
const MAX_OTHER_EXTENSIONS = 5;
const MAX_HOTSPOTS = 10;
const MAX_RISK_HOTSPOTS = 10;

// Without this, monorepos with many packages/*/index.ts (or many
// __init__.py) saturate MAX_ENTRY_POINTS alphabetically and hide the real
// startup file. Tested only against names that already passed
// ENTRY_POINT_FILENAME_RE, so a stem-only check is sufficient.
const BARREL_ENTRY_RE = /^(index|__init__)\./i;

const LANGUAGE_DISPLAY: Readonly<Partial<Record<string, string>>> = {
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  rust: 'Rust',
  swift: 'Swift',
  kotlin: 'Kotlin',
  dart: 'Dart',
  csharp: 'C#',
  php: 'PHP',
  ruby: 'Ruby',
  cpp: 'C++',
  c: 'C',
};

const KIND_PLURAL: Record<SymbolKind, string> = {
  function: 'functions',
  class: 'classes',
  interface: 'interfaces',
  type: 'types',
  variable: 'variables',
  method: 'methods',
  module: 'modules',
  enum: 'enums',
};

export async function runOverview(
  args: OverviewArgs,
  deps: OverviewDeps,
): Promise<ToolResponse> {
  try {
    const projectRoot = deps.config.projectRoot;
    if (args.path && resolve(args.path) !== projectRoot) {
      return textResponse(
        `Error: path "${args.path}" does not match configured project root "${projectRoot}". Multi-root workspaces are not yet supported.`,
      );
    }

    const stats = deps.index.getStats();
    const allFiles = deps.index.getAllFiles();

    const lines: string[] = [];

    if (!deps.indexer.ready) {
      lines.push(INDEXING_BANNER, '');
    }

    lines.push(`## Project: ${basename(projectRoot)}`, '');

    const unknownCount = stats.filesByLanguage[LANGUAGE_UNKNOWN] ?? 0;
    const recognizedTotal = stats.totalFiles - unknownCount;

    lines.push('### Languages');
    if (recognizedTotal === 0) {
      lines.push('- (no source files indexed)');
    } else {
      const langs = Object.entries(stats.filesByLanguage)
        .filter(([lang]) => lang !== LANGUAGE_UNKNOWN)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      for (const [lang, count] of langs) {
        const pct = Math.round((count / recognizedTotal) * 100);
        lines.push(
          `- ${displayLanguage(lang)}: ${count} ${plural('file', count)} (${pct}%)`,
        );
      }
    }
    lines.push('');

    if (unknownCount > 0) {
      lines.push('### Other files');
      const topExts = topUnknownExtensions(allFiles, MAX_OTHER_EXTENSIONS);
      const detail = topExts.length > 0 ? ` (${topExts.join(', ')})` : '';
      lines.push(
        `- ${unknownCount} ${plural('file', unknownCount)} not parsed${detail}`,
      );
      lines.push('');
    }

    lines.push('### Structure');
    const groups = groupFilesByDirectory(allFiles, deps.index);
    if (groups.length === 0) {
      lines.push('- (no files indexed)');
    } else {
      for (const g of groups) {
        const kindParts = g.topKinds.map(
          (k) => `${k.count} ${pluralKind(k.kind, k.count)}`,
        );
        const kindSuffix = kindParts.length > 0 ? ` (${kindParts.join(', ')})` : '';
        lines.push(
          `- ${g.dir} — ${g.fileCount} ${plural('file', g.fileCount)}${kindSuffix}`,
        );
      }
    }
    lines.push('');

    lines.push('### Entry Points');
    const entries = await collectEntryPoints(deps.index, allFiles, projectRoot);
    if (entries.length === 0) {
      lines.push('- (none detected)');
    } else {
      for (const e of entries) {
        if (e.summary) {
          lines.push(`- ${e.file} — ${e.summary}`);
        } else if (e.symbol !== undefined && e.line !== undefined) {
          lines.push(`- ${e.file}:${e.line} — ${e.symbol}`);
        } else {
          lines.push(`- ${e.file}`);
        }
      }
    }
    lines.push('');

    lines.push('### Symbols');
    const kindLine = formatSymbolKinds(stats.symbolsByKind);
    if (kindLine) lines.push(`- ${kindLine}`);
    lines.push(
      `- ${stats.totalFiles} ${plural('file', stats.totalFiles)} indexed, ${stats.totalSymbols} total ${plural('symbol', stats.totalSymbols)}`,
    );

    appendGitSections(lines, await collectGitData(deps));

    return textResponse(lines.join('\n'));
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}

interface OverviewGitData {
  branch: BranchSummary | null;
  hotspots: Array<{ path: string; commits: number }>;
  riskHotspots: RiskRow[];
  windowDays: number;
}

// Defensive catch at the tool boundary: GitService promises not to
// throw, but a git failure must never break overview output.
async function collectGitData(deps: OverviewDeps): Promise<OverviewGitData> {
  let branch: BranchSummary | null = null;
  try {
    branch = await deps.git.branchSummary();
  } catch {
    branch = null;
  }
  return {
    branch,
    hotspots: deps.index.getHotspots(MAX_HOTSPOTS),
    // Empty off-git (getRiskHotspots gates on getGitMeta) — the section is
    // then omitted, matching the silent-omission contract below.
    riskHotspots: deps.index.getRiskHotspots(MAX_RISK_HOTSPOTS),
    // Label with the window that PRODUCED the data (gitMeta provenance),
    // not the live config: after a gitWindow change, persisted counts
    // keep their true label until the re-analysis lands.
    windowDays: deps.index.getGitMeta()?.windowDays ?? deps.config.gitWindow,
  };
}

// Both sections vanish entirely outside git repos (and before the first
// analysis lands) — silent omission is the degradation contract, never a
// placeholder. Hotspots come from the persisted index, so a warm start
// shows them immediately, even while the indexing banner is up.
function appendGitSections(lines: string[], data: OverviewGitData): void {
  if (data.branch !== null) {
    lines.push('', `### Branch ${BEHAVIORAL_TAG}`, formatBranchLine(data.branch));
  }
  if (data.hotspots.length > 0) {
    lines.push('', `### Hotspots (last ${data.windowDays} days) ${BEHAVIORAL_TAG}`);
    for (const h of data.hotspots) {
      lines.push(`- ${h.path} — ${h.commits} ${plural('commit', h.commits)}`);
    }
  }
  // Churn × coupling × complexity: the file's most-coupled symbol crossed with
  // its commit frequency, refined by that offender's complexity. Empty (and so
  // omitted) off-git, where the product has no churn factor — the same silent-
  // omission contract as the sections above.
  if (data.riskHotspots.length > 0) {
    lines.push('', `### Risk Hotspots (churn × coupling × complexity) ${BEHAVIORAL_TAG}`);
    for (const r of data.riskHotspots) {
      // No `()` after the offender — it can be a class/variable, not a function.
      // "references" (not "callers") because fanIn is reference-granular, unlike
      // the distinct-caller blast count; a trailing `+` flags a capped walk.
      // The offender's complexity is appended tag-less (fanIn/blast are already
      // rendered tag-less under the one [behavioral] heading); omitted entirely
      // for a trivial offender so the line keeps its churn × coupling shape.
      const complexity = formatComplexityMetrics(r);
      lines.push(
        `- ${r.file} — ${r.symbol} — ${r.churn} ${plural('commit', r.churn)} × ` +
          `${r.fanIn} ${plural('reference', r.fanIn)} ` +
          `(blast radius ${r.blast.callers}${r.blast.truncated ? '+' : ''} across ${r.blast.files} ${plural('file', r.blast.files)})` +
          (complexity ? ` — ${complexity}` : ''),
      );
    }
  }
}

function formatBranchLine(s: BranchSummary): string {
  if (s.defaultBranch !== null && s.branch === s.defaultBranch) {
    return `- ${s.branch} (default branch)`;
  }
  if (s.defaultBranch === null || s.ahead === null) {
    return `- ${s.branch}`;
  }
  const files =
    s.changedFiles === null
      ? ''
      : `, ${s.changedFiles.length} ${plural('file', s.changedFiles.length)} changed on branch`;
  return `- ${s.branch} — ${s.ahead} ${plural('commit', s.ahead)} ahead of ${s.defaultBranch}${files}`;
}

function displayLanguage(lang: string): string {
  return LANGUAGE_DISPLAY[lang] ?? capitalize(lang);
}

function topUnknownExtensions(files: FileInfo[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (f.language !== LANGUAGE_UNKNOWN) continue;
    const ext = extname(f.path).toLowerCase();
    const key = ext === '' ? '(no ext)' : ext;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([ext]) => ext);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function pluralKind(kind: SymbolKind, count: number): string {
  return count === 1 ? kind : KIND_PLURAL[kind];
}


function sortedKindCounts(
  kinds: Record<SymbolKind, number>,
): Array<[SymbolKind, number]> {
  return (Object.entries(kinds) as Array<[SymbolKind, number]>)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function groupKey(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 1) return '(root)';
  const dirParts = parts.slice(0, -1);
  if (dirParts.length === 1) return dirParts[0];
  return dirParts.slice(0, 2).join('/');
}

interface DirGroup {
  dir: string;
  fileCount: number;
  topKinds: Array<{ kind: SymbolKind; count: number }>;
}

function groupFilesByDirectory(
  files: FileInfo[],
  index: CodeIndex,
): DirGroup[] {
  const groups = new Map<
    string,
    { fileCount: number; kinds: Record<SymbolKind, number> }
  >();
  for (const f of files) {
    const key = groupKey(f.path);
    let g = groups.get(key);
    if (!g) {
      g = { fileCount: 0, kinds: zeroSymbolsByKind() };
      groups.set(key, g);
    }
    g.fileCount++;
    for (const sym of index.getSymbolsInFile(f.path)) {
      g.kinds[sym.kind]++;
    }
  }

  return [...groups.entries()]
    .sort((a, b) => b[1].fileCount - a[1].fileCount || a[0].localeCompare(b[0]))
    .slice(0, MAX_DIR_GROUPS)
    .map(([dir, g]) => ({
      dir: dir === '(root)' ? '(root)' : `${dir}/`,
      fileCount: g.fileCount,
      topKinds: topKinds(g.kinds, MAX_KINDS_PER_GROUP),
    }));
}

function topKinds(
  kinds: Record<SymbolKind, number>,
  limit: number,
): Array<{ kind: SymbolKind; count: number }> {
  return sortedKindCounts(kinds)
    .slice(0, limit)
    .map(([kind, count]) => ({ kind, count }));
}

function formatSymbolKinds(kinds: Record<SymbolKind, number>): string {
  return sortedKindCounts(kinds)
    .map(([k, c]) => `${c} ${pluralKind(k, c)}`)
    .join(', ');
}

interface EntryPoint {
  file: string;
  symbol?: string;
  line?: number;
  summary?: string;
}

const PY_MAIN_GUARD_RE = /^if\s+__name__\s*==\s*['"]__main__['"]/m;
const PY_FILE_SCAN_CAP = 100;

async function collectPythonMainGuards(
  pyFiles: FileInfo[],
  projectRoot: string,
  slots: number,
): Promise<string[]> {
  // Re-sort shallow-first here rather than trusting scan order: CodeIndex
  // Map iteration order shifts as updateFile (remove + re-add) moves
  // modified files to the end, so a root manage.py edited post-scan can
  // land beyond PY_FILE_SCAN_CAP without this.
  const sorted = [...pyFiles].sort(compareShallowFirst);
  const limit = Math.min(sorted.length, PY_FILE_SCAN_CAP);
  const reads = sorted.slice(0, limit).map(async (f) => {
    try {
      const content = await fs.readFile(join(projectRoot, f.path), 'utf8');
      return PY_MAIN_GUARD_RE.test(content) ? f.path : null;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT' && code !== 'EISDIR') {
        log.warn(`overview: failed to read ${f.path}: ${errMsg(err)}`);
      }
      return null;
    }
  });
  const results = await Promise.all(reads);
  const out: string[] = [];
  for (const r of results) {
    if (r === null) continue;
    if (out.length >= slots) break;
    out.push(r);
  }
  return out;
}

function fallbackByExportCount(
  allFiles: FileInfo[],
  index: CodeIndex,
  excluded: { has(path: string): boolean },
  slots: number,
): string[] {
  const ranked: Array<{ path: string; count: number }> = [];
  for (const f of allFiles) {
    if (excluded.has(f.path)) continue;
    const count = index
      .getSymbolsInFile(f.path)
      .filter(isTopLevelExport).length;
    if (count > 0) ranked.push({ path: f.path, count });
  }
  ranked.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return ranked.slice(0, slots).map((r) => r.path);
}

function insertCandidates(
  candidates: Map<string, EntryPoint>,
  paths: Iterable<string>,
  index: CodeIndex,
): void {
  for (const p of paths) {
    if (candidates.has(p)) continue;
    if (candidates.size >= MAX_ENTRY_POINTS) break;
    candidates.set(p, makeEntry(p, index));
  }
}

async function collectEntryPoints(
  index: CodeIndex,
  allFiles: FileInfo[],
  projectRoot: string,
): Promise<EntryPoint[]> {
  const candidates = new Map<string, EntryPoint>();

  // Restrict to parseable files so package.json self-export patterns like
  // `"./package.json": "./package.json"` don't resolve and pollute the list.
  const indexed = new Set<string>();

  // Split entry-name files: non-barrels (main.py, server.ts) take
  // precedence over barrels (__init__.py, index.ts). Without the split,
  // 15+ barrels in a monorepo saturate the cap and prevent the main-guard
  // tier from ever surfacing manage.py-style scripts. Sort each sub-tier
  // shallow-first; otherwise 15+ packages/*/server.ts crowds out src/server.ts.
  const nonBarrelEntries: FileInfo[] = [];
  const barrelEntries: FileInfo[] = [];
  for (const f of allFiles) {
    if (f.language !== LANGUAGE_UNKNOWN) indexed.add(f.path);
    const name = basename(f.path);
    if (!ENTRY_POINT_FILENAME_RE.test(name)) continue;
    if (BARREL_ENTRY_RE.test(name)) barrelEntries.push(f);
    else nonBarrelEntries.push(f);
  }
  nonBarrelEntries.sort(compareShallowFirst);
  barrelEntries.sort(compareShallowFirst);

  // package.json entries are inserted first so they survive cap-clipping
  // in barrel-heavy monorepos.
  const pkgPaths = await readPackageJsonEntries(projectRoot);
  const resolvedPkg = pkgPaths
    .map((p) => resolveIndexedPath(p, indexed))
    .filter((r): r is string => r !== undefined);
  insertCandidates(candidates, resolvedPkg, index);

  if (candidates.size < MAX_ENTRY_POINTS) {
    insertCandidates(candidates, nonBarrelEntries.map((f) => f.path), index);
  }

  // Catches Python scripts (e.g. Django manage.py, train.py) whose names
  // don't match ENTRY_POINT_FILENAME_RE but use the main-guard idiom.
  if (candidates.size < MAX_ENTRY_POINTS) {
    const pyCandidates = allFiles.filter(
      (f) => f.language === 'python' && !candidates.has(f.path),
    );
    const guarded = await collectPythonMainGuards(
      pyCandidates,
      projectRoot,
      MAX_ENTRY_POINTS - candidates.size,
    );
    insertCandidates(candidates, guarded, index);
  }

  if (candidates.size < MAX_ENTRY_POINTS) {
    insertCandidates(candidates, barrelEntries.map((f) => f.path), index);
  }

  // Fallback for library projects: rank remaining files by top-level
  // export count so a public API in src/foo.ts surfaces even without a
  // package.json main, entry-named file, or Python main guard.
  if (candidates.size < MAX_ENTRY_POINTS) {
    const fallback = fallbackByExportCount(
      allFiles,
      index,
      candidates,
      MAX_ENTRY_POINTS - candidates.size,
    );
    insertCandidates(candidates, fallback, index);
  }

  return [...candidates.values()].slice(0, MAX_ENTRY_POINTS);
}

function isTopLevelExport(s: Symbol): boolean {
  return s.exported && !isClassMember(s);
}

function makeEntry(file: string, index: CodeIndex): EntryPoint {
  const exported = index.getSymbolsInFile(file).filter(isTopLevelExport);
  if (exported.length === 0) return { file };
  if (exported.length === 1) {
    const e = exported[0];
    return { file, symbol: e.name, line: e.startLine };
  }
  return {
    file,
    summary: `exports ${exported.length} ${plural('symbol', exported.length)}`,
  };
}

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

function resolveIndexedPath(p: string, indexed: Set<string>): string | undefined {
  // "." and "" both denote the project root — collapse to empty prefix.
  const cleaned = p === '.' || p === '' ? '' : p.replace(/\/$/, '');

  if (indexed.has(cleaned)) return cleaned;

  const bases = [cleaned, cleaned ? `${cleaned}/index` : 'index'];
  for (const base of bases) {
    for (const ext of RESOLVE_EXTENSIONS) {
      const candidate = base + ext;
      if (indexed.has(candidate)) return candidate;
    }
  }

  return undefined;
}

async function readPackageJsonEntries(projectRoot: string): Promise<string[]> {
  const pkgPath = join(projectRoot, 'package.json');
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      log.warn(`overview: failed to read ${pkgPath}: ${errMsg(err)}`);
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn(`overview: failed to parse ${pkgPath}: ${errMsg(err)}`);
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const pkg = parsed as { main?: unknown; bin?: unknown; exports?: unknown };

  const out: string[] = [];
  if (typeof pkg.main === 'string' && pkg.main.length > 0) {
    out.push(normalizeRelative(pkg.main));
  }
  if (typeof pkg.bin === 'string' && pkg.bin.length > 0) {
    out.push(normalizeRelative(pkg.bin));
  } else if (
    pkg.bin &&
    typeof pkg.bin === 'object' &&
    !Array.isArray(pkg.bin)
  ) {
    for (const v of Object.values(pkg.bin)) {
      if (typeof v === 'string' && v.length > 0) {
        out.push(normalizeRelative(v));
      }
    }
  }
  if (pkg.exports !== undefined) {
    collectExportPaths(pkg.exports, out);
  }
  return out;
}

function collectExportPaths(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    // Skip wildcard subpath patterns ("./features/*" → "./src/features/*.js")
    // since they require glob expansion against the file system.
    if (node.startsWith('./') && !node.includes('*')) {
      out.push(normalizeRelative(node));
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectExportPaths(v, out);
    return;
  }
  if (typeof node === 'object' && node !== null) {
    // Skip the `types` exports condition: it points to .d.ts metadata,
    // not runtime entry points. Subpath keys always start with "." per
    // the Node.js exports spec, so a bare "types" key is unambiguously
    // the type-declaration condition.
    for (const [k, v] of Object.entries(node)) {
      if (k === 'types') continue;
      collectExportPaths(v, out);
    }
  }
}

function normalizeRelative(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '');
}
