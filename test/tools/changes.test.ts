import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { hashContent } from '../../src/indexer/pipeline.js';
import { NoteStore } from '../../src/notes/note-store.js';
import type { WorkingSetResult } from '../../src/git/git-service.js';
import { runChanges, type ChangesDeps } from '../../src/tools/changes.js';
import type { Symbol } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeGitStub,
  makeProjectDir,
  mkCoChange,
  mkMemberRef,
  mkSym,
  mkUnresolvedRef,
  writeTree,
} from '../helpers.js';

let tmpRoot: string;
let notes: NoteStore;

beforeEach(() => {
  tmpRoot = makeProjectDir('codedeep-changes-');
  notes = new NoteStore(join(tmpRoot, '.codedeep', 'cache', 'notes.json'), tmpRoot);
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(
  index: CodeIndex,
  workingSet: WorkingSetResult,
  ready = true,
): ChangesDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot),
    git: {
      ...makeGitStub(),
      changedFiles: vi.fn().mockResolvedValue(workingSet),
    },
    notes,
  };
}

function okSet(
  files: Array<{ path: string; status?: string }>,
  scope = 'uncommitted',
): WorkingSetResult {
  return {
    kind: 'ok',
    scope,
    files: files.map((f) => ({
      path: f.path,
      status: (f.status ?? 'modified') as never,
    })),
  };
}

// A file with one hot symbol (cross-file callers) + one cold one.
function addHotFile(idx: CodeIndex): { hot: Symbol; cold: Symbol } {
  const hot = mkSym({
    name: 'authenticate', file: 'src/auth.ts', exported: true,
    signature: 'function authenticate()', startLine: 1, endLine: 3,
  });
  const cold = mkSym({
    name: 'helper', file: 'src/auth.ts',
    signature: 'function helper()', startLine: 5, endLine: 6,
  });
  idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [hot, cold], [], []);
  // Two cross-file callers → fan-in + blast tree edges.
  for (const caller of ['src/api.ts', 'src/web.ts']) {
    const c = mkSym({
      name: `call_${caller.replace(/\W/g, '_')}`, file: caller, exported: true,
      signature: 'function c()', startLine: 1, endLine: 2,
    });
    idx.addFile(
      makeFileInfo('typescript', caller),
      [c],
      [mkUnresolvedRef(c, 'authenticate')],
      [
        {
          file: caller,
          sourceModule: './auth',
          importedNames: [{ name: 'authenticate' }],
          line: 1,
        },
      ],
    );
  }
  return { hot, cold };
}

describe('runChanges — git failure modes (load-bearing, in-band)', () => {
  it.each([
    [{ kind: 'no-repo' } as WorkingSetResult, /requires a git repository/],
    [{ kind: 'unavailable' } as WorkingSetResult, /git is unavailable/],
    [{ kind: 'transient' } as WorkingSetResult, /transiently; try again/],
    [
      { kind: 'bad-ref', detail: 'not a valid ref name' } as WorkingSetResult,
      /not a valid ref name/,
    ],
  ])('renders an honest message for %o', async (ws, pattern) => {
    const r = await runChanges({ ref: 'x' }, makeDeps(new CodeIndex(tmpRoot), ws));
    expect(r.content[0].text).toMatch(/^Error:/);
    expect(r.content[0].text).toMatch(pattern);
  });

  it('says the working tree is clean when there are no changes', async () => {
    const r = await runChanges({}, makeDeps(new CodeIndex(tmpRoot), okSet([])));
    expect(r.content[0].text).toContain('Working tree clean');
  });
});

