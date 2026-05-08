import { rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import {
  runGetContext,
  type GetContextDeps,
} from '../../src/tools/get-context.js';
import type { ImportInfo, Reference, Symbol } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeProjectDir,
  mkSym,
  skipOnWindows,
  writeTree,
} from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('probe-get-context-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(index: CodeIndex, ready = true): GetContextDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot),
  };
}

function mkRef(source: Symbol, target: Symbol): Reference {
  return {
    sourceId: source.id,
    targetId: target.id,
    kind: 'calls',
    file: source.file,
    line: source.startLine,
  };
}

describe('runGetContext — symbol mode happy path', () => {
  it('renders header, signature, doc, body, callers, callees, imports', async () => {
    const idx = new CodeIndex(tmpRoot);
    const source = [
      "import { hash } from './utils';",
      '',
      '/** Validates the JWT token */',
      'export async function authenticate(req: Request): Promise<User> {',
      '  return helper(req);',
      '}',
      '',
      'function helper(req: Request): User {',
      '  return req as User;',
      '}',
      '',
      'function caller(req: Request) {',
      '  return authenticate(req);',
      '}',
      '',
    ].join('\n');
    writeTree(tmpRoot, { 'src/auth.ts': source });

    const target = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      kind: 'function',
      exported: true,
      signature:
        'async function authenticate(req: Request): Promise<User>',
      doc: 'Validates the JWT token',
      startLine: 4,
      endLine: 6,
    });
    const helper = mkSym({
      name: 'helper',
      file: 'src/auth.ts',
      kind: 'function',
      signature: 'function helper(req: Request): User',
      startLine: 8,
      endLine: 10,
    });
    const caller = mkSym({
      name: 'caller',
      file: 'src/auth.ts',
      kind: 'function',
      signature: 'function caller(req: Request)',
      startLine: 12,
      endLine: 14,
    });
    const imports: ImportInfo[] = [
      {
        file: 'src/auth.ts',
        sourceModule: './utils',
        importedNames: [{ name: 'hash' }],
        line: 1,
      },
    ];
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [target, helper, caller],
      [mkRef(target, helper), mkRef(caller, target)],
      imports,
    );

    const result = await runGetContext(
      { file: 'src/auth.ts', symbol: 'authenticate' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/auth.ts:4-6 | function | exported');
    expect(text).toContain(
      'async function authenticate(req: Request): Promise<User>',
    );
    expect(text).toContain('Validates the JWT token');
    expect(text).toContain('### Body');
    expect(text).toContain('export async function authenticate(req: Request)');
    expect(text).toContain('  return helper(req);');
    expect(text).toContain('### Callers');
    expect(text).toContain('src/auth.ts:12 — function caller(req: Request) [structural]');
    expect(text).toContain('### Callees');
    expect(text).toContain('src/auth.ts:8 — function helper(req: Request): User [structural]');
    expect(text).toContain('### Imports');
    expect(text).toContain('- ./utils: hash');
  });

  it('omits the exported tag when symbol is internal', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/u.ts': 'function helper() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [
        mkSym({
          name: 'helper',
          file: 'src/u.ts',
          exported: false,
          signature: 'function helper()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/u.ts', symbol: 'helper' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/u.ts:1-1 | function');
    expect(text).not.toContain('| exported');
  });

  it('omits the doc line when doc is null', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/u.ts': 'function helper() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [
        mkSym({
          name: 'helper',
          file: 'src/u.ts',
          signature: 'function helper()',
          doc: null,
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/u.ts', symbol: 'helper' },
      makeDeps(idx),
    );
    const lines = result.content[0].text.split('\n');

    // Header is two lines (no doc), then a blank line before each section.
    expect(lines[0]).toBe('src/u.ts:1-1 | function');
    expect(lines[1]).toBe('function helper()');
    expect(lines[2]).toBe('');
  });

  it('renders Callers (none) and Callees (none) when there are no refs', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/u.ts': 'function foo() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/u.ts',
          signature: 'function foo()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/u.ts', symbol: 'foo' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Callers\n(none)');
    expect(text).toContain('### Callees\n(none)');
  });

  it('does not list coincidentally same-named exports from unrelated files', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': 'export function init() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'init',
          file: 'src/a.ts',
          exported: true,
          signature: 'function init()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/b.ts'),
      [
        mkSym({
          name: 'init',
          file: 'src/b.ts',
          exported: true,
          signature: 'function init()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'init' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).not.toContain('### Exported by');
    expect(text).not.toContain('src/b.ts');
  });
});

describe('runGetContext — symbol mode body extraction', () => {
  it('returns the exact line slice from the on-disk file', async () => {
    const idx = new CodeIndex(tmpRoot);
    const source = [
      'line one',
      'line two',
      'line three',
      'line four',
      'line five',
    ].join('\n');
    writeTree(tmpRoot, { 'src/a.ts': source });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo()',
          startLine: 2,
          endLine: 4,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Body\n```typescript\nline two\nline three\nline four\n```');
  });

  it('reports an in-band body error when the file is missing on disk', async () => {
    const idx = new CodeIndex(tmpRoot);
    // No writeTree — the indexed symbol references a file that does not exist.
    idx.addFile(
      makeFileInfo('typescript', 'src/missing.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/missing.ts',
          signature: 'function foo()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/missing.ts', symbol: 'foo' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Body');
    expect(text).toContain('(unable to read src/missing.ts');
    expect(text).toContain('### Callers');
  });

  it.skipIf(skipOnWindows)('refuses to follow symlinks when reading a symbol body', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/auth.ts': 'function authenticate() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth.ts',
          signature: 'function authenticate()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );
    unlinkSync(join(tmpRoot, 'src/auth.ts'));
    // Symlink target is a stable, universally-readable file; the test
    // asserts the read was refused, not where the symlink points.
    symlinkSync('/etc/hostname', join(tmpRoot, 'src/auth.ts'));

    const result = await runGetContext(
      { file: 'src/auth.ts', symbol: 'authenticate' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Body');
    expect(text).toContain('(unable to read src/auth.ts');
    expect(text).toContain('symlink');
  });

  it('refuses to read symbol body when the file exceeds maxFileSize', async () => {
    const idx = new CodeIndex(tmpRoot);
    const deps: GetContextDeps = {
      index: idx,
      indexer: { ready: true },
      config: makeConfig(tmpRoot, { maxFileSize: 128 }),
    };
    writeTree(tmpRoot, { 'src/big.ts': 'x'.repeat(deps.config.maxFileSize + 1) });
    idx.addFile(
      makeFileInfo('typescript', 'src/big.ts'),
      [
        mkSym({
          name: 'f',
          file: 'src/big.ts',
          signature: 'function f()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/big.ts', symbol: 'f' },
      deps,
    );
    const text = result.content[0].text;

    expect(text).toContain('### Body');
    expect(text).toContain('(unable to read src/big.ts');
    expect(text).toContain('exceeds maxFileSize');
  });

  it.skipIf(skipOnWindows)(
    'refuses to read when a parent directory is replaced by a symlink',
    async () => {
      const idx = new CodeIndex(tmpRoot);
      writeTree(tmpRoot, { 'src/auth.ts': 'function authenticate() {}\n' });
      idx.addFile(
        makeFileInfo('typescript', 'src/auth.ts'),
        [
          mkSym({
            name: 'authenticate',
            file: 'src/auth.ts',
            signature: 'function authenticate()',
            startLine: 1,
            endLine: 1,
          }),
        ],
        [],
        [],
      );

      // Replace src/ with a symlink to a sibling outside the project
      // root. The target also contains an auth.ts so the path resolves
      // — without realpath the read would return outside-project bytes.
      const outside = makeProjectDir('evil-');
      try {
        writeTree(outside, { 'auth.ts': 'EVIL_CONTENT\n' });
        rmSync(join(tmpRoot, 'src'), { recursive: true });
        symlinkSync(outside, join(tmpRoot, 'src'));

        const result = await runGetContext(
          { file: 'src/auth.ts', symbol: 'authenticate' },
          makeDeps(idx),
        );
        const text = result.content[0].text;

        expect(text).toContain('### Body');
        expect(text).toContain('(unable to read src/auth.ts');
        expect(text).toContain('escapes project root');
        expect(text).not.toContain('EVIL_CONTENT');
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe('runGetContext — symbol mode disambiguation', () => {
  it('lists the candidates and asks for `line` when no line is provided', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/a.ts': 'function foo() {}\n\nfunction foo() {}\n',
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo(): string',
          startLine: 1,
          endLine: 1,
        }),
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo(x: number): number',
          startLine: 3,
          endLine: 3,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain("Multiple symbols named 'foo' in src/a.ts");
    expect(text).toContain('- function 1-1: function foo(): string');
    expect(text).toContain(
      '- function 3-3: function foo(x: number): number',
    );
    expect(text).toContain('Pass `line` to disambiguate.');
  });

  it('picks the candidate whose body contains the provided line', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/a.ts': 'function foo() {}\n\n\nfunction foo() {}\n',
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo(a: string): string',
          startLine: 1,
          endLine: 1,
        }),
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo(b: number): number',
          startLine: 4,
          endLine: 4,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', line: 4 },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/a.ts:4-4');
    expect(text).toContain('function foo(b: number): number');
    expect(text).not.toContain('function foo(a: string)');
  });

  it('falls back to the nearest startLine when no candidate contains the line', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': '\n'.repeat(50) });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo(a: string)',
          startLine: 5,
          endLine: 6,
        }),
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo(b: number)',
          startLine: 30,
          endLine: 31,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', line: 28 },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/a.ts:30-31');
    expect(text).toContain('function foo(b: number)');
  });

  it('picks the innermost containing range when ranges nest', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': '\n'.repeat(15) });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'Foo',
          file: 'src/a.ts',
          kind: 'class',
          signature: 'class Foo',
          startLine: 1,
          endLine: 10,
        }),
        mkSym({
          name: 'Foo',
          file: 'src/a.ts',
          kind: 'method',
          signature: 'Foo()',
          parent: 'Foo',
          startLine: 3,
          endLine: 5,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'Foo', line: 4 },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('src/a.ts:3-5 | method');
    expect(text).not.toContain('src/a.ts:1-10');
  });
});

