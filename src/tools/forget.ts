import { errMsg } from '../logger.js';
import { NoteStore } from '../notes/note-store.js';
import { textResponse, type ToolResponse } from './common.js';

export interface ForgetArgs {
  noteId: string;
}

export interface ForgetDeps {
  notes: NoteStore;
}

// A note delete is entirely index-independent, so — unlike remember/recall — it
// does NOT prepend the readiness banner (which would misleadingly imply the
// delete was deferred while the index is still building).
export async function runForget(
  args: ForgetArgs,
  deps: ForgetDeps,
): Promise<ToolResponse> {
  try {
    const id = (args.noteId ?? '').trim();
    if (id.length === 0) {
      return textResponse('Error: noteId must be non-empty.');
    }
    // load() first so a prior transient read failure is retried before we read
    // (and act on) the write-block flag.
    await deps.notes.load();
    const blocked = deps.notes.writeBlockReason;
    if (blocked) return textResponse(`Error: ${blocked}`);
    const removed = await deps.notes.remove(id);
    return textResponse(
      removed
        ? `✓ Forgot note ${id}.`
        : `No note ${id} found. Use recall to list note ids.`,
    );
  } catch (err) {
    return textResponse(`Error: ${errMsg(err)}`);
  }
}
