import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NoteStore } from '../../src/notes/note-store.js';
import { runForget, type ForgetDeps } from '../../src/tools/forget.js';
import type { Note } from '../../src/notes/types.js';
import { makeProjectDir, silenceStderr } from '../helpers.js';

function mkNote(id: string): Note {
  return { id, text: `note ${id}`, createdAt: '2026-07-01T00:00:00.000Z', anchors: [] };
}

describe('runForget', () => {
  let root: string;
  let notes: NoteStore;

  beforeEach(async () => {
    root = makeProjectDir('codedeep-forget-');
    notes = new NoteStore(join(root, '.codedeep', 'cache', 'notes.json'), root);
    await notes.load();
    silenceStderr();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function deps(): ForgetDeps {
    return { notes };
  }

  it('rejects an empty id in-band', async () => {
    const r = await runForget({ noteId: '  ' }, deps());
    expect(r.content[0].text).toBe('Error: noteId must be non-empty.');
  });

  it('removes an existing note and persists', async () => {
    await notes.add(mkNote('keep'));
    await notes.add(mkNote('drop'));
    const r = await runForget({ noteId: 'drop' }, deps());
    expect(r.content[0].text).toContain('✓ Forgot note drop.');
    expect(notes.all().map((n) => n.id)).toEqual(['keep']);

    const reloaded = new NoteStore(join(root, '.codedeep', 'cache', 'notes.json'), root);
    await reloaded.load();
    expect(reloaded.all().map((n) => n.id)).toEqual(['keep']);
  });

  it('reports a friendly message for an unknown id', async () => {
    const r = await runForget({ noteId: 'absent' }, deps());
    expect(r.content[0].text).toContain('No note absent found');
  });

  it('refuses to write a blocked store, surfacing the reason', async () => {
    vi.spyOn(notes, 'writeBlockReason', 'get').mockReturnValue('store quarantine failed');
    const r = await runForget({ noteId: 'x' }, deps());
    expect(r.content[0].text).toBe('Error: store quarantine failed');
  });

  it('returns an in-band error when the store throws', async () => {
    vi.spyOn(notes, 'remove').mockRejectedValue(new Error('boom'));
    const r = await runForget({ noteId: 'x' }, deps());
    expect(r.content[0].text).toBe('Error: boom');
  });
});