describe('runGetContext — symbol mode no-match', () => {
  it('renders Did you mean suggestions when fuzzy returns results', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': '' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/a.ts',
          kind: 'function',
          exported: true,
          startLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'authntcate' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain("No symbol 'authntcate' found in src/a.ts.");
    expect(text).toContain('Did you mean:');
    expect(text).toContain(
      '- authenticate (function, src/a.ts:1) [exported]',
    );
  });

  it('limits Did you mean suggestions to the requested file', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/auth.ts': '', 'src/other.ts': '' });

    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth.ts',
          kind: 'function',
          exported: true,
          startLine: 1,
        }),
      ],
      [],
      [],
    );

    idx.addFile(
      makeFileInfo('typescript', 'src/other.ts'),
      ['authn', 'authzCheck', 'authClient', 'authToken', 'authConfig'].map(
        (name, i) =>
          mkSym({
            name,
            file: 'src/other.ts',
            kind: 'function',
            startLine: i + 1,
          }),
      ),
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/auth.ts', symbol: 'authntcate' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain("No symbol 'authntcate' found in src/auth.ts.");
    expect(text).toContain(
      '- authenticate (function, src/auth.ts:1) [exported]',
    );
    expect(text).not.toContain('src/other.ts');
  });

  it('renders only the no-symbol line when fuzzy returns nothing', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': '' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'unrelated', file: 'src/a.ts' })],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'xyzqwertynotexist' },
      makeDeps(idx),
    );

    expect(result.content[0].text).toBe(
      "No symbol 'xyzqwertynotexist' found in src/a.ts.",
    );
  });
});