describe('runChanges — blast radius per changed file', () => {
  it('ranks hot symbols by fan-in and shows their transitive blast', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/auth.ts' }])));
    const text = r.content[0].text;
    expect(text).toContain('## Working set — 1 changed file (uncommitted)');
    expect(text).toContain('### src/auth.ts (modified)');
    expect(text).toMatch(/authenticate\(\) — \d+\+? distinct callers across \d+ files/);
    expect(text).toContain('`impact` for the tree');
    expect(text).not.toContain('helper()'); // fan-in 0 → not a blast row
  });

  it('orders files by hottest fan-in so high-impact changes render first', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    idx.addFile(
      makeFileInfo('typescript', 'src/quiet.ts'),
      [mkSym({ name: 'lonely', file: 'src/quiet.ts', signature: 'function lonely()' })],
      [],
      [],
    );
    const r = await runChanges(
      {},
      makeDeps(idx, okSet([{ path: 'src/quiet.ts' }, { path: 'src/auth.ts' }])),
    );
    const text = r.content[0].text;
    expect(text.indexOf('src/auth.ts')).toBeLessThan(text.indexOf('src/quiet.ts'));
    expect(text).toContain('no known callers — likely safe to change in isolation');
  });

  it('marks unindexed and deleted files distinctly', async () => {
    const idx = new CodeIndex(tmpRoot);
    const r = await runChanges(
      {},
      makeDeps(
        idx,
        okSet([
          { path: 'README.md', status: 'modified' },
          { path: 'src/gone.ts', status: 'deleted' },
        ]),
      ),
    );
    const text = r.content[0].text;
    expect(text).toContain('### README.md (modified)');
    expect(text).toContain('(not indexed — excluded, unknown language, or not yet scanned)');
    expect(text).toContain('### src/gone.ts (deleted)');
    expect(text).toContain('(no indexed symbols — deleted)');
  });
});

describe('runChanges — suspect notes', () => {
  it('flags a stale note on a changed file and totals it in the tail', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    writeTree(tmpRoot, { 'src/auth.ts': 'current content\n' });
    await notes.add({
      id: 'aaaaaaaaaaaaaaaa',
      text: 'auth swallows trailing slashes — normalize first',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [{ file: 'src/auth.ts', fileContentHash: 'stale00000000000' }],
    });
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/auth.ts' }])));
    const text = r.content[0].text;
    expect(text).toContain('Notes anchored here:');
    expect(text).toContain('⚠ stale');
    expect(text).toContain('auth swallows trailing slashes');
    expect(text).toContain('(note aaaaaaaaaaaaaaaa)');
    expect(text).toMatch(/⚠ 1 note anchored to the files above is stale or missing/);
  });

  it('renders a fresh note without the suspect tail', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    const content = 'stable content\n';
    writeTree(tmpRoot, { 'src/auth.ts': content });
    await notes.add({
      id: 'bbbbbbbbbbbbbbbb',
      text: 'still-true invariant',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [{ file: 'src/auth.ts', fileContentHash: hashContent(content) }],
    });
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/auth.ts' }])));
    const text = r.content[0].text;
    expect(text).toContain('✓ fresh');
    expect(text).not.toMatch(/stale or missing/);
  });
});

describe('runChanges — co-change nudge', () => {
  it('nudges about a usual partner missing from the changeset, and only then', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    await idx.applyGitAnalysis({
      counts: new Map([['src/auth.ts', 8]]),
      cochanges: new Map([
        ['src/auth.ts', [mkCoChange('src/auth.ts', 'src/session.ts', 6, { confidenceAB: 0.75 })]],
      ]),
      hotspots: ['src/auth.ts'],
      meta: { head: 'abc', windowDays: 180, analyzedAt: Date.now() },
    });

    // Partner absent from the changeset → nudge.
    const r1 = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/auth.ts' }])));
    expect(r1.content[0].text).toMatch(
      /Usually changes with: src\/session\.ts \(\d+%\) — NOT in this changeset \[behavioral\]/,
    );

    // Partner IS in the changeset → no nudge for it.
    const r2 = await runChanges(
      {},
      makeDeps(idx, okSet([{ path: 'src/auth.ts' }, { path: 'src/session.ts' }])),
    );
    expect(r2.content[0].text).not.toContain('NOT in this changeset');
  });
});

