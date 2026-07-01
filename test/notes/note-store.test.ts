import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteStore } from '../../src/notes/note-store.js';
import { NOTES_STORE_VERSION, type Note } from '../../src/notes/types.js';
import { makeProjectDir, silenceStderr, skipOnWindows, withChmod } from '../helpers.js';
import { rmSync } from 'node:fs';

function mkNote(over: Partial<Note> = {}): Note {
  return {
    id: over.id ?? 'note0001',
    text: over.text ?? 'a note',
    createdAt: over.createdAt ?? '2026-07-01T00:00:00.000Z',
    anchors: over.anchors ?? [{ file: 'src/a.ts' }],
    ...(over.head !== undefined ? { head: over.head } : {}),
  };
}

describe('NoteStore', () => {
  let root: string;
  let notesPath: string;

  beforeEach(() => {
    root = makeProjectDir('codedeep-notestore-');
    notesPath = join(root, '.codedeep', 'cache', 'notes.json');
    mkdirSync(dirname(notesPath), { recursive: true });
    silenceStderr();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('starts empty when no file exists (ENOENT)', async () => {
    const store = new NoteStore(notesPath, root);
    await store.load();
    expect(store.all()).toEqual([]);
    expect(store.isReadOnly).toBe(false);
  });

  it('persists on add and round-trips through a fresh instance', async () => {
    const a = new NoteStore(notesPath, root);
    await a.load();
    await a.add(mkNote({ id: 'n1', text: 'first' }));
    await a.add(mkNote({ id: 'n2', text: 'second' }));

    expect(existsSync(notesPath)).toBe(true);
    const onDisk = JSON.parse(readFileSync(notesPath, 'utf8'));
    expect(onDisk.version).toBe(NOTES_STORE_VERSION);
    expect(onDisk.projectRoot).toBe(root);
    expect(onDisk.notes).toHaveLength(2);

    const b = new NoteStore(notesPath, root);
    await b.load();
    expect(b.all().map((n) => n.id).sort()).toEqual(['n1', 'n2']);
  });

  it('remove returns false for an unknown id and true after deletion', async () => {
    const store = new NoteStore(notesPath, root);
    await store.load();
    await store.add(mkNote({ id: 'keep' }));
    await store.add(mkNote({ id: 'drop' }));

    expect(await store.remove('absent')).toBe(false);
    expect(await store.remove('drop')).toBe(true);
    expect(store.all().map((n) => n.id)).toEqual(['keep']);

    const reloaded = new NoteStore(notesPath, root);
    await reloaded.load();
    expect(reloaded.all().map((n) => n.id)).toEqual(['keep']);
  });

  it('quarantines (never deletes) malformed JSON and starts empty', async () => {
    writeFileSync(notesPath, '{ this is not json', 'utf8');
    const store = new NoteStore(notesPath, root);
    await store.load();

    expect(store.all()).toEqual([]);
    expect(existsSync(notesPath)).toBe(false); // moved aside
    const quarantined = readdirSync(join(root, '.codedeep', 'cache')).filter(
      (e) => e.includes('notes.json.corrupt-'),
    );
    expect(quarantined).toHaveLength(1);
    // A quarantine-SUCCESS leaves writes ENABLED (empty store is writable) but
    // the prior notes were MOVED ASIDE — so recall must be told the empty view is
    // degraded, not genuine absence. writeBlockReason stays null (writes fine).
    expect(store.isReadOnly).toBe(false);
    expect(store.degradedReason).toMatch(/moved aside/);
  });

  it('quarantines a foreign projectRoot rather than serving its notes', async () => {
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: NOTES_STORE_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectRoot: '/some/other/project',
        notes: [mkNote({ id: 'foreign' })],
      }),
      'utf8',
    );
    const store = new NoteStore(notesPath, root);
    await store.load();

    expect(store.all()).toEqual([]);
    const quarantined = readdirSync(join(root, '.codedeep', 'cache')).filter(
      (e) => e.includes('notes.json.otherroot-'),
    );
    expect(quarantined).toHaveLength(1);
    expect(store.degradedReason).toMatch(/moved aside/); // empty view is degraded
  });

  it('serves a newer-version store read-only (remember/forget refuse)', async () => {
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: NOTES_STORE_VERSION + 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectRoot: root,
        notes: [mkNote({ id: 'future' })],
      }),
      'utf8',
    );
    const store = new NoteStore(notesPath, root);
    await store.load();

    expect(store.isReadOnly).toBe(true);
    expect(store.all().map((n) => n.id)).toEqual(['future']); // still served
    // A newer-version store SERVES its notes — it is read-only, NOT degraded. A
    // zero-match filter against it is genuine no-match, so recall must NOT print a
    // "degraded" notice: degradedReason stays null (findings-#3 false positive).
    expect(store.degradedReason).toBeNull();
    await expect(store.add(mkNote({ id: 'new' }))).rejects.toThrow(/newer codedeep build/);
    await expect(store.remove('future')).rejects.toThrow(/newer codedeep build/);
  });

  it('self-loads on a mutation and does not overwrite an existing on-disk store', async () => {
    // A store already on disk; a fresh instance whose add() is called WITHOUT
    // an explicit load() must read the existing notes first, not clobber them.
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: NOTES_STORE_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectRoot: root,
        notes: [mkNote({ id: 'existing' })],
      }),
      'utf8',
    );
    const store = new NoteStore(notesPath, root);
    await store.add(mkNote({ id: 'added' })); // no explicit load() first
    expect(store.all().map((n) => n.id).sort()).toEqual(['added', 'existing']);
  });

  it('concurrent load() calls share one read (memoized)', async () => {
    await new NoteStore(notesPath, root).load(); // create dir
    const store = new NoteStore(notesPath, root);
    await Promise.all([store.load(), store.load(), store.load()]);
    expect(store.all()).toEqual([]);
  });

  it('rolls back in-memory state on a persist failure and never re-commits it', async () => {
    if (skipOnWindows) return;
    const store = new NoteStore(notesPath, root);
    await store.load();
    await store.add(mkNote({ id: 'first' })); // creates the dir + file
    // A read-only cache dir makes the next write fail (can't create the tmp).
    await withChmod(dirname(notesPath), 0o500, async () => {
      await expect(store.add(mkNote({ id: 'doomed' }))).rejects.toThrow();
    });
    // Rolled back: the failed note is gone from memory…
    expect(store.all().map((n) => n.id)).toEqual(['first']);
    // …and a later successful add persists only the new note, not 'doomed'.
    await store.add(mkNote({ id: 'second' }));
    const reloaded = new NoteStore(notesPath, root);
    await reloaded.load();
    expect(reloaded.all().map((n) => n.id).sort()).toEqual(['first', 'second']);
  });

  it('starts empty (never resurrects) when notes.json is missing but a .bak lingers', async () => {
    // notes.json absent (intentional rm, or a crash) with a leftover interrupted-
    // swap backup (unique `.bak.<pid>.<ts>` name): the store must NOT auto-restore
    // — an absent notes.json is indistinguishable from a deliberate delete, so
    // start EMPTY and preserve the .bak for MANUAL recovery.
    const bak = `${notesPath}.bak.111.222`;
    writeFileSync(
      bak,
      JSON.stringify({
        version: NOTES_STORE_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectRoot: root,
        notes: [mkNote({ id: 'ghost' })],
      }),
      'utf8',
    );
    const store = new NoteStore(notesPath, root);
    await store.load();
    expect(store.all()).toEqual([]); // NOT resurrected
    expect(existsSync(bak)).toBe(true); // preserved for manual recovery
  });

  function seedStore(id: string): void {
    writeFileSync(
      notesPath,
      JSON.stringify({
        version: NOTES_STORE_VERSION,
        createdAt: '2026-01-01T00:00:00.000Z',
        projectRoot: root,
        notes: [mkNote({ id })],
      }),
      'utf8',
    );
  }

  it('blocks writes (preserving the original) while a present notes.json is unreadable', async () => {
    if (skipOnWindows) return;
    seedStore('precious');
    const store = new NoteStore(notesPath, root);
    // A transient read failure (EACCES) on a PRESENT store must NOT start
    // empty-and-writable — the next write would clobber the un-read original.
    await withChmod(notesPath, 0o000, async () => {
      await store.load();
      expect(store.isReadOnly).toBe(true);
      expect(store.writeBlockReason).toMatch(/could not be read/);
      // Writes refused WHILE unreadable (add re-reads, re-fails, stays blocked).
      await expect(store.add(mkNote({ id: 'new' }))).rejects.toThrow();
    });
    // The original bytes are intact (writes were refused, not overwritten).
    const recovered = new NoteStore(notesPath, root);
    await recovered.load();
    expect(recovered.all().map((n) => n.id)).toEqual(['precious']);
  });

  it('recovers on a later load() once a transient read failure clears', async () => {
    if (skipOnWindows) return;
    seedStore('precious');
    const store = new NoteStore(notesPath, root);
    await withChmod(notesPath, 0o000, async () => {
      await store.load(); // fails transiently → blocked + empty, memo reset
    });
    expect(store.isReadOnly).toBe(true);
    expect(store.all()).toEqual([]);
    // Perms restored: a subsequent load() re-reads and recovers (not latched).
    await store.load();
    expect(store.isReadOnly).toBe(false);
    expect(store.all().map((n) => n.id)).toEqual(['precious']);
    await expect(store.add(mkNote({ id: 'new' }))).resolves.toBeUndefined();
  });

  it('does not latch the block if a transient failure is followed by an intentional rm', async () => {
    if (skipOnWindows) return;
    seedStore('precious');
    const store = new NoteStore(notesPath, root);
    await withChmod(notesPath, 0o000, async () => {
      await store.load(); // transient fail → blocked, memo reset
    });
    expect(store.isReadOnly).toBe(true);
    // User follows the message and deletes notes.json. The retried load() lands
    // in the ENOENT branch, which must CLEAR the block (empty store is writable).
    rmSync(notesPath);
    await store.load();
    expect(store.isReadOnly).toBe(false);
    await expect(store.add(mkNote({ id: 'fresh' }))).resolves.toBeUndefined();
  });

  it('NEVER reaps a lingering .bak on a clean load (it may hold recoverable notes)', async () => {
    // A `.bak` can be the ONLY copy of pre-crash notes: an interrupted Windows
    // swap left notes.json absent, then a fresh unrelated notes.json was written.
    // Auto-deleting it on a later clean load would be silent data loss (round-11
    // finding [0]) — so the store must preserve every .bak for manual recovery.
    const store = new NoteStore(notesPath, root);
    await store.load();
    await store.add(mkNote({ id: 'n1' })); // fresh, healthy notes.json
    const dir = dirname(notesPath);
    const bak = join(dir, `${basename(notesPath)}.bak.1.1`); // an ancient-ts name
    writeFileSync(bak, 'possibly the only copy of older notes', 'utf8');
    const reloaded = new NoteStore(notesPath, root);
    await reloaded.load(); // clean load — must NOT touch the .bak
    expect(existsSync(bak)).toBe(true);
    expect(reloaded.all().map((n) => n.id)).toEqual(['n1']);
  });

  it('flags degraded (in-band) when notes.json is missing but a .bak survives', async () => {
    // Crash-orphan case: notes.json absent, a .bak present. The load warns on
    // stderr (invisible to an MCP client) AND sets degradedReason so recall can
    // tell the agent recoverable notes may exist — not genuine emptiness ([1]).
    const dir = dirname(notesPath);
    writeFileSync(join(dir, `${basename(notesPath)}.bak.9.9`), 'older notes', 'utf8');
    const store = new NoteStore(notesPath, root);
    await store.load();
    expect(store.all()).toEqual([]); // notes.json absent → empty
    expect(store.isReadOnly).toBe(false); // an absent store is writable
    expect(store.degradedReason).toMatch(/backup/i);
  });

  it('survives an index.json wipe — notes.json is a separate file', async () => {
    const store = new NoteStore(notesPath, root);
    await store.load();
    await store.add(mkNote({ id: 'durable' }));
    // Simulate a SCHEMA_VERSION-bump / corruption wipe of the index cache.
    const indexPath = join(root, '.codedeep', 'cache', 'index.json');
    writeFileSync(indexPath, '{}', 'utf8');
    rmSync(indexPath);

    const reloaded = new NoteStore(notesPath, root);
    await reloaded.load();
    expect(reloaded.all().map((n) => n.id)).toEqual(['durable']);
  });

  it('blocks writes (preserving the original) when quarantine cannot rename', async () => {
    if (skipOnWindows) return;
    writeFileSync(notesPath, 'not json at all', 'utf8');
    const store = new NoteStore(notesPath, root);
    // A read-only cache dir makes the quarantine rename fail.
    await withChmod(dirname(notesPath), 0o500, async () => {
      await store.load();
    });
    expect(store.isReadOnly).toBe(true);
    expect(store.writeBlockReason).toMatch(/could not be read or moved aside/);
    // The un-recovered original bytes are still there, NOT overwritten.
    expect(readFileSync(notesPath, 'utf8')).toBe('not json at all');
  });

  it('only reaps its OWN temp files, never an index.json temp', async () => {
    const store = new NoteStore(notesPath, root);
    await store.load();
    await store.add(mkNote()); // creates .codedeep/cache
    const dir = join(root, '.codedeep', 'cache');
    writeFileSync(join(dir, 'notes.json.tmp.999.123'), 'stale', 'utf8');
    writeFileSync(join(dir, 'index.json.tmp.999.123'), 'keep', 'utf8');

    const fresh = new NoteStore(notesPath, root);
    await fresh.load();

    expect(existsSync(join(dir, 'notes.json.tmp.999.123'))).toBe(false);
    expect(existsSync(join(dir, 'index.json.tmp.999.123'))).toBe(true);
  });
});
