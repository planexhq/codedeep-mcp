import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { runImpact, type ImpactDeps } from '../../src/tools/impact.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  mkCoChange,
  mkGitMeta,
  mkImport,
  mkMemberRef,
  mkRef,
  mkSym,
  mkUnresolvedRef,
} from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('codedeep-impact-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(index: CodeIndex, ready = true): ImpactDeps {
  return { index, indexer: { ready }, config: makeConfig(tmpRoot) };
}

// alpha (src/a.ts) -> beta (src/b.ts) -> gamma (src/c.ts), cross-file imports.
function buildChain(idx: CodeIndex) {
  const gamma = mkSym({ name: 'gamma', file: 'src/c.ts', exported: true, startLine: 1 });
  const beta = mkSym({ name: 'beta', file: 'src/b.ts', startLine: 2 });
  const alpha = mkSym({ name: 'alpha', file: 'src/a.ts', startLine: 3 });
  idx.addFile(makeFileInfo('typescript', 'src/c.ts'), [gamma], [], []);
  idx.addFile(
    makeFileInfo('typescript', 'src/b.ts'),
    [beta],
    [mkUnresolvedRef(beta, 'gamma', 'src/b.ts', 10)],
    [mkImport('src/b.ts', './c', ['gamma'])],
  );
  idx.addFile(
    makeFileInfo('typescript', 'src/a.ts'),
    [alpha],
    [mkUnresolvedRef(alpha, 'beta', 'src/a.ts', 20)],
    [mkImport('src/a.ts', './b', ['beta'])],
  );
  return { gamma, beta, alpha };
}

async function run(idx: CodeIndex, args: Parameters<typeof runImpact>[0]) {
  return (await runImpact(args, makeDeps(idx))).content[0].text;
}

