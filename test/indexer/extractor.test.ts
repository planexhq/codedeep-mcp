import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { extractSymbols, symbolId } from '../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../src/indexer/parser.js';
import { makeFileInfo } from '../helpers.js';

describe('extractSymbols dispatcher', () => {
  beforeAll(async () => {
    await initParser();
  });

  it.each([
    ['typescript', 'const x = 1;'],
    ['tsx', 'const X = 1;'],
    ['javascript', 'var x = 1;'],
    ['python', 'x = 1'],
  ])('routes %s to its extractor without warning', (language, src) => {
    const tree = parseFile(src, language)!;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = extractSymbols(tree, src, makeFileInfo(language));
      expect(Array.isArray(result.symbols)).toBe(true);
      expect(Array.isArray(result.references)).toBe(true);
      expect(Array.isArray(result.imports)).toBe(true);
      const warned = stderr.mock.calls.some((c) =>
        String(c[0]).includes('unsupported language'),
      );
      expect(warned).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });

  it('returns empty and warns for an unsupported language', () => {
    const tree = parseFile('const x = 1;', 'typescript')!;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = extractSymbols(tree, 'const x = 1;', makeFileInfo('ruby'));
      expect(result).toEqual({ symbols: [], references: [], imports: [] });
      const warned = stderr.mock.calls.some((c) =>
        String(c[0]).includes('unsupported language "ruby"'),
      );
      expect(warned).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('symbolId', () => {
  it('produces a 16-char lowercase hex string', () => {
    const id = symbolId('src/a.ts', 'foo', 'function', 'function foo()');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = symbolId('src/a.ts', 'foo', 'function', 'function foo()');
    const b = symbolId('src/a.ts', 'foo', 'function', 'function foo()');
    expect(a).toBe(b);
  });

  it('changes when any field differs', () => {
    const base = symbolId('src/a.ts', 'foo', 'function', 'function foo()');
    expect(symbolId('src/b.ts', 'foo', 'function', 'function foo()')).not.toBe(base);
    expect(symbolId('src/a.ts', 'bar', 'function', 'function foo()')).not.toBe(base);
    expect(symbolId('src/a.ts', 'foo', 'method', 'function foo()')).not.toBe(base);
    expect(symbolId('src/a.ts', 'foo', 'function', 'function foo(x: number)')).not.toBe(base);
  });

  it('produces distinct ids for same-name/same-signature methods on different classes', () => {
    const a = symbolId('src/a.ts', 'init', 'method', 'init()', 'A');
    const b = symbolId('src/a.ts', 'init', 'method', 'init()', 'B');
    expect(a).not.toBe(b);
  });

  it('matches the documented hash format for top-level symbols', () => {
    const expected = createHash('sha1')
      .update('src/a.ts\0foo\0function\0function foo()')
      .digest('hex')
      .slice(0, 16);
    expect(symbolId('src/a.ts', 'foo', 'function', 'function foo()')).toBe(expected);
  });

  it('appends the qualifier with a separator only when non-empty', () => {
    const expected = createHash('sha1')
      .update('src/a.ts\0init\0method\0init()\0A')
      .digest('hex')
      .slice(0, 16);
    expect(symbolId('src/a.ts', 'init', 'method', 'init()', 'A')).toBe(expected);
  });
});
