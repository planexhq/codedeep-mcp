// Behavioral oracle: codedeep's hotspots and co-change partners come from a
// git-log analysis; here we re-derive the same signals from raw `git log`
// and check bounded agreement. codedeep filters to indexed paths and skips
// >30-file commits, so we mirror those filters and compare rankings/subsets
// rather than demanding equality.

import { GIT_COMMIT_CAP } from '../../../src/git/analyzer.js';
import type { HarnessEnv } from '../harness-env.js';
import { tryExec } from './exec.js';
import type { OracleResult } from '../types.js';

const MAX_FILES_PER_COMMIT = 30; // analyzer skips commits above this

interface RawCommit {
  files: string[];
}

// Mirrors the analyzer's invocation shape: the same config pins
// (core.quotepath would octal-escape non-ASCII paths so they never match
// index keys; log.showSignature would inject gpg lines this parser would
// count as file paths) and the same commit cap — without the cap, a
// >10k-commit window would make the oracle count history codedeep never saw.
function rawCommits(repoDir: string, windowDays: number): RawCommit[] | null {
  const { stdout, status } = tryExec(
    'git',
    [
      '-c', 'core.quotepath=false',
      '-c', 'log.showSignature=false',
      'log',
      `--since=${windowDays} days ago`,
      '--no-merges',
      '--no-renames',
      '--name-only',
      `--max-count=${GIT_COMMIT_CAP}`,
      '--pretty=format:\x01%H',
    ],
    repoDir,
  );
  if (status !== 0) return null;
  const commits: RawCommit[] = [];
  let cur: RawCommit | null = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('\x01')) {
      cur = { files: [] };
      commits.push(cur);
    } else if (cur && line.trim().length > 0) {
      cur.files.push(line.trim());
    }
  }
  return commits;
}

export function gitLogOracle(env: HarnessEnv, repoDir: string): OracleResult[] {
  if (env.git.state !== 'ready' || env.index.getGitMeta() === null) {
    return [
      {
        oracle: 'git-log',
        target: 'behavioral signals',
        verdict: 'skipped',
        detail: `git state '${env.git.state}', no analysis to verify`,
      },
    ];
  }
  const windowDays = env.index.getGitMeta()!.windowDays;
  const commits = rawCommits(repoDir, windowDays);
  if (commits === null) {
    return [{ oracle: 'git-log', target: 'behavioral signals', verdict: 'skipped', detail: 'raw git log failed' }];
  }

  const out: OracleResult[] = [];

  // --- Hotspots ---
  const counts = new Map<string, number>();
  for (const c of commits) {
    if (c.files.length > MAX_FILES_PER_COMMIT) continue;
    for (const f of c.files) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const rawRankedIndexed = [...counts.entries()]
    .filter(([f]) => env.index.hasFile(f))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([f]) => f);
  const rawTop15 = new Set(rawRankedIndexed.slice(0, 15));
  const codedeepHot = env.index.getHotspots(10);
  const codedeepTop5 = codedeepHot.slice(0, 5).map((h) => h.path);
  const overlap = codedeepTop5.filter((p) => rawTop15.has(p));
  // Count agreement on the single top hotspot.
  const topCodedeep = codedeepHot[0];
  const topRaw = topCodedeep ? counts.get(topCodedeep.path) ?? 0 : 0;
  out.push({
    oracle: 'git-log',
    target: 'overview hotspots',
    verdict: codedeepHot.length === 0 ? 'info' : overlap.length >= Math.min(3, codedeepTop5.length) ? 'clean' : 'suspicious',
    detail:
      codedeepHot.length === 0
        ? 'codedeep reported no hotspots'
        : `${overlap.length}/${codedeepTop5.length} codedeep top-5 hotspots are in raw indexed top-15; top hotspot count codedeep=${topCodedeep?.commits} raw=${topRaw}`,
    data: { codedeepTop5, rawTop10: rawRankedIndexed.slice(0, 10), topCodedeepCount: topCodedeep?.commits, topRawCount: topRaw },
  });

  // --- Co-change of the top hotspot ---
  const hub = codedeepHot[0]?.path;
  if (hub) {
    const shared = new Map<string, number>();
    for (const c of commits) {
      if (c.files.length > MAX_FILES_PER_COMMIT) continue;
      if (!c.files.includes(hub)) continue;
      for (const f of c.files) {
        if (f === hub) continue;
        shared.set(f, (shared.get(f) ?? 0) + 1);
      }
    }
    const rawPartners = new Set([...shared.entries()].filter(([, n]) => n >= 3).map(([f]) => f));
    const codedeepPartners = env.index.getCoChanges(hub).map((cc) => (cc.fileA === hub ? cc.fileB : cc.fileA));
    const notInRaw = codedeepPartners.filter((p) => !rawPartners.has(p));
    out.push({
      oracle: 'git-log',
      target: `co-change partners of ${hub}`,
      verdict: codedeepPartners.length === 0 ? 'info' : notInRaw.length === 0 ? 'clean' : 'suspicious',
      detail:
        codedeepPartners.length === 0
          ? 'codedeep found no co-change partners for the top hotspot'
          : `${codedeepPartners.length} codedeep partners; ${notInRaw.length} not in raw (>=3 shared) set of ${rawPartners.size}`,
      data: { codedeepPartners, notInRaw, rawPartnerCount: rawPartners.size },
    });
  }

  return out;
}
