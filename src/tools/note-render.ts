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
