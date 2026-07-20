// Analyzer parsing/math against canned `git log` output strings — the
// runner is not involved, so malformed records and precise count
// scenarios are cheap to construct. One real-git test at the bottom pins
// the format contract (and core.quotepath=false) end to end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';

import {
  COCHANGES_PER_FILE_CAP,
  GIT_COMMIT_CAP,
  HOTSPOTS_KEPT,
  analyzeLog,
  buildLogArgs,
  partnerOf,
} from '../../src/git/analyzer.js';
import { GitRunner } from '../../src/git/runner.js';
import { makeProjectDir, silenceStderr } from '../helpers.js';
import { gitAvailable, makeGitRepo, REAL_GIT_SUITE_TIMEOUT } from '../git-helpers.js';

interface CannedCommit {
  ts: number; // epoch seconds
  files: string[];
}

// Byte-exact model of `--pretty=format:%x00%ct --name-only` output as
// verified against real git: records separated by NUL, newest first,
// `\0<ts>\n<files...>\n` joined with a blank line.
function logOutput(commits: CannedCommit[]): string {
  return commits
    .map((c) => `\u0000${c.ts}\n${c.files.join('\n')}\n`)
    .join('\n');
}

const anyIndexed = () => true;

describe('buildLogArgs', () => {
  it('builds the bulk pass arguments with an ISO --since cutoff', () => {
    const now = Date.UTC(2026, 5, 10); // 2026-06-10
    const args = buildLogArgs(30, now);
    expect(args).toContain('log');
    expect(args).toContain('--no-merges');
    expect(args).toContain('--no-renames');
    expect(args).toContain('--name-only');
    expect(args).toContain(`--max-count=${GIT_COMMIT_CAP}`);
    expect(args).toContain('--pretty=format:%x00%ct');
    const since = args.find((a) => a.startsWith('--since='));
    expect(since).toBe(`--since=${new Date(now - 30 * 86_400_000).toISOString()}`);
  });

  it('omits the subtree pathspec by default (repo-root case unchanged)', () => {
    const args = buildLogArgs(30, Date.UTC(2026, 5, 10));
    expect(args).not.toContain('--');
    expect(args).not.toContain('.');
  });

  it('appends a `-- .` pathspec (last) when scoping to a subdir root', () => {
    const args = buildLogArgs(30, Date.UTC(2026, 5, 10), true);
    // Must be the final two args, after every option (the `--` terminator).
    expect(args.slice(-2)).toEqual(['--', '.']);
    // The pathspec is cwd-relative; the runner runs git with cwd=projectRoot,
    // so at a monorepo subdir it filters --name-only to the subtree.
    expect(args.indexOf('--')).toBe(args.length - 2);
  });
});