describe('runImpact — rendering', () => {
  it('renders a depth-grouped blast radius with tags and provenance', async () => {
    const idx = new CodeIndex(tmpRoot);
    buildChain(idx);
    const text = await run(idx, { file: 'src/c.ts', symbol: 'gamma' });

    expect(text).toContain('## Impact of `gamma` (src/c.ts:1)');
    expect(text).toContain('Upstream callers traced to depth 3.');
    expect(text).toContain('not compiler-verified');
    expect(text).toContain('2 callers across 2 depths (2 files).');
    expect(text).toContain('### Depth 1 — direct callers (1) — highest risk');
    expect(text).toContain('- src/b.ts:2 — beta()  [name match, unverified]');
    expect(text).toContain('### Depth 2 — callers of the above (1)');
    expect(text).toContain('- src/a.ts:3 — alpha()  [name match, unverified]');
    expect(text).toContain('← via beta()');
    // A confidence summary (distinct callers by tier) leads the response.
    expect(text).toContain('Confidence: 2 name-match (verify)');
  });

  it('confidence summary dedups diamond callers to match the N-callers headline', async () => {
    // root2 -> branchA -> target AND root2 -> branchB -> target: root2 is
    // reachable at depth 2 via two paths but is ONE distinct caller. The tier
    // summary must dedup it (like the "N callers" headline), not double-count it
    // into "Confidence: 4". (Names are ≥4 chars to clear the short-name gate.)
    const idx = new CodeIndex(tmpRoot);
    const target = mkSym({ name: 'target', file: 'src/t.ts', exported: true, startLine: 1 });
    const branchA = mkSym({ name: 'branchA', file: 'src/b.ts', exported: true, startLine: 2 });
    const branchB = mkSym({ name: 'branchB', file: 'src/c.ts', exported: true, startLine: 3 });
    const root2 = mkSym({ name: 'root2', file: 'src/a.ts', startLine: 4 });
    idx.addFile(makeFileInfo('typescript', 'src/t.ts'), [target], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [branchA],
      [mkUnresolvedRef(branchA, 'target', 'src/b.ts', 10)],
      [mkImport('src/b.ts', './t', ['target'])],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/c.ts'),
      [branchB],
      [mkUnresolvedRef(branchB, 'target', 'src/c.ts', 11)],
      [mkImport('src/c.ts', './t', ['target'])],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [root2],
      [
        mkUnresolvedRef(root2, 'branchA', 'src/a.ts', 20),
        mkUnresolvedRef(root2, 'branchB', 'src/a.ts', 21),
      ],
      [mkImport('src/a.ts', './b', ['branchA']), mkImport('src/a.ts', './c', ['branchB'])],
    );

    const text = await run(idx, { file: 'src/t.ts', symbol: 'target' });
    // branchA, branchB, root2 = 3 distinct callers (root2 deduped despite two paths).
    expect(text).toContain('3 callers across 2 depths (3 files).');
    // The confidence summary must reconcile with the headline (3), never 4.
    expect(text).toContain('Confidence: 3 name-match (verify)');
    expect(text).not.toContain('Confidence: 4');
  });

  it('reports an empty blast radius honestly', async () => {
    const idx = new CodeIndex(tmpRoot);
    const lone = mkSym({ name: 'orphan', file: 'src/x.ts', startLine: 1 });
    idx.addFile(makeFileInfo('typescript', 'src/x.ts'), [lone], [], []);

    const text = await run(idx, { file: 'src/x.ts', symbol: 'orphan' });
    expect(text).toContain('0 callers found.');
    expect(text).toContain('not proof of dead code');
  });

  it('truncates deep hops under a tight max_tokens with an honest note', async () => {
    const idx = new CodeIndex(tmpRoot);
    buildChain(idx);
    const text = await run(idx, {
      file: 'src/c.ts',
      symbol: 'gamma',
      max_tokens: 1,
    });
    // Depth 1 is the floor and always renders; depth 2 is dropped.
    expect(text).toContain('### Depth 1 — direct callers (1)');
    expect(text).not.toContain('### Depth 2');
    expect(text).toContain('(Depth 2+ omitted to stay within max_tokens=1');
  });

  it('expands weak member edges only under include_weak', async () => {
    const idx = new CodeIndex(tmpRoot);
    const proc = mkSym({
      name: 'process',
      file: 'src/c.ts',
      kind: 'method',
      parent: 'Cls',
      exported: true,
      startLine: 5,
    });
    const runner = mkSym({ name: 'runner', file: 'src/b.ts', startLine: 2 });
    const driver = mkSym({ name: 'driver', file: 'src/b.ts', startLine: 10 });
    idx.addFile(makeFileInfo('typescript', 'src/c.ts'), [proc], [], []);
    idx.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [runner, driver],
      [
        mkMemberRef(runner, 'process', 'obj', { file: 'src/b.ts', line: 3 }),
        mkRef(driver, runner),
      ],
      [],
    );

    const def = await run(idx, { file: 'src/c.ts', symbol: 'process' });
    expect(def).toContain('- src/b.ts:2 — runner()  [member call, unverified]');
    expect(def).toContain('not expanded (weak edge) — pass include_weak');
    expect(def).not.toContain('driver()');

    const weak = await run(idx, {
      file: 'src/c.ts',
      symbol: 'process',
      include_weak: true,
    });
    expect(weak).toContain('driver()');
  });

  it('surfaces depth-1 breadth truncation instead of silently undercounting', async () => {
    const idx = new CodeIndex(tmpRoot);
    const tgt = mkSym({ name: 'target', file: 'src/t.ts', startLine: 1 });
    // 30 direct callers > DEFAULT_CALLER_TREE_BREADTH (25): the excess lands in
    // root.truncatedChildren / tree.truncated, which the headline must reflect.
    const callers = Array.from({ length: 30 }, (_, i) =>
      mkSym({ name: `c${i}`, file: 'src/t.ts', startLine: 10 + i }),
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/t.ts'),
      [tgt, ...callers],
      callers.map((c) => mkRef(c, tgt)),
      [],
    );
    const text = await run(idx, { file: 'src/t.ts', symbol: 'target' });
    expect(text).toContain('25+ callers'); // the trailing + flags the cap
    expect(text).toContain('Caller discovery hit the breadth/size limit');
    // The confidence summary must carry the same incompleteness signal as the
    // headline's `+`, not present a truncated count as the complete distribution.
    expect(text).toContain('(+ more callers not shown)');
  });

  it('clamps a non-positive depth to 1 rather than reporting 0 callers', async () => {
    const idx = new CodeIndex(tmpRoot);
    buildChain(idx);
    const text = await run(idx, { file: 'src/c.ts', symbol: 'gamma', depth: 0 });
    expect(text).not.toContain('0 callers found');
    expect(text).toContain('### Depth 1 — direct callers');
  });

  it('appends co-change partners when git data is present', async () => {
    const idx = new CodeIndex(tmpRoot);
    buildChain(idx);
    await idx.applyGitAnalysis({
      counts: new Map(),
      cochanges: new Map([
        ['src/c.ts', [mkCoChange('src/c.ts', 'config/x.yaml', 5)]],
      ]),
      hotspots: [],
      meta: mkGitMeta(),
    });

    const text = await run(idx, { file: 'src/c.ts', symbol: 'gamma' });
    expect(text).toContain('### Co-change Partners [behavioral]');
    expect(text).toContain('- config/x.yaml  50% confidence');
    expect(text).toContain('May also be affected');
  });
});

