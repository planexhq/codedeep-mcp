import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { hashContent } from '../../src/indexer/pipeline.js';
import { NoteStore } from '../../src/notes/note-store.js';
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
import { runForget } from '../../src/tools/forget.js';

const CONTENT = 'export function authenticate(t) { return !!t; }\n';

describe('runRemember', () => {
  let root: string;
  let index: CodeIndex;
  let notes: NoteStore;

  beforeEach(async () => {
    root = makeProjectDir('codedeep-remember-');
    index = new CodeIndex(root);
    notes = new NoteStore(join(root, '.codedeep', 'cache', 'notes.json'), root);
    await notes.load();
    silenceStderr();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Write the file to DISK (remember now hashes the baseline from disk) AND
  // register it in the index (for symbol resolution).
  function addIndexed(rel: string, content: string, syms: Symbol[] = []): void {
    writeTree(root, { [rel]: content });
    const fi: FileInfo = { ...makeFileInfo('typescript', rel), contentHash: hashContent(content) };
    index.addFile(fi, syms, [], []);
  }

  function makeDeps(
    ready = true,
    git: RememberDeps['git'] = makeGitStub(),
  ): RememberDeps {
    return { notes, index, indexer: { ready }, config: makeConfig(root), git };
  }

  it('rejects an empty note in-band', async () => {
    const r = await runRemember({ note: '   ' }, makeDeps());
    expect(r.content[0].text).toBe('Error: note must be non-empty.');
    expect(notes.all()).toHaveLength(0);
  });

  it('rejects an over-long note in-band', async () => {
    const r = await runRemember({ note: 'x'.repeat(5000) }, makeDeps());
    expect(r.content[0].text).toMatch(/too long/);
  });

  it('captures symbolId + contentHash + head for a resolved symbol anchor', async () => {
    const sym = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      signature: 'authenticate(t)',
    });
    addIndexed('src/auth.ts', CONTENT, [sym]);
    const deps = makeDeps(true, makeGitStub({ currentHead: async () => 'abc1234' }));
    const r = await runRemember(
      { note: 'token must be non-empty', anchors: ['src/auth.ts:authenticate'] },
      deps,
    );
    expect(r.content[0].text).toContain('✓ Remembered (note');
    expect(r.content[0].text).toContain('src/auth.ts:authenticate — function');

    expect(notes.all()).toHaveLength(1);
    const note = notes.all()[0];
    expect(note.head).toBe('abc1234');
    const anchor = note.anchors[0];
    expect(anchor.file).toBe('src/auth.ts');
    expect(anchor.symbol).toBe('authenticate');
    expect(anchor.symbolId).toBe(sym.id);
    expect(anchor.symbolKind).toBe('function');
    expect(anchor.signature).toBe('authenticate(t)');
    expect(anchor.fileContentHash).toBe(hashContent(CONTENT));
  });

  it('captures a file-only anchor', async () => {
    addIndexed('src/auth.ts', CONTENT);
    const r = await runRemember(
      { note: 'auth module', anchors: ['src/auth.ts'] },
      makeDeps(),
    );
    expect(r.content[0].text).toContain('src/auth.ts — file captured');
    expect(notes.all()[0].anchors[0].fileContentHash).toBe(hashContent(CONTENT));
    expect(notes.all()[0].anchors[0].symbol).toBeUndefined();
  });

  it('flags an unindexed file as an unverified anchor (still stored)', async () => {
    const r = await runRemember(
      { note: 'about a file not on disk', anchors: ['src/ghost.ts'] },
      makeDeps(),
    );
    expect(r.content[0].text).toContain('not readable on disk; stored as an unverified anchor');
    expect(notes.all()[0].anchors[0].fileContentHash).toBeUndefined();
  });

  it('flags a missing symbol but anchors at file level', async () => {
    addIndexed('src/auth.ts', CONTENT);
    const r = await runRemember(
      { note: 'x', anchors: ['src/auth.ts:doesNotExist'] },
      makeDeps(),
    );
    expect(r.content[0].text).toContain('symbol not found; anchored at file level');
    const anchor = notes.all()[0].anchors[0];
    expect(anchor.symbolId).toBeUndefined();
    expect(anchor.fileContentHash).toBe(hashContent(CONTENT));
  });

  it('rejects a path-traversal anchor in-band', async () => {
    const r = await runRemember(
      { note: 'x', anchors: ['../../etc/passwd'] },
      makeDeps(),
    );
    expect(r.content[0].text).toMatch(/outside the project root/);
    expect(notes.all()).toHaveLength(0);
  });

  it('stores an anchorless note but warns it is not tracked', async () => {
    const r = await runRemember({ note: 'a stray thought' }, makeDeps());
    expect(r.content[0].text).toContain('No anchors');
    expect(notes.all()).toHaveLength(1);
    expect(notes.all()[0].anchors).toEqual([]);
  });

  it('refuses to write a read-only (newer-version) store', async () => {
    vi.spyOn(notes, 'writeBlockReason', 'get').mockReturnValue('newer build, disabled');
    const r = await runRemember({ note: 'x', anchors: ['src/a.ts'] }, makeDeps());
    expect(r.content[0].text).toBe('Error: newer build, disabled');
  });

  it('captures the DISK hash as baseline, not the lagging index hash', async () => {
    // The index holds an OLD hash; disk holds the current bytes. remember must
    // snapshot the disk hash so the note is not born stale on the first recall.
    writeTree(root, { 'src/auth.ts': CONTENT });
    const fi: FileInfo = {
      ...makeFileInfo('typescript', 'src/auth.ts'),
      contentHash: 'staleindexhash00', // deliberately wrong (index lagged disk)
    };
    index.addFile(fi, [], [], []);
    await runRemember({ note: 'n', anchors: ['src/auth.ts'] }, makeDeps());
    expect(notes.all()[0].anchors[0].fileContentHash).toBe(hashContent(CONTENT));
  });

  it('resolves an FQN-style Class.member symbol anchor', async () => {
    const method = mkSym({
      name: 'login',
      file: 'src/auth.ts',
      parent: 'AuthService',
      kind: 'method',
      signature: 'login(pw)',
    });
    addIndexed('src/auth.ts', CONTENT, [method]);
    const r = await runRemember(
      { note: 'n', anchors: ['src/auth.ts:AuthService.login'] },
      makeDeps(),
    );
    // Stored + displayed under the QUALIFIED name so recall can disambiguate.
    expect(r.content[0].text).toContain('src/auth.ts:AuthService.login — method');
    const anchor = notes.all()[0].anchors[0];
    expect(anchor.symbolId).toBe(method.id);
    expect(anchor.symbol).toBe('AuthService.login');
  });

  it('parses and resolves a :: scope-resolution symbol anchor', async () => {
    const method = mkSym({
      name: 'Get',
      file: 'src/db.cpp',
      parent: 'DBImpl',
      kind: 'method',
      signature: 'Get()',
    });
    addIndexed('src/db.cpp', 'struct DBImpl { void Get(); };\n', [method]);
    const r = await runRemember(
      { note: 'n', anchors: ['src/db.cpp:DBImpl::Get'] },
      makeDeps(),
    );
    // '::' must NOT be mis-split into the file part; resolves via the dotted fqn
    // and is stored/displayed under the qualified name.
    expect(r.content[0].text).toContain('src/db.cpp:DBImpl.Get — method');
    expect(notes.all()[0].anchors[0].symbolId).toBe(method.id);
    expect(notes.all()[0].anchors[0].symbol).toBe('DBImpl.Get');
  });

  it('treats file:<digits> as a line (file-level anchor), not a symbol named after a number', async () => {
    addIndexed('src/auth.ts', CONTENT);
    const r = await runRemember({ note: 'n', anchors: ['src/auth.ts:42'] }, makeDeps());
    expect(r.content[0].text).toContain('src/auth.ts — file captured');
    expect(notes.all()[0].anchors[0].symbol).toBeUndefined();
  });

  it('treats file:line:col (grep/editor paste) as a location, not a symbol named "10"', async () => {
    addIndexed('src/auth.ts', CONTENT);
    const r = await runRemember({ note: 'n', anchors: ['src/auth.ts:10:20'] }, makeDeps());
    // line 10, column 20 → a file-level anchor, NOT a phantom "symbol not found"
    // for a symbol literally named "10" (and the location is not lost).
    expect(r.content[0].text).toContain('src/auth.ts — file captured');
    expect(r.content[0].text).not.toContain('symbol not found');
    expect(notes.all()[0].anchors[0].symbol).toBeUndefined();
  });

  it('does not falsely claim "symbol not found" while the index is still building', async () => {
    // The file is on disk (baseline hash captured) but not yet indexed. During
    // warm-up (ready=false) a real symbol looks absent — remember must NOT claim
    // it does not exist; it anchors by name so recall can still find the note.
    writeTree(root, { 'src/auth.ts': CONTENT }); // on disk, NOT added to the index
    const r = await runRemember(
      { note: 'about authenticate', anchors: ['src/auth.ts:authenticate'] },
      makeDeps(false), // indexer.ready === false
    );
    const text = r.content[0].text;
    expect(text).toContain('index still building');
    expect(text).not.toContain('symbol not found');
    const anchor = notes.all()[0].anchors[0];
    expect(anchor.symbol).toBe('authenticate'); // stored by name (recall can match)
    expect(anchor.symbolId).toBeUndefined(); // no baseline id → file-level staleness
    expect(anchor.fileContentHash).toBe(hashContent(CONTENT)); // baseline still captured
  });

  it('parses a single-letter filename with a symbol (not as a drive letter)', async () => {
    const fn = mkSym({ name: 'run', file: 'm', signature: 'run()' });
    addIndexed('m', 'export function run() {}\n', [fn]);
    const r = await runRemember({ note: 'n', anchors: ['m:run'] }, makeDeps());
    expect(r.content[0].text).toContain('m:run — function');
    expect(notes.all()[0].anchors[0].symbolId).toBe(fn.id);
  });

  it('rejects an anchor missing a file part with a clear message', async () => {
    const r = await runRemember({ note: 'n', anchors: [':authenticate'] }, makeDeps());
    expect(r.content[0].text).toMatch(/missing a file part/);
    expect(notes.all()).toHaveLength(0);
  });

  it('treats a :0 line-spec as no pin (rejects it, so an ambiguous name stays ambiguous)', async () => {
    const a = mkSym({ name: 'dup', file: 'src/auth.ts', startLine: 5, endLine: 6 });
    const b = mkSym({ name: 'dup', file: 'src/auth.ts', startLine: 20, endLine: 21, signature: 'dup2' });
    addIndexed('src/auth.ts', CONTENT, [a, b]);
    const r = await runRemember({ note: 'n', anchors: ['src/auth.ts:dup:0'] }, makeDeps());
    // :0 is not a valid 1-based line, so it must NOT silently pin an overload.
    expect(r.content[0].text).toContain('share this name');
    expect(notes.all()[0].anchors[0].symbolId).toBeUndefined();
  });

  it('generates collision-free ids across forget+re-remember of the same text', async () => {
    addIndexed('src/auth.ts', CONTENT);
    await runRemember({ note: 'same text', anchors: ['src/auth.ts'] }, makeDeps());
    const firstId = notes.all()[0].id;
    await runForget({ noteId: firstId }, { notes });
    await runRemember({ note: 'same text', anchors: ['src/auth.ts'] }, makeDeps());
    expect(notes.all()[0].id).not.toBe(firstId);
  });

  it('returns an in-band error when the store throws', async () => {
    vi.spyOn(notes, 'add').mockRejectedValue(new Error('disk full'));
    const r = await runRemember({ note: 'x', anchors: ['src/a.ts'] }, makeDeps());
    expect(r.content[0].text).toBe('Error: disk full');
  });
});
