import { beforeAll, describe, expect, it, vi } from 'vitest';

import { initParser, parseFile } from '../../src/indexer/parser.js';

const TS_SRC =
  'export const x: number = 1;\nexport function add(a: number, b: number): number { return a + b; }\n';
const TSX_SRC =
  "import * as React from 'react';\nexport const Hello = (): JSX.Element => <div className=\"x\">hi</div>;\n";
const JS_SRC = 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n';
const PY_SRC = 'def add(a, b):\n    """Sum two numbers."""\n    return a + b\n';

describe('parser', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('initParser is idempotent (second call resolves without re-loading)', async () => {
    await expect(initParser()).resolves.toBeUndefined();
    await expect(initParser()).resolves.toBeUndefined();
  });

  it('parses valid TypeScript into a non-error tree', () => {
    const tree = parseFile(TS_SRC, 'typescript');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.namedChildCount).toBeGreaterThan(0);
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it('parses valid TSX into a non-error tree', () => {
    const tree = parseFile(TSX_SRC, 'tsx');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.namedChildCount).toBeGreaterThan(0);
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it('parses valid JavaScript into a non-error tree', () => {
    const tree = parseFile(JS_SRC, 'javascript');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('program');
    expect(tree!.rootNode.namedChildCount).toBeGreaterThan(0);
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it('parses valid Python into a non-error tree', () => {
    const tree = parseFile(PY_SRC, 'python');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.type).toBe('module');
    expect(tree!.rootNode.namedChildCount).toBeGreaterThan(0);
    expect(tree!.rootNode.hasError).toBe(false);
  });

  it('returns a partial tree with hasError=true for syntactically broken input (does not throw)', () => {
    const broken = 'function broken( {\n  return\n';
    const tree = parseFile(broken, 'typescript');
    expect(tree).not.toBeNull();
    expect(tree!.rootNode.hasError).toBe(true);
  });

  it('returns null for an unsupported language and logs a warning', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const tree = parseFile('puts 1', 'ruby');
      expect(tree).toBeNull();

      const warned = stderr.mock.calls.some((c) =>
        String(c[0]).includes('unsupported language "ruby"'),
      );
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('parser without initialization', () => {
  it('throws when parseFile is called before initParser', async () => {
    vi.resetModules();
    const fresh = await import('../../src/indexer/parser.js');
    expect(() => fresh.parseFile('const x = 1;', 'typescript')).toThrow(
      /not initialized/i,
    );
  });
});
