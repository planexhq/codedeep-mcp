import { afterEach, describe, expect, it, vi } from 'vitest';

// Wrap web-tree-sitter so Language.load can be made to fail a controlled
// number of times — simulating the transient EMFILE the in-place retry in
// ensureLanguage exists for. Only `Language.load` is intercepted; Parser
// (init/setLanguage/parse) stays real.
const loadState = vi.hoisted(() => ({ failUntilCall: 0, calls: 0 }));
vi.mock('web-tree-sitter', async (importOriginal) => {
  const real = await importOriginal<typeof import('web-tree-sitter')>();
  return {
    ...real,
    Language: {
      load: (p: string) => {
        loadState.calls++;
        if (loadState.calls <= loadState.failUntilCall) {
          return Promise.reject(new Error('simulated EMFILE'));
        }
        return real.Language.load(p);
      },
    },
  };
});

const PY_SRC = 'def add(a, b):\n    return a + b\n';

describe('grammar load — bounded in-place retry', () => {
  afterEach(() => {
    vi.resetModules();
    loadState.calls = 0;
    loadState.failUntilCall = 0;
  });

  it('a transient load failure self-heals WITHIN one initParser call', async () => {
    // Two failures, then success: the caller sees ONE resolved promise —
    // no watcher re-queues, no per-path budgets, no startup/watcher split.
    vi.resetModules();
    loadState.calls = 0;
    loadState.failUntilCall = 2;
    const parser = await import('../../src/indexer/parser.js');
    await expect(parser.initParser(['python'])).resolves.toBeUndefined();
    expect(loadState.calls).toBe(3); // 2 failures + 1 success, all in place
    const tree = parser.parseFile(PY_SRC, 'python');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it('a durable failure rejects after the attempt budget, fails FAST within the TTL, then probes again', async () => {
    // Fake Date only — the retry backoff's setTimeout must stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.resetModules();
      loadState.calls = 0;
      loadState.failUntilCall = Number.MAX_SAFE_INTEGER;
      const parser = await import('../../src/indexer/parser.js');
      await expect(parser.initParser(['python'])).rejects.toThrow(/simulated EMFILE/);
      expect(loadState.calls).toBe(3); // bounded — never spins on a corrupt .wasm

      // Within the failure TTL, further ensures FAIL FAST without re-running
      // the backoff sequence — a serial batch over thousands of files of a
      // broken language must not pay ~150ms of backoff per file.
      await expect(parser.initParser(['python'])).rejects.toThrow(/simulated EMFILE/);
      await expect(parser.initParser(['python'])).rejects.toThrow(/simulated EMFILE/);
      expect(loadState.calls).toBe(3); // no new load attempts inside the window

      // Past the TTL the next call probes for real; once the cause has
      // cleared it loads — the language is never latched off for the session.
      vi.setSystemTime(Date.now() + 10_000);
      loadState.failUntilCall = loadState.calls;
      await expect(parser.initParser(['python'])).resolves.toBeUndefined();
      expect(loadState.calls).toBe(4); // exactly one fresh probe
      expect(parser.parseFile(PY_SRC, 'python')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
