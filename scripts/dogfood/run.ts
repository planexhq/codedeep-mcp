// Dogfooding campaign runner. Clones pinned repos, indexes each in-process
// (the integration-test driver pattern against real code), mines the index
// for inputs, runs all five tools, checks outputs against ground-truth
// oracles, and writes run.json + report.md.
//
//   npm run dogfood                      # all repos, clean cache, warm pass
//   npm run dogfood -- --repos ky,express
//   npm run dogfood -- --seed 7 --no-warm
//   npm run dogfood -- --smoke ky        # + MCP-protocol smoke (needs dist build)

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initParser } from '../../src/indexer/parser.js';
import { createEnv, isolateCodedeepEnv, type HarnessEnv } from './harness-env.js';
import { indexWithTiming, timeWarmReload } from './index-and-time.js';
import { selectInputs, type Selection } from './input-selection.js';
import { fileSliceOracle } from './oracles/file-slice.js';
import { gitLogOracle } from './oracles/git-log.js';
import { resolutionRateOracle } from './oracles/resolution-rate.js';
import { resolvedEdgeOracle } from './oracles/resolved-edge.js';
import { ripgrepCallerOracle } from './oracles/ripgrep.js';
import { symbolSanityOracle } from './oracles/symbol-sanity.js';
import { rgCountLines } from './oracles/exec.js';
import { fetchRepo, codedeepMcpCommit } from './repo-fetch.js';
import { writeReport } from './report.js';
import { REPOS, reposByName, type RepoSpec } from './repos.js';
import { runFindReferencesSuite } from './runners/find-references.js';
import { runFindSymbolSuite } from './runners/find-symbol.js';
import { runGetContextSuite } from './runners/get-context.js';
import { runOverviewSuite } from './runners/overview.js';
import { runSearchStructureSuite } from './runners/search-structure.js';
import type { OracleResult, RepoResult, RunRecord, ToolCallRecord } from './types.js';

const HARNESS_VERSION = '1.0.0';
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..');

interface Cli {
  repos: RepoSpec[];
  seed: number;
  warm: boolean;
  smoke: string | null;
  cacheRoot: string;
  outDir: string;
}

function parseCli(argv: string[]): Cli {
  let repos = REPOS;
  let seed = 12345;
  let warm = true;
  let smoke: string | null = null;
  let cacheRoot = join(REPO_ROOT, 'dogfood-cache');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let outDir = join(REPO_ROOT, 'dogfood-runs', stamp);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repos') {
      const names = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const known = new Set(REPOS.map((r) => r.name));
      const unknown = names.filter((n) => !known.has(n));
      if (names.length === 0 || unknown.length > 0) {
        // A typo must not masquerade as a green zero-repo campaign.
        throw new Error(
          `--repos: unknown repo(s) ${unknown.join(', ') || '(none given)'}; valid: ${[...known].join(', ')}`,
        );
      }
      repos = reposByName(names);
    } else if (a === '--seed') {
      seed = Number(argv[++i]);
      if (!Number.isFinite(seed)) {
        // NaN would silently become seed 0 via `>>> 0` and serialize as
        // null in run.json — the reproducibility record would lie.
        throw new Error(`--seed: '${argv[i]}' is not a number`);
      }
    } else if (a === '--no-warm') warm = false;
    else if (a === '--warm') warm = true;
    else if (a === '--smoke') smoke = argv[++i];
    else if (a === '--cache') cacheRoot = resolve(argv[++i]);
    else if (a === '--out') outDir = resolve(argv[++i]);
  }
  return { repos, seed, warm, smoke, cacheRoot, outDir };
}

// Shared rg counter (oracles/exec.ts) — mirrors codedeep's exclude set and
// returns null when rg itself is unusable, so probes skip instead of
// silently reporting "no declarations" on machines without ripgrep.
const rgCount = rgCountLines;