describe('runGetContext — file mode', () => {
  it('renders the file outline with exports, internal, imports, and callers', async () => {
    const idx = new CodeIndex(tmpRoot);
    const source = [
      "import { verify } from 'jsonwebtoken';",
      '',
      'export function authenticate() {}',
      '',
      'export function authorize() {}',
      '',
      'function validateToken() {}',
      '',
    ].join('\n');
    writeTree(tmpRoot, { 'src/auth.ts': source });

    const authenticate = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      exported: true,
      signature: 'function authenticate()',
      startLine: 3,
      endLine: 3,
    });
    const authorize = mkSym({
      name: 'authorize',
      file: 'src/auth.ts',
      exported: true,
      signature: 'function authorize()',
      startLine: 5,
      endLine: 5,
    });
    const validateToken = mkSym({
      name: 'validateToken',
      file: 'src/auth.ts',
      exported: false,
      signature: 'function validateToken()',
      startLine: 7,
      endLine: 7,
    });
    const externalCaller = mkSym({
      name: 'route',
      file: 'src/api.ts',
      signature: 'function route()',
      startLine: 10,
      endLine: 10,
    });

    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [authenticate, authorize, validateToken],
      [],
      [
        {
          file: 'src/auth.ts',
          sourceModule: 'jsonwebtoken',
          importedNames: [{ name: 'verify' }],
          line: 1,
        },
      ],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/api.ts'),
      [externalCaller],
      [mkRef(externalCaller, authenticate), mkRef(externalCaller, authorize)],
      [],
    );

    const result = await runGetContext(
      { file: 'src/auth.ts' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('## File: src/auth.ts (8 lines, 3 symbols)');
    expect(text).toContain('### Exports');
    expect(text).toContain(
      '- authenticate (function, line 3) — function authenticate()',
    );
    expect(text).toContain(
      '- authorize (function, line 5) — function authorize()',
    );
    expect(text).toContain('### Internal');
    expect(text).toContain(
      '- validateToken (function, line 7) — function validateToken()',
    );
    expect(text).toContain('### Imports');
    expect(text).toContain('- jsonwebtoken: verify');
    expect(text).toContain("### Callers of this file's exports");
    expect(text).toContain('- src/api.ts — uses authenticate, authorize');
  });

  it('lists same-file callers under Callers of this file\'s exports', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/a.ts': 'export function api() {}\n\nfunction inner() { api(); }\n',
    });
    const api = mkSym({
      name: 'api',
      file: 'src/a.ts',
      exported: true,
      signature: 'function api()',
      startLine: 1,
      endLine: 1,
    });
    const inner = mkSym({
      name: 'inner',
      file: 'src/a.ts',
      exported: false,
      signature: 'function inner()',
      startLine: 3,
      endLine: 3,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [api, inner],
      [mkRef(inner, api)],
      [],
    );

    const result = await runGetContext({ file: 'src/a.ts' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain("### Callers of this file's exports");
    expect(text).toContain('- src/a.ts — uses api');
  });

  it('renders Exports (none) when the file has no exported symbols', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/u.ts': 'function helper() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [
        mkSym({
          name: 'helper',
          file: 'src/u.ts',
          exported: false,
          signature: 'function helper()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext({ file: 'src/u.ts' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('### Exports\n(none)');
    expect(text).toContain('### Internal');
  });

  it('omits class members from the top-level Exports/Internal lists', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/u.ts': 'export class User {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [
        mkSym({
          name: 'User',
          file: 'src/u.ts',
          kind: 'class',
          exported: true,
          signature: 'class User',
          startLine: 1,
          endLine: 1,
        }),
        mkSym({
          name: 'validate',
          file: 'src/u.ts',
          kind: 'method',
          exported: true,
          signature: 'validate(): boolean',
          parent: 'User',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext({ file: 'src/u.ts' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- User (class, line 1) — class User');
    expect(text).not.toContain('- validate (method');
  });

  it('does not read files that are not in the index', async () => {
    const idx = new CodeIndex(tmpRoot);
    // The file exists on disk but is not in the index (e.g. an excluded path).
    writeTree(tmpRoot, { 'node_modules/big.js': 'a\nb\nc\n' });

    const result = await runGetContext(
      { file: 'node_modules/big.js' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('## File: node_modules/big.js');
    expect(text).toContain('0 lines');
    expect(text).toContain('not in the index');
    // Sanity: a non-zero line count would mean the disk content leaked.
    expect(text).not.toMatch(/[1-9]\d* lines/);
  });
});

describe('runGetContext — token budget', () => {
  it('truncates lower-priority sections when the budget is exhausted', async () => {
    const idx = new CodeIndex(tmpRoot);
    const longBody = Array.from(
      { length: 200 },
      (_, i) => `  // line ${i}`,
    ).join('\n');
    writeTree(tmpRoot, { 'src/a.ts': `function foo() {\n${longBody}\n}\n` });

    const target = mkSym({
      name: 'foo',
      file: 'src/a.ts',
      signature: 'function foo()',
      startLine: 1,
      endLine: 202,
    });
    const caller = mkSym({
      name: 'caller',
      file: 'src/a.ts',
      signature: 'function caller()',
      startLine: 203,
      endLine: 203,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [target, caller],
      [mkRef(caller, target)],
      [
        {
          file: 'src/a.ts',
          sourceModule: 'fs',
          importedNames: [{ name: 'readFile' }],
          line: 1,
        },
      ],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', max_tokens: 50 },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Body');
    expect(text).toContain('omitted to stay within max_tokens=50');
    expect(text).not.toContain('### Imports');
  });

  it('truncates file-mode sections when the budget is exhausted', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/big.ts': 'export function a() {}\n' });
    const exports = Array.from({ length: 50 }, (_, i) =>
      mkSym({
        name: `exp${i}`,
        file: 'src/big.ts',
        exported: true,
        signature: `function exp${i}()`,
        startLine: i + 1,
        endLine: i + 1,
      }),
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/big.ts'),
      exports,
      [],
      [
        {
          file: 'src/big.ts',
          sourceModule: 'fs',
          importedNames: [{ name: 'readFile' }],
          line: 1,
        },
      ],
    );

    const result = await runGetContext(
      { file: 'src/big.ts', max_tokens: 100 },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('## File: src/big.ts');
    expect(text).toContain('omitted to stay within max_tokens=100');
    expect(text).not.toContain('### Imports');
    expect(text).not.toContain("### Callers of this file's exports");
  });
});

describe('runGetContext — include filter', () => {
  it('honors include and emits only the requested sections', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': 'function foo() {}\n' });
    const target = mkSym({
      name: 'foo',
      file: 'src/a.ts',
      signature: 'function foo()',
      startLine: 1,
      endLine: 1,
    });
    const caller = mkSym({
      name: 'bar',
      file: 'src/a.ts',
      signature: 'function bar()',
      startLine: 5,
      endLine: 5,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [target, caller],
      [mkRef(caller, target)],
      [
        {
          file: 'src/a.ts',
          sourceModule: 'fs',
          importedNames: [{ name: 'readFile' }],
          line: 1,
        },
      ],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', include: ['callers'] },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Callers');
    expect(text).not.toContain('### Body');
    expect(text).not.toContain('### Callees');
    expect(text).not.toContain('### Imports');
  });

  it('honors include in file mode and shows only the requested sections', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/a.ts': "import { x } from 'm';\nexport function f() {}\n",
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'f',
          file: 'src/a.ts',
          exported: true,
          signature: 'function f()',
          startLine: 2,
          endLine: 2,
        }),
      ],
      [],
      [
        {
          file: 'src/a.ts',
          sourceModule: 'm',
          importedNames: [{ name: 'x' }],
          line: 1,
        },
      ],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', include: ['imports'] },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('## File: src/a.ts');
    expect(text).toContain('### Imports');
    expect(text).toContain('- m: x');
    expect(text).not.toContain('### Exports');
    expect(text).not.toContain('### Internal');
    expect(text).not.toContain("### Callers of this file's exports");
  });

  it('honors include=[body] in file mode by showing only Exports and Internal', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/a.ts': "import { x } from 'm';\nexport function f() {}\nfunction g() {}\n",
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'f',
          file: 'src/a.ts',
          exported: true,
          signature: 'function f()',
          startLine: 2,
          endLine: 2,
        }),
        mkSym({
          name: 'g',
          file: 'src/a.ts',
          exported: false,
          signature: 'function g()',
          startLine: 3,
          endLine: 3,
        }),
      ],
      [],
      [
        {
          file: 'src/a.ts',
          sourceModule: 'm',
          importedNames: [{ name: 'x' }],
          line: 1,
        },
      ],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', include: ['body'] },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Exports');
    expect(text).toContain('### Internal');
    expect(text).not.toContain('### Imports');
    expect(text).not.toContain("### Callers of this file's exports");
  });
});

