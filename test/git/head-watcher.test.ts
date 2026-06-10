// HeadWatcher debounce/filter logic with a fake backend and fake timers
// (cloned from the watcher.test.ts pattern). No real fs.watch here — the
// real-FS path is smoke-tested at the GitService level where a commit
// must end in a refresh.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HeadWatcher,
  type HeadWatchBackend,
  type HeadWatchFactory,
} from '../../src/git/head-watcher.js';
import { silenceStderr } from '../helpers.js';

type EventFn = (eventType: string, filename: string | Buffer | null) => void;

class FakeBackend implements HeadWatchBackend {
  closed = 0;
  close(): void {
    this.closed++;
  }
}

function harness(debounceMs = 1_000) {
  const backend = new FakeBackend();
  let emit: EventFn = () => {};
  let fail: (err: unknown) => void = () => {};
  let dirWatched = '';
  const factory: HeadWatchFactory = (dir, onEvent, onError) => {
    dirWatched = dir;
    emit = onEvent;
    fail = onError;
    return backend;
  };
  const fired: number[] = [];
  const watcher = new HeadWatcher('/repo/.git/logs/HEAD', () => fired.push(Date.now()), {
    debounceMs,
    watchFactory: factory,
  });
  return {
    backend,
    watcher,
    fired,
    dir: () => dirWatched,
    emit: (name: string | Buffer | null) => emit('change', name),
    fail: (err: unknown) => fail(err),
  };
}

let stderrSpy: ReturnType<typeof silenceStderr>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  stderrSpy = silenceStderr();
});

afterEach(() => {
  vi.useRealTimers();
  stderrSpy.mockRestore();
  vi.restoreAllMocks();
});

describe('HeadWatcher', () => {
  it('watches the logs DIRECTORY, not the file', () => {
    const h = harness();
    expect(h.watcher.start()).toBe(true);
    expect(h.dir()).toBe('/repo/.git/logs');
  });

  it('coalesces a burst of HEAD events into one onChange (rebase case)', async () => {
    const h = harness();
    h.watcher.start();
    for (let i = 0; i < 12; i++) {
      h.emit('HEAD');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(h.fired).toHaveLength(0); // still inside the trailing window
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fired).toHaveLength(1);
  });

  it('uses a trailing debounce — each event resets the timer', async () => {
    const h = harness();
    h.watcher.start();
    h.emit('HEAD');
    await vi.advanceTimersByTimeAsync(600);
    h.emit('HEAD');
    await vi.advanceTimersByTimeAsync(600);
    expect(h.fired).toHaveLength(0); // 1.2s elapsed but reset at 0.6s
    await vi.advanceTimersByTimeAsync(400);
    expect(h.fired).toHaveLength(1);
  });

  it('fires again for a later, separate event', async () => {
    const h = harness();
    h.watcher.start();
    h.emit('HEAD');
    await vi.advanceTimersByTimeAsync(1_000);
    h.emit('HEAD');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fired).toHaveLength(2);
  });

  it('ignores events for other files in logs/', async () => {
    const h = harness();
    h.watcher.start();
    h.emit('refs');
    h.emit(Buffer.from('refs'));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.fired).toHaveLength(0);
  });

  it('treats a null filename as potentially-HEAD', async () => {
    const h = harness();
    h.watcher.start();
    h.emit(null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fired).toHaveLength(1);
  });

  it('accepts Buffer filenames', async () => {
    const h = harness();
    h.watcher.start();
    h.emit(Buffer.from('HEAD'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fired).toHaveLength(1);
  });

  it('close() cancels a pending refresh and is idempotent', async () => {
    const h = harness();
    h.watcher.start();
    h.emit('HEAD');
    h.watcher.close();
    h.watcher.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.fired).toHaveLength(0);
    expect(h.backend.closed).toBe(1);
  });

  it('ignores events arriving after close', async () => {
    const h = harness();
    h.watcher.start();
    h.watcher.close();
    h.emit('HEAD');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.fired).toHaveLength(0);
  });

  it('start() returns false when the factory throws and never propagates', () => {
    const watcher = new HeadWatcher('/repo/.git/logs/HEAD', () => {}, {
      watchFactory: () => {
        throw new Error('inotify exhausted');
      },
    });
    expect(watcher.start()).toBe(false);
  });

  it('a backend error closes the watcher; pending and later events are dropped', async () => {
    const h = harness();
    h.watcher.start();
    h.emit('HEAD');
    h.fail(new Error('watch died'));
    h.emit('HEAD');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.fired).toHaveLength(0);
    expect(h.backend.closed).toBe(1);
  });

  it('start() after close stays closed', () => {
    const h = harness();
    h.watcher.start();
    h.watcher.close();
    expect(h.watcher.start()).toBe(false);
  });
});

describe('HeadWatcher max-wait cap', () => {
  it('a continuous event stream still fires by the wall-clock deadline', async () => {
    const backend = new FakeBackend();
    let emit: EventFn = () => {};
    const factory: HeadWatchFactory = (_dir, onEvent) => {
      emit = onEvent;
      return backend;
    };
    const fired: number[] = [];
    const watcher = new HeadWatcher('/repo/.git/logs/HEAD', () => fired.push(1), {
      debounceMs: 1_000,
      maxDelayMs: 5_000,
      watchFactory: factory,
    });
    watcher.start();

    // Events every 500ms forever — trailing debounce alone would never fire.
    for (let i = 0; i < 14; i++) {
      emit('change', 'HEAD');
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(fired.length).toBeGreaterThanOrEqual(1);
    watcher.close();
  });
});

describe('HeadWatcher leading-edge window-start callback', () => {
  it('fires once at the FIRST event of each accumulation window', async () => {
    const backend = new FakeBackend();
    let emit: EventFn = () => {};
    const factory: HeadWatchFactory = (_dir, onEvent) => {
      emit = onEvent;
      return backend;
    };
    const starts: number[] = [];
    const fires: number[] = [];
    const watcher = new HeadWatcher('/repo/.git/logs/HEAD', () => fires.push(1), {
      debounceMs: 1_000,
      watchFactory: factory,
      onWindowStart: () => starts.push(1),
    });
    watcher.start();

    // Burst: window-start exactly once, trailing fire once.
    for (let i = 0; i < 5; i++) {
      emit('change', 'HEAD');
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(starts).toHaveLength(1);
    expect(fires).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fires).toHaveLength(1);

    // A later event opens a NEW window: window-start fires again.
    emit('change', 'HEAD');
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fires).toHaveLength(2);
    watcher.close();
  });
});
