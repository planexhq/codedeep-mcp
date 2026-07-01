import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { hashContent } from '../../src/indexer/pipeline.js';
import { computeAnchorStatus, computeNoteStatus } from '../../src/notes/staleness.js';
import type { Anchor, Note } from '../../src/notes/types.js';
import type { FileInfo } from '../../src/types.js';
import type { RecentCommit } from '../../src/git/git-service.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  mkSym,
  writeTree,
} from '../helpers.js';

const OLD = 'export function parseRoute(p: string) { return p; }\n';

// A FileInfo whose contentHash matches `disk` — symbol-level detail is only
// asserted when the index reflects the CURRENT disk bytes (staleness #5).
function indexedFileInfo(rel: string, disk: string): FileInfo {
  return { ...makeFileInfo('typescript', rel), contentHash: hashContent(disk) };
}

// recall is read-only: staleness reads the index AS-IS (no re-index), so tests
// set up the index to reflect the post-edit state directly.
function mkStalenessDeps(
  index: CodeIndex,
  root: string,
  opts: { recentCommits?: RecentCommit[] } = {},
) {
  return {
    index,
    config: makeConfig(root),
    git: {
      recentCommits: async (): Promise<RecentCommit[]> =>
        opts.recentCommits ?? [],
    },
  };
}

describe('computeAnchorStatus', () => {
  let root: string;
  beforeEach(() => {
    root = makeProjectDir('codedeep-staleness-');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // hashContent of a known file: capture it by indexing once via the store's
  // own hash. We re-derive by reading the helper's exported hash.
  async function hashOf(content: string): Promise<string> {
    const { hashContent } = await import('../../src/indexer/pipeline.js');
    return hashContent(content);
  }

  it('fresh: file byte-identical to the captured hash', async () => {
    writeTree(root, { 'src/a.ts': OLD });
    const anchor: Anchor = { file: 'src/a.ts', fileContentHash: await hashOf(OLD) };
    const index = new CodeIndex(root);
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('fresh');
  });

  it('missing: anchored file no longer exists', async () => {
    const anchor: Anchor = { file: 'src/gone.ts', fileContentHash: 'deadbeefdeadbeef' };
    const index = new CodeIndex(root);
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('missing');
  });

  it('unverified: no baseline hash captured', async () => {
    writeTree(root, { 'src/a.ts': OLD });
    const anchor: Anchor = { file: 'src/a.ts' }; // no fileContentHash
    const index = new CodeIndex(root);
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('unverified');
    expect(st.detail).toMatch(/no baseline/);
  });

  it('unverified: file unreadable (exceeds maxFileSize)', async () => {
    writeTree(root, { 'src/a.ts': 'x'.repeat(5000) });
    const anchor: Anchor = { file: 'src/a.ts', fileContentHash: 'whatever00000000' };
    const index = new CodeIndex(root);
    const deps = {
      ...mkStalenessDeps(index, root),
      config: makeConfig(root, { maxFileSize: 100 }),
    };
    const st = await computeAnchorStatus(anchor, deps);
    expect(st.verdict).toBe('unverified');
    expect(st.detail).toMatch(/could not be read/);
  });

  it('stale (non-symbol anchor): file changed, generic detail + live commit', async () => {
    writeTree(root, { 'src/a.ts': 'export const changed = 1;\n' });
    const anchor: Anchor = { file: 'src/a.ts', fileContentHash: await hashOf(OLD) };
    const index = new CodeIndex(root);
    const commit: RecentCommit = { hash: 'abc1234', date: '2026-06-30', subject: 'edit a' };
    const st = await computeAnchorStatus(
      anchor,
      mkStalenessDeps(index, root, { recentCommits: [commit] }),
    );
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/file changed since this note/);
    expect(st.lastCommit).toEqual(commit);
  });

  it('stale (symbol anchor): signature changed reports was-signature', async () => {
    const disk = 'export function parseRoute(p, q) {}\n';
    writeTree(root, { 'src/a.ts': disk });
    // The live index holds the NEW signature; the anchor snapshot is the OLD id.
    const current = mkSym({
      name: 'parseRoute',
      file: 'src/a.ts',
      signature: 'parseRoute(p, q)',
    });
    const oldSym = mkSym({
      name: 'parseRoute',
      file: 'src/a.ts',
      signature: 'parseRoute(p)',
    });
    const index = new CodeIndex(root);
    index.addFile(indexedFileInfo('src/a.ts', disk), [current], [], []);
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD),
      symbol: 'parseRoute',
      symbolId: oldSym.id,
      signature: 'parseRoute(p)',
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/signature changed \(was `parseRoute\(p\)`\)/);
  });

  it('stale (symbol anchor): id intact => body-may-have-changed', async () => {
    const disk = 'export function parseRoute(p) { return 2; }\n';
    writeTree(root, { 'src/a.ts': disk });
    const sym = mkSym({
      name: 'parseRoute',
      file: 'src/a.ts',
      signature: 'parseRoute(p)',
    });
    const index = new CodeIndex(root);
    index.addFile(indexedFileInfo('src/a.ts', disk), [sym], [], []);
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD), // file differs on disk
      symbol: 'parseRoute',
      symbolId: sym.id, // same id => signature intact
      signature: 'parseRoute(p)',
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/signature intact, body may have changed/);
  });

  it('stale (symbol anchor): symbol removed', async () => {
    const disk = '// emptied\n';
    writeTree(root, { 'src/a.ts': disk });
    const index = new CodeIndex(root);
    index.addFile(indexedFileInfo('src/a.ts', disk), [], [], []);
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD),
      symbol: 'parseRoute',
      symbolId: 'oldid00000000000',
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/renamed or removed/);
  });

  it('stale (member anchor, qualified name): reports intact, NOT "renamed or removed"', async () => {
    const disk = 'class Auth { login(pw) {} }\n';
    writeTree(root, { 'src/a.ts': disk });
    // remember stores the QUALIFIED name "Auth.login"; describeChange must match
    // it against the member's fqn, not the simple Symbol.name "login".
    const method = mkSym({
      name: 'login',
      file: 'src/a.ts',
      parent: 'Auth',
      kind: 'method',
      signature: 'login(pw)',
    });
    const index = new CodeIndex(root);
    index.addFile(indexedFileInfo('src/a.ts', disk), [method], [], []);
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD), // file changed on disk
      symbol: 'Auth.login',
      symbolId: method.id, // same id ⇒ signature intact
      signature: 'login(pw)',
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/signature intact, body may have changed/);
    expect(st.detail).not.toMatch(/renamed or removed/);
  });

  it('stale (symbol anchor): index lags disk → defers symbol detail', async () => {
    const disk = 'export function parseRoute(p, q) {}\n';
    writeTree(root, { 'src/a.ts': disk });
    const sym = mkSym({ name: 'parseRoute', file: 'src/a.ts', signature: 'parseRoute(p)' });
    const index = new CodeIndex(root);
    // The index's file hash does NOT match disk (watcher hasn't caught up), so a
    // symbolId comparison would be untrustworthy — detail must defer, not lie.
    index.addFile(
      { ...makeFileInfo('typescript', 'src/a.ts'), contentHash: 'staleindexhash00' },
      [sym],
      [],
      [],
    );
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD),
      symbol: 'parseRoute',
      symbolId: sym.id,
      signature: 'parseRoute(p)',
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/re-index for symbol-level detail/);
  });

  it('stale (symbol anchor): file not in index → "not indexed", not a useless re-index hint', async () => {
    // The file is on disk and changed, but absent from the index (excluded by
    // config, unknown-language, or not re-scanned after a wipe). Re-indexing can
    // never surface its symbols, so the detail must NOT advise re-indexing —
    // getFile() returns undefined here, distinct from a lagging-hash mismatch ([5]).
    writeTree(root, { 'src/a.ts': 'export function parseRoute(p, q) {}\n' });
    const index = new CodeIndex(root); // file deliberately NOT added
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD),
      symbol: 'parseRoute',
      symbolId: 'someoldid00000000',
      signature: 'parseRoute(p)',
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/not indexed/);
    expect(st.detail).not.toMatch(/re-index/);
  });

  it('stale (symbol anchor, generic): no symbolId → file-changed detail', async () => {
    writeTree(root, { 'src/a.ts': 'export function parseRoute(p, q) {}\n' });
    const index = new CodeIndex(root);
    const anchor: Anchor = {
      file: 'src/a.ts',
      fileContentHash: await hashOf(OLD),
      // file-level anchor (no symbol) → generic detail, never touches the index
    };
    const st = await computeAnchorStatus(anchor, mkStalenessDeps(index, root));
    expect(st.verdict).toBe('stale');
    expect(st.detail).toMatch(/file changed since this note/);
  });
});

