import { existsSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeIndex } from '../../src/indexer/code-index.js';
import { NoteStore } from '../../src/notes/note-store.js';
import { runRecall } from '../../src/tools/recall.js';
import { runRemember } from '../../src/tools/remember.js';
import {
  runGetContext,
  type GetContextDeps,
} from '../../src/tools/get-context.js';
import type { ImportInfo, Symbol } from '../../src/types.js';
import {
  makeConfig,
  makeFileInfo,
  makeGitStub,
  makeProjectDir,
  mkCoChange,
  mkGitMeta,
  mkImport,
  mkMemberRef,
  mkModuleRef,
  mkRef,
  mkSym,
  mkUnresolvedRef,
  skipOnWindows,
  writeTree,
} from '../helpers.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = makeProjectDir('codedeep-get-context-');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDeps(
  index: CodeIndex,
  ready = true,
  git: GetContextDeps['git'] = makeGitStub(),
  notes: NoteStore = new NoteStore(
    join(tmpRoot, '.codedeep', 'cache', 'notes.json'),
    tmpRoot,
  ),
): GetContextDeps {
  return {
    index,
    indexer: { ready },
    config: makeConfig(tmpRoot),
    git,
    notes,
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

  it('renders same-file module-level callers as `(module-level) [structural]`', async () => {
    const idx = new CodeIndex(tmpRoot);
    const source = [
      'function helper() {}',
      '',
      'helper();',
      '',
    ].join('\n');
    writeTree(tmpRoot, { 'src/u.ts': source });
    const target = mkSym({
      name: 'helper',
      file: 'src/u.ts',
      kind: 'function',
      signature: 'function helper()',
      startLine: 1,
      endLine: 1,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [target],
      [mkModuleRef(target, 3)],
      [],
    );

    const result = await runGetContext(
      { file: 'src/u.ts', symbol: 'helper' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Callers');
    expect(text).toContain('- src/u.ts:3 — (module-level) [structural]');
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

  it('strips the carriage return from body lines of CRLF-authored source', async () => {
    const idx = new CodeIndex(tmpRoot);
    // CRLF line endings (a Windows-saved source file). writeTree writes raw
    // bytes, so the '\r' survives to the reader. tree-sitter counts '\r\n' as
    // one row, so the symbol's line range is unchanged — only the rendered
    // body could leak a stray '\r' onto every line.
    const source = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\r\n');
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
    // The regression guard: without the CR strip each body line keeps a '\r'.
    expect(text).not.toContain('\r');
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
      git: makeGitStub(),
      notes: new NoteStore(join(tmpRoot, '.codedeep', 'cache', 'notes.json'), tmpRoot),
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
      // Cross-file calls are UNRESOLVED name refs (targetId null) — the real
      // extractor resolves ids within one file only, and addFile's same-file
      // gate demotes anything else. The import edge is what scopes them to
      // src/auth.ts (primaryRefMatchesTarget), exactly as in real code.
      [
        mkUnresolvedRef(externalCaller, 'authenticate'),
        mkUnresolvedRef(externalCaller, 'authorize'),
      ],
      [
        {
          file: 'src/api.ts',
          sourceModule: './auth',
          importedNames: [{ name: 'authenticate' }, { name: 'authorize' }],
          line: 1,
        },
      ],
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

  it("lists same-file module-level uses under Callers of this file's exports", async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/u.ts': 'export function helper() {}\n\nhelper();\n',
    });
    const helper = mkSym({
      name: 'helper',
      file: 'src/u.ts',
      exported: true,
      signature: 'function helper()',
      startLine: 1,
      endLine: 1,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/u.ts'),
      [helper],
      [mkModuleRef(helper, 3)],
      [],
    );

    const result = await runGetContext({ file: 'src/u.ts' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain("### Callers of this file's exports");
    expect(text).toContain('- src/u.ts — uses helper');
  });

  it("lists cross-file callers under Callers of this file's exports", async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/utils.ts': 'export function hash() {}\n',
      'src/foo.ts':
        "import { hash } from './utils.js';\n\nfunction caller() { hash(); }\n",
    });
    const hash = mkSym({
      name: 'hash',
      file: 'src/utils.ts',
      exported: true,
      signature: 'function hash()',
      startLine: 1,
      endLine: 1,
    });
    const caller = mkSym({
      name: 'caller',
      file: 'src/foo.ts',
      exported: false,
      signature: 'function caller()',
      startLine: 3,
      endLine: 3,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/utils.ts'),
      [hash],
      [],
      [],
    );
    idx.addFile(
      makeFileInfo('typescript', 'src/foo.ts'),
      [caller],
      [mkUnresolvedRef(caller, 'hash', 'src/foo.ts', 3)],
      [mkImport('src/foo.ts', './utils.js', [{ name: 'hash' }])],
    );

    const result = await runGetContext(
      { file: 'src/utils.ts' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain("### Callers of this file's exports");
    expect(text).toContain('- src/foo.ts — uses hash');
  });

  it("Callers of this file's exports excludes precise-homonym mismatches", async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/a.ts':
        'export function hash() {}\n\nfunction otherHash() {}\n\nfunction inner() { otherHash(); }\n',
    });
    const hash = mkSym({
      name: 'hash',
      file: 'src/a.ts',
      exported: true,
      signature: 'function hash()',
      startLine: 1,
      endLine: 1,
    });
    const otherHash = mkSym({
      name: 'hash',
      file: 'src/a.ts',
      exported: false,
      signature: 'function hash() // shadow',
      startLine: 3,
      endLine: 3,
    });
    const inner = mkSym({
      name: 'inner',
      file: 'src/a.ts',
      exported: false,
      signature: 'function inner()',
      startLine: 5,
      endLine: 5,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [hash, otherHash, inner],
      [mkRef(inner, otherHash)],
      [],
    );

    const result = await runGetContext({ file: 'src/a.ts' }, makeDeps(idx));
    const text = result.content[0].text;

    // inner() calls the second `hash` (otherHash); isCallerOf rejects it
    // for the exported `hash` (precise targetId mismatch). Section should
    // be (none).
    expect(text).toContain(
      "### Callers of this file's exports (approximate — from AST name matching)\n(none)",
    );
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

  it('surfaces a typo\'d include section instead of silently dropping it', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/a.ts': 'function foo() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/a.ts'),
      [mkSym({ name: 'foo', file: 'src/a.ts', startLine: 1, endLine: 1 })],
      [],
      [],
    );

    // All-invalid: the old behavior yielded an EMPTY shell that read as "no
    // data here" — a false conclusion. Now: note the typo, list the valid
    // names, and fall back to showing everything.
    const allBad = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', include: ['callrs'] },
      makeDeps(idx),
    );
    const allBadText = allBad.content[0].text;
    expect(allBadText).toContain('Ignored unknown include section');
    expect(allBadText).toContain('"callrs"');
    expect(allBadText).toContain('Valid: body, callers');
    expect(allBadText).toContain('Showing all sections');
    expect(allBadText).toContain('### Body'); // fell back to ALL_SECTIONS

    // Mixed: keep the valid selection, still surface the unknown key.
    const mixed = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', include: ['body', 'callrs'] },
      makeDeps(idx),
    );
    const mixedText = mixed.content[0].text;
    expect(mixedText).toContain('Ignored unknown include section');
    expect(mixedText).toContain('### Body');
    expect(mixedText).not.toContain('### Callers'); // selection still honored
    expect(mixedText).not.toContain('Showing all sections');

    // Hyphen alias folds to the canonical underscore name — no note.
    const hyphen = await runGetContext(
      { file: 'src/a.ts', symbol: 'foo', include: ['co-changes'] },
      makeDeps(idx),
    );
    expect(hyphen.content[0].text).not.toContain('Ignored unknown');
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

describe('runGetContext — member-ref method adjacency', () => {
  it('renders sibling-method callers and callees from resolved this.x() refs', async () => {
    const idx = new CodeIndex(tmpRoot);
    const source = [
      'class Service {',
      '  helper() {',
      '    return 1;',
      '  }',
      '  run() {',
      '    return this.helper();',
      '  }',
      '}',
      '',
    ].join('\n');
    writeTree(tmpRoot, { 'src/service.ts': source });

    const cls = mkSym({
      name: 'Service',
      kind: 'class',
      file: 'src/service.ts',
      signature: 'class Service',
      startLine: 1,
      endLine: 8,
    });
    const helper = mkSym({
      name: 'helper',
      kind: 'method',
      parent: 'Service',
      file: 'src/service.ts',
      signature: 'helper()',
      startLine: 2,
      endLine: 4,
    });
    const run = mkSym({
      name: 'run',
      kind: 'method',
      parent: 'Service',
      file: 'src/service.ts',
      signature: 'run()',
      startLine: 5,
      endLine: 7,
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/service.ts'),
      [cls, helper, run],
      [mkMemberRef(run, 'helper', 'this', { targetId: helper.id, line: 6 })],
      [],
    );

    const callersText = (
      await runGetContext(
        { file: 'src/service.ts', symbol: 'helper' },
        makeDeps(idx),
      )
    ).content[0].text;
    expect(callersText).toContain('### Callers');
    expect(callersText).toContain('src/service.ts:5 — run() [structural]');

    const calleesText = (
      await runGetContext(
        { file: 'src/service.ts', symbol: 'run' },
        makeDeps(idx),
      )
    ).content[0].text;
    expect(calleesText).toContain('### Callees');
    expect(calleesText).toContain('src/service.ts:2 — helper() [structural]');
  });
});

describe('runGetContext — git sections', () => {
  // Symbol-mode fixture with one exported symbol whose body exists on disk.
  function gitFixture(): CodeIndex {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/auth.ts': 'export function authenticate() {\n  return 1;\n}\n',
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth.ts',
          exported: true,
          startLine: 1,
          endLine: 3,
          signature: 'function authenticate()',
        }),
      ],
      [],
      [],
    );
    return idx;
  }

  // Asymmetric on purpose: the queried file is fileB, so the from-self
  // confidence is confidenceBA (83%), NOT confidenceAB (60%). Inverting
  // the direction is the bug this fixture exists to catch.
  async function applyCoChanges(idx: CodeIndex): Promise<void> {
    await idx.applyGitAnalysis({
      counts: new Map([
        ['src/auth.ts', 14],
        ['config/auth.yaml', 20],
      ]),
      cochanges: new Map([
        [
          'src/auth.ts',
          [
            mkCoChange('config/auth.yaml', 'src/auth.ts', 12, {
              confidenceAB: 0.6,
              confidenceBA: 0.83,
            }),
            mkCoChange('src/auth.ts', 'tests/auth.test.ts', 9, {
              confidenceAB: 0.71,
              confidenceBA: 0.4,
            }),
          ],
        ],
      ]),
      hotspots: ['src/auth.ts'],
      meta: { head: 'h'.repeat(40), windowDays: 180, analyzedAt: Date.now() },
    });
  }

  it('renders co-change partners with the from-self confidence direction', async () => {
    const idx = gitFixture();
    await applyCoChanges(idx);

    const result = await runGetContext(
      { file: 'src/auth.ts', symbol: 'authenticate' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Co-change Partners (2 behavioral)');
    expect(text).toContain('- config/auth.yaml  83% confidence (12 shared commits)');
    expect(text).toContain('- tests/auth.test.ts  71% confidence (9 shared commits)');
    // Strongest first.
    expect(text.indexOf('config/auth.yaml')).toBeLessThan(
      text.indexOf('tests/auth.test.ts'),
    );
  });

  it('renders recent changes rows from the git service', async () => {
    const idx = gitFixture();
    const git = makeGitStub({
      recentCommits: async () => [
        { hash: 'abc1234', date: '2026-04-10', subject: 'fix token refresh race condition' },
        { hash: 'def5678', date: '2026-04-03', subject: 'add OAuth2 PKCE support' },
      ],
    });
    const result = await runGetContext(
      { file: 'src/auth.ts', symbol: 'authenticate' },
      makeDeps(idx, true, git),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Recent Changes [behavioral]');
    expect(text).toContain('- 2026-04-10 abc1234 "fix token refresh race condition"');
    expect(text).toContain('- 2026-04-03 def5678 "add OAuth2 PKCE support"');
  });

  it('renders both git sections in file mode too', async () => {
    const idx = gitFixture();
    await applyCoChanges(idx);
    const git = makeGitStub({
      recentCommits: async () => [
        { hash: 'abc1234', date: '2026-04-10', subject: 'touch' },
      ],
    });
    const text = (
      await runGetContext({ file: 'src/auth.ts' }, makeDeps(idx, true, git))
    ).content[0].text;

    expect(text).toContain('## File: src/auth.ts');
    expect(text).toContain('### Co-change Partners (2 behavioral)');
    expect(text).toContain('### Recent Changes [behavioral]');
  });

  it('omits git sections entirely outside git repos', async () => {
    const idx = gitFixture();
    const text = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Body');
    expect(text).not.toContain('Co-change Partners');
    expect(text).not.toContain('Recent Changes');
    expect(text).not.toContain('[behavioral]');
  });

  it('include filtering isolates the co_changes section', async () => {
    const idx = gitFixture();
    await applyCoChanges(idx);
    const text = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate', include: ['co_changes'] },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Co-change Partners (2 behavioral)');
    expect(text).not.toContain('### Body');
    expect(text).not.toContain('### Callers');
    expect(text).not.toContain('### Recent Changes');
  });

  it('drops git sections first under max_tokens pressure while body survives', async () => {
    const idx = gitFixture();
    await applyCoChanges(idx);
    const git = makeGitStub({
      recentCommits: async () => [
        { hash: 'abc1234', date: '2026-04-10', subject: 'touch' },
      ],
    });
    const text = (
      await runGetContext(
        {
          file: 'src/auth.ts',
          symbol: 'authenticate',
          include: ['body', 'co_changes', 'git'],
          max_tokens: 30,
        },
        makeDeps(idx, true, git),
      )
    ).content[0].text;

    expect(text).toContain('### Body');
    expect(text).not.toContain('Co-change Partners');
    expect(text).not.toContain('Recent Changes');
    expect(text).toContain('omitted to stay within max_tokens=30');
    expect(text).toContain('co-change partners');
  });

  it('a rejecting recentCommits never breaks the response', async () => {
    const idx = gitFixture();
    const git = makeGitStub({
      recentCommits: async () => {
        throw new Error('boom');
      },
    });
    const text = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        makeDeps(idx, true, git),
      )
    ).content[0].text;

    expect(text).toContain('### Body');
    expect(text).not.toContain('Recent Changes');
    expect(text).not.toContain('Error:');
  });

  it('caps co-change partners at five rows', async () => {
    const idx = gitFixture();
    const list = Array.from({ length: 7 }, (_, i) =>
      mkCoChange('src/auth.ts', `src/p${i}.ts`, 10 - i, {
        confidenceAB: (10 - i) / 14,
      }),
    );
    await idx.applyGitAnalysis({
      counts: new Map([['src/auth.ts', 14]]),
      cochanges: new Map([['src/auth.ts', list]]),
      hotspots: [],
      meta: mkGitMeta(),
    });
    const text = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Co-change Partners (5 behavioral)');
    expect(text).toContain('src/p0.ts');
    expect(text).toContain('src/p4.ts');
    expect(text).not.toContain('src/p5.ts');
  });
});

describe('runGetContext — review hardening', () => {
  it('floors displayed co-change confidence at 1% (never a 0% row)', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/hub.ts': 'export function hub() {}\n' });
    idx.addFile(
      makeFileInfo('typescript', 'src/hub.ts'),
      [
        mkSym({
          name: 'hub',
          file: 'src/hub.ts',
          startLine: 1,
          endLine: 1,
          signature: 'function hub()',
        }),
      ],
      [],
      [],
    );
    await idx.applyGitAnalysis({
      counts: new Map([['src/hub.ts', 700]]),
      cochanges: new Map([
        [
          'src/hub.ts',
          [
            mkCoChange('src/hub.ts', 'src/rare.ts', 3, {
              confidenceAB: 3 / 700, // 0.43% — would round to 0
            }),
          ],
        ],
      ]),
      hotspots: [],
      meta: mkGitMeta(),
    });
    const text = (
      await runGetContext({ file: 'src/hub.ts', symbol: 'hub' }, makeDeps(idx))
    ).content[0].text;
    expect(text).toContain('- src/rare.ts  1% confidence (3 shared commits)');
    expect(text).not.toContain('0% confidence');
  });

  it('truncation note never names a git section that would render empty', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/auth.ts': 'export function authenticate() {\n  return 1;\n}\n',
    });
    idx.addFile(
      makeFileInfo('typescript', 'src/auth.ts'),
      [
        mkSym({
          name: 'authenticate',
          file: 'src/auth.ts',
          startLine: 1,
          endLine: 3,
          signature: 'function authenticate()',
        }),
      ],
      [],
      [],
    );
    // No git data at all: with a tight budget the old pre-render break
    // would name 'co-change partners' and promise content that a larger
    // max_tokens could never reveal.
    const text = (
      await runGetContext(
        {
          file: 'src/auth.ts',
          symbol: 'authenticate',
          include: ['body', 'co_changes', 'git'],
          max_tokens: 30,
        },
        makeDeps(idx),
      )
    ).content[0].text;

    expect(text).toContain('### Body');
    expect(text).not.toContain('omitted to stay within');
    expect(text).not.toContain('co-change partners');
  });
});

