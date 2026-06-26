import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import * as parserModule from '../../src/indexer/parser.js';
import { Indexer } from '../../src/indexer/pipeline.js';
import { Watcher, type WatchFactory } from '../../src/indexer/watcher.js';
import type { CodedeepConfig } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  silenceStderr,
  writeTree,
} from '../helpers.js';

const DEBOUNCE = 100;
const RETRY = 250;

let root: string;
let config: CodedeepConfig;

beforeAll(async () => {
  await parserModule.initParser();
});

beforeEach(() => {
  root = makeProjectDir('codedeep-watcher-');
  config = makeConfig(root);
  // Date is faked alongside the timers so scheduleDebounced's max-wait
  // deadline math follows the fake clock — otherwise a >1s real-time
  // stall mid-test (GC, loaded CI) expires the deadline and flips the
  // trailing-debounce assertions. setImmediate stays live: the real
  // Indexer yields between batches with it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

interface IndexerStubOpts {
  isIndexing?: boolean;
  ready?: boolean;
  indexFile?: ReturnType<typeof vi.fn>;
  indexChanged?: ReturnType<typeof vi.fn>;
}

function stubIndexer(opts: IndexerStubOpts = {}): Indexer {
  return {
    isIndexing: opts.isIndexing ?? false,
    ready: opts.ready ?? true,
    lastScanComplete: true,
    cachePath: join(root, '.codedeep', 'cache', 'index.json'),
    indexFile: opts.indexFile ?? vi.fn().mockResolvedValue('indexed'),
    indexChanged: opts.indexChanged ?? vi.fn().mockResolvedValue(true),
  } as unknown as Indexer;
}

function stubIndex(
  opts: { save?: ReturnType<typeof vi.fn>; files?: Array<{ path: string }> } = {},
): CodeIndex {
  const files = opts.files ?? [];
  return {
    save: opts.save ?? vi.fn().mockResolvedValue(undefined),
    getAllFiles: vi.fn().mockReturnValue(files),
    hasFile: vi.fn((path: string) => files.some((f) => f.path === path)),
    hasFileUnder: vi.fn(
      (prefix: string) => files.some((f) => f.path.startsWith(prefix)),
    ),
    filesUnder: vi.fn((prefix: string) =>
      files.map((f) => f.path).filter((p) => p.startsWith(prefix)),
    ),
  } as unknown as CodeIndex;
}

// Fires the debounce timer, then awaits the resulting drain (which does
// real fs I/O the fake clock can't see).
async function advanceAndSettle(watcher: Watcher, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await watcher.settle();
}

describe('Watcher — debounce and batching', () => {
  it('batches rapid events: one indexFile per distinct path, one save', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const save = vi.fn().mockResolvedValue(undefined);
    const indexer = stubIndexer({ indexFile });
    const watcher = new Watcher(indexer, stubIndex({ save }), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    for (let i = 0; i < 3; i++) {
      watcher.handleEvent('change', 'src/a.ts');
      watcher.handleEvent('change', 'src/b.ts');
    }
    expect(indexFile).not.toHaveBeenCalled();

    await advanceAndSettle(watcher, DEBOUNCE);

    expect(indexFile).toHaveBeenCalledTimes(2);
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
    expect(indexFile).toHaveBeenCalledWith('src/b.ts');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('uses a trailing debounce — each event pushes the flush out', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(60);
    watcher.handleEvent('change', 'src/a.ts');
    // 100ms after the FIRST event — the second reset the timer.
    await vi.advanceTimersByTimeAsync(40);
    await watcher.settle();
    expect(indexFile).not.toHaveBeenCalled();

    await advanceAndSettle(watcher, 60);
    expect(indexFile).toHaveBeenCalledTimes(1);
  });

  it('processes events arriving mid-drain in a follow-up flush', async () => {
    let resolveFirst!: (v: string) => void;
    const firstCall = new Promise<string>((r) => (resolveFirst = r));
    const indexFile = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // Drain is now awaiting indexFile('src/a.ts'); a new event lands.
    watcher.handleEvent('change', 'src/b.ts');
    resolveFirst('indexed');
    await watcher.settle();

    // The leftover path is picked up on the retry tick.
    await advanceAndSettle(watcher, RETRY);
    expect(indexFile).toHaveBeenCalledWith('src/b.ts');
  });
});

describe('Watcher — event filtering', () => {
  it('ignores excluded and binary paths before debouncing', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const save = vi.fn().mockResolvedValue(undefined);
    const watcher = new Watcher(
      stubIndexer({ indexFile }),
      stubIndex({ save }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('change', 'node_modules/pkg/index.js');
    watcher.handleEvent('change', '.codedeep/cache/index.json');
    watcher.handleEvent('rename', 'assets/logo.png');

    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('does NOT filter unknown-language files (overview counts them)', async () => {
    writeTree(root, { 'README.md': '# hi\n' });
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'README.md');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).toHaveBeenCalledWith('README.md');
  });

  it('canonicalizes platform-separated event paths to POSIX form', async () => {
    // fs.watch emits platform-sep relative paths; toPosix rewrites the
    // platform separator only (a backslash is a legal POSIX filename
    // char), so the meaningful conversion happens on Windows.
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', join('src', 'a.ts'));
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('treats a null or empty filename as a rescan signal', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const indexChanged = vi.fn().mockResolvedValue(true);
    const save = vi.fn().mockResolvedValue(undefined);
    const watcher = new Watcher(
      stubIndexer({ indexFile, indexChanged }),
      stubIndex({ save }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('rename', null);
    watcher.handleEvent('change', '');
    await advanceAndSettle(watcher, DEBOUNCE);

    expect(indexChanged).toHaveBeenCalledTimes(1);
    expect(indexFile).not.toHaveBeenCalled();
    // indexChanged persists internally — no watcher-side save.
    expect(save).not.toHaveBeenCalled();
  });
});

describe('Watcher — busy indexer and guard drops', () => {
  it('defers flushes until the indexer is ready (startup load window)', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const indexer = stubIndexer({ indexFile, ready: false });
    let ready = false;
    Object.defineProperty(indexer, 'ready', { get: () => ready });
    const watcher = new Watcher(indexer, stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).not.toHaveBeenCalled();

    ready = true;
    await advanceAndSettle(watcher, RETRY);
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('re-queues the batched paths after a rescan (partial scans must not lose edits)', async () => {
    // indexChanged resolves true even when its scan was incomplete, so
    // the batch is re-queued; covered paths become mtime+size no-ops.
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const indexChanged = vi.fn().mockResolvedValue(true);
    const watcher = new Watcher(
      stubIndexer({ indexFile, indexChanged }),
      stubIndex(),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('rename', null); // rescanPending
    watcher.handleEvent('change', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexChanged).toHaveBeenCalledTimes(1);
    expect(indexFile).not.toHaveBeenCalled();

    await advanceAndSettle(watcher, RETRY);
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('processes deletions before creations within a batch', async () => {
    // At the maxFiles cap, a rename's delete must free its slot before
    // the create claims one.
    writeTree(root, { 'src/new.ts': 'export function fresh() {}\n' });
    const calls: string[] = [];
    const indexFile = vi.fn().mockImplementation((rel: string) => {
      calls.push(rel);
      return Promise.resolve('indexed');
    });
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    // Event order: create first, delete second — processing must invert it.
    watcher.handleEvent('rename', 'src/new.ts');
    watcher.handleEvent('rename', 'src/old.ts'); // never existed → deletion
    await advanceAndSettle(watcher, DEBOUNCE);

    expect(calls).toEqual(['src/old.ts', 'src/new.ts']);
  });

  it('retries the rescan when indexChanged throws transiently', async () => {
    const stderr = silenceStderr();
    const indexChanged = vi
      .fn()
      .mockRejectedValueOnce(new Error('EMFILE'))
      .mockResolvedValue(true);
    const watcher = new Watcher(
      stubIndexer({ indexChanged }),
      stubIndex(),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('rename', null);
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexChanged).toHaveBeenCalledTimes(1);
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes('rescan failed')),
    ).toBe(true);

    // The failure must re-arm the rescan, not drop it.
    await advanceAndSettle(watcher, RETRY);
    expect(indexChanged).toHaveBeenCalledTimes(2);
  });

  it('caps trailing-debounce postponement at maxFlushDelayMs', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
      maxFlushDelayMs: 300,
    });

    // A continuously-written file: events every 60ms forever would
    // postpone a pure trailing debounce indefinitely.
    for (let elapsed = 0; elapsed <= 240; elapsed += 60) {
      watcher.handleEvent('change', 'src/hot.ts');
      await vi.advanceTimersByTimeAsync(60);
    }
    await watcher.settle();
    expect(indexFile).toHaveBeenCalledWith('src/hot.ts');
  });

  it('retries (not drops) when the indexer is busy', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const indexer = stubIndexer({ indexFile });
    let busy = true;
    Object.defineProperty(indexer, 'isIndexing', { get: () => busy });
    const watcher = new Watcher(indexer, stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).not.toHaveBeenCalled();

    busy = false;
    await advanceAndSettle(watcher, RETRY);
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('re-queues paths whose indexFile was dropped by the guard', async () => {
    const indexFile = vi
      .fn()
      .mockResolvedValueOnce('dropped') // guard drop
      .mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).toHaveBeenCalledTimes(1);

    await advanceAndSettle(watcher, RETRY);
    expect(indexFile).toHaveBeenCalledTimes(2);
    expect(indexFile).toHaveBeenLastCalledWith('src/a.ts');
  });
});

describe('Watcher — error isolation', () => {
  it('warns on save failure and keeps processing later flushes', async () => {
    const stderr = silenceStderr();
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValue(undefined);
    const watcher = new Watcher(
      stubIndexer({ indexFile }),
      stubIndex({ save }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('change', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes('failed to save cache')),
    ).toBe(true);

    watcher.handleEvent('change', 'src/b.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('isolates a per-path indexFile failure from the rest of the batch', async () => {
    const stderr = silenceStderr();
    const indexFile = vi.fn().mockImplementation((rel: string) => {
      if (rel === 'src/bad.ts') return Promise.reject(new Error('boom'));
      return Promise.resolve('indexed');
    });
    const save = vi.fn().mockResolvedValue(undefined);
    const watcher = new Watcher(
      stubIndexer({ indexFile }),
      stubIndex({ save }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('change', 'src/bad.ts');
    watcher.handleEvent('change', 'src/good.ts');
    await advanceAndSettle(watcher, DEBOUNCE);

    expect(indexFile).toHaveBeenCalledWith('src/good.ts');
    expect(save).toHaveBeenCalledTimes(1);
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes('failed to index src/bad.ts')),
    ).toBe(true);
  });

  it('start() degrades gracefully when the backend factory throws', () => {
    const stderr = silenceStderr();
    const factory: WatchFactory = () => {
      throw new Error('ERR_FEATURE_UNAVAILABLE_ON_PLATFORM');
    };
    const watcher = new Watcher(stubIndexer(), stubIndex(), config, {
      watchFactory: factory,
    });

    expect(() => watcher.start()).not.toThrow();
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes('live re-indexing disabled')),
    ).toBe(true);
  });

  it('disables the backend on watch errors without crashing', async () => {
    const stderr = silenceStderr();
    let emitError!: (err: unknown) => void;
    const close = vi.fn();
    const factory: WatchFactory = (_root, _onEvent, onError) => {
      emitError = onError;
      return { close };
    };
    const watcher = new Watcher(stubIndexer(), stubIndex(), config, {
      watchFactory: factory,
    });
    watcher.start();

    emitError(Object.assign(new Error('inotify exhausted'), { code: 'ENOSPC' }));
    expect(close).toHaveBeenCalled();
    expect(
      stderr.mock.calls.some((c) => String(c[0]).includes('live re-indexing disabled')),
    ).toBe(true);
  });
});

describe('Watcher — close()', () => {
  it('flushes and saves the pending batch in a final drain instead of discarding it', async () => {
    // The shutdown contract: edits sitting in the debounce window when
    // close() runs must reach the index AND the on-disk cache — close()
    // is self-contained, no caller-side save needed.
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const save = vi.fn().mockResolvedValue(undefined);
    const watcher = new Watcher(
      stubIndexer({ indexFile }),
      stubIndex({ save }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('change', 'src/a.ts');
    await watcher.close();

    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('awaits an in-flight drain, then final-drains the remainder', async () => {
    let resolveFirst!: (v: string) => void;
    const firstCall = new Promise<string>((r) => (resolveFirst = r));
    const indexFile = vi
      .fn()
      .mockImplementationOnce(() => firstCall)
      .mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    watcher.handleEvent('change', 'src/b.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE);
    // Drain is awaiting the first path; close mid-drain. The in-flight
    // drain re-queues the remainder, and close()'s final drain flushes it.
    const closing = watcher.close();
    resolveFirst('indexed');
    await closing;

    expect(indexFile).toHaveBeenCalledTimes(2);
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
    expect(indexFile).toHaveBeenCalledWith('src/b.ts');
  });

  it('skips the rescan in the final drain but still flushes per-file paths', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const indexChanged = vi.fn().mockResolvedValue(true);
    const watcher = new Watcher(
      stubIndexer({ indexFile, indexChanged }),
      stubIndex(),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('rename', null); // rescanPending
    watcher.handleEvent('change', 'src/a.ts');
    await watcher.close();

    // A shutdown-time full rescan would stall exit; indexChanged heals on
    // next start. The concrete edits still flush.
    expect(indexChanged).not.toHaveBeenCalled();
    expect(indexFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('a concurrent second close() awaits the first close()\'s final drain', async () => {
    let resolveFirst!: (v: string) => void;
    const firstCall = new Promise<string>((r) => (resolveFirst = r));
    const indexFile = vi.fn().mockImplementationOnce(() => firstCall);
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('change', 'src/a.ts');
    const closeA = watcher.close(); // final drain blocks on indexFile
    let bDone = false;
    const closeB = watcher.close().then(() => {
      bDone = true;
    });
    await Promise.resolve();
    // B must not resolve while A's final drain is still in flight.
    expect(bDone).toBe(false);

    resolveFirst('indexed');
    await Promise.all([closeA, closeB]);
    expect(bDone).toBe(true);
  });

  it('ignores events after close', async () => {
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });
    await watcher.close();

    watcher.handleEvent('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 2);
    expect(indexFile).not.toHaveBeenCalled();
  });
});

describe('Watcher — directory events', () => {
  it('coalesces an existing-directory event into one indexChanged', async () => {
    mkdirSync(join(root, 'newpkg'), { recursive: true });
    const indexFile = vi.fn().mockResolvedValue('indexed');
    const indexChanged = vi.fn().mockResolvedValue(true);
    const watcher = new Watcher(
      stubIndexer({ indexFile, indexChanged }),
      stubIndex(),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    watcher.handleEvent('rename', 'newpkg');
    await advanceAndSettle(watcher, DEBOUNCE);
    // Directory detected → rescan scheduled for the retry tick.
    expect(indexFile).not.toHaveBeenCalledWith('newpkg');

    await advanceAndSettle(watcher, RETRY);
    expect(indexChanged).toHaveBeenCalledTimes(1);
  });

  it('skips the rescan when the batch itself covers every deleted child', async () => {
    // rm -rf emits per-child events alongside the dir's on most
    // platforms — the per-file deletions fully cover the prune, so a
    // full rescan walk would be pure waste.
    const indexChanged = vi.fn().mockResolvedValue(true);
    const indexFile = vi.fn().mockResolvedValue('removed');
    const watcher = new Watcher(
      stubIndexer({ indexFile, indexChanged }),
      stubIndex({ files: [makeFileInfo('typescript', 'src/sub/a.ts')] }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    // Both the child and the directory are gone on disk; both evented.
    watcher.handleEvent('rename', 'src/sub/a.ts');
    watcher.handleEvent('rename', 'src/sub');
    await advanceAndSettle(watcher, DEBOUNCE);
    await advanceAndSettle(watcher, RETRY);

    expect(indexFile).toHaveBeenCalledWith('src/sub/a.ts');
    expect(indexChanged).not.toHaveBeenCalled();
  });

  it('re-queues cap-skipped creations once a same-batch deletion frees a slot', async () => {
    writeTree(root, { 'src/new.ts': 'export function fresh() {}\n' });
    const outcomes = new Map([
      ['src/old.ts', 'removed'], // deletion frees a slot
      ['src/new.ts', 'cap-skipped'],
    ]);
    const indexFile = vi.fn().mockImplementation((rel: string) => {
      const out = outcomes.get(rel) ?? 'indexed';
      outcomes.set(rel, 'indexed'); // retry succeeds
      return Promise.resolve(out);
    });
    const watcher = new Watcher(stubIndexer({ indexFile }), stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('rename', 'src/new.ts');
    watcher.handleEvent('rename', 'src/old.ts');
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexFile).toHaveBeenCalledTimes(2);

    await advanceAndSettle(watcher, RETRY);
    expect(indexFile).toHaveBeenCalledTimes(3);
    expect(indexFile).toHaveBeenLastCalledWith('src/new.ts');
  });

  it('re-arms the rescan when the scan completed but was partial', async () => {
    const indexChanged = vi.fn().mockResolvedValue(true);
    const indexer = stubIndexer({ indexChanged });
    let complete = false;
    Object.defineProperty(indexer, 'lastScanComplete', { get: () => complete });
    const watcher = new Watcher(indexer, stubIndex(), config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });

    watcher.handleEvent('rename', null);
    await advanceAndSettle(watcher, DEBOUNCE);
    expect(indexChanged).toHaveBeenCalledTimes(1);

    // Partial scan → retried; once complete, it settles.
    complete = true;
    await advanceAndSettle(watcher, RETRY);
    expect(indexChanged).toHaveBeenCalledTimes(2);
    await advanceAndSettle(watcher, RETRY);
    expect(indexChanged).toHaveBeenCalledTimes(2);
  });

  it('rescans when a missing path has indexed children (deleted directory)', async () => {
    const indexChanged = vi.fn().mockResolvedValue(true);
    const watcher = new Watcher(
      stubIndexer({ indexChanged }),
      stubIndex({ files: [makeFileInfo('typescript', 'src/sub/a.ts')] }),
      config,
      { debounceMs: DEBOUNCE, retryMs: RETRY },
    );

    // src/sub never existed in tmpRoot — lstat fails, children indexed.
    watcher.handleEvent('rename', 'src/sub');
    await advanceAndSettle(watcher, DEBOUNCE);
    await advanceAndSettle(watcher, RETRY);

    expect(indexChanged).toHaveBeenCalledTimes(1);
  });
});

describe('Watcher — end-to-end with a real Indexer', () => {
  function realSetup() {
    const index = new CodeIndex(config.projectRoot);
    const indexer = new Indexer(config, index);
    const watcher = new Watcher(indexer, index, config, {
      debounceMs: DEBOUNCE,
      retryMs: RETRY,
    });
    return { index, indexer, watcher };
  }

  it('indexes a created file and persists the cache', async () => {
    const { index, indexer, watcher } = realSetup();
    await indexer.indexAll();

    writeTree(root, { 'src/new.ts': 'export function fresh() {}\n' });
    watcher.handleEvent('rename', 'src/new.ts');
    await advanceAndSettle(watcher, DEBOUNCE);

    expect(index.findSymbolByName('fresh')).toHaveLength(1);
    expect(existsSync(indexer.cachePath)).toBe(true);
  });

  it('re-indexes a modified file', async () => {
    writeTree(root, { 'src/a.ts': 'export function before() {}\n' });
    const { index, indexer, watcher } = realSetup();
    await indexer.indexAll();
    expect(index.findSymbolByName('before')).toHaveLength(1);

    writeFileSync(join(root, 'src/a.ts'), 'export function after() {}\n');
    watcher.handleEvent('change', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);

    expect(index.findSymbolByName('before')).toEqual([]);
    expect(index.findSymbolByName('after')).toHaveLength(1);
  });

  it('removes symbols for a deleted file and still saves', async () => {
    writeTree(root, { 'src/a.ts': 'export function gone() {}\n' });
    const { index, indexer, watcher } = realSetup();
    await indexer.indexAll();
    expect(index.findSymbolByName('gone')).toHaveLength(1);
    const saveSpy = vi.spyOn(index, 'save');

    rmSync(join(root, 'src/a.ts'));
    watcher.handleEvent('rename', 'src/a.ts');
    await advanceAndSettle(watcher, DEBOUNCE);

    expect(index.findSymbolByName('gone')).toEqual([]);
    expect(saveSpy).toHaveBeenCalledTimes(1);
  });
});

describe('Watcher — real fs.watch smoke test', () => {
  it('picks up a file written to disk', async () => {
    vi.useRealTimers();
    const index = new CodeIndex(config.projectRoot);
    const indexer = new Indexer(config, index);
    const watcher = new Watcher(indexer, index, config, { debounceMs: 20 });
    await indexer.indexAll();
    watcher.start();

    try {
      // FSEvents (macOS) has a registration-latency window: a write that
      // lands immediately after fs.watch() can be missed entirely. Keep
      // re-touching the file while polling so an event fires once the
      // backend settles — the test asserts delivery, not first-write
      // latency.
      const deadline = Date.now() + 8000;
      let lastTouch = 0;
      while (Date.now() < deadline) {
        if (index.findSymbolByName('live').length > 0) break;
        if (Date.now() - lastTouch > 500) {
          writeTree(root, { 'src/live.ts': 'export function live() {}\n' });
          lastTouch = Date.now();
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(index.findSymbolByName('live')).toHaveLength(1);
    } finally {
      await watcher.close();
    }
  });
});