describe('computeNoteStatus', () => {
  let root: string;
  beforeEach(() => {
    root = makeProjectDir('codedeep-notestatus-');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function hashOf(content: string): Promise<string> {
    const { hashContent } = await import('../../src/indexer/pipeline.js');
    return hashContent(content);
  }

  it('overall verdict is the worst across anchors', async () => {
    const fresh = 'export const ok = 1;\n';
    writeTree(root, { 'src/fresh.ts': fresh, 'src/changed.ts': 'now different\n' });
    const note: Note = {
      id: 'n1',
      text: 'spans two files',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [
        { file: 'src/fresh.ts', fileContentHash: await hashOf(fresh) },
        { file: 'src/changed.ts', fileContentHash: await hashOf('was original\n') },
      ],
    };
    const index = new CodeIndex(root);
    const status = await computeNoteStatus(note, mkStalenessDeps(index, root));
    expect(status.overall).toBe('stale');
    expect(status.anchors.map((a) => a.verdict).sort()).toEqual(['fresh', 'stale']);
  });

  it('no anchors => unverified (not staleness-tracked)', async () => {
    const note: Note = {
      id: 'n2',
      text: 'free-floating',
      createdAt: '2026-07-01T00:00:00.000Z',
      anchors: [],
    };
    const index = new CodeIndex(root);
    const status = await computeNoteStatus(note, mkStalenessDeps(index, root));
    expect(status.overall).toBe('unverified');
    expect(status.anchors).toEqual([]);
  });
});
