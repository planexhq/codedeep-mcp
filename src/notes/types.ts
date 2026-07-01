// Persisted shape for the agent-curated knowledge layer (the `remember` /
// `recall` / `forget` tools). This store is DELIBERATELY separate from the
// code index's `index.json`:
//
//   - index.json is a DISPOSABLE derived cache — CodeIndex.load() fs.unlink's
//     it on any schema/projectRoot mismatch or corruption, because it can be
//     rebuilt from source in seconds.
//   - notes are PRIMARY user/agent-authored data — NOT rebuildable. They must
//     survive every index invalidation, so they live in their own file with
//     their own version, and on corruption they are QUARANTINED (renamed
//     aside), never deleted. See note-store.ts.
//
// Consequently this version is INDEPENDENT of the index SCHEMA_VERSION: adding
// notes did not (and must not) bump the index schema, and a future index-schema
// bump leaves these notes untouched.

// Bump ONLY on a backward-incompatible Note/Anchor shape change. Additive
// OPTIONAL fields (the expected evolution — e.g. a future per-symbol body hash)
// need NO bump: a missing field already reads as the "unknown" dimension.
export const NOTES_STORE_VERSION = 1;

export interface NotesStore {
  version: number; // NOTES_STORE_VERSION at write time
  createdAt: string; // ISO, first write
  // Sanity field. A mismatch (e.g. one explicit CODEDEEP_CACHE_DIR shared by
  // two repos) means these notes belong to a DIFFERENT project — the store
  // quarantines and starts empty rather than serve foreign notes against this
  // project's files. Never used to DELETE.
  projectRoot: string;
  notes: Note[];
}

export interface Note {
  // sha1(createdAt \0 text \0 randomBytes(8)).slice(0,16) — a random nonce (NOT a
  // reproducible sequence): re-remembering identical text yields a DIFFERENT id,
  // and ids stay collision-proof even across a forget (a monotonic seq would
  // repeat after a delete). Do NOT recompute an id from a note's fields.
  id: string;
  // The knowledge itself (markdown allowed). Required, non-empty.
  text: string;
  createdAt: string; // ISO, capture time
  // Short HEAD sha when the note was written (provenance: "noted at commit X").
  // Omitted off-git / when HEAD was unavailable.
  head?: string;
  // 0..N anchors. An empty list = a free-floating note (stored, but NOT
  // staleness-tracked — the staleness wedge needs at least one anchor).
  anchors: Anchor[];
}

// One anchor = "this note is about <file>[, specifically <symbol>]". Every
// anchor is rooted at a file; `symbolId != null` is the file-vs-symbol
// discriminator. All snapshot fields are OPTIONAL so capture degrades cleanly
// (off-git, unknown-language file, symbol-not-found) without failing remember.
export interface Anchor {
  // Normalized project-relative path (normalizeFilePath; rejects '..' escapes).
  file: string;
  // FileInfo.contentHash snapshot at capture (sha1 of file text, first 16 hex).
  // The body-change detector. Absent when the file was unknown-language /
  // unparsed / not-yet-indexed at capture → staleness reads "unverified".
  fileContentHash?: string;
  // --- symbol fields, present iff a symbol resolved at capture ---
  symbol?: string; // Symbol.name — the key used to re-find after an id change
  symbolId?: string; // extractor.ts symbolId snapshot (sig/name/kind fingerprint)
  symbolKind?: string; // disambiguates findSymbolByName on rebind
  signature?: string; // Symbol.signature snapshot (display + "was <sig>" message)
}
