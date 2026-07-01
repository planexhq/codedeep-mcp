import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import * as parserModule from '../../src/indexer/parser.js';
import { Indexer } from '../../src/indexer/pipeline.js';
import { NoteStore } from '../../src/notes/note-store.js';
import { runForget } from '../../src/tools/forget.js';
import { runRecall, type RecallDeps } from '../../src/tools/recall.js';
import { runRemember, type RememberDeps } from '../../src/tools/remember.js';
import type { CodedeepConfig } from '../../src/types.js';
import {
  makeConfig,
  makeGitStub,
  makeProjectDir,
  silenceStderr,
  writeTree,
} from '../helpers.js';

const ROUTER_V1 = 'def parse_route(path):\n    return path.rstrip("/")\n';
const APP = 'from router import parse_route\n\n\ndef handle(path):\n    return parse_route(path)\n';

beforeAll(async () => {
  await parserModule.initParser();
});

// End-to-end keystone proof: a real tree-sitter index over a FastAPI-shaped
// router chain, the real Indexer (so recall's best-effort indexFile refresh
// runs for real), and the real NoteStore on disk. Proves the staleness
// anchoring across body edit / signature change / removal / cache wipe.
describe('notes integration: remember → recall staleness', () => {
  let root: string;
  let index: CodeIndex;
  let indexer: Indexer;
  let config: CodedeepConfig;
  let notes: NoteStore;
  let noteId: string;

  async function recallDeps(): Promise<RecallDeps> {
    return { notes, index, indexer, config, git: makeGitStub() };
  }

  beforeEach(async () => {
    root = makeProjectDir('codedeep-notes-int-');
    writeTree(root, { 'router.py': ROUTER_V1, 'app.py': APP });
    config = makeConfig(root);
    index = new CodeIndex(root);
    indexer = new Indexer(config, index);
    silenceStderr();
    await indexer.indexAll();

    notes = new NoteStore(join(config.cacheDir, 'notes.json'), root);
    await notes.load();

    const rememberDeps: RememberDeps = {
      notes,
      index,
      indexer,
      config,
      git: makeGitStub(),
    };
    const out = await runRemember(
      {
        note: 'parse_route strips trailing slashes — normalize before comparing',
        anchors: ['router.py:parse_route', 'app.py'],
      },
      rememberDeps,
    );
    expect(out.content[0].text).toContain('✓ Remembered');
    expect(out.content[0].text).toContain('router.py:parse_route — function');
    noteId = notes.all()[0].id;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('is FRESH when source is unchanged', async () => {
    const r = await runRecall({ symbol: 'parse_route', file: 'router.py' }, await recallDeps());
    const text = r.content[0].text;
    expect(text).toContain('✓ fresh');
    expect(text).toContain('strips trailing slashes');
  });

  it('reports body-change vs signature-intact when only the body changes', async () => {
    writeTree(root, {
      'router.py': 'def parse_route(path):\n    return path.removesuffix("/")\n',
    });
    await indexer.indexFile('router.py'); // the watcher would re-index; recall won't
    const r = await runRecall({ file: 'router.py' }, await recallDeps());
    const text = r.content[0].text;
    expect(text).toContain('⚠ stale');
    expect(text).toContain('signature intact, body may have changed');
  });

  it('reports a signature change', async () => {
    writeTree(root, {
      'router.py': 'def parse_route(path, strict):\n    return path\n',
    });
    await indexer.indexFile('router.py'); // the watcher would re-index; recall won't
    const r = await runRecall({ file: 'router.py' }, await recallDeps());
    expect(r.content[0].text).toContain('signature changed');
  });

  it('reports the symbol as renamed or removed', async () => {
    writeTree(root, { 'router.py': '# parse_route deleted\nX = 1\n' });
    await indexer.indexFile('router.py'); // the watcher would re-index; recall won't
    const r = await runRecall({ file: 'router.py' }, await recallDeps());
    expect(r.content[0].text).toContain('renamed or removed');
  });

  it('survives an index cache wipe (notes are a separate file)', async () => {
    // Simulate a SCHEMA_VERSION-bump / corruption wipe: a brand-new index with
    // no cache, re-built from source — and a fresh NoteStore over the same
    // notes.json. The note must still load and re-resolve.
    const freshIndex = new CodeIndex(root);
    const freshIndexer = new Indexer(config, freshIndex);
    await freshIndexer.indexAll();
    const freshNotes = new NoteStore(join(config.cacheDir, 'notes.json'), root);
    await freshNotes.load();
    expect(freshNotes.all().map((n) => n.id)).toEqual([noteId]);

    const r = await runRecall(
      { file: 'router.py' },
      { notes: freshNotes, index: freshIndex, indexer: freshIndexer, config, git: makeGitStub() },
    );
    const text = r.content[0].text;
    expect(text).toContain(noteId);
    expect(text).toContain('✓ fresh'); // source unchanged ⇒ re-resolves to fresh
  });

  it('forget removes the note', async () => {
    const f = await runForget({ noteId }, { notes });
    expect(f.content[0].text).toContain(`✓ Forgot note ${noteId}`);
    const r = await runRecall({ file: 'router.py' }, await recallDeps());
    expect(r.content[0].text).toContain('No notes match');
  });
});
