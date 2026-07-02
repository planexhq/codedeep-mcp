import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { errMsg, log } from '../logger.js';
import {
  NOTES_STORE_VERSION,
  type Anchor,
  type Note,
  type NotesStore,
} from './types.js';

// Durable, agent-curated note store backing `remember` / `recall` / `forget`.
//
// Lifecycle is deliberately the OPPOSITE of CodeIndex on unreadable/foreign
// data: the index DELETES (it is rebuildable), the note store QUARANTINES
// (notes are not rebuildable). The store NEVER fs.unlink's notes.json, and any
// failure degrades to an empty in-memory store rather than throwing out of a
// tool call.
//
// Concurrency: every mutation is a whole-store read-modify-write persisted via
// an atomic temp+fsync+rename (mirroring CodeIndex.save), serialized behind an
// in-process write lock. N is expected to be tens–hundreds of notes, so a full
// rewrite per remember/forget is cheap and crash-safe.
//
// KNOWN LIMITATION (MVP): the lock is IN-PROCESS only. Two codedeep servers on
// the same repo sharing one notes.json can lost-update each other (each has its
// own snapshot from load()). Acceptable for the single-agent-per-repo common
// case; a cross-process file lock is deferred (see project memory).
export class NoteStore {
  private notes: Note[] = [];
  private loadPromise: Promise<void> | null = null;
  // Non-null when writes are blocked (and the reason). Set when the on-disk
  // store was written by a NEWER build (recall still serves it; remember/forget
  // refuse so we never down-convert and clobber it), when a corrupt/foreign
  // store could NOT be quarantined (so a later persist can't overwrite the
  // un-recovered original), when notes.json is PRESENT but unreadable
  // (transient lock/EACCES — a write would rename-over the un-read original),
  // OR when notes.json is MISSING but a `.bak` survives (a write would clobber
  // the manual restore our own message invites).
  private writeBlocked: string | null = null;
  // Non-null when the store's NOTES are unavailable at load — a corrupt/foreign
  // store that was quarantined (moved aside, success OR fail) or a
  // transiently-unreadable one — so an empty view is NOT genuine absence. recall
  // surfaces it. Distinct from writeBlocked: a newer-version store still SERVES
  // its notes (no loadNotice), and a quarantine-SUCCESS leaves writes enabled
  // (no writeBlocked) yet the prior notes were moved aside (loadNotice set).
  private loadNotice: string | null = null;
  // Identity of the blocked/degraded state the LAST load ended in (null =
  // healthy). Three states reset loadPromise so every tool call re-loads
  // (missing-with-.bak, present-but-unreadable, quarantine-rename-failure) —
  // their stderr warns fire only on ENTERING the state (key change across
  // consecutive loads), not once per recall/remember/forget forever. The
  // in-band loadNotice still rides every response. The .bak state keys on the
  // backup NAME SET, so exiting and re-entering with different backups (e.g.
  // one restored, notes.json rm'd again) is a NEW entry and warns again.
  private blockedWarnKey: string | null = null;
  private storeCreatedAt: string | null = null;
  private writeLock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly notesPath: string,
    private readonly projectRoot: string,
  ) {}

  get isReadOnly(): boolean {
    return this.writeBlocked !== null;
  }

  get writeBlockReason(): string | null {
    return this.writeBlocked;
  }

  // A user-facing notice that the store's notes are unavailable/were moved aside
  // (so recall can distinguish a degraded empty view from genuine emptiness).
  get degradedReason(): string | null {
    return this.loadNotice;
  }

  // Idempotent and concurrency-safe (memoized): reads notes.json, validating
  // shape. Missing file → empty store. Unparseable / shape-invalid / foreign
  // projectRoot → quarantine the bytes aside and start empty. A newer on-disk
  // version → read-only. load() is awaited at startup, and every mutation
  // awaits it too, so a write can never race or precede the initial read.
  load(): Promise<void> {
    this.loadPromise ??= this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    // Clear the block + notice up front so EVERY (re-)load starts from a clean
    // slate — the branches below re-set them only when they genuinely must
    // (unreadable / newer-version / quarantine / missing-with-.bak). This is
    // the single reset point, so a retried load ending in ANY branch recovers
    // instead of latching stale state. `prevWarnKey` is captured here for the
    // same reason: the per-call-retry branches warn only on ENTERING their state.
    const prevWarnKey = this.blockedWarnKey;
    this.blockedWarnKey = null;
    this.writeBlocked = null;
    this.loadNotice = null;
    await this.cleanupStaleTmp();

    let raw: string;
    try {
      raw = await fs.readFile(this.notesPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        // notes.json is PRESENT but unreadable (a transient Windows lock / EACCES
        // glitch). Do NOT start empty-and-writable — the next write's atomic
        // rename-over would destroy the still-present, un-read original. Block
        // writes so the real notes survive; recall surfaces the block. This is a
        // TRANSIENT condition, so reset the load memo (loadPromise) — the next
        // tool call's load() re-reads and recovers once the lock/perm clears.
        this.writeBlocked =
          `the note store at ${this.notesPath} could not be read (${errMsg(err)}); ` +
          `writes are disabled until it becomes readable (retried each tool call) — ` +
          `or recover/delete it manually.`;
        this.loadNotice = this.writeBlocked; // notes are unavailable this session
        this.blockedWarnKey = 'unreadable';
        if (prevWarnKey !== this.blockedWarnKey) {
          log.warn(
            `NoteStore.load: failed to read ${this.notesPath}: ${errMsg(err)}; writes disabled (retried each tool call)`,
          );
        }
        this.loadPromise = null; // transient → allow the next load() to re-read
        return;
      }
      // notes.json is absent → start empty, but if an interrupted-swap backup is
      // present, warn AND surface it in-band (we never auto-restore — see
      // warnIfBackupPresent). Crucially, BLOCK WRITES and reset the load memo:
      // the message invites a manual `.bak`→notes.json restore, and with the
      // empty view memoized and writable, the very next remember's atomic
      // rename-over would CLOBBER the file the user just restored — destroying
      // exactly the notes we told them to recover. Mirroring the
      // transient-unreadable pattern (block + re-read each tool call) makes the
      // advertised manual path survivable: restore → next load serves the real
      // notes and re-enables writes; delete the .bak instead → next load starts
      // empty-and-writable. Race-free because writes throw before mutating.
      //
      // ADJUDICATED TRADEOFF: this block also captures a stale ORPHAN .bak
      // (successful Windows swap whose final unlink failed) followed by an
      // intentional `rm notes.json` — that user hits a write outage until they
      // delete the orphan. Post-hoc the two cases are indistinguishable on
      // disk, notes are non-rebuildable, and the error message names the exact
      // one-command remediation — so data-safety wins over availability here.
      // Do not weaken the block without a way to tell the cases apart.
      const baks = await this.detectBackups();
      if (baks.length > 0) {
        // Key on the backup NAME SET so a genuine re-entry (one .bak restored,
        // notes.json rm'd again with another .bak still present) reads as a
        // NEW state and warns again, while per-call re-loads of the SAME state
        // stay silent. (detectBackups returns its names pre-sorted.)
        this.blockedWarnKey = `bak:${baks.join('\0')}`;
        if (prevWarnKey !== this.blockedWarnKey) {
          log.warn(
            `NoteStore.load: ${this.notesPath} is missing but ${baks.length} backup ` +
              `file(s) exist (${basename(this.notesPath)}.bak.*) — possibly from an ` +
              `interrupted or a prior write. Inspect the newest and rename it to ` +
              `${basename(this.notesPath)} to restore it (it may be older than your ` +
              `last state), or delete the .bak file(s) to start fresh; writes stay ` +
              `disabled until one or the other.`,
          );
        }
        this.writeBlocked =
          `the note store at ${this.notesPath} is missing but a backup (.bak) is ` +
          `present — it may hold recoverable notes from an interrupted write. ` +
          `Writes are disabled (retried each tool call) so a manual restore ` +
          `can't be overwritten: rename the newest .bak to ` +
          `${basename(this.notesPath)} to restore it, or delete the .bak ` +
          `file(s) to start fresh.`;
        this.loadNotice = this.writeBlocked;
        this.loadPromise = null; // re-check on the next tool call
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.quarantine('corrupt', 'malformed JSON', prevWarnKey);
      return;
    }

    if (!isValidStore(parsed)) {
      await this.quarantine('corrupt', 'shape validation failed', prevWarnKey);
      return;
    }
    if (parsed.projectRoot !== this.projectRoot) {
      // These notes belong to a different project (e.g. a shared explicit
      // cacheDir). Never serve them here; preserve the bytes for recovery.
      await this.quarantine('otherroot', `projectRoot ${parsed.projectRoot}`, prevWarnKey);
      return;
    }

    this.notes = parsed.notes;
    this.storeCreatedAt = parsed.createdAt;
    // NOTE: we deliberately do NOT reap `.bak.*` orphans here. A stray `.bak`
    // cannot be proven redundant from a clean load alone — it may hold the ONLY
    // copy of pre-crash notes (an interrupted Windows swap left notes.json absent,
    // then a fresh, unrelated notes.json was written). Auto-deleting it would
    // break warnIfBackupPresent's "preserve for manual recovery" promise. The
    // successful-swap path already unlinks its own `.bak`; a rare crash-orphan is
    // accepted clutter (Windows-only, locked-target-during-write). Do not re-add a
    // reaper — every prior attempt (rounds 9-11) produced its own data-loss edge.
    // (writeBlocked was already cleared at the top of doLoad.)
    if (parsed.version > NOTES_STORE_VERSION) {
      this.writeBlocked =
        'the note store was written by a newer codedeep build; ' +
        'writes are disabled to avoid clobbering it. Upgrade codedeep.';
      log.warn(
        `NoteStore.load: ${this.notesPath} is version ${parsed.version} > ` +
          `${NOTES_STORE_VERSION}; serving read-only (remember disabled)`,
      );
    }
  }

  // --- queries (read-only; callers must have load()ed first) ---

  all(): Note[] {
    // A COPY — like byFile/bySymbol/search — so a caller can sort/splice the
    // result without mutating the store's live array.
    return [...this.notes];
  }

  getById(id: string): Note | undefined {
    return this.notes.find((n) => n.id === id);
  }

  // Notes with at least one anchor on `relPath`, newest first (so recall's
  // limit/budget truncation keeps the most RECENT notes — matching search()).
  byFile(relPath: string): Note[] {
    return sortByRecency(
      this.notes.filter((n) => n.anchors.some((a) => a.file === relPath)),
    );
  }

  // Notes with an anchor on `relPath` naming `symbolName`, newest first. Anchors
  // store the QUALIFIED name ("Class.member"), so: a QUALIFIED query matches
  // exactly (distinguishing two same-simple-named members in the file), while a
  // bare SIMPLE query matches any member with that last segment. `::` scope in
  // the query is folded to the extractor's `.` form first.
  bySymbol(relPath: string, symbolName: string): Note[] {
    const q = normalizeSymbolQuery(symbolName);
    const qualified = q.includes('.');
    return sortByRecency(
      this.notes.filter((n) =>
        n.anchors.some(
          (a) =>
            a.file === relPath &&
            a.symbol !== undefined &&
            (qualified ? a.symbol === q : simpleSymbolName(a.symbol) === q),
        ),
      ),
    );
  }

  // Token/substring match over note text + anchor file/symbol. Returns
  // {note, score} sorted by score desc then recency; score 0 entries dropped.
  search(query: string): Array<{ note: Note; score: number }> {
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      // No usable query → everything, recency-ranked (score 1 each).
      return sortByRecency(this.notes).map((note) => ({ note, score: 1 }));
    }
    const scored: Array<{ note: Note; score: number }> = [];
    for (const note of this.notes) {
      const text = note.text.toLowerCase();
      // Anchors weigh more than free text: a query hitting an anchored
      // file/symbol is a stronger signal than the same word in prose.
      const anchorHay = note.anchors
        .map((a) => `${a.file} ${a.symbol ?? ''}`)
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (anchorHay.includes(tok)) score += 2;
        else if (text.includes(tok)) score += 1;
      }
      if (score > 0) scored.push({ note, score });
    }
    // Decorate with the parsed epoch so the tiebreak sort doesn't re-parse dates.
    const decorated = scored.map((s) => ({ ...s, t: createdAtEpoch(s.note) }));
    decorated.sort(
      (a, b) => b.score - a.score || b.t - a.t || (a.note.id < b.note.id ? -1 : 1),
    );
    return decorated.map(({ note, score }) => ({ note, score }));
  }

  // --- mutations (write-through: persist after each change) ---

  async add(note: Note): Promise<void> {
    await this.load();
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    // The snapshot, mutation, AND write all run inside runLocked so the
    // read-modify-write is one critical section: `prev` is always the
    // immediately-preceding COMMITTED state, so a rollback on persist failure
    // can never clobber a concurrently-committed mutation (snapshotting
    // outside the lock would let a failed write roll back over a later note).
    await this.runLocked(async () => {
      const prev = this.notes;
      this.notes = [...prev, note];
      try {
        await this.writeStore();
      } catch (err) {
        this.notes = prev;
        throw err;
      }
    });
  }

  async remove(id: string): Promise<boolean> {
    await this.load();
    if (this.writeBlocked) throw new Error(this.writeBlocked);
    return this.runLocked(async () => {
      const prev = this.notes;
      const next = prev.filter((n) => n.id !== id);
      if (next.length === prev.length) return false;
      this.notes = next;
      try {
        await this.writeStore();
      } catch (err) {
        this.notes = prev;
        throw err;
      }
      return true;
    });
  }

  // --- internals ---

  // Atomic temp+fsync+rename of the current this.notes. NOT self-locked — every
  // caller invokes it INSIDE runLocked (with the snapshot+mutation) so the whole
  // read-modify-write is serialized.
  private async writeStore(): Promise<void> {
    const createdAt = this.storeCreatedAt ?? new Date().toISOString();
    const data: NotesStore = {
      version: NOTES_STORE_VERSION,
      createdAt,
      projectRoot: this.projectRoot,
      notes: this.notes,
    };
    const json = JSON.stringify(data, null, 2);
    const tmp = `${this.notesPath}.tmp.${process.pid}.${Date.now()}`;
    await fs.mkdir(dirname(this.notesPath), { recursive: true });
    try {
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(json);
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await fs.rename(tmp, this.notesPath);
      } catch {
        // A rename over an existing file fails on Windows. NEVER unlink the only
        // copy (notes are non-rebuildable, unlike CodeIndex): move the current
        // store aside to a UNIQUE `.bak.<pid>.<ts>` — a FIXED name could itself be
        // a locked leftover and wedge every write; a unique target never collides.
        // Put the new one in place, restore the .bak if the swap fails so a
        // notes.json always survives, then drop the .bak. A crash between the two
        // renames leaves the pre-write store in a `.bak` for MANUAL recovery (load
        // warns; it never auto-restores — see the ENOENT branch in doLoad).
        const bak = `${this.notesPath}.bak.${process.pid}.${Date.now()}`;
        await fs.rename(this.notesPath, bak);
        try {
          await fs.rename(tmp, this.notesPath);
        } catch (swapErr) {
          await fs.rename(bak, this.notesPath).catch(() => undefined);
          throw swapErr;
        }
        await fs.unlink(bak).catch(() => undefined);
      }
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
    // Only stamp the store's createdAt after a SUCCESSFUL persist, so a failed
    // first write (rolled back by add/remove) doesn't leave storeCreatedAt set.
    this.storeCreatedAt = createdAt;
  }

  // notes.json is absent — list any `.bak` survivors from an interrupted swap
  // (or a prior write whose cleanup didn't run). Silent (the caller owns the
  // warn-once-per-state-entry decision). We deliberately do NOT auto-restore:
  // an absent notes.json is indistinguishable from an intentional `rm`, and a
  // lingering backup may be OLDER than the last state — silently resurrecting
  // it is worse than starting empty. The caller BLOCKS writes so the advertised
  // manual restore can't be clobbered by a memoized empty store. Never throws.
  // Returned names are SORTED so callers can use them directly as a stable
  // state-identity key (readdir order is platform-dependent).
  private async detectBackups(): Promise<string[]> {
    try {
      const dir = dirname(this.notesPath);
      const prefix = `${basename(this.notesPath)}.bak.`;
      return (await fs.readdir(dir)).filter((e) => e.startsWith(prefix)).sort();
    } catch {
      // no dir / unreadable → nothing to recover, start empty
      return [];
    }
  }

  // Preserve unreadable/foreign bytes for manual recovery, then start empty.
  // If the rename SUCCEEDS the original is safe aside, so writes may proceed
  // (that warn is unconditional — the file is renamed away, so it fires once
  // by nature). If it FAILS the original is still at notesPath — block writes,
  // because a later persist() would atomically overwrite (and destroy) those
  // un-recovered bytes, violating the "never lose notes" invariant; that
  // failure state RE-LOADS per tool call, so its warn is gated on state entry
  // (prevWarnKey). Never throws out of load.
  private async quarantine(
    kind: string,
    reason: string,
    prevWarnKey: string | null,
  ): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const aside = `${this.notesPath}.${kind}-${stamp}`;
    try {
      await fs.rename(this.notesPath, aside);
      log.warn(
        `NoteStore.load: ${this.notesPath} ${reason}; quarantined to ${aside}; starting empty`,
      );
      // Writes are fine (empty store), but the prior notes were MOVED ASIDE —
      // surface it so recall doesn't present the empty view as genuine absence.
      this.loadNotice = `the previous note store was ${reason} and moved aside to ${aside}; starting empty`;
    } catch (err) {
      this.writeBlocked =
        `the note store at ${this.notesPath} could not be read or moved aside ` +
        `(${reason}); writes are disabled to avoid overwriting it — recover or ` +
        `delete it manually.`;
      this.loadNotice = this.writeBlocked;
      // The key carries the CAUSE: transitioning between different
      // quarantine-fail reasons (corrupt → foreign-root, say the user swapped
      // the file while the dir stayed unwritable) is a NEW state whose fresh
      // cause must reach stderr, not be suppressed as a repeat.
      this.blockedWarnKey = `quarantine-fail:${kind}:${reason}`;
      if (prevWarnKey !== this.blockedWarnKey) {
        log.warn(
          `NoteStore.load: ${this.notesPath} ${reason}; could not quarantine ` +
            `(${errMsg(err)}); writes disabled, original left in place`,
        );
      }
      // The rename failure is often TRANSIENT (a read-only-for-a-moment dir) —
      // reset the memo so a later load() re-attempts the quarantine once the dir
      // is writable again, instead of latching the block for the whole session.
      this.loadPromise = null;
    }
    this.notes = [];
    this.storeCreatedAt = null;
  }

  // Scoped to OUR basename prefix so it can never reap an index.json temp
  // sharing the directory (mirrors CodeIndex.cleanupStaleTmp).
  private async cleanupStaleTmp(): Promise<void> {
    try {
      const dir = dirname(this.notesPath);
      const tmpPrefix = `${basename(this.notesPath)}.tmp.`;
      const entries = await fs.readdir(dir);
      await Promise.all(
        entries
          .filter((e) => e.startsWith(tmpPrefix))
          .map((e) => fs.unlink(join(dir, e)).catch(() => undefined)),
      );
    } catch {
      // ignore: parent dir may not exist yet
    }
  }

  private runLocked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(work);
    this.writeLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

