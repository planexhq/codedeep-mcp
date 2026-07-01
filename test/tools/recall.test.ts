import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { hashContent } from '../../src/indexer/pipeline.js';
import { NoteStore } from '../../src/notes/note-store.js';
import type { RecentCommit } from '../../src/git/git-service.js';
import { runRecall, type RecallDeps } from '../../src/tools/recall.js';
import { runRemember, type RememberDeps } from '../../src/tools/remember.js';
import type { FileInfo, Symbol } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeGitStub,
  makeProjectDir,
  mkSym,
  silenceStderr,
  writeTree,
} from '../helpers.js';

const AUTH = 'export function authenticate(t) { return !!t; }\n';

describe('runRecall', () => {
  let root: string;
  let index: CodeIndex;
  let notes: NoteStore;

  beforeEach(async () => {
    root = makeProjectDir('codedeep-recall-');
    index = new CodeIndex(root);
    notes = new NoteStore(join(root, '.codedeep', 'cache', 'notes.json'), root);
    await notes.load();
    silenceStderr();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function addIndexed(rel: string, content: string, syms: Symbol[] = []): void {
    writeTree(root, { [rel]: content }); // remember hashes the baseline from disk
    const fi: FileInfo = { ...makeFileInfo('typescript', rel), contentHash: hashContent(content) };
    index.addFile(fi, syms, [], []);
  }

  function rememberDeps(): RememberDeps {
    return { notes, index, indexer: { ready: true }, config: makeConfig(root), git: makeGitStub() };
  }
  function recallDeps(opts: { recentCommits?: RecentCommit[] } = {}): RecallDeps {
    return {
      notes,
      index,
      indexer: { ready: true },
      config: makeConfig(root),
      git: makeGitStub({ recentCommits: async () => opts.recentCommits ?? [] }),
    };
  }

  it('reports a note FRESH when its anchored file is unchanged', async () => {
    writeTree(root, { 'src/auth.ts': AUTH });
    const sym = mkSym({ name: 'authenticate', file: 'src/auth.ts', signature: 'authenticate(t)' });
    addIndexed('src/auth.ts', AUTH, [sym]);
    await runRemember(
      { note: 'token must be non-empty', anchors: ['src/auth.ts:authenticate'] },
      rememberDeps(),
    );

    const r = await runRecall({ symbol: 'authenticate', file: 'src/auth.ts' }, recallDeps());
    expect(r.content[0].text).toContain('✓ fresh');
    expect(r.content[0].text).toContain('token must be non-empty');
  });

  it('flags STALE with body-intact detail when only the body changed', async () => {
    writeTree(root, { 'src/auth.ts': AUTH });
    const sym = mkSym({ name: 'authenticate', file: 'src/auth.ts', signature: 'authenticate(t)' });
    addIndexed('src/auth.ts', AUTH, [sym]);
    await runRemember({ note: 'n', anchors: ['src/auth.ts:authenticate'] }, rememberDeps());

    // Edit the BODY only, then re-index (as the watcher would) so the index
    // reflects disk with the SAME symbolId — file hash changes, signature stays.
    const newBody = 'export function authenticate(t) { return Boolean(t); }\n';
    writeTree(root, { 'src/auth.ts': newBody });
    addIndexed('src/auth.ts', newBody, [sym]); // same-signature sym → same id
    const r = await runRecall(
      { file: 'src/auth.ts' },
      recallDeps({ recentCommits: [{ hash: 'def5678', date: '2026-06-30', subject: 'tidy' }] }),
    );
    expect(r.content[0].text).toContain('⚠ stale');
    expect(r.content[0].text).toContain('signature intact, body may have changed');
    expect(r.content[0].text).toContain('last commit def5678');
    expect(r.content[0].text).toContain('[behavioral]');
  });

  it('flags STALE with signature-changed detail when the signature changed', async () => {
    writeTree(root, { 'src/auth.ts': AUTH });
    const oldSym = mkSym({ name: 'authenticate', file: 'src/auth.ts', signature: 'authenticate(t)' });
    addIndexed('src/auth.ts', AUTH, [oldSym]);
    await runRemember({ note: 'n', anchors: ['src/auth.ts:authenticate'] }, rememberDeps());

    // Simulate a re-index: new signature, new symbolId, new disk content.
    writeTree(root, { 'src/auth.ts': 'export function authenticate(t, opts) {}\n' });
    index = new CodeIndex(root);
    const newSym = mkSym({ name: 'authenticate', file: 'src/auth.ts', signature: 'authenticate(t, opts)' });
    addIndexed('src/auth.ts', 'export function authenticate(t, opts) {}\n', [newSym]);

    const r = await runRecall({ file: 'src/auth.ts' }, recallDeps());
    expect(r.content[0].text).toContain('signature changed (was `authenticate(t)`)');
  });

  it('matches by query over note text', async () => {
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'token refresh has a 5-minute leeway', anchors: ['src/auth.ts'] }, rememberDeps());
    await runRemember({ note: 'unrelated styling note', anchors: ['src/auth.ts'] }, rememberDeps());
    writeTree(root, { 'src/auth.ts': AUTH });

    const r = await runRecall({ query: 'leeway' }, recallDeps());
    expect(r.content[0].text).toContain('token refresh');
    expect(r.content[0].text).not.toContain('styling note');
  });

  it('lists all notes when no filter is given', async () => {
    addIndexed('src/auth.ts', AUTH);
    writeTree(root, { 'src/auth.ts': AUTH });
    await runRemember({ note: 'note one', anchors: ['src/auth.ts'] }, rememberDeps());
    await runRemember({ note: 'note two', anchors: ['src/auth.ts'] }, rememberDeps());

    const r = await runRecall({}, recallDeps());
    expect(r.content[0].text).toContain('All notes');
    expect(r.content[0].text).toContain('note one');
    expect(r.content[0].text).toContain('note two');
  });

  it('recalls a member note by either the simple name or the FQN', async () => {
    const method = mkSym({
      name: 'login',
      file: 'src/auth.ts',
      parent: 'AuthService',
      kind: 'method',
      signature: 'login()',
    });
    addIndexed('src/auth.ts', AUTH, [method]);
    await runRemember(
      { note: 'member note', anchors: ['src/auth.ts:AuthService.login'] },
      rememberDeps(),
    );
    const byFqn = await runRecall(
      { file: 'src/auth.ts', symbol: 'AuthService.login' },
      recallDeps(),
    );
    expect(byFqn.content[0].text).toContain('member note');
    const bySimple = await runRecall({ file: 'src/auth.ts', symbol: 'login' }, recallDeps());
    expect(bySimple.content[0].text).toContain('member note');
  });

  it('filters file-anchored notes by query when both file and query are given', async () => {
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'token refresh logic', anchors: ['src/auth.ts'] }, rememberDeps());
    await runRemember({ note: 'unrelated styling', anchors: ['src/auth.ts'] }, rememberDeps());
    const r = await runRecall({ file: 'src/auth.ts', query: 'token' }, recallDeps());
    expect(r.content[0].text).toContain('token refresh');
    expect(r.content[0].text).not.toContain('unrelated styling');
  });

  it('honors query when symbol is given without file (no error)', async () => {
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'jwt handling', anchors: ['src/auth.ts'] }, rememberDeps());
    const r = await runRecall({ symbol: 'authenticate', query: 'jwt' }, recallDeps());
    expect(r.content[0].text).toContain('jwt handling');
    expect(r.content[0].text).not.toMatch(/`symbol` requires `file`/);
  });

  it('disambiguates two same-named members in one file by their class', async () => {
    const pay = mkSym({ name: 'charge', file: 'src/pay.ts', parent: 'PaymentService', kind: 'method', signature: 'charge()' });
    const refund = mkSym({ name: 'charge', file: 'src/pay.ts', parent: 'RefundService', kind: 'method', signature: 'charge()' });
    writeTree(root, { 'src/pay.ts': 'x\n' });
    index.addFile(
      { ...makeFileInfo('typescript', 'src/pay.ts'), contentHash: hashContent('x\n') },
      [pay, refund],
      [],
      [],
    );
    await runRemember({ note: 'payment charge note', anchors: ['src/pay.ts:PaymentService.charge'] }, rememberDeps());
    await runRemember({ note: 'refund charge note', anchors: ['src/pay.ts:RefundService.charge'] }, rememberDeps());

    const r = await runRecall({ file: 'src/pay.ts', symbol: 'PaymentService.charge' }, recallDeps());
    expect(r.content[0].text).toContain('payment charge note');
    expect(r.content[0].text).not.toContain('refund charge note');
  });

  it('file+query still matches the anchored symbol name (not only note text)', async () => {
    const method = mkSym({ name: 'login', file: 'src/auth.ts', parent: 'Auth', kind: 'method', signature: 'login()' });
    addIndexed('src/auth.ts', AUTH, [method]);
    await runRemember({ note: 'handles credentials', anchors: ['src/auth.ts:Auth.login'] }, rememberDeps());
    // Query names the anchored symbol; the note TEXT does not contain "login".
    const r = await runRecall({ file: 'src/auth.ts', query: 'login' }, recallDeps());
    expect(r.content[0].text).toContain('handles credentials');
  });

  it('file+query filters on note text, not the already-known anchor path', async () => {
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'token refresh logic', anchors: ['src/auth.ts'] }, rememberDeps());
    await runRemember({ note: 'styling tweak', anchors: ['src/auth.ts'] }, rememberDeps());
    // 'auth' is a substring of the anchor path but of neither note's text.
    const r = await runRecall({ file: 'src/auth.ts', query: 'auth' }, recallDeps());
    expect(r.content[0].text).toContain('No notes match');
  });

  it('flags unchecked notes beyond the limit rather than implying the area is clean', async () => {
    writeTree(root, { 'a.ts': AUTH, 'b.ts': AUTH });
    addIndexed('a.ts', AUTH);
    addIndexed('b.ts', AUTH);
    await runRemember({ note: 'stale one', anchors: ['a.ts'] }, rememberDeps());
    await new Promise((r) => setTimeout(r, 5));
    await runRemember({ note: 'fresh one', anchors: ['b.ts'] }, rememberDeps());
    writeTree(root, { 'a.ts': 'changed\n' }); // a.ts stale, b.ts fresh
    // limit 1 checks only the newest (b.ts, fresh); the stale a.ts note is unchecked.
    const r = await runRecall({ limit: 1 }, recallDeps());
    const text = r.content[0].text;
    expect(text).toContain('1 not checked'); // staleness incomplete — not "clean"
    expect(text).toMatch(/raise `limit`/);
  });

  it('surfaces a degraded/moved-aside store instead of a bare "No notes match"', async () => {
    // Empty store + a load notice ⇒ notes were quarantined/unreadable ⇒ flag it.
    // recall keys off degradedReason (the notes-unavailable signal), NOT
    // writeBlockReason (writes can be disabled while the notes still serve fine).
    vi.spyOn(notes, 'degradedReason', 'get').mockReturnValue(
      'the previous note store was malformed JSON and moved aside to …; starting empty',
    );
    const r = await runRecall({ file: 'src/auth.ts' }, recallDeps());
    expect(r.content[0].text).toContain('store is degraded');
    expect(r.content[0].text).toContain('moved aside');
  });

  it('still surfaces the degraded notice on a NON-empty recall (quarantine-then-add)', async () => {
    // After a startup quarantine (prior notes moved aside, loadNotice set) the
    // agent adds a new note. A later recall RETURNS that note, but must STILL warn
    // that the earlier notes were moved aside — the notice can't only ride on the
    // zero-match path, or the agent never learns recoverable notes exist ([2]).
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'a fresh note after quarantine', anchors: ['src/auth.ts'] }, rememberDeps());
    vi.spyOn(notes, 'degradedReason', 'get').mockReturnValue(
      'the previous note store was malformed JSON and moved aside to …; starting empty',
    );
    const r = await runRecall({ file: 'src/auth.ts' }, recallDeps());
    const text = r.content[0].text;
    expect(text).toContain('a fresh note after quarantine'); // the note IS shown
    expect(text).toContain('store is degraded'); // AND the notice rides along
    expect(text).toContain('moved aside');
  });

  it('does NOT flag "degraded" for a serving (write-blocked) store on a zero-match filter', async () => {
    // A newer-version store serves notes read-only: writeBlockReason is SET but
    // degradedReason is NULL (the notes are present, just frozen). A filter
    // matching none of them is a normal no-match — recall must not cry "degraded".
    addIndexed('src/other.ts', AUTH);
    await runRemember({ note: 'a real note', anchors: ['src/other.ts'] }, rememberDeps());
    vi.spyOn(notes, 'writeBlockReason', 'get').mockReturnValue('written by a newer build');
    vi.spyOn(notes, 'degradedReason', 'get').mockReturnValue(null); // serving, not degraded
    const r = await runRecall({ file: 'src/auth.ts' }, recallDeps()); // no notes for src/auth.ts
    expect(r.content[0].text).toContain('No notes match');
    expect(r.content[0].text).not.toContain('degraded');
  });

  it('says no notes match when the store is empty', async () => {
    const r = await runRecall({ file: 'src/auth.ts' }, recallDeps());
    expect(r.content[0].text).toContain('No notes match');
  });

  it('rejects a path-traversal file filter in-band', async () => {
    const r = await runRecall({ file: '../../etc/passwd' }, recallDeps());
    expect(r.content[0].text).toMatch(/outside the project root/);
  });

  it('rejects a symbol without a file (anchors are file-scoped)', async () => {
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'n', anchors: ['src/auth.ts'] }, rememberDeps());
    const r = await runRecall({ symbol: 'authenticate' }, recallDeps());
    expect(r.content[0].text).toMatch(/`symbol` requires `file`/);
  });

  it('returns file-anchored notes newest-first (limit keeps the most recent)', async () => {
    addIndexed('src/auth.ts', AUTH);
    // createdAt has ms resolution; force distinct timestamps so ordering is stable.
    for (const t of ['oldest note', 'middle note', 'newest note']) {
      await runRemember({ note: t, anchors: ['src/auth.ts'] }, rememberDeps());
      await new Promise((r) => setTimeout(r, 5));
    }
    const r = await runRecall({ file: 'src/auth.ts', limit: 1 }, recallDeps());
    expect(r.content[0].text).toContain('newest note');
    expect(r.content[0].text).not.toContain('oldest note');
  });

  it('labels a deleted-file note as missing, not stale', async () => {
    addIndexed('src/auth.ts', AUTH);
    await runRemember({ note: 'about auth', anchors: ['src/auth.ts'] }, rememberDeps());
    rmSync(join(root, 'src/auth.ts')); // delete the anchored file
    const r = await runRecall({ file: 'src/auth.ts' }, recallDeps());
    const text = r.content[0].text;
    expect(text).toContain('1 missing');
    expect(text).not.toContain('1 stale');
    expect(text).toContain('✗ src/auth.ts');
  });

  it('counts stale over ALL checked notes (not just shown) under a tight budget', async () => {
    addIndexed('src/auth.ts', AUTH);
    for (const t of ['note alpha', 'note bravo', 'note charlie']) {
      await runRemember({ note: t, anchors: ['src/auth.ts'] }, rememberDeps());
    }
    writeTree(root, { 'src/auth.ts': 'all three now stale\n' }); // all anchors stale
    const r = await runRecall({ file: 'src/auth.ts', max_tokens: 40 }, recallDeps());
    const text = r.content[0].text;
    // Only 1 renders under the tiny budget, but all 3 checked are reported stale
    // (truncation must not hide staleness by under-counting).
    expect(text).toMatch(/1 shown of 3 checked, 3 stale/);
    expect(text).toContain('not shown');
    expect(text).toContain('raise `max_tokens`'); // budget-break lever offered
  });
});