describe('runGetContext — banner and validation', () => {
  it('prepends the indexing banner when indexer is not ready', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': 'function foo() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [
        mkSym({
          name: 'foo',
          file: 'src/a.ts',
          signature: 'function foo()',
          startLine: 1,
          endLine: 1,
        }),
      ],
      [],
      [],
    );

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo' },
      makeDeps(idx, false),
    );

    expect(result.content[0].text.startsWith('⏳ Indexing in progress')).toBe(
      true,
    );
  });

  it('returns an in-band error when the file path escapes the project root', async () => {
    const idx = new CodeIndex(tmpRoot);

    const result = await runGetContext(
      { file: '../outside.ts' },
      makeDeps(idx),
    );

    expect(result.content[0].text).toBe(
      'Error: file "../outside.ts" is outside the project root.',
    );
  });

  it('rejects relative paths whose `..` segments escape the project root', async () => {
    const idx = new CodeIndex(tmpRoot);

    const result = await runGetContext(
      { file: 'src/../../outside.log' },
      makeDeps(idx),
    );

    expect(result.content[0].text).toBe(
      'Error: file "src/../../outside.log" is outside the project root.',
    );
  });

  it('returns an in-band error when symbol is whitespace-only', async () => {
    const idx = new CodeIndex(tmpRoot);

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: '   ' },
      makeDeps(idx),
    );

    expect(result.content[0].text).toBe('Error: symbol must be non-empty.');
  });

  it('returns an in-band error when an index method throws', async () => {
    const idx = new CodeIndex(tmpRoot);
    vi.spyOn(idx, 'getSymbolsInFile').mockImplementation(() => {
      throw new Error('boom');
    });

    const result = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo' },
      makeDeps(idx),
    );

    expect(result.content[0].text).toBe('Error: boom');
  });
});