function computeOtherExts(env: HarnessEnv): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of env.index.getAllFiles()) {
    if (f.language !== 'unknown') continue;
    const ext = (f.path.match(/\.[^./]+$/)?.[0] ?? '(no ext)').toLowerCase();
    out[ext] = (out[ext] ?? 0) + 1;
  }
  return out;
}

// Heuristic gap scan over the captured calls/oracles + a few targeted rg
// probes for by-design holes (enums, namespaces, decorators, constructors).
function detectGaps(
  env: HarnessEnv,
  repo: RepoSpec,
  dir: string,
  calls: ToolCallRecord[],
  oracles: OracleResult[],
): string[] {
  const gaps: string[] = [];
  const stats = env.index.getStats();
  const langs = stats.filesByLanguage;
  const hasTS = (langs.typescript ?? 0) + (langs.tsx ?? 0) > 0;
  const hasPy = (langs.python ?? 0) > 0;
  const hasJava = (langs.java ?? 0) > 0;
  const hasRust = (langs.rust ?? 0) > 0;
  const hasSwift = (langs.swift ?? 0) > 0;
  const hasCSharp = (langs.csharp ?? 0) > 0;

  const threw = calls.filter((c) => c.notes.includes('handler-threw'));
  if (threw.length) {
    gaps.push(
      `🔴 P0: ${threw.length} tool call(s) THREW (contract says handlers never throw): ${threw
        .slice(0, 3)
        .map((c) => `${c.tool} ${JSON.stringify(c.args)}`)
        .join('; ')}`,
    );
  }

  const sliceMiss = oracles.filter((o) => o.oracle === 'file-slice' && o.verdict === 'mismatch');
  if (sliceMiss.length) gaps.push(`🔴 P0: ${sliceMiss.length} get_context Body slice mismatch(es) — line drift between index and disk`);

  const rt = oracles.find((o) => o.oracle === 'symbol-sanity' && o.target.includes('round-trip') && o.verdict === 'mismatch');
  if (rt) gaps.push(`🔴 P0: re-findability — ${rt.detail}`);

  const codedeepOnly = oracles.filter((o) => o.oracle === 'ripgrep' && o.verdict === 'suspicious');
  if (codedeepOnly.length) gaps.push(`🟠 P1: ${codedeepOnly.length} find_references caller set(s) name files ripgrep never sees (possible false-positive callers)`);

  const blind = oracles.filter(
    (o) => o.oracle === 'ripgrep' && o.data && (o.data as { codedeep?: number }).symbols === 0 && ((o.data as { rg?: number }).rg ?? 0) >= 5,
  );
  if (blind.length) {
    gaps.push(
      `🟠 P1: ${blind.length} top-referenced symbol(s) with 0 codedeep callers but ripgrep sees the name in ≥5 files — likely chained/member/optional-chaining blind spot`,
    );
  }

  let floods = 0;
  for (const c of calls) {
    if (c.tool !== 'find_references') continue;
    const n = (c.fullText?.match(/\[member call, unverified\]/g) ?? []).length;
    if (n > 15) floods++;
  }
  if (floods) gaps.push(`🟡 UX: ${floods} find_references result(s) with >15 [member call, unverified] rows — real caller may be drowned`);

  const dts = env.index.getAllFiles().filter((f) => f.path.endsWith('.d.ts'));
  if (dts.length) gaps.push(`ℹ️ .d.ts parsed as TypeScript: ${dts.length} declaration file(s) indexed (inflates interface/type counts, homonym noise)`);

  // Verified probes: flag only when declarations exist in source AND the
  // index extracted zero of the corresponding kind — so these self-correct
  // when extraction support lands instead of reporting stale claims.
  // (Constructors have no probe: they ARE extracted — a constructor is a
  // method_definition named 'constructor'. An earlier unverified claim here
  // said otherwise; see the dogfood findings' G5 correction.)
  if (hasTS) {
    const kinds = stats.symbolsByKind;
    const enumsInSource = rgCount(dir, '^\\s*(export\\s+)?(declare\\s+)?(const\\s+)?enum\\s', '*.{ts,tsx}');
    if (enumsInSource !== null && enumsInSource > 0 && (kinds.enum ?? 0) === 0) {
      gaps.push(`🟠 P1: ${enumsInSource} enum declaration(s) in source but 0 enum symbols indexed`);
    }
    // Simple identifier followed by `{` only: dotted `namespace A.B` and
    // string-named `declare module "pkg"` are deliberately not extracted,
    // so counting them here would fabricate a P1 on correct behavior.
    const nsInSource = rgCount(
      dir,
      '^\\s*(export\\s+)?(declare\\s+)?(namespace|module)\\s+[A-Za-z_$][\\w$]*\\s*\\{',
      '*.{ts,tsx}',
    );
    if (nsInSource !== null && nsInSource > 0 && (kinds.module ?? 0) === 0) {
      gaps.push(`🟠 P1: ${nsInSource} namespace/module declaration(s) in source but 0 module symbols indexed`);
    }
    if (enumsInSource === null || nsInSource === null) {
      gaps.push('ℹ️ ripgrep unavailable — enum/namespace extraction probes skipped');
    }
  }

  // Java type-declaration probe, mirroring the TS enum/namespace probe:
  // flag only catastrophic under-extraction (declarations exist in source but
  // the index holds zero type-kind symbols), so it self-corrects rather than
  // reporting stale claims. Records map to 'class', annotation types and
  // interfaces to 'interface'.
  if (hasJava) {
    const kinds = stats.symbolsByKind;
    const typeSymbols = (kinds.class ?? 0) + (kinds.interface ?? 0) + (kinds.enum ?? 0);
    const typeDeclsInSource = rgCount(
      dir,
      '^\\s*((public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\\s+)*(class|interface|enum|record)\\s',
      '*.java',
    );
    if (typeDeclsInSource === null) {
      gaps.push('ℹ️ ripgrep unavailable — Java type-extraction probe skipped');
    } else if (typeDeclsInSource > 0 && typeSymbols === 0) {
      gaps.push(`🟠 P1: ${typeDeclsInSource} Java type declaration(s) in source but 0 class/interface/enum symbols indexed`);
    }
    // Info: annotation/@Nested/static-import density — context for the
    // annotation-ref and nested-type dimensions (extraction is correct; these
    // just characterize what the repo stresses).
    const staticImports = rgCount(dir, '^\\s*import\\s+static\\s', '*.java') ?? 0;
    const nested = rgCount(dir, '^\\s*@Nested\\b', '*.java') ?? 0;
    if (staticImports > 0 || nested > 0) {
      gaps.push(`ℹ️ Java: ${staticImports} static import(s), ${nested} @Nested class(es) — static-import call targets stay unresolved by design; @Nested types are extracted with simple-name FQNs`);
    }
  }

  if (hasRust) {
    const kinds = stats.symbolsByKind;
    const typeSymbols = (kinds.class ?? 0) + (kinds.interface ?? 0) + (kinds.enum ?? 0);
    const typeDeclsInSource = rgCount(
      dir,
      '^\\s*(pub(\\([^)]*\\))?\\s+)?(struct|enum|trait|union)\\s',
      '*.rs',
    );
    if (typeDeclsInSource === null) {
      gaps.push('ℹ️ ripgrep unavailable — Rust type-extraction probe skipped');
    } else if (typeDeclsInSource > 0 && typeSymbols === 0) {
      gaps.push(`🟠 P1: ${typeDeclsInSource} Rust type declaration(s) in source but 0 class/interface/enum symbols indexed`);
    }
    // Info: macros are findable as symbols, but their invocations emit no call
    // refs (token-tree args are opaque to tree-sitter) — characterizes recall.
    const macros = rgCount(dir, '^\\s*macro_rules!\\s', '*.rs') ?? 0;
    if (macros > 0) {
      gaps.push(`ℹ️ Rust: ${macros} macro_rules! definition(s) — extracted as findable symbols; macro INVOCATIONS emit no call refs (token-tree args opaque)`);
    }
  }

  if (hasSwift) {
    const kinds = stats.symbolsByKind;
    const typeSymbols = (kinds.class ?? 0) + (kinds.interface ?? 0) + (kinds.enum ?? 0);
    const typeDeclsInSource = rgCount(
      dir,
      '^\\s*((public|private|internal|fileprivate|open|final)\\s+)*(class|struct|actor|enum|protocol)\\s',
      '*.swift',
    );
    if (typeDeclsInSource === null) {
      gaps.push('ℹ️ ripgrep unavailable — Swift type-extraction probe skipped');
    } else if (typeDeclsInSource > 0 && typeSymbols === 0) {
      gaps.push(`🟠 P1: ${typeDeclsInSource} Swift type declaration(s) in source but 0 class/interface/enum symbols indexed`);
    }
    // Info: extensions are methods-apart (members keyed on the extended type,
    // like Go receivers); macro INVOCATIONS and #if-guarded decls characterize
    // recall (calls inside macro args are opaque; #if directive lines are ERROR
    // nodes but the guarded declarations still extract).
    const extensions = rgCount(dir, '^\\s*(public\\s+|private\\s+|internal\\s+|fileprivate\\s+)?extension\\s', '*.swift') ?? 0;
    if (extensions > 0) {
      gaps.push(`ℹ️ Swift: ${extensions} extension(s) — methods/properties extracted as members of their extended type (methods-apart)`);
    }
  }

  if (hasCSharp) {
    const kinds = stats.symbolsByKind;
    const typeSymbols = (kinds.class ?? 0) + (kinds.interface ?? 0) + (kinds.enum ?? 0) + (kinds.type ?? 0);
    const typeDeclsInSource = rgCount(
      dir,
      '^\\s*((public|private|protected|internal|partial|abstract|sealed|static|new|readonly|ref|file|unsafe|required)\\s+)*(class|struct|interface|enum|record|delegate)\\s',
      '*.cs',
    );
    if (typeDeclsInSource === null) {
      gaps.push('ℹ️ ripgrep unavailable — C# type-extraction probe skipped');
    } else if (typeDeclsInSource > 0 && typeSymbols === 0) {
      gaps.push(`🟠 P1: ${typeDeclsInSource} C# type declaration(s) in source but 0 class/interface/enum/type symbols indexed`);
    }
    // Info: extension methods are methods-apart (keyed on the `this`-param type,
    // like Go receivers / Dart extensions); construction `new Foo()` resolves to
    // the class via bareCallableKinds (no constructorKinds node).
    const extMethods = rgCount(dir, '\\(\\s*this\\s', '*.cs') ?? 0;
    if (extMethods > 0) {
      gaps.push(`ℹ️ C#: ~${extMethods} extension method(s) — extracted as members of the receiver type (methods-apart)`);
    }
  }

  const edge = oracles.find((o) => o.oracle === 'resolved-edge' && o.verdict === 'suspicious');
  if (edge) gaps.push(`🔴 P0: resolved-edge — ${edge.detail}`);

  const bareBroke = oracles.find(
    (o) =>
      o.oracle === 'resolution-rate' &&
      o.target.includes('bare call resolution') &&
      o.verdict === 'suspicious',
  );
  if (bareBroke) gaps.push(`🟠 P1: bare-call resolution collapsed — ${bareBroke.detail}`);

  // Decorators: TS uses PascalCase (@Injectable, @Get) — restrict to @[A-Z]
  // so JSDoc tags (@param/@returns) don't inflate the count. Python @ at
  // line start is always a real decorator (no JSDoc). Info-only line, so a
  // null (rg unusable) just coalesces to zero.
  const tsDecos = (hasTS ? rgCount(dir, '^\\s*@[A-Z]\\w', '*.{ts,tsx}') : 0) ?? 0;
  const pyDecos = (hasPy ? rgCount(dir, '^\\s*@\\w', '*.py') : 0) ?? 0;
  const decos = tsDecos + pyDecos;
  if (decos > 0) {
    gaps.push(
      `ℹ️ ${decos} decorator application(s) (ts:${tsDecos} py:${pyDecos}) — extracted as call refs, NOT findable as declarations (no "find all routes/controllers")`,
    );
  }

  const unknownCount = langs.unknown ?? 0;
  if (repo.lang === 'ruby' && unknownCount > 0) {
    const recognized = env.index.getStats().totalFiles - unknownCount;
    gaps.push(`✅ unsupported-language graceful: ${unknownCount} ${repo.lang} (+other) files scanned, 0 parsed; ${recognized} recognized source file(s)`);
  }

  return gaps;
}