// Parse to epoch so an offset-form ISO ("...+08:00") or a hand-edited/imported
// createdAt can't win a lexicographic comparison and float above real UTC-Z
// notes. NaN → 0 (treated as oldest) so a garbage value sinks, not dominates.
function createdAtEpoch(n: Note): number {
  return Date.parse(n.createdAt) || 0;
}

// Newest first, decorate-sort-undecorate so each createdAt is parsed once (not
// O(n log n) times inside a comparator).
function sortByRecency(notes: readonly Note[]): Note[] {
  return notes
    .map((note) => ({ note, t: createdAtEpoch(note) }))
    .sort((a, b) => b.t - a.t || (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0))
    .map(({ note }) => note);
}

// Anchors store the qualified symbol name; reduce an FQN-style name to its last
// segment ("Ns::Type::login" / "Type.login" → "login").
function simpleSymbolName(s: string): string {
  const parts = s.split(/::|\./);
  return parts[parts.length - 1];
}

// A symbol's file-qualified name = its fqn suffix after "<file>:" ("Class.member"
// for a member, the bare name for a top-level symbol), or `fallback` when the
// fqn doesn't carry the file prefix. This is what remember stores in
// anchor.symbol, so staleness must reconstruct it the same way to match.
export function qualifiedSymbolName(fqn: string, file: string, fallback: string): string {
  const prefix = `${file}:`;
  return fqn.startsWith(prefix) ? fqn.slice(prefix.length) : fallback;
}