describe('runChanges — limits, scope label, errors', () => {
  it('caps rendered files at `limit` and names the lever', async () => {
    const idx = new CodeIndex(tmpRoot);
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const r = await runChanges({ limit: 2 }, makeDeps(idx, okSet(files)));
    const text = r.content[0].text;
    expect(text).toContain('5 changed files');
    expect((text.match(/^### /gm) ?? []).length).toBe(2);
    expect(text).toContain('(3 more changed files beyond the file limit — raise `limit` (max 30).)');
  });

  it('drops config-excluded paths (its own cache dir must never self-report)', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    const r = await runChanges(
      {},
      makeDeps(
        idx,
        okSet([
          { path: 'src/auth.ts' },
          { path: '.codedeep/cache/index.json', status: 'untracked' },
          { path: 'node_modules/x/y.js', status: 'untracked' },
        ]),
      ),
    );
    const text = r.content[0].text;
    expect(text).toContain('1 changed file'); // count reflects the filtered set
    expect(text).not.toContain('.codedeep');
    expect(text).not.toContain('node_modules');
    expect(text).toContain('(2 changed files in excluded paths not shown.)');

    // ALL excluded → honest clean message, not an empty shell.
    const r2 = await runChanges(
      {},
      makeDeps(idx, okSet([{ path: '.codedeep/cache/notes.json', status: 'untracked' }])),
    );
    expect(r2.content[0].text).toContain('Working tree clean');
    expect(r2.content[0].text).toContain('(1 changed file in excluded paths not shown.)');
  });

  it('labels ref-mode scope from the service', async () => {
    const idx = new CodeIndex(tmpRoot);
    const r = await runChanges(
      { ref: 'main' },
      makeDeps(idx, okSet([{ path: 'src/a.ts', status: 'changed' }], 'vs main (committed)')),
    );
    expect(r.content[0].text).toContain('(vs main (committed))');
    expect(r.content[0].text).toContain('### src/a.ts (changed)');
  });

  it('returns an in-band error when a dependency throws', async () => {
    const idx = new CodeIndex(tmpRoot);
    const deps = makeDeps(idx, okSet([{ path: 'src/a.ts' }]));
    vi.spyOn(deps.notes, 'load').mockRejectedValue(new Error('boom'));
    const r = await runChanges({}, deps);
    expect(r.content[0].text).toMatch(/^Error: boom/);
  });
});

describe('runChanges — review-round hardening', () => {
  it('surfaces the STALE note first (actionable-first), pushing a fresh one under the cap', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    const content = 'stable content\n';
    writeTree(tmpRoot, { 'src/auth.ts': content });
    // Three FRESH recent notes (would fill the cap by recency alone) + one
    // older STALE note: severity sort must lift the stale one into view and
    // drop a fresh one below the cap, so the suspect note is never hidden.
    for (let i = 0; i < 3; i++) {
      await notes.add({
        id: `fresh${i}`.padEnd(16, '0'),
        text: `fresh note ${i}`,
        createdAt: `2026-07-0${2 + i}T00:00:00.000Z`,
        anchors: [{ file: 'src/auth.ts', fileContentHash: hashContent(content) }],
      });
    }
    await notes.add({
      id: 'staleactionable0',
      text: 'the stale one',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [{ file: 'src/auth.ts', fileContentHash: 'stale00000000000' }],
    });
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/auth.ts' }])));
    const text = r.content[0].text;
    expect(text).toContain('⚠ stale — "the stale one"'); // surfaced, not buried
    expect(text).toContain('(1 more — recall({ file: "src/auth.ts" })'); // a fresh one dropped instead
    expect(text).toMatch(/⚠ 1 note anchored to the files above is stale or missing/);
  });

  it('counts a distinct cross-file note ONCE across the changeset', async () => {
    // One note anchored to two changed files must not double-count in the tail.
    const idx = new CodeIndex(tmpRoot);
    await notes.add({
      id: 'crossfile0000000',
      text: 'invariant spanning two files',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [
        { file: 'src/a.ts', fileContentHash: 'stale00000000000' },
        { file: 'src/b.ts', fileContentHash: 'stale00000000000' },
      ],
    });
    const r = await runChanges(
      {},
      makeDeps(idx, okSet([{ path: 'src/a.ts' }, { path: 'src/b.ts' }])),
    );
    // The note renders under BOTH files, but the tally is 1 distinct note.
    expect(r.content[0].text).toMatch(/⚠ 1 note anchored to the files above is stale/);
    expect(r.content[0].text).not.toContain('2 notes anchored');
  });

  it('surfaces notes anchored to the PRE-rename path (the orphaned knowledge)', async () => {
    const idx = new CodeIndex(tmpRoot);
    await notes.add({
      id: 'orphaned00000000',
      text: 'invariant of the old path',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [{ file: 'src/old.ts', fileContentHash: 'aaaaaaaaaaaaaaaa' }],
    });
    const r = await runChanges(
      {},
      makeDeps(idx, {
        kind: 'ok',
        scope: 'uncommitted',
        files: [{ path: 'src/new.ts', status: 'renamed', origPath: 'src/old.ts' }],
      }),
    );
    const text = r.content[0].text;
    expect(text).toContain('### src/new.ts (renamed from src/old.ts)');
    expect(text).toContain('invariant of the old path');
    expect(text).toContain('✗ missing'); // the old path no longer exists on disk
    expect(text).toMatch(/⚠ 1 note anchored to the files above/);
  });

  it('describes an unindexed ref-mode file honestly (may be deleted in the range)', async () => {
    const idx = new CodeIndex(tmpRoot);
    const r = await runChanges(
      { ref: 'main' },
      makeDeps(idx, okSet([{ path: 'src/legacy.ts', status: 'changed' }], 'vs main (committed)')),
    );
    expect(r.content[0].text).toContain(
      '(not in the index — deleted in this range, or not an indexed source file)',
    );
  });

  it('nudges the next ABSENT co-change partner even when top partners are all changed', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    // 6 partners; the 5 strongest are IN the changeset, only #6 is absent.
    const partners = ['p1.ts', 'p2.ts', 'p3.ts', 'p4.ts', 'p5.ts', 'p6.ts'];
    await idx.applyGitAnalysis({
      counts: new Map([['src/auth.ts', 10]]),
      cochanges: new Map([
        [
          'src/auth.ts',
          partners.map((p, i) =>
            mkCoChange('src/auth.ts', p, 9 - i, { confidenceAB: (9 - i) / 10 }),
          ),
        ],
      ]),
      hotspots: ['src/auth.ts'],
      meta: { head: 'abc', windowDays: 180, analyzedAt: Date.now() },
    });
    const r = await runChanges(
      {},
      makeDeps(
        idx,
        okSet([{ path: 'src/auth.ts' }, ...partners.slice(0, 5).map((p) => ({ path: p }))]),
      ),
    );
    expect(r.content[0].text).toMatch(/Usually changes with: p6\.ts \(\d+%\) — NOT in this changeset/);
  });

  it('qualifies same-named members so two `send` methods are distinguishable', async () => {
    // Dogfooded on requests: sessions.py has SessionRedirectMixin.send AND
    // Session.send — bare `send()` twice is unreadable. Callers are SAME-FILE so
    // the resolved member refs survive the same-file adjacency gate and each
    // method clears the fan-in>0 blast gate.
    const idx = new CodeIndex(tmpRoot);
    const mixinSend = mkSym({
      name: 'send', file: 'src/s.ts', kind: 'method', parent: 'Mixin',
      signature: 'send()', startLine: 2, endLine: 3,
    });
    const clsSend = mkSym({
      name: 'send', file: 'src/s.ts', kind: 'method', parent: 'Session',
      signature: 'send()', startLine: 8, endLine: 9,
    });
    const c1 = mkSym({ name: 'callA', file: 'src/s.ts', kind: 'method', parent: 'Session', signature: 'callA()', startLine: 12, endLine: 13 });
    const c2 = mkSym({ name: 'callB', file: 'src/s.ts', kind: 'method', parent: 'Session', signature: 'callB()', startLine: 15, endLine: 16 });
    idx.addFile(
      makeFileInfo('typescript', 'src/s.ts'),
      [mixinSend, clsSend, c1, c2],
      [
        mkMemberRef(c1, 'send', 'self', { targetId: mixinSend.id, selfReceiver: true }),
        mkMemberRef(c2, 'send', 'self', { targetId: clsSend.id, selfReceiver: true }),
      ],
      [],
    );
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/s.ts' }])));
    const text = r.content[0].text;
    expect(text).toContain('Mixin.send()');
    expect(text).toContain('Session.send()');
    expect(text).not.toMatch(/^- send\(\) /m); // never a bare, ambiguous `send()`
  });

  it('never renders call parens on a non-callable top symbol', async () => {
    const idx = new CodeIndex(tmpRoot);
    const cls = mkSym({
      name: 'AuthService', file: 'src/svc.ts', kind: 'class', exported: true,
      signature: 'class AuthService', startLine: 1, endLine: 9,
    });
    idx.addFile(makeFileInfo('typescript', 'src/svc.ts'), [cls], [], []);
    const caller = mkSym({
      name: 'boot', file: 'src/boot.ts', exported: true,
      signature: 'function boot()', startLine: 1, endLine: 2,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/boot.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'AuthService')],
      [{ file: 'src/boot.ts', sourceModule: './svc', importedNames: [{ name: 'AuthService' }], line: 1 }],
    );
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/svc.ts' }])));
    const text = r.content[0].text;
    expect(text).toMatch(/- AuthService — \d+/);
    expect(text).not.toContain('AuthService()');
  });

  it('drops the raise-`limit` lever when limit is already at the max', async () => {
    const idx = new CodeIndex(tmpRoot);
    const files = Array.from({ length: 35 }, (_, i) => ({ path: `src/f${i}.ts` }));
    const r = await runChanges({ limit: 30 }, makeDeps(idx, okSet(files)));
    const text = r.content[0].text;
    expect(text).toContain('5 more changed files beyond the file limit');
    expect(text).not.toContain('raise `limit`');
    expect(text).toContain('`limit` is at its max');
  });

  it('keeps the first block and emits the truncation tail under a tiny max_tokens', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    const files = [
      { path: 'src/auth.ts' },
      ...Array.from({ length: 6 }, (_, i) => ({ path: `src/f${i}.ts` })),
    ];
    const r = await runChanges({ max_tokens: 30 }, makeDeps(idx, okSet(files)));
    const text = r.content[0].text;
    // The highest-impact block always renders, even over budget…
    expect(text).toContain('### src/auth.ts (modified)');
    // …and the omission is stated, not silent.
    expect(text).toContain('omitted to stay within `max_tokens`');
    expect((text.match(/^### /gm) ?? []).length).toBe(1);
  });
});

describe('runChanges — delta-review hardening', () => {
  it('shows blast radius for a renamed file whose symbols are still keyed under the OLD path', async () => {
    // The incremental re-index has not run: the index holds symbols under
    // src/old.ts, but git reports the working set as src/new.ts.
    const idx = new CodeIndex(tmpRoot);
    const hot = mkSym({
      name: 'authenticate', file: 'src/old.ts', exported: true,
      signature: 'function authenticate()', startLine: 1, endLine: 3,
    });
    idx.addFile(makeFileInfo('typescript', 'src/old.ts'), [hot], [], []);
    const caller = mkSym({ name: 'boot', file: 'src/boot.ts', exported: true, signature: 'function boot()' });
    idx.addFile(
      makeFileInfo('typescript', 'src/boot.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'authenticate')],
      [{ file: 'src/boot.ts', sourceModule: './old', importedNames: [{ name: 'authenticate' }], line: 1 }],
    );
    const r = await runChanges(
      {},
      makeDeps(idx, {
        kind: 'ok',
        scope: 'uncommitted',
        files: [{ path: 'src/new.ts', status: 'renamed', origPath: 'src/old.ts' }],
      }),
    );
    const text = r.content[0].text;
    expect(text).toContain('### src/new.ts (renamed from src/old.ts)');
    expect(text).toMatch(/authenticate\(\) — \d+/); // blast via the old-path symbols
    expect(text).not.toContain('(not indexed');
  });

  it('does NOT nudge a co-change partner that WAS changed but renamed', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    await idx.applyGitAnalysis({
      counts: new Map([['src/auth.ts', 8]]),
      cochanges: new Map([
        ['src/auth.ts', [mkCoChange('src/auth.ts', 'src/session.ts', 6, { confidenceAB: 0.75 })]],
      ]),
      hotspots: ['src/auth.ts'],
      meta: { head: 'abc', windowDays: 180, analyzedAt: Date.now() },
    });
    // session.ts WAS changed — as a rename to session-v2.ts. Its OLD path is
    // the co-change partner, so it must be recognised as present.
    const r = await runChanges(
      {},
      makeDeps(idx, {
        kind: 'ok',
        scope: 'uncommitted',
        files: [
          { path: 'src/auth.ts', status: 'modified' },
          { path: 'src/session-v2.ts', status: 'renamed', origPath: 'src/session.ts' },
        ],
      }),
    );
    expect(r.content[0].text).not.toContain('NOT in this changeset');
  });

  it('does NOT nudge a co-change partner that changed but is exclude-filtered', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    // src/auth.ts co-changes with an excluded build artifact.
    await idx.applyGitAnalysis({
      counts: new Map([['src/auth.ts', 8]]),
      cochanges: new Map([
        ['src/auth.ts', [mkCoChange('src/auth.ts', 'node_modules/x/y.js', 6, { confidenceAB: 0.75 })]],
      ]),
      hotspots: ['src/auth.ts'],
      meta: { head: 'abc', windowDays: 180, analyzedAt: Date.now() },
    });
    // The partner IS in the raw changeset but gets exclude-filtered from display;
    // it must still count as present for the nudge.
    const r = await runChanges(
      {},
      makeDeps(idx, okSet([{ path: 'src/auth.ts' }, { path: 'node_modules/x/y.js', status: 'modified' }])),
    );
    expect(r.content[0].text).not.toContain('NOT in this changeset');
  });

  it('advises `max_tokens` (not `limit`) when truncation, not the file cap, hid files', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    // limit=20 (below MAX) is NOT the constraint; a tiny max_tokens is.
    const files = [
      { path: 'src/auth.ts' },
      ...Array.from({ length: 8 }, (_, i) => ({ path: `src/f${i}.ts` })),
    ];
    const r = await runChanges({ limit: 20, max_tokens: 30 }, makeDeps(idx, okSet(files)));
    const text = r.content[0].text;
    expect(text).toContain('omitted to stay within `max_tokens`');
    expect(text).not.toContain('beyond the file limit'); // limit wasn't the constraint
    expect(text).not.toContain('raise `limit`');
  });

  it('renders a whitespace-only note as (empty), never bare quotes', async () => {
    const idx = new CodeIndex(tmpRoot);
    addHotFile(idx);
    writeTree(tmpRoot, { 'src/auth.ts': 'x\n' });
    await notes.add({
      id: 'blanknote0000000',
      text: '     ',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [{ file: 'src/auth.ts', fileContentHash: hashContent('x\n') }],
    });
    const r = await runChanges({}, makeDeps(idx, okSet([{ path: 'src/auth.ts' }])));
    const text = r.content[0].text;
    expect(text).toContain('"(empty)"');
    expect(text).not.toMatch(/— "\s+" \(note/); // not quoted blanks
  });
});