async function runOneRepo(repo: RepoSpec, cli: Cli): Promise<RepoResult> {
  const restore = isolateCodedeepEnv();
  try {
    console.error(`\n[${repo.name}] fetching…`);
    const { dir, commit } = fetchRepo(repo, cli.cacheRoot);
    const scratch = join(cli.outDir, 'scratch', repo.name);
    mkdirSync(scratch, { recursive: true });

    console.error(`[${repo.name}] indexing…`);
    const env = createEnv(dir, scratch);
    const timing = await indexWithTiming(env);
    if (cli.warm) timing.indexChangedMs = await timeWarmReload(env);

    const stats = env.index.getStats();
    console.error(
      `[${repo.name}] ${stats.totalFiles} files, ${stats.totalSymbols} symbols, ` +
        `index ${timing.indexAllMs.toFixed(0)}ms, git=${env.git.state}`,
    );

    const sel = selectInputs(env.index, stats, cli.seed);

    console.error(`[${repo.name}] running tools…`);
    const calls: ToolCallRecord[] = [
      ...(await runOverviewSuite(env)),
      ...(await runFindSymbolSuite(env, sel)),
      ...(await runGetContextSuite(env, sel)),
      ...(await runFindReferencesSuite(env, sel)),
      ...(await runSearchStructureSuite(env, sel)),
    ];

    console.error(`[${repo.name}] oracles…`);
    const oracles: OracleResult[] = [];
    for (const c of calls) {
      if (c.tool === 'find_references' && c.provenance.startsWith('all/') && c.fullText) {
        oracles.push(ripgrepCallerOracle(dir, String(c.args.symbol), c.fullText));
      }
    }
    for (const t of sel.getContextSymbolTargets) {
      const rec = calls.find(
        (c) => c.tool === 'get_context' && c.args.file === t.file && c.args.symbol === t.name && c.provenance.startsWith('symbol/'),
      );
      if (rec?.fullText) oracles.push(fileSliceOracle(dir, t.file, t.startLine, t.endLine, rec.fullText));
    }
    oracles.push(...gitLogOracle(env, dir));
    oracles.push(...symbolSanityOracle(env, dir, sel));
    // Java-only: resolution quality + the field-misbind regression guard.
    // Both no-op (skipped) on repos without Java references.
    oracles.push(...resolutionRateOracle(env));
    oracles.push(...resolvedEdgeOracle(env));

    const gaps = detectGaps(env, repo, dir, calls, oracles);
    const otherFilesByExt = computeOtherExts(env);
    const gitState = env.git.state;
    env.git.close();

    return {
      name: repo.name,
      url: repo.url,
      commit,
      lang: repo.lang,
      dimension: repo.dimension,
      stats,
      timing,
      gitState,
      otherFilesByExt,
      calls,
      oracles,
      gaps,
    };
  } catch (err) {
    console.error(`[${repo.name}] FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return {
      name: repo.name,
      url: repo.url,
      commit: 'unknown',
      lang: repo.lang,
      dimension: repo.dimension,
      error: err instanceof Error ? err.message : String(err),
      stats: null,
      timing: null,
      gitState: 'error',
      otherFilesByExt: {},
      calls: [],
      oracles: [],
      gaps: [],
    };
  } finally {
    restore();
  }
}

// Minimal MCP-protocol conformance check: spawn the real stdio server with
// cwd=repo, do initialize -> tools/list -> tools/call overview over
// newline-delimited JSON-RPC. Proves the wire format + zod schemas on a
// real repo. Needs `dist/` built.
async function runProtocolSmoke(repoDir: string, scratch: string): Promise<void> {
  console.error(`\n[smoke] spawning node dist/index.js (cwd=${repoDir})…`);
  // Strip ALL ambient CODEDEEP_* vars (not just the three we set) — a shell
  // CODEDEEP_EXCLUDE would otherwise gut the spawned server's index, same
  // hazard isolateCodedeepEnv() guards the in-process path against.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k.startsWith('CODEDEEP_')) delete childEnv[k];
  }
  childEnv.CODEDEEP_CACHE_DIR = scratch;
  childEnv.CODEDEEP_WATCH = '0';
  childEnv.CODEDEEP_GIT = '0';
  const child = spawn('node', [join(REPO_ROOT, 'dist', 'index.js')], {
    cwd: repoDir,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<number, (msg: unknown) => void>();
  let buf = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { id?: number };
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* non-JSON line */
      }
    }
  });
  const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const request = (id: number, method: string, params?: object) =>
    new Promise<unknown>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timeout on ${method}`)), 60_000);
      pending.set(id, (m) => {
        clearTimeout(timer);
        res(m);
      });
      send({ jsonrpc: '2.0', id, method, params });
    });

  try {
    await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dogfood-smoke', version: '1.0.0' },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const list = (await request(2, 'tools/list', {})) as { result?: { tools?: unknown[] } };
    const toolCount = list.result?.tools?.length ?? 0;
    const call = (await request(3, 'tools/call', { name: 'overview', arguments: {} })) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = call.result?.content?.[0]?.text ?? '';
    console.error(`[smoke] ✅ tools/list → ${toolCount} tools; overview → ${text.length} chars`);
    if (toolCount !== 5) console.error(`[smoke] ⚠️ expected 5 tools, got ${toolCount}`);
    if (!text.includes('## Project:')) console.error('[smoke] ⚠️ overview output missing "## Project:" header');
  } finally {
    child.stdin.end();
    child.kill();
  }
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  console.error(
    `codedeep-mcp dogfood: ${cli.repos.length} repo(s), seed=${cli.seed}, warm=${cli.warm}` +
      (cli.smoke ? `, smoke=${cli.smoke}` : ''),
  );
  await initParser();

  const repos: RepoResult[] = [];
  const startedAt = new Date().toISOString();
  for (const repo of cli.repos) {
    repos.push(await runOneRepo(repo, cli));
  }

  if (cli.smoke) {
    const spec = REPOS.find((r) => r.name === cli.smoke);
    if (spec) {
      const { dir } = fetchRepo(spec, cli.cacheRoot);
      try {
        await runProtocolSmoke(dir, join(cli.outDir, 'scratch', `${spec.name}-smoke`));
      } catch (err) {
        console.error(`[smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      console.error(`[smoke] unknown repo '${cli.smoke}'`);
    }
  }

  const run: RunRecord = {
    harnessVersion: HARNESS_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    seed: cli.seed,
    node: process.version,
    codedeepMcpCommit: codedeepMcpCommit(REPO_ROOT),
    cleanCache: true,
    repos,
  };
  writeReport(cli.outDir, run);
  console.error(`\n✅ wrote ${join(cli.outDir, 'report.md')}`);
  console.error(`   and ${join(cli.outDir, 'run.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