describe('runGetContext — file mode member outline (Go split files)', () => {
  it('lists methods whose receiver type is declared in ANOTHER file', async () => {
    // Go methods routinely live apart from their type (handlers.go beside
    // server.go); hiding all members would render "Exports (none)".
    const idx = new CodeIndex(tmpRoot);
    const source = [
      'package main',
      '',
      'func (s *Server) HandleGet() {}',
      '',
      'func (s *Server) handlePost() {}',
      '',
    ].join('\n');
    writeTree(tmpRoot, { 'pkg/handlers.go': source });

    const handleGet = mkSym({
      name: 'HandleGet',
      kind: 'method',
      parent: 'Server',
      file: 'pkg/handlers.go',
      language: 'go',
      exported: true,
      signature: 'func (s *Server) HandleGet()',
      startLine: 3,
      endLine: 3,
    });
    const handlePost = mkSym({
      name: 'handlePost',
      kind: 'method',
      parent: 'Server',
      file: 'pkg/handlers.go',
      language: 'go',
      exported: false,
      signature: 'func (s *Server) handlePost()',
      startLine: 5,
      endLine: 5,
    });
    idx.addFile(makeFileInfo('go', 'pkg/handlers.go'), [handleGet, handlePost], [], []);

    const result = await runGetContext({ file: 'pkg/handlers.go' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- HandleGet (method, line 3)');
    expect(text).toContain('- handlePost (method, line 5)');
    expect(text).not.toContain('### Exports\n(none)');
  });

  it('still hides members whose enclosing type is declared in the SAME file', async () => {
    const idx = new CodeIndex(tmpRoot);
    const source = [
      'package main',
      '',
      'type Server struct{}',
      '',
      'func (s *Server) HandleGet() {}',
      '',
    ].join('\n');
    writeTree(tmpRoot, { 'pkg/server.go': source });

    const server = mkSym({
      name: 'Server',
      kind: 'class',
      file: 'pkg/server.go',
      language: 'go',
      exported: true,
      signature: 'type Server struct',
      startLine: 3,
      endLine: 3,
    });
    const handleGet = mkSym({
      name: 'HandleGet',
      kind: 'method',
      parent: 'Server',
      file: 'pkg/server.go',
      language: 'go',
      exported: true,
      signature: 'func (s *Server) HandleGet()',
      startLine: 5,
      endLine: 5,
    });
    idx.addFile(makeFileInfo('go', 'pkg/server.go'), [server, handleGet], [], []);

    const result = await runGetContext({ file: 'pkg/server.go' }, makeDeps(idx));
    const text = result.content[0].text;

    expect(text).toContain('- Server (class, line 3)');
    expect(text).not.toContain('- HandleGet (method');
  });
});

describe('runGetContext — coupling section', () => {
  it('renders fan-in, fan-out, and blast radius for a symbol', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/svc.ts':
        'function runner() {}\nfunction handler() {}\nfunction a() {}\nfunction b() {}\n',
    });
    const handler = mkSym({ name: 'handler', file: 'src/svc.ts', startLine: 2, endLine: 2 });
    const runner = mkSym({ name: 'runner', file: 'src/svc.ts', startLine: 1, endLine: 1 });
    const a = mkSym({ name: 'a', file: 'src/svc.ts', startLine: 3, endLine: 3 });
    const b = mkSym({ name: 'b', file: 'src/svc.ts', startLine: 4, endLine: 4 });
    idx.addFile(
      makeFileInfo('typescript', 'src/svc.ts'),
      [handler, runner, a, b],
      [mkRef(runner, handler), mkRef(handler, a), mkRef(handler, b)],
      [],
    );

    const result = await runGetContext(
      { file: 'src/svc.ts', symbol: 'handler' },
      makeDeps(idx),
    );
    const text = result.content[0].text;

    expect(text).toContain('### Coupling');
    expect(text).toContain('- Fan-in: ~1 (callers) [name match, unverified]');
    expect(text).toContain('- Fan-out: 2 (callees) [structural]');
    expect(text).toContain('- Blast radius: 1 caller across 1 depth (1 file) [name match, unverified]');
  });

  it('include: ["coupling"] isolates the coupling section', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/svc.ts': 'function handler() {}\n' });
    const handler = mkSym({ name: 'handler', file: 'src/svc.ts', startLine: 1, endLine: 1 });
    idx.addFile(makeFileInfo('typescript', 'src/svc.ts'), [handler], [], []);

    const result = await runGetContext(
      { file: 'src/svc.ts', symbol: 'handler', include: ['coupling'] },
      makeDeps(idx),
    );
    const text = result.content[0].text;
    expect(text).toContain('### Coupling');
    expect(text).not.toContain('### Callers');
    expect(text).not.toContain('### Imports');
  });

  it('renders the 0-caller honest blast-radius line', async () => {
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, { 'src/svc.ts': 'function lonely() {}\n' });
    const lonely = mkSym({ name: 'lonely', file: 'src/svc.ts', startLine: 1, endLine: 1 });
    idx.addFile(makeFileInfo('typescript', 'src/svc.ts'), [lonely], [], []);

    const result = await runGetContext(
      { file: 'src/svc.ts', symbol: 'lonely' },
      makeDeps(idx),
    );
    expect(result.content[0].text).toContain(
      '- Blast radius: 0 callers (no upstream call sites in the index)',
    );
  });
});

