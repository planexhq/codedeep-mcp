import { describe, expect, it } from 'vitest';

import { renderNoteLine } from '../../src/tools/note-render.js';
import type { NoteStatus } from '../../src/notes/staleness.js';
import type { Note } from '../../src/notes/types.js';

function mkNote(text: string): Note {
  return {
    id: 'abcdefabcdefabcd',
    text,
    createdAt: '2026-07-01T00:00:00.000Z',
    anchors: [],
  };
}
const FRESH: NoteStatus = { overall: 'fresh', anchors: [] };

describe('renderNoteLine (compact summary grammar)', () => {
  it('renders verdict, quoted text, and the note id on one line', () => {
    const line = renderNoteLine(mkNote('short note'), FRESH);
    expect(line).toBe('- ✓ fresh — "short note" (note abcdefabcdefabcd)');
  });

  it('flattens newlines BEFORE measuring the cap (a fitting multi-line note is not truncated)', () => {
    // Raw length > 90 because of newline+indent runs, but flattens to < 90.
    const text = 'alpha\n    beta\n    gamma\n    ' + 'x'.repeat(65);
    expect(text.length).toBeGreaterThan(90);
    const line = renderNoteLine(mkNote(text), FRESH);
    expect(line).toContain(`alpha beta gamma ${'x'.repeat(65)}`);
    expect(line).not.toContain('…');
    expect(line).not.toContain('\n');
  });

  it('caps long text with an ellipsis and no trailing space', () => {
    const line = renderNoteLine(mkNote('y'.repeat(200)), FRESH);
    expect(line).toContain('…');
    expect(line).not.toContain('y'.repeat(95));
    expect(line).not.toMatch(/ …/);
  });

  it('never splits a surrogate pair at the cap boundary', () => {
    // 88 ASCII chars put the astral emoji exactly across the slice(0, 89) cut.
    const text = 'a'.repeat(88) + '🔥' + 'tail'.repeat(10);
    const line = renderNoteLine(mkNote(text), FRESH);
    // A lone high surrogate would be \uD83D with no low surrogate following.
    expect(line).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