describe('analyzeLog', () => {
  it('returns an empty analysis for empty stdout', () => {
    const result = analyzeLog('', anyIndexed);
    expect(result.counts.size).toBe(0);
    expect(result.cochanges.size).toBe(0);
    expect(result.hotspots).toEqual([]);
    expect(result.commitCount).toBe(0);
  });

  it('counts per-file commits across records', () => {
    const out = logOutput([
      { ts: 300, files: ['src/a.ts', 'src/b.ts'] },
      { ts: 200, files: ['src/a.ts'] },
      { ts: 100, files: ['src/a.ts'] },
    ]);
    const result = analyzeLog(out, anyIndexed);
    expect(result.commitCount).toBe(3);
    expect(result.counts.get('src/a.ts')).toBe(3);
    expect(result.counts.get('src/b.ts')).toBe(1);
  });

  it('tolerates CRLF line endings', () => {
    const out = '\u0000100\r\nsrc/a.ts\r\nsrc/b.ts\r\n';
    const result = analyzeLog(out, anyIndexed);
    expect(result.counts.get('src/a.ts')).toBe(1);
    expect(result.counts.get('src/b.ts')).toBe(1);
  });

  it('drops a garbled record (non-numeric timestamp) without throwing', () => {
    const out = `\u0000not-a-timestamp\nsrc/a.ts\n\n${logOutput([
      { ts: 100, files: ['src/b.ts'] },
    ])}`;
    const result = analyzeLog(out, anyIndexed);
    expect(result.commitCount).toBe(1);
    expect(result.counts.has('src/a.ts')).toBe(false);
    expect(result.counts.get('src/b.ts')).toBe(1);
  });

  it('skips empty commits (no file list)', () => {
    const out = `\u0000100\n\n${logOutput([{ ts: 50, files: ['src/a.ts'] }])}`;
    const result = analyzeLog(out, anyIndexed);
    expect(result.commitCount).toBe(1);
    expect(result.counts.get('src/a.ts')).toBe(1);
  });

  it('skips commits over MAX_FILES_PER_COMMIT entirely — counts AND pairs', () => {
    const mega = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`);
    const out = logOutput([
      { ts: 600, files: mega },
      { ts: 500, files: ['src/a.ts', 'src/b.ts'] },
      { ts: 400, files: ['src/a.ts', 'src/b.ts'] },
      { ts: 300, files: ['src/a.ts', 'src/b.ts'] },
    ]);
    const result = analyzeLog(out, anyIndexed);
    expect(result.commitCount).toBe(3);
    expect(result.counts.has('src/f0.ts')).toBe(false);
    expect(result.counts.get('src/a.ts')).toBe(3);
    // The pair exists from the three small commits only; were the mega
    // commit counted, shared would be 3 but confidence denominators 4.
    const record = result.cochanges.get('src/a.ts')?.[0];
    expect(record?.sharedCommits).toBe(3);
    expect(record?.confidenceAB).toBe(1);
    expect(record?.confidenceBA).toBe(1);
  });

  it('omits pairs below MIN_SHARED_COMMITS', () => {
    const out = logOutput([
      { ts: 200, files: ['src/a.ts', 'src/b.ts'] },
      { ts: 100, files: ['src/a.ts', 'src/b.ts'] },
    ]);
    const result = analyzeLog(out, anyIndexed);
    expect(result.counts.get('src/a.ts')).toBe(2);
    expect(result.cochanges.size).toBe(0);
  });

  it('computes both confidence directions from the same filtered stream', () => {
    // a.ts in 10 commits, b.ts in 12, 6 shared.
    const commits: CannedCommit[] = [];
    let ts = 1_000;
    for (let i = 0; i < 6; i++) commits.push({ ts: ts--, files: ['src/a.ts', 'src/b.ts'] });
    for (let i = 0; i < 4; i++) commits.push({ ts: ts--, files: ['src/a.ts'] });
    for (let i = 0; i < 6; i++) commits.push({ ts: ts--, files: ['src/b.ts'] });
    const result = analyzeLog(logOutput(commits), anyIndexed);

    const fromA = result.cochanges.get('src/a.ts');
    expect(fromA).toHaveLength(1);
    const record = fromA![0];
    // Canonical orientation: fileA < fileB.
    expect(record.fileA).toBe('src/a.ts');
    expect(record.fileB).toBe('src/b.ts');
    expect(record.sharedCommits).toBe(6);
    expect(record.confidenceAB).toBeCloseTo(6 / 10);
    expect(record.confidenceBA).toBeCloseTo(6 / 12);
    expect(partnerOf(record, 'src/a.ts')).toBe('src/b.ts');
    expect(partnerOf(record, 'src/b.ts')).toBe('src/a.ts');
    // Same record object reachable from both indexed sides.
    expect(result.cochanges.get('src/b.ts')).toEqual([record]);
  });

  it('records lastSeen from the newest shared commit', () => {
    const out = logOutput([
      { ts: 900, files: ['src/solo.ts'] },
      { ts: 800, files: ['src/a.ts', 'src/b.ts'] }, // newest shared
      { ts: 700, files: ['src/a.ts', 'src/b.ts'] },
      { ts: 600, files: ['src/a.ts', 'src/b.ts'] },
    ]);
    const result = analyzeLog(out, anyIndexed);
    expect(result.cochanges.get('src/a.ts')?.[0].lastSeen).toBe(800_000);
  });

  it('keeps non-indexed paths as denominators and partner values but never as keys', () => {
    const isIndexed = (p: string) => p.endsWith('.ts');
    const commits: CannedCommit[] = [];
    let ts = 500;
    for (let i = 0; i < 3; i++) {
      commits.push({ ts: ts--, files: ['src/auth.ts', 'config/auth.yaml'] });
    }
    // Extra yaml-only commits inflate the partner's denominator.
    for (let i = 0; i < 3; i++) commits.push({ ts: ts--, files: ['config/auth.yaml'] });
    const result = analyzeLog(logOutput(commits), isIndexed);

    expect(result.cochanges.has('config/auth.yaml')).toBe(false);
    const record = result.cochanges.get('src/auth.ts')?.[0];
    expect(record).toBeDefined();
    expect(partnerOf(record!, 'src/auth.ts')).toBe('config/auth.yaml');
    // From auth.ts's side: 3 shared / 3 commits of auth.ts.
    const confSelf = record!.fileA === 'src/auth.ts' ? record!.confidenceAB : record!.confidenceBA;
    const confPartner = record!.fileA === 'src/auth.ts' ? record!.confidenceBA : record!.confidenceAB;
    expect(confSelf).toBeCloseTo(1);
    expect(confPartner).toBeCloseTo(3 / 6);
    expect(result.hotspots).toEqual(['src/auth.ts']);
  });

  it('ignores pairs where neither side is indexed', () => {
    const isIndexed = () => false;
    const out = logOutput([
      { ts: 300, files: ['a.yaml', 'b.yaml'] },
      { ts: 200, files: ['a.yaml', 'b.yaml'] },
      { ts: 100, files: ['a.yaml', 'b.yaml'] },
    ]);
    const result = analyzeLog(out, isIndexed);
    expect(result.cochanges.size).toBe(0);
    expect(result.hotspots).toEqual([]);
    // Counts still accumulate — they are window-wide denominators.
    expect(result.counts.get('a.yaml')).toBe(3);
  });

  it('ranks hotspots by count desc then path asc, indexed only', () => {
    const isIndexed = (p: string) => p !== 'skip.yaml';
    const commits: CannedCommit[] = [];
    let ts = 1_000;
    for (let i = 0; i < 5; i++) commits.push({ ts: ts--, files: ['src/hot.ts'] });
    for (let i = 0; i < 5; i++) commits.push({ ts: ts--, files: ['skip.yaml'] });
    for (let i = 0; i < 2; i++) commits.push({ ts: ts--, files: ['src/b.ts'] });
    for (let i = 0; i < 2; i++) commits.push({ ts: ts--, files: ['src/a.ts'] });
    const result = analyzeLog(logOutput(commits), isIndexed);
    expect(result.hotspots).toEqual(['src/hot.ts', 'src/a.ts', 'src/b.ts']);
  });

  it('caps per-file partner lists at COCHANGES_PER_FILE_CAP, strongest first', () => {
    const commits: CannedCommit[] = [];
    let ts = 100_000;
    const partners = Array.from(
      { length: COCHANGES_PER_FILE_CAP + 2 },
      (_, i) => `src/p${String(i).padStart(2, '0')}.ts`,
    );
    // hub pairs with every partner 3x, except the first partner gets 4x.
    for (const p of partners) {
      const times = p === partners[0] ? 4 : 3;
      for (let i = 0; i < times; i++) commits.push({ ts: ts--, files: ['src/hub.ts', p] });
    }
    const result = analyzeLog(logOutput(commits), anyIndexed);
    const list = result.cochanges.get('src/hub.ts');
    expect(list).toHaveLength(COCHANGES_PER_FILE_CAP);
    expect(partnerOf(list![0], 'src/hub.ts')).toBe(partners[0]); // 4 shared wins
    // Remaining are tied at 3 shared → path asc; the two largest paths fell off.
    expect(list!.map((r) => partnerOf(r, 'src/hub.ts'))).not.toContain(
      partners[partners.length - 1],
    );
  });

  it('stops counting at GIT_COMMIT_CAP records', () => {
    const commits: CannedCommit[] = [];
    for (let i = 0; i < GIT_COMMIT_CAP + 5; i++) {
      commits.push({ ts: 10_000_000 - i, files: [`src/f${i % 7}.ts`] });
    }
    const result = analyzeLog(logOutput(commits), anyIndexed);
    expect(result.commitCount).toBe(GIT_COMMIT_CAP);
  });

  it('keeps HOTSPOTS_KEPT as the hotspot list bound', () => {
    const commits: CannedCommit[] = [];
    let ts = 1_000_000;
    for (let i = 0; i < HOTSPOTS_KEPT + 10; i++) {
      commits.push({ ts: ts--, files: [`src/f${String(i).padStart(3, '0')}.ts`] });
    }
    const result = analyzeLog(logOutput(commits), anyIndexed);
    expect(result.hotspots).toHaveLength(HOTSPOTS_KEPT);
  });
});

describe.skipIf(!gitAvailable)('analyzeLog against real git output', { timeout: REAL_GIT_SUITE_TIMEOUT }, () => {
  let tmp: string;
  let stderrSpy: ReturnType<typeof silenceStderr>;

  beforeEach(() => {
    tmp = makeProjectDir('codedeep-git-analyzer-');
    stderrSpy = silenceStderr();
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('round-trips non-ASCII paths unescaped (core.quotepath=false) and parses real records', async () => {
    makeGitRepo(tmp, [
      // `world` (not `aux`): a Windows reserved device name like aux/con/nul
      // cannot be created as a real file, so git add fails to stat it.
      { files: { 'src/héllo.ts': 'a', 'src/world.ts': 'b' }, message: 'add files' },
      { files: { 'src/héllo.ts': 'a2' }, message: 'touch héllo' },
      { files: { 'src/héllo.ts': 'a3', 'src/world.ts': 'b2' }, message: 'touch both' },
    ]);
    const runner = new GitRunner(tmp);
    const stdout = await runner.run(buildLogArgs(365));

    const result = analyzeLog(stdout, anyIndexed);
    expect(result.commitCount).toBe(3);
    expect(result.counts.get('src/héllo.ts')).toBe(3);
    expect(result.counts.get('src/world.ts')).toBe(2);
    // Without quotepath=false this key would be "src/h\303\251llo.ts".
    expect([...result.counts.keys()].some((k) => k.includes('\\303'))).toBe(false);
  });
});

describe('analyzeLog — subdirectory pathPrefix (monorepo package roots)', () => {
  it('strips the prefix for in-project paths and keeps outside paths as denominators', () => {
    const isIndexed = (p: string) => p === 'src/a.ts';
    const commits: CannedCommit[] = [];
    let ts = 900;
    for (let i = 0; i < 3; i++) {
      commits.push({
        ts: ts--,
        files: ['packages/app/src/a.ts', 'packages/lib/src/b.ts'],
      });
    }
    // Outside-prefix solo commits inflate the partner denominator only.
    for (let i = 0; i < 3; i++) {
      commits.push({ ts: ts--, files: ['packages/lib/src/b.ts'] });
    }
    const result = analyzeLog(logOutput(commits), isIndexed, 'packages/app/');

    expect(result.counts.get('src/a.ts')).toBe(3);
    // Outside-prefix paths are rewritten project-relative ('../'-prefixed)
    // so they can never collide with an index key.
    expect(result.counts.get('../lib/src/b.ts')).toBe(6);
    expect(result.counts.has('packages/app/src/a.ts')).toBe(false);
    expect(result.counts.has('packages/lib/src/b.ts')).toBe(false);
    expect(result.hotspots).toEqual(['src/a.ts']);

    const record = result.cochanges.get('src/a.ts')?.[0];
    expect(record).toBeDefined();
    expect(partnerOf(record!, 'src/a.ts')).toBe('../lib/src/b.ts');
    const confSelf =
      record!.fileA === 'src/a.ts' ? record!.confidenceAB : record!.confidenceBA;
    expect(confSelf).toBeCloseTo(1);
  });

  it('empty prefix (toplevel root) leaves paths untouched', () => {
    const out = logOutput([{ ts: 100, files: ['src/a.ts'] }]);
    const result = analyzeLog(out, () => true, '');
    expect(result.counts.get('src/a.ts')).toBe(1);
  });
});

describe('analyzeLog — outside-prefix key collision regression', () => {
  it('a toplevel file equal to an index key cannot merge into it', () => {
    const isIndexed = (p: string) => p === 'package.json' || p === 'src/a.ts';
    const commits: CannedCommit[] = [
      // Root dependabot churn: 4 commits to the TOPLEVEL package.json.
      { ts: 900, files: ['package.json'] },
      { ts: 800, files: ['package.json'] },
      { ts: 700, files: ['package.json'] },
      { ts: 600, files: ['package.json'] },
      // One commit to the package's OWN package.json.
      { ts: 500, files: ['packages/app/package.json'] },
    ];
    const result = analyzeLog(logOutput(commits), isIndexed, 'packages/app/');

    // The package's key holds ONLY its own commit; the toplevel file
    // lives under a '../'-relative key that can never be indexed.
    expect(result.counts.get('package.json')).toBe(1);
    expect(result.counts.get('../../package.json')).toBe(4);
    expect(result.hotspots).toEqual(['package.json']);
  });
});