describe('runGetContext — notes section (PULL)', () => {
  const AUTH_SRC =
    'export function authenticate(req: string): string {\n' +
    '  return req;\n' +
    '}\n' +
    'export function authorize(u: string): boolean {\n' +
    '  return u.length > 0;\n' +
    '}\n';

  function addAuthFile(idx: CodeIndex): { auth: Symbol; authz: Symbol } {
    writeTree(tmpRoot, { 'src/auth.ts': AUTH_SRC });
    const auth = mkSym({
      name: 'authenticate',
      file: 'src/auth.ts',
      exported: true,
      signature: 'function authenticate(req: string): string',
      startLine: 1,
      endLine: 3,
    });
    const authz = mkSym({
      name: 'authorize',
      file: 'src/auth.ts',
      exported: true,
      signature: 'function authorize(u: string): boolean',
      startLine: 4,
      endLine: 6,
    });
    idx.addFile(makeFileInfo('typescript', 'src/auth.ts'), [auth, authz], [], []);
    return { auth, authz };
  }

  // Notes are written through the REAL remember path so anchors carry the
  // disk-hash baseline + qualified symbol name exactly as production does.
  async function rememberNote(
    notes: NoteStore,
    idx: CodeIndex,
    note: string,
    anchors: string[],
  ): Promise<void> {
    const r = await runRemember(
      { note, anchors },
      {
        notes,
        index: idx,
        indexer: { ready: true },
        config: makeConfig(tmpRoot),
        git: makeGitStub(),
      },
    );
    expect(r.content[0].text).toContain('✓ Remembered');
  }

  it('symbol mode surfaces an anchored note with a fresh verdict', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    await rememberNote(
      deps.notes,
      idx,
      'authenticate swallows trailing whitespace — trim first',
      ['src/auth.ts:authenticate'],
    );

    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, deps)
    ).content[0].text;

    expect(text).toContain('### Notes (agent-curated)');
    expect(text).toContain('authenticate swallows trailing whitespace');
    expect(text).toContain('✓ fresh');
    expect(text).toContain('✓ src/auth.ts:authenticate — unchanged');
    // The structural sections still render around it.
    expect(text).toContain('### Body');
  });

  it('flags the note stale after the file changes on disk', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    await rememberNote(deps.notes, idx, 'watch this invariant', [
      'src/auth.ts:authenticate',
    ]);

    // Edit the file on disk AFTER the note was taken (index left lagging —
    // the disk re-hash alone must flag it).
    writeTree(tmpRoot, { 'src/auth.ts': AUTH_SRC + '\n// drift\n' });

    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, deps)
    ).content[0].text;

    expect(text).toContain('⚠ stale');
    expect(text).toContain('file changed since this note');
  });

  it('symbol mode includes file-level notes but excludes other symbols’ notes', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    await rememberNote(deps.notes, idx, 'note about the whole file', ['src/auth.ts']);
    await rememberNote(deps.notes, idx, 'note about authorize only', [
      'src/auth.ts:authorize',
    ]);

    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, deps)
    ).content[0].text;

    expect(text).toContain('note about the whole file'); // file-level anchor rides along
    expect(text).not.toContain('note about authorize only'); // other symbol = noise
  });

  it('file mode surfaces every note anchored in the file', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    await rememberNote(deps.notes, idx, 'note about authorize only', [
      'src/auth.ts:authorize',
    ]);
    await rememberNote(deps.notes, idx, 'note about the whole file', ['src/auth.ts']);

    const text = (
      await runGetContext({ file: 'src/auth.ts' }, deps)
    ).content[0].text;

    expect(text).toContain('### Notes (agent-curated)');
    expect(text).toContain('note about authorize only');
    expect(text).toContain('note about the whole file');
  });

  it('caps rendered notes and points the overflow at recall', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    for (let i = 1; i <= 5; i++) {
      await rememberNote(deps.notes, idx, `note number ${i}`, ['src/auth.ts']);
    }

    const text = (
      await runGetContext({ file: 'src/auth.ts' }, deps)
    ).content[0].text;

    const shown = (text.match(/### Note [0-9a-f]{16}/g) ?? []).length;
    expect(shown).toBe(3); // MAX_CONTEXT_NOTES — structural sections keep priority
    expect(text).toContain('(2 more not shown — recall({ file: "src/auth.ts" }) to browse notes here.)');
  });

  it('overflow in SYMBOL mode points at recall({file}), which actually returns the hidden file-level notes', async () => {
    // The selection mixes symbol + file-level notes; recall({file,symbol}) is
    // bySymbol (file-level excluded) and would return NONE of these — so the
    // pointer must be the file-only recall (byFile = the true superset).
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    for (let i = 1; i <= 5; i++) {
      await rememberNote(deps.notes, idx, `file-level note ${i}`, ['src/auth.ts']);
    }
    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, deps)
    ).content[0].text;
    // File-only recall suggestion — NOT the symbol-scoped one that drops file anchors.
    expect(text).toContain('recall({ file: "src/auth.ts" }) to browse notes here.');
    expect(text).not.toContain('symbol:');

    // Follow the suggestion: recall({file}) must actually return the notes.
    const recalled = (
      await runRecall(
        { file: 'src/auth.ts' },
        { notes: deps.notes, index: idx, indexer: { ready: true }, config: makeConfig(tmpRoot), git: makeGitStub() },
      )
    ).content[0].text;
    expect(recalled).toContain('file-level note');
  });

  it('excludes a member-qualified anchor from a same-named TOP-LEVEL target', async () => {
    // src/x.ts has top-level parse() AND Parser.parse. A note anchored to
    // 'Parser.parse' must NOT bleed into the top-level function's context —
    // an agent would read another symbol's invariant as this one's.
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/x.ts':
        'export function parse(s: string) { return s; }\n' +
        'export class Parser {\n  parse(s: string) { return s; }\n}\n',
    });
    const topLevel = mkSym({
      name: 'parse', file: 'src/x.ts', exported: true,
      signature: 'function parse(s: string)', startLine: 1, endLine: 1,
    });
    const member = mkSym({
      name: 'parse', file: 'src/x.ts', kind: 'method', parent: 'Parser',
      signature: 'parse(s: string)', startLine: 3, endLine: 3,
    });
    const cls = mkSym({
      name: 'Parser', file: 'src/x.ts', kind: 'class', exported: true,
      signature: 'class Parser', startLine: 2, endLine: 4,
    });
    idx.addFile(makeFileInfo('typescript', 'src/x.ts'), [topLevel, cls, member], [], []);
    const deps = makeDeps(idx);
    await rememberNote(deps.notes, idx, 'note about the METHOD Parser.parse', [
      'src/x.ts:Parser.parse',
    ]);

    const text = (
      await runGetContext({ file: 'src/x.ts', symbol: 'parse', line: 1 }, deps)
    ).content[0].text;
    expect(text).not.toContain('note about the METHOD Parser.parse');
  });

  it('excludes a RESOLVED top-level anchor (symbolId set) from a same-named member', async () => {
    // The reverse bleed: a note line-disambiguated to top-level `foo` resolves
    // with a symbolId, so it is about THAT symbol only — it must NOT surface on
    // a same-named method `foo` via the loose name arm (which is reserved for
    // name-only/ambiguous anchors that carry no symbolId).
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/x.ts':
        'export function foo() {}\n' +
        'export class C {\n  foo() {}\n}\n',
    });
    const topLevel = mkSym({
      name: 'foo', file: 'src/x.ts', exported: true,
      signature: 'function foo()', startLine: 1, endLine: 1,
    });
    const member = mkSym({
      name: 'foo', file: 'src/x.ts', kind: 'method', parent: 'C',
      signature: 'foo()', startLine: 3, endLine: 3,
    });
    idx.addFile(makeFileInfo('typescript', 'src/x.ts'), [topLevel, member], [], []);
    const deps = makeDeps(idx);
    // Line-disambiguate to the top-level symbol → remember stores a symbolId.
    await rememberNote(deps.notes, idx, 'invariant of the TOP-LEVEL foo', [
      'src/x.ts:foo:1',
    ]);
    const stored = deps.notes.all()[0].anchors[0];
    expect(stored.symbolId).toBeDefined(); // resolved, not name-only

    const text = (
      await runGetContext({ file: 'src/x.ts', symbol: 'foo', line: 3 }, deps)
    ).content[0].text;
    expect(text).not.toContain('invariant of the TOP-LEVEL foo');
  });

  it('surfaces the degraded notice even when the body eats the whole token budget', async () => {
    // The degraded signal must ride EVERY response (like recall) — a body large
    // enough to truncate before the notes section must not suppress it.
    const idx = new CodeIndex(tmpRoot);
    const big = 'export function huge() {\n' + '  const x = 1;\n'.repeat(200) + '}\n';
    writeTree(tmpRoot, { 'src/big.ts': big });
    idx.addFile(
      makeFileInfo('typescript', 'src/big.ts'),
      [mkSym({ name: 'huge', file: 'src/big.ts', exported: true, signature: 'function huge()', startLine: 1, endLine: 202 })],
      [],
      [],
    );
    const deps = makeDeps(idx);
    vi.spyOn(deps.notes, 'degradedReason', 'get').mockReturnValue(
      'the previous note store was malformed JSON and moved aside; starting empty',
    );
    const text = (
      await runGetContext({ file: 'src/big.ts', symbol: 'huge', max_tokens: 50 }, deps)
    ).content[0].text;
    // Budget forced truncation…
    expect(text).toMatch(/omitted to stay within max_tokens/);
    // …yet the degraded notice still rides the response (appended past budget).
    expect(text).toContain('(note store degraded:');
  });

  it('surfaces a name-only (ambiguous) anchor on the member target it may describe', async () => {
    // remember stores name-only anchors ('anchored by name') when the name is
    // ambiguous — such a note is about ANY symbol with that name, so it must
    // surface when reading the member, not fall through both selection paths.
    const idx = new CodeIndex(tmpRoot);
    writeTree(tmpRoot, {
      'src/x.ts':
        'export function foo() {}\n' +
        'export class C {\n  foo() {}\n}\n',
    });
    const topLevel = mkSym({
      name: 'foo', file: 'src/x.ts', exported: true,
      signature: 'function foo()', startLine: 1, endLine: 1,
    });
    const member = mkSym({
      name: 'foo', file: 'src/x.ts', kind: 'method', parent: 'C',
      signature: 'foo()', startLine: 3, endLine: 3,
    });
    idx.addFile(makeFileInfo('typescript', 'src/x.ts'), [topLevel, member], [], []);
    const deps = makeDeps(idx);
    // Ambiguous name → remember stores the SIMPLE name, no symbolId.
    const r = await runRemember(
      { note: 'footgun shared by every foo', anchors: ['src/x.ts:foo'] },
      { notes: deps.notes, index: idx, indexer: { ready: true }, config: makeConfig(tmpRoot), git: makeGitStub() },
    );
    expect(r.content[0].text).toContain('anchored by name');

    const text = (
      await runGetContext({ file: 'src/x.ts', symbol: 'foo', line: 3 }, deps)
    ).content[0].text;
    expect(text).toContain('footgun shared by every foo');
  });

  it('keeps the degraded notice on a NON-empty notes section', async () => {
    // Same adjudication as recall: a newly-added note rendering fine must not
    // hide that the PRIOR notes were moved aside.
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    await rememberNote(deps.notes, idx, 'fresh note after quarantine', [
      'src/auth.ts:authenticate',
    ]);
    vi.spyOn(deps.notes, 'degradedReason', 'get').mockReturnValue(
      'the previous note store was malformed JSON and moved aside; starting empty',
    );
    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, deps)
    ).content[0].text;
    expect(text).toContain('fresh note after quarantine');
    expect(text).toContain('(note store degraded:');
  });

  it('omits the section entirely when no notes are anchored', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, makeDeps(idx))
    ).content[0].text;
    expect(text).not.toContain('### Notes');
  });

  it('honors the include filter for notes', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    await rememberNote(deps.notes, idx, 'filterable note', ['src/auth.ts:authenticate']);

    const only = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate', include: ['notes'] },
        deps,
      )
    ).content[0].text;
    expect(only).toContain('filterable note');
    expect(only).not.toContain('### Body');

    const without = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate', include: ['body'] },
        deps,
      )
    ).content[0].text;
    expect(without).toContain('### Body');
    expect(without).not.toContain('filterable note');
  });

  it('surfaces a degraded note store instead of silently omitting', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const deps = makeDeps(idx);
    vi.spyOn(deps.notes, 'degradedReason', 'get').mockReturnValue(
      'the previous note store was malformed JSON and moved aside; starting empty',
    );
    const text = (
      await runGetContext({ file: 'src/auth.ts', symbol: 'authenticate' }, deps)
    ).content[0].text;
    expect(text).toContain('(note store degraded:');
  });

  it('never creates or writes the note store (read-only surface)', async () => {
    const idx = new CodeIndex(tmpRoot);
    addAuthFile(idx);
    const notesPath = join(tmpRoot, '.codedeep', 'cache', 'notes.json');
    await runGetContext(
      { file: 'src/auth.ts', symbol: 'authenticate' },
      makeDeps(idx),
    );
    expect(existsSync(notesPath)).toBe(false); // load() of an absent store never writes
  });
});
