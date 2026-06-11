// Writes the run artifacts: per-call full-text dumps, run.json (structured,
// diffable), and report.md (human summary with the gap scan up top).

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { OracleResult, RepoResult, RunRecord, ToolCallRecord } from './types.js';

function dumpCall(repo: RepoResult, call: ToolCallRecord): string {
  return [
    `# ${call.tool}  (${repo.name})`,
    `args: ${JSON.stringify(call.args)}`,
    `provenance: ${call.provenance}`,
    `ok=${call.ok} empty=${call.isEmpty} error=${call.isError} bytes=${call.bytes} estTokens=${call.estTokens} wallMs=${call.wallMs.toFixed(1)}`,
    `notes: ${call.notes.join(', ') || '(none)'}`,
    '',
    '---',
    '',
    call.fullText ?? call.textPreview,
  ].join('\n');
}

const mb = (b: number) => (b / 1e6).toFixed(0);
const kb = (b: number | null) => (b === null ? '—' : (b / 1024).toFixed(0));

function toolAggregates(calls: ToolCallRecord[]): string[] {
  const byTool = new Map<string, { n: number; ok: number; empty: number; err: number }>();
  for (const c of calls) {
    let a = byTool.get(c.tool);
    if (!a) {
      a = { n: 0, ok: 0, empty: 0, err: 0 };
      byTool.set(c.tool, a);
    }
    a.n++;
    if (c.isError) a.err++;
    else if (c.isEmpty) a.empty++;
    else a.ok++;
  }
  const lines: string[] = ['| tool | calls | ok | empty | error |', '|---|---|---|---|---|'];
  for (const [tool, a] of byTool) {
    lines.push(`| ${tool} | ${a.n} | ${a.ok} | ${a.empty} | ${a.err} |`);
  }
  return lines;
}

function oracleLines(oracles: OracleResult[]): string[] {
  const order = { mismatch: 0, suspicious: 1, info: 2, clean: 3, skipped: 4 } as const;
  const sorted = [...oracles].sort((a, b) => order[a.verdict] - order[b.verdict]);
  const lines: string[] = [];
  for (const o of sorted) {
    const mark =
      o.verdict === 'mismatch' || o.verdict === 'suspicious'
        ? '⚠️'
        : o.verdict === 'clean'
          ? '✅'
          : o.verdict === 'info'
            ? 'ℹ️'
            : '⏭️';
    lines.push(`- ${mark} **${o.oracle}** · ${o.verdict} · ${o.target} — ${o.detail}`);
  }
  return lines;
}

function renderMarkdown(run: RunRecord): string {
  const L: string[] = [];
  L.push('# probe-mcp dogfooding report', '');
  L.push(
    `harness ${run.harnessVersion} · seed ${run.seed} · node ${run.node} · probe-mcp \`${run.probeMcpCommit.slice(0, 10)}\``,
    `started ${run.startedAt} · finished ${run.finishedAt} · cleanCache=${run.cleanCache}`,
    '',
  );

  // Global gap scan up top — the campaign's payload.
  L.push('## Findings (auto-detected)', '');
  let any = false;
  for (const repo of run.repos) {
    const flagged = repo.oracles.filter((o) => o.verdict === 'mismatch' || o.verdict === 'suspicious');
    if (repo.gaps.length === 0 && flagged.length === 0 && !repo.error) continue;
    any = true;
    L.push(`### ${repo.name}`);
    if (repo.error) L.push(`- ❌ ERROR: ${repo.error}`);
    for (const g of repo.gaps) L.push(`- ${g}`);
    for (const o of flagged) L.push(`- ⚠️ ${o.oracle}: ${o.target} — ${o.detail}`);
    L.push('');
  }
  if (!any) L.push('_No suspicious oracle verdicts or auto-detected gaps._', '');

  // Repo comparison.
  L.push('## Repos', '');
  L.push(
    '| repo | lang | files | symbols | indexMs | warmMs | µs/file | peakHeapMB | cacheKB | git |',
    '|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const r of run.repos) {
    if (!r.stats || !r.timing) {
      L.push(`| ${r.name} | ${r.lang} | — | — | (failed) | — | — | — | — | ${r.gitState} |`);
      continue;
    }
    const usPerFile = r.stats.totalFiles > 0 ? ((r.timing.indexAllMs * 1000) / r.stats.totalFiles).toFixed(0) : '—';
    L.push(
      `| ${r.name} | ${r.lang} | ${r.stats.totalFiles} | ${r.stats.totalSymbols} | ${r.timing.indexAllMs.toFixed(0)} | ${r.timing.indexChangedMs?.toFixed(0) ?? '—'} | ${usPerFile} | ${mb(r.timing.peakHeapBytes)} | ${kb(r.timing.cacheBytes)} | ${r.gitState} |`,
    );
  }
  L.push('');

  // Per-repo detail.
  for (const r of run.repos) {
    L.push(`## ${r.name} — detail`, '');
    L.push(`_${r.dimension}_`, '');
    L.push(`commit \`${r.commit.slice(0, 10)}\``, '');
    if (r.error) {
      L.push(`**ERROR:** ${r.error}`, '');
      continue;
    }
    if (r.stats) {
      const langs = Object.entries(r.stats.filesByLanguage)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      const kinds = Object.entries(r.stats.symbolsByKind)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      L.push(`- languages: ${langs}`);
      L.push(`- kinds: ${kinds}`);
      const otherExts = Object.entries(r.otherFilesByExt)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      if (otherExts) L.push(`- other (unparsed) files: ${otherExts}`);
      L.push('');
    }
    L.push(...toolAggregates(r.calls), '');
    L.push('**Oracles:**', ...oracleLines(r.oracles), '');
  }

  return L.join('\n');
}

export function writeReport(runDir: string, run: RunRecord): void {
  mkdirSync(runDir, { recursive: true });
  for (const repo of run.repos) {
    const counters = new Map<string, number>();
    for (const call of repo.calls) {
      const n = counters.get(call.tool) ?? 0;
      counters.set(call.tool, n + 1);
      const rel = join('calls', repo.name, call.tool, `${n}.md`);
      const abs = join(runDir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, dumpCall(repo, call));
      call.textPath = rel;
      delete call.fullText; // keep run.json lean
    }
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(join(runDir, 'report.md'), renderMarkdown(run));
}
