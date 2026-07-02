import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wrap the real parser module so initParser can be made to fail per-test —
// simulating a transient grammar-load failure (EMFILE reading the .wasm),
// which the lazy-loading design must survive WITHOUT destroying index state.
const grammarFailure = vi.hoisted(() => ({ fail: false }));
vi.mock('../../src/indexer/parser.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../src/indexer/parser.js')>();
  return {
    ...real,
    initParser: (languages?: Iterable<string>) =>
      grammarFailure.fail
        ? Promise.reject(new Error('simulated grammar load failure (EMFILE)'))
        : real.initParser(languages),
  };
});

import { CodeIndex } from '../../src/indexer/code-index.js';
import { Indexer } from '../../src/indexer/pipeline.js';
import type { CodedeepConfig } from '../../src/types.js';
import {
  makeConfig,
  makeProjectDir,
  silenceStderr,
  writeTree,
} from '../helpers.js';

const PY = 'def parse_route(path):\n    return path\n';
const PY_V2 = 'def parse_route(path):\n    return path.rstrip("/")\n';

describe('lazy grammar loading — failure isolation', () => {
  let root: string;
  let config: CodedeepConfig;
  let index: CodeIndex;
  let indexer: Indexer;

  beforeEach(() => {
    grammarFailure.fail = false;
    root = makeProjectDir('codedeep-lazy-grammar-');
    config = makeConfig(root);
    index = new CodeIndex(config.projectRoot);
    indexer = new Indexer(config, index);
    silenceStderr();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('a transient grammar-load failure keeps existing symbols (never cascade-deletes)', async () => {
    writeTree(root, { 'app.py': PY });
    await indexer.indexAll();
    expect(index.getSymbolsInFile('app.py').map((s) => s.name)).toEqual([
      'parse_route',
    ]);

    // The file changes on disk, but the grammar load fails transiently when
    // the watcher path re-indexes it. The old symbols MUST survive — a load
    // failure says nothing about the file; deleting (and persisting the
    // deletion) would blind every tool to this file for the session. The
    // result is 'transient' (NOT 'removed', NOT 'noop') so the watcher
    // retries it a bounded number of times.
    grammarFailure.fail = true;
    writeTree(root, { 'app.py': PY_V2 });
    const result = await indexer.indexFile('app.py');
    expect(result).toBe('transient');
    expect(index.getSymbolsInFile('app.py').map((s) => s.name)).toEqual([
      'parse_route',
    ]);

    // Once the transient failure clears, the next event re-indexes for real.
    grammarFailure.fail = false;
    const retry = await indexer.indexFile('app.py');
    expect(retry).toBe('indexed');
    expect(index.getSymbolsInFile('app.py')).toHaveLength(1);
  });

  it('a bulk grammar warm-up failure degrades per-file instead of aborting indexAll', async () => {
    writeTree(root, { 'app.py': PY, 'lib.py': PY_V2 });
    grammarFailure.fail = true;
    // Must resolve (not throw): the warm-up is an optimization; per-file
    // ensures carry correctness. With every load failing, files skip
    // ('transient') and the run completes.
    await expect(indexer.indexAll()).resolves.toBe(true);
    expect(index.getSymbolsInFile('app.py')).toEqual([]);

    // The per-file warn is deduped per LANGUAGE — two failing python files
    // must produce ONE 'grammar load failed' line, not one per file.
    const spy = vi.mocked(process.stderr.write);
    const warns = spy.mock.calls.filter((c) =>
      String(c[0]).includes('grammar load failed for python'),
    );
    expect(warns).toHaveLength(1);

    // Recovery: once loads succeed, a changed-scan picks the file up.
    grammarFailure.fail = false;
    await indexer.indexChanged();
    expect(index.getSymbolsInFile('app.py').map((s) => s.name)).toEqual([
      'parse_route',
    ]);
  });
});
