// Shared renderers for staleness-checked notes. Extracted from recall.ts so
// the PULL surfaces (a notes section inside get_context / a knowledge line in
// overview) render notes IDENTICALLY to recall — one grammar for verdict tags,
// ages, and anchor lines. This lives in tools/ (not notes/) on purpose: the
// renderers depend on tools/common's formatRelativeAge + BEHAVIORAL_TAG, and a
// notes/-located module would re-create the notes→tools layering inversion.

import type { AnchorStatus, AnchorVerdict, NoteStatus } from '../notes/staleness.js';
import type { Note } from '../notes/types.js';
import { BEHAVIORAL_TAG, formatRelativeAge } from './common.js';

// Module-private until a PULL surface actually consumes them — renderNote is
// the one export with a consumer today; widen the surface when real callers
// land, not speculatively.
const VERDICT_TAG: Record<AnchorVerdict, string> = {
  fresh: '✓ fresh',
  stale: '⚠ stale',
  unverified: '? unverified',
  missing: '✗ missing',
};

const VERDICT_MARK: Record<AnchorVerdict, string> = {
  fresh: '✓',
  stale: '⚠',
  unverified: '?',
  missing: '✗',
};

// Compact one-line form for summary surfaces (the `changes` tool's per-file
// note list): same verdict grammar as renderNote, but one line — mark+word,
// truncated text, id (so forget/recall can target it). Full detail lives one
// recall away.
const NOTE_LINE_TEXT_CAP = 90;
export function renderNoteLine(note: Note, status: NoteStatus): string {
  // Flatten FIRST (newlines collapse to single spaces), then cap — measuring
  // the raw text would needlessly truncate a multi-line note whose flattened
  // form fits, and could land the cut on collapsed whitespace.
  let flat = note.text.replace(/\s*\n\s*/g, ' ').trim();
  // A whitespace-only / empty note (hand-edited or migrated store) must not
  // render as a bare `"…"` or quoted blanks — say what it is.
  if (flat.length === 0) flat = '(empty)';
  else if (flat.length > NOTE_LINE_TEXT_CAP) {
    let cut = flat.slice(0, NOTE_LINE_TEXT_CAP - 1);
    // Never split a surrogate pair: a cut landing mid-astral-char (emoji,
    // CJK extensions) would emit a lone high surrogate (mojibake, and invalid
    // if the response is re-encoded).
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    cut = cut.trimEnd();
    flat = cut.length > 0 ? `${cut}…` : '(empty)';
  }
  return `- ${VERDICT_TAG[status.overall]} — "${flat}" (note ${note.id})`;
}

export function renderNote(note: Note, status: NoteStatus): string {
  // Guard a hand-edited / non-ISO createdAt that parses to NaN (isValidNote only
  // checks it's a string) so the header never reads "NaNd ago".
  const parsed = Date.parse(note.createdAt);
  const age = Number.isNaN(parsed)
    ? 'unknown age'
    : `${formatRelativeAge(Date.now() - parsed)} ago`;
  const tag = VERDICT_TAG[status.overall];
  const lines = [`### Note ${note.id}  ${tag} · ${age}`, note.text];
  if (status.anchors.length > 0) {
    lines.push('Anchors:');
    for (const a of status.anchors) lines.push(renderAnchor(a));
  } else {
    lines.push('(no anchors — not staleness-tracked)');
  }
  if (note.head) lines.push(`Noted at commit ${note.head}.`);
  return lines.join('\n');
}

function renderAnchor(a: AnchorStatus): string {
  const where = a.anchor.symbol
    ? `${a.anchor.file}:${a.anchor.symbol}`
    : a.anchor.file;
  let line = `- ${VERDICT_MARK[a.verdict]} ${where} — ${a.detail}`;
  if (a.lastCommit) {
    // The file's most recent COMMIT — not necessarily when it went stale (a
    // working-tree edit is uncommitted), so phrase it as provenance, not cause.
    line +=
      `; last commit ${a.lastCommit.hash} ${a.lastCommit.date} ` +
      `"${a.lastCommit.subject}" ${BEHAVIORAL_TAG}`;
  }
  return line;
}