describe('runImpact — resolution and errors', () => {
  it('rejects a path outside the project root', async () => {
    const idx = new CodeIndex(tmpRoot);
    const text = await run(idx, { file: '../etc/passwd', symbol: 'x' });
    expect(text).toContain('is outside the project root');
  });

  it('rejects an empty symbol', async () => {
    const idx = new CodeIndex(tmpRoot);
    idx.addFile(makeFileInfo('typescript', 'src/c.ts'), [], [], []);
    const text = await run(idx, { file: 'src/c.ts', symbol: '   ' });
    expect(text).toContain('Error: symbol must be non-empty.');
  });

  it('errors when the file is not indexed', async () => {
    const idx = new CodeIndex(tmpRoot);
    const text = await run(idx, { file: 'src/missing.ts', symbol: 'x' });
    expect(text).toContain("Error: file 'src/missing.ts' not found in index.");
  });

  it('suggests alternatives when the symbol is missing', async () => {
    const idx = new CodeIndex(tmpRoot);
    const sym = mkSym({ name: 'authenticate', file: 'src/c.ts', startLine: 1 });
    idx.addFile(makeFileInfo('typescript', 'src/c.ts'), [sym], [], []);
    const text = await run(idx, { file: 'src/c.ts', symbol: 'authenticat' });
    expect(text).toContain("Error: no symbol 'authenticat' in 'src/c.ts'.");
  });

  it('asks for a line when the name is ambiguous, then resolves with one', async () => {
    const idx = new CodeIndex(tmpRoot);
    const a = mkSym({ name: 'dup', file: 'src/c.ts', startLine: 5, endLine: 9 });
    const b = mkSym({ name: 'dup', file: 'src/c.ts', startLine: 20, endLine: 25 });
    idx.addFile(makeFileInfo('typescript', 'src/c.ts'), [a, b], [], []);

    const ambiguous = await run(idx, { file: 'src/c.ts', symbol: 'dup' });
    expect(ambiguous).toContain("Multiple symbols named 'dup'");
    expect(ambiguous).toContain('Pass `line` to disambiguate.');

    const resolved = await run(idx, { file: 'src/c.ts', symbol: 'dup', line: 21 });
    expect(resolved).toContain('## Impact of `dup` (src/c.ts:20)');
  });

  it('prepends the indexing banner when the index is not ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    buildChain(idx);
    const text = (
      await runImpact({ file: 'src/c.ts', symbol: 'gamma' }, makeDeps(idx, false))
    ).content[0].text;
    expect(text).toContain('Indexing in progress');
  });
});