// Fold `::` scope separators to the extractor's dotted FQN form
// ("Ns::Type::method" → "Ns.Type.method"). The ONE normalization every
// symbol-name entry point applies — remember's anchor resolution, bySymbol
// queries — so a note stored from a C++-style query is findable by either form.
export function normalizeSymbolQuery(symbolName: string): string {
  return symbolName.replace(/::/g, '.');
}

function isValidStore(data: unknown): data is NotesStore {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.version === 'number' &&
    typeof d.createdAt === 'string' &&
    typeof d.projectRoot === 'string' &&
    Array.isArray(d.notes) &&
    d.notes.every(isValidNote)
  );
}

function isValidNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false;
  const n = value as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    typeof n.text === 'string' &&
    typeof n.createdAt === 'string' &&
    (n.head === undefined || typeof n.head === 'string') &&
    Array.isArray(n.anchors) &&
    n.anchors.every(isValidAnchor)
  );
}

function isValidAnchor(value: unknown): value is Anchor {
  if (typeof value !== 'object' || value === null) return false;
  const a = value as Record<string, unknown>;
  if (typeof a.file !== 'string') return false;
  for (const key of [
    'fileContentHash',
    'symbol',
    'symbolId',
    'symbolKind',
    'signature',
  ]) {
    if (a[key] !== undefined && typeof a[key] !== 'string') return false;
  }
  return true;
}
