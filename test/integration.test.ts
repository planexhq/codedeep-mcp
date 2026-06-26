import { promises as fsp, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CodeIndex } from '../src/indexer/code-index.js';
import * as parserModule from '../src/indexer/parser.js';
import { Indexer } from '../src/indexer/pipeline.js';
import { runFindReferences } from '../src/tools/find-references.js';
import { runFindSymbol } from '../src/tools/find-symbol.js';
import { runGetContext } from '../src/tools/get-context.js';
import { runImpact } from '../src/tools/impact.js';
import { runOverview } from '../src/tools/overview.js';
import { runSearchStructure } from '../src/tools/search-structure.js';
import type { CodedeepConfig } from '../src/types.js';
import {
  makeConfig,
  makeGitStub,
  makeProjectDir,
  silenceStderr,
  writeTree,
} from './helpers.js';

const FIXTURES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

type FixtureName = 'small-ts' | 'small-py' | 'small-java' | 'small-go' | 'small-rust' | 'small-swift' | 'small-kotlin' | 'small-dart' | 'small-cs' | 'small-php' | 'small-cpp' | 'small-c' | 'small-objc';

const FIXTURE_FILES: Record<FixtureName, readonly string[]> = {
  'small-ts': [
    'src/index.ts',
    'src/auth.ts',
    'src/utils.ts',
    'src/types.ts',
    'src/service.ts',
  ],
  'small-py': ['app/auth.py', 'app/models.py', 'app/service.py'],
  'small-java': ['Greeter.java', 'Shape.java', 'App.java'],
  'small-go': ['greeter.go', 'shape.go', 'main.go'],
  'small-rust': ['lib.rs', 'shape.rs', 'main.rs'],
  'small-swift': ['greeter.swift', 'shape.swift', 'main.swift'],
  'small-kotlin': ['greeter.kt', 'shape.kt', 'main.kt'],
  'small-dart': ['greeter.dart', 'shape.dart', 'main.dart'],
  'small-cs': ['Greeter.cs', 'Shape.cs', 'Program.cs'],
  'small-php': ['Greeter.php', 'Shape.php', 'index.php'],
  'small-cpp': [
    'include/greeter.h',
    'include/shape.h',
    'src/greeter.cpp',
    'src/shape.cpp',
    'src/main.cpp',
  ],
  'small-c': [
    'include/greeter.h',
    'include/shape.h',
    'src/greeter.c',
    'src/shape.c',
    'src/main.c',
  ],
  'small-objc': [
    'include/Greeter.h',
    'include/Shape.h',
    'src/Greeter.m',
    'src/Shape.m',
    'src/main.m',
  ],
};

async function copyFixtureToTmp(
  name: FixtureName,
): Promise<string> {
  const root = makeProjectDir(`codedeep-int-${name}-`);
  const tree: Record<string, string> = {};
  for (const rel of FIXTURE_FILES[name]) {
    tree[rel] = await fsp.readFile(join(FIXTURES_ROOT, name, rel), 'utf8');
  }
  writeTree(root, tree);
  return root;
}

// Slice a `### Header` section out of tool output so an assertion can't be
// satisfied by the same string appearing under a different header.
function sectionAfter(text: string, header: string): string {
  return text.split(header)[1]?.split('\n###')[0] ?? '';
}

beforeAll(async () => {
  await parserModule.initParser();
});

describe('integration: end-to-end pipeline + tools', () => {
  let root = '';

  async function setup(fixture: FixtureName): Promise<{
    index: CodeIndex;
    indexer: Indexer;
    config: CodedeepConfig;
    git: ReturnType<typeof makeGitStub>;
  }> {
    // loadConfig (config.ts:81,115) reads CODEDEEP_EXCLUDE and CODEDEEP_CACHE_DIR.
    // Unset them so a developer's shell can't perturb the fixture's index.
    vi.stubEnv('CODEDEEP_EXCLUDE', undefined);
    vi.stubEnv('CODEDEEP_CACHE_DIR', undefined);
    root = await copyFixtureToTmp(fixture);
    const config = makeConfig(root);
    const index = new CodeIndex(root);
    const indexer = new Indexer(config, index);
    silenceStderr();
    await indexer.indexAll();
    // Disabled stub: fixtures are not git repos. Real-git end-to-end
    // coverage lives in integration-git.test.ts.
    return { index, indexer, config, git: makeGitStub() };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (root) {
      rmSync(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('indexes the TS fixture end-to-end', async () => {
    const { index } = await setup('small-ts');

    expect(index.getStats().totalFiles).toBe(5);

    for (const name of [
      'authenticate',
      'authorize',
      'extractToken',
      'hash',
      'formatDate',
      'SALT_ROUNDS',
      'User',
      'AuthToken',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // Within-file call ref: authenticate() calls extractToken().
    const auth = index.findSymbolByName('authenticate')[0];
    const extract = index.findSymbolByName('extractToken')[0];
    expect(auth).toBeDefined();
    expect(extract).toBeDefined();
    const callees = index.getCallees(auth.id).map((s) => s.id);
    expect(callees).toContain(extract.id);
  });

  it('impact traces a multi-hop cross-file blast radius', async () => {
    const deps = await setup('small-ts');
    // formatDate <- stamp (utils.formatDate, cross-file via namespace import)
    //            <- login (this.stamp(), second hop) <- module-level svc.login()
    const text = (
      await runImpact({ file: 'src/utils.ts', symbol: 'formatDate' }, deps)
    ).content[0].text;

    expect(text).toContain('## Impact of `formatDate`');
    expect(text).toContain('### Depth 1 — direct callers');
    expect(text).toContain('stamp()');
    // Second hop upstream: stamp is called by login.
    expect(text).toContain('login()');
  });

  it('overview reports language stats, structure, and entry points', async () => {
    const deps = await setup('small-ts');
    const text = (await runOverview({}, deps)).content[0].text;

    expect(text).toContain('## Project:');
    expect(text).toContain('### Languages');
    expect(text).toContain('- TypeScript: 5 files (100%)');
    expect(text).toContain('### Structure');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('src/index.ts');
    expect(text).toContain('### Symbols');
  });

  it('find_symbol returns the exact match for authenticate', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runFindSymbol({ name: 'authenticate' }, deps)
    ).content[0].text;

    expect(text).toContain('src/auth.ts:');
    expect(text).toContain('| function');
    expect(text).toContain('| exported');
    expect(text).toContain('async function authenticate');
    expect(text).toContain('References: ~');
  });

  it('find_symbol returns prefix matches for "auth"', async () => {
    const deps = await setup('small-ts');
    const text = (await runFindSymbol({ name: 'auth' }, deps)).content[0].text;

    // Prefix is case-insensitive (code-index.ts:142), so AuthToken matches too.
    // Guard against fuzzy fallthrough: if prefix tier breaks, runFindSymbol
    // calls suggest() and renders 'No symbol ... Did you mean:' lines that
    // would still mention all three names (find-symbol.ts:56-58, 117-122).
    expect(text).not.toContain("No symbol 'auth' found.");
    expect(text).toContain('authenticate');
    expect(text).toContain('authorize');
    expect(text).toContain('AuthToken');
  });

  it('find_symbol returns suggestions on miss', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runFindSymbol({ name: 'authentcate' }, deps)
    ).content[0].text;

    expect(text).toContain("No symbol 'authentcate' found.");
    expect(text).toContain('Did you mean:');
    expect(text).toContain('authenticate');
  });

  it('get_context symbol mode renders body, callees, and imports', async () => {
    // An earlier note called extractToken a "caller" of authenticate, but in the
    // codebase's reference graph authenticate is the caller and extractToken
    // is the callee. Assertion follows the handler's actual output sections.
    const deps = await setup('small-ts');
    const text = (
      await runGetContext(
        { file: 'src/auth.ts', symbol: 'authenticate' },
        deps,
      )
    ).content[0].text;

    expect(text).toContain('### Body');
    expect(text).toContain('async function authenticate');
    // Anchor extractToken under ### Callees so a regression that drops
    // or misnames the section can't be masked by the body's source slice.
    expect(sectionAfter(text, '### Callees')).toContain('extractToken');
    expect(text).toContain('### Imports');
    expect(text).toContain('./utils');
    expect(text).toContain('./types');
  });

  it('get_context file mode outlines exports, internals, and imports', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runGetContext({ file: 'src/auth.ts' }, deps)
    ).content[0].text;

    expect(text).toContain('## File: src/auth.ts');
    const exports = sectionAfter(text, '### Exports');
    expect(exports).toContain('authenticate');
    expect(exports).toContain('authorize');
    expect(sectionAfter(text, '### Internal')).toContain('extractToken');
    expect(text).toContain('### Imports');
  });

  it('renders cyclomatic + cognitive complexity on find_symbol and get_context', async () => {
    const proj = makeProjectDir('codedeep-int-cyclo-');
    try {
      writeTree(proj, {
        // 3 decision points (two ifs + a ternary) → cyclomatic 4; cognitive 3
        // (two flat ifs + a flat ternary, all at nesting 0).
        'src/classify.ts':
          'export function classify(n: number): string {\n' +
          "  if (n < 0) return 'neg';\n" +
          "  if (n === 0) return 'zero';\n" +
          "  return n > 100 ? 'big' : 'small';\n" +
          '}\n' +
          'export function trivial(n: number): number {\n' +
          '  return n;\n' +
          '}\n',
      });
      const config = makeConfig(proj);
      const index = new CodeIndex(proj);
      const indexer = new Indexer(config, index);
      silenceStderr();
      await indexer.indexAll();
      const deps = { index, indexer, config, git: makeGitStub() };

      const found = (await runFindSymbol({ name: 'classify' }, deps)).content[0].text;
      // TS now carries BOTH metrics → "cyc N / cog M".
      expect(found).toContain('Complexity: cyc 4 / cog 3 [structural]');
      // A trivial function (cyc 1 / cog 0) omits the line entirely.
      const trivial = (await runFindSymbol({ name: 'trivial' }, deps)).content[0].text;
      expect(trivial).not.toContain('Complexity:');

      const ctx = (
        await runGetContext({ file: 'src/classify.ts', symbol: 'classify' }, deps)
      ).content[0].text;
      expect(sectionAfter(ctx, '### Coupling')).toContain('- Complexity: cyc 4 / cog 3 [structural]');
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });

  it('find_references surfaces cross-file callers from AST name matching', async () => {
    // The fixture's auth.ts calls hash() (defined in utils.ts) — a real
    // cross-file call edge that exercises Reference.targetId=null storage
    // and the name-keyed lookup in find_references.
    const deps = await setup('small-ts');
    const text = (
      await runFindReferences(
        { file: 'src/utils.ts', symbol: 'hash' },
        deps,
      )
    ).content[0].text;

    expect(text).toContain('## References for `hash` (src/utils.ts:1)');
    expect(text).toContain('### Callers (approximate — from AST name matching)');
    expect(sectionAfter(text, '### Callers')).toContain('src/auth.ts:');
    expect(text).toContain('[name match, unverified]');
  });

  it('find_references returns Phase-2 placeholder for kind=implementations', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runFindReferences(
        {
          file: 'src/auth.ts',
          symbol: 'authenticate',
          kind: 'implementations',
        },
        deps,
      )
    ).content[0].text;

    expect(text).toContain('### Implementations');
    expect(text).toContain('(none — ships with LSP in Phase 2)');
  });

  it('find_references errors when symbol is unknown in file', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runFindReferences(
        { file: 'src/auth.ts', symbol: 'doesNotExist' },
        deps,
      )
    ).content[0].text;

    expect(text).toContain("Error: no symbol 'doesNotExist' in 'src/auth.ts'.");
  });

  it('resolves this.x() member calls into method adjacency end-to-end', async () => {
    const { index } = await setup('small-ts');

    // service.ts: login() calls this.stamp() — extract-time resolution
    // must land in the id-keyed caller/callee adjacency.
    const stamp = index.findSymbolByName('stamp')[0];
    const login = index.findSymbolByName('login')[0];
    expect(stamp?.kind).toBe('method');
    expect(index.getCallers(stamp.id).map((s) => s.id)).toContain(login.id);
    expect(index.getCallees(login.id).map((s) => s.id)).toContain(stamp.id);
  });

  it('find_references surfaces namespace-import member callers', async () => {
    // service.ts calls utils.formatDate() through `import * as utils` —
    // the receiver resolves the module precisely, so the ref must be
    // attributed to utils.ts and labeled as a member match.
    const deps = await setup('small-ts');
    const text = (
      await runFindReferences(
        { file: 'src/utils.ts', symbol: 'formatDate' },
        deps,
      )
    ).content[0].text;

    expect(sectionAfter(text, '### Callers')).toContain('src/service.ts:13');
    expect(text).toContain('[member call, unverified]');
  });

  it('find_references shows member-call callers for methods', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runFindReferences(
        { file: 'src/service.ts', symbol: 'login' },
        deps,
      )
    ).content[0].text;

    // svc.login('admin') at module level — unknown receiver, weakly
    // included and tagged as the noisier member tier.
    const callers = sectionAfter(text, '### Callers');
    expect(callers).toContain('src/service.ts:18');
    expect(callers).toContain('[member call, unverified]');
  });

  it('resolves Python `from . import auth` member callers cross-module', async () => {
    const deps = await setup('small-py');
    const text = (
      await runFindReferences(
        { file: 'app/auth.py', symbol: 'authenticate' },
        deps,
      )
    ).content[0].text;

    // service.py calls auth.authenticate() inside Session.helper().
    expect(sectionAfter(text, '### Callers')).toContain('app/service.py:8');

    // And self.helper() resolves to method adjacency.
    const helper = deps.index
      .getSymbolsInFile('app/service.py')
      .find((s) => s.name === 'helper')!;
    const run = deps.index
      .getSymbolsInFile('app/service.py')
      .find((s) => s.name === 'run')!;
    expect(deps.index.getCallers(helper.id).map((s) => s.id)).toContain(run.id);
  });

  it('search_structure query mode finds symbols by docstring keyword', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runSearchStructure({ query: 'JWT' }, deps)
    ).content[0].text;

    // 'JWT' appears only in authenticate's doc comment, never in a name —
    // exercises the widened name+signature+doc search index end-to-end.
    expect(text).toContain('src/auth.ts:');
    expect(text).toContain('async function authenticate');
    expect(text).toContain('Validates the JWT and attaches user to request');
  });

  it('search_structure pattern mode maps matches to enclosing symbols', async () => {
    const deps = await setup('small-ts');
    const text = (
      await runSearchStructure({ pattern: 'hash($A)' }, deps)
    ).content[0].text;

    // auth.ts:7 calls hash(token) inside authenticate (lines 5-10).
    expect(text).toContain('src/auth.ts:5-10 | function | exported');
    expect(text).toContain('match :7  hash(token)');
  });

  it('search_structure pattern mode declines non-TS/JS languages in-band', async () => {
    const deps = await setup('small-py');
    const text = (
      await runSearchStructure(
        { pattern: 'authenticate($A)', language: 'python' },
        deps,
      )
    ).content[0].text;

    expect(text).toContain(
      'Structural patterns are not supported for this language yet',
    );

    // Query mode still serves Python.
    const query = (
      await runSearchStructure({ query: 'authenticate', language: 'python' }, deps)
    ).content[0].text;
    expect(query).toContain('app/auth.py');
  });

  it('indexes the Python fixture and respects __all__ + underscore privacy', async () => {
    const { index } = await setup('small-py');

    const auth = index.findSymbolByName('authenticate')[0];
    const authorize = index.findSymbolByName('authorize')[0];
    const stored = index.findSymbolByName('_get_stored_hash')[0];

    expect(auth?.exported).toBe(true);
    expect(authorize?.exported).toBe(true);
    expect(stored?.exported).toBe(false);

    // Symbol carries no `parent` field (types.ts:24); class membership is
    // encoded in fqn as `<file>:<ClassName>.<member>`.
    const hasPerm = index.findSymbolByName('has_permission')[0];
    expect(hasPerm?.kind).toBe('method');
    expect(hasPerm?.fqn).toContain('User.has_permission');
  });

  it('indexes the Java fixture end-to-end', async () => {
    const { index } = await setup('small-java');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'greet',
      'format',
      'Builder',
      'Shape',
      'describe',
      'Color',
      'hex',
      'Point',
      'origin',
      'App',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // Implicit-this call edge resolved at extract time: greet() → format().
    const greet = index.findSymbolByName('greet')[0]!;
    const format = index.findSymbolByName('format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // Visibility-based exported-ness.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);

    // Constructor convention + nested-class simple-name FQN.
    const ctors = index.findSymbolByName('constructor');
    expect(
      ctors.some((s) => s.fqn === 'Greeter.java:Greeter.constructor'),
    ).toBe(true);
    expect(index.findSymbolByName('Builder')[0]!.fqn).toBe(
      'Greeter.java:Builder',
    );
  });

  it('overview shows Java language stats and the App.java entry point', async () => {
    const deps = await setup('small-java');
    const text = (await runOverview({}, deps)).content[0].text;

    expect(text).toContain('- Java: 3 files (100%)');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('App.java');
  });

  it('java tools: find_symbol, get_context callees, find_references member callers', async () => {
    const deps = await setup('small-java');

    const found = (await runFindSymbol({ name: 'greet' }, deps)).content[0]
      .text;
    expect(found).toContain('Greeter.java:');
    expect(found).toContain('| method');
    expect(found).toContain('public String greet(String name)');

    const ctx = (
      await runGetContext({ file: 'Greeter.java', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('format');

    // Cross-file member ref: App.main calls g.greet(...) — unknown receiver,
    // weakly included because the method target is exported.
    const refs = (
      await runFindReferences({ file: 'Greeter.java', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(refs, '### Callers')).toContain('App.java:');
  });

  it('indexes the Go fixture end-to-end', async () => {
    const { index } = await setup('small-go');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'NewGreeter',
      'Greet',
      'format',
      'Shape',
      'Area',
      'Pi',
      'Circle',
      'Radius',
      'defaultShape',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // Receiver self-call edge resolved at extract time: Greet() → format().
    const greet = index.findSymbolByName('Greet')[0]!;
    const format = index.findSymbolByName('format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // Capitalization-based exported-ness.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);

    // Receiver type is the "class" in the member FQN.
    expect(greet.fqn).toBe('greeter.go:Greeter.Greet');

    // Composite-literal constructor edge: defaultShape() → Circle{...}.
    const defaultShape = index.findSymbolByName('defaultShape')[0]!;
    const circle = index
      .findSymbolByName('Circle')
      .find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultShape.id).map((s) => s.id)).toContain(
      circle.id,
    );
  });

  it('indexes the C++ fixture end-to-end (header/impl decl-def split)', async () => {
    const { index } = await setup('small-cpp');

    expect(index.getStats().totalFiles).toBe(5);

    for (const name of [
      'Greeter',
      'greet',
      'format',
      'Shape',
      'Circle',
      'area',
      'describe',
      'kPi',
      'defaultShape',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // Within-file resolved edge (no decl/def ambiguity): main() → defaultShape().
    const main = index.findSymbolByName('main')[0]!;
    const defaultShape = index.findSymbolByName('defaultShape')[0]!;
    expect(index.getCallees(main.id).map((s) => s.id)).toContain(defaultShape.id);

    // Same-file out-of-line self-call edge: Greeter::greet() → Greeter::format(),
    // both DEFINED in greeter.cpp (the in-class decls live in greeter.h).
    const greetDef = index.findSymbolByName('greet').find((s) => s.file === 'src/greeter.cpp')!;
    const formatDef = index.findSymbolByName('format').find((s) => s.file === 'src/greeter.cpp')!;
    expect(greetDef).toBeDefined();
    expect(formatDef).toBeDefined();
    expect(index.getCallees(greetDef.id).map((s) => s.id)).toContain(formatDef.id);

    // The decl/def split: greet exists as both an include/greeter.h declaration
    // and a src/greeter.cpp definition; the FQN folds the namespace into the
    // qualifier (FQN stays simple-name, the receiver type is the "class").
    const greetDecl = index.findSymbolByName('greet').find((s) => s.file === 'include/greeter.h')!;
    expect(greetDecl.fqn).toBe('include/greeter.h:Greeter.greet');
    expect(greetDecl.kind).toBe('method');

    // public:/private: access governs exportedness.
    expect(greetDecl.exported).toBe(true);
    const formatDecl = index.findSymbolByName('format').find((s) => s.file === 'include/greeter.h')!;
    expect(formatDecl.exported).toBe(false);
  });

  it('overview shows C++ language stats and the main.cpp entry point', async () => {
    const deps = await setup('small-cpp');
    const text = (await runOverview({}, deps)).content[0].text;
    expect(text).toContain('- C++: 5 files (100%)');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('main.cpp');
  });

  it('indexes the C fixture end-to-end (.c/.h split, file-scope static linkage)', async () => {
    const { index } = await setup('small-c');

    expect(index.getStats().totalFiles).toBe(5);

    for (const name of [
      'Greeter',
      'greeter_init',
      'greeter_greet',
      'format',
      'Circle',
      'circle_area',
      'default_shape',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // Within-file resolved edge: main() -> default_shape() (both in src/main.c).
    const main = index.findSymbolByName('main')[0]!;
    const defaultShape = index.findSymbolByName('default_shape')[0]!;
    expect(index.getCallees(main.id).map((s) => s.id)).toContain(defaultShape.id);

    // Same-file resolved bare call: greeter_greet() -> format() (both in greeter.c).
    const greetDef = index
      .findSymbolByName('greeter_greet')
      .find((s) => s.file === 'src/greeter.c')!;
    const formatDef = index.findSymbolByName('format')[0]!;
    expect(greetDef).toBeDefined();
    expect(index.getCallees(greetDef.id).map((s) => s.id)).toContain(formatDef.id);

    // File-scope `static` → internal linkage → NOT exported (C's privacy rule);
    // a non-static free function is exported.
    expect(formatDef.exported).toBe(false);
    expect(defaultShape.exported).toBe(false);
    expect(greetDef.exported).toBe(true);
  });

  it('overview classifies .c as C and .h as C++ (the header-ambiguity tradeoff)', async () => {
    const deps = await setup('small-c');
    const text = (await runOverview({}, deps)).content[0].text;
    // `.c` → C (the 3 source files); `.h` stays mapped to C++ (a C header parses
    // fine as a C++ subset) — so the C fixture's two headers report as C++.
    expect(text).toContain('- C: 3 files (60%)');
    expect(text).toContain('- C++: 2 files (40%)');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('main.c');
  });

  it('indexes the Objective-C fixture end-to-end (.h sniff, decl/def split, self-send)', async () => {
    const { index } = await setup('small-objc');

    expect(index.getStats().totalFiles).toBe(5);

    for (const name of [
      'Greeter',
      'greet',
      'format',
      'initWithName:',
      'Shape',
      'Circle',
      'area',
      'makeGreeter',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // Same-file self-send edge: Greeter -greet → -format (both DEFINED in Greeter.m;
    // -format is NOT in the header). The full-selector naming + the byte-identical
    // call-side match make `[self format]` resolve.
    const greetDef = index.findSymbolByName('greet').find((s) => s.file === 'src/Greeter.m')!;
    const formatDef = index.findSymbolByName('format')[0]!;
    expect(greetDef).toBeDefined();
    expect(index.getCallees(greetDef.id).map((s) => s.id)).toContain(formatDef.id);

    // Bare C call edge (no implicit-this): main() → the static makeGreeter() free function.
    const main = index.findSymbolByName('main')[0]!;
    const makeGreeter = index.findSymbolByName('makeGreeter')[0]!;
    expect(index.getCallees(main.id).map((s) => s.id)).toContain(makeGreeter.id);

    // The decl/def split: -greet exists as both an include/Greeter.h declaration and a
    // src/Greeter.m definition; the header decl is a class-keyed method.
    const greetDecl = index.findSymbolByName('greet').find((s) => s.file === 'include/Greeter.h')!;
    expect(greetDecl.fqn).toBe('include/Greeter.h:Greeter.greet');
    expect(greetDecl.kind).toBe('method');

    // File-scope `static` C function → internal linkage → not exported (the shared C gate).
    expect(makeGreeter.exported).toBe(false);
  });

  it('overview shows Objective-C stats (headers content-sniffed) and the main.m entry point', async () => {
    const deps = await setup('small-objc');
    const text = (await runOverview({}, deps)).content[0].text;
    // All 5 files are Objective-C: the two `.h` headers are content-sniffed from cpp→objc
    // (they carry `#import`/`@interface` markers), not left as C++.
    expect(text).toContain('- Objective-C: 5 files (100%)');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('main.m');
  });

  it('overview shows Go language stats and the main.go entry point', async () => {
    const deps = await setup('small-go');
    const text = (await runOverview({}, deps)).content[0].text;

    expect(text).toContain('- Go: 3 files (100%)');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('main.go');
  });

  it('go tools: find_symbol, get_context callees, find_references callers', async () => {
    const deps = await setup('small-go');

    const found = (await runFindSymbol({ name: 'Greet' }, deps)).content[0]
      .text;
    expect(found).toContain('greeter.go:');
    expect(found).toContain('| method');
    expect(found).toContain('func (g *Greeter) Greet(name string) string');

    const ctx = (
      await runGetContext({ file: 'greeter.go', symbol: 'Greet' }, deps)
    ).content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('format');

    // Cross-file member ref: main calls g.Greet(...) — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'greeter.go', symbol: 'Greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('main.go:');

    // Cross-file BARE ref: main calls NewGreeter() with no import — the
    // same-directory (= same package) carve-out attributes it.
    const bareRefs = (
      await runFindReferences(
        { file: 'greeter.go', symbol: 'NewGreeter' },
        deps,
      )
    ).content[0].text;
    expect(sectionAfter(bareRefs, '### Callers')).toContain('main.go:');
  });

  it('indexes the Rust fixture end-to-end', async () => {
    const { index } = await setup('small-rust');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'new',
      'greet',
      'format',
      'normalize',
      'MAX_LEN',
      'util',
      'helper',
      'Shape',
      'Circle',
      'area',
      'Kind',
      'default_circle',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // self-call edge resolved at extract time: greet() → self.format().
    const greet = index.findSymbolByName('greet')[0]!;
    const format = index.findSymbolByName('format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // bare call edge within a file: format() → normalize().
    const normalize = index.findSymbolByName('normalize')[0]!;
    expect(index.getCallees(format.id).map((s) => s.id)).toContain(normalize.id);

    // struct-expression constructor edge: default_circle() → Circle { .. }.
    const defaultCircle = index.findSymbolByName('default_circle')[0]!;
    const circle = index
      .findSymbolByName('Circle')
      .find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultCircle.id).map((s) => s.id)).toContain(
      circle.id,
    );

    // module recursion: util::helper() → util::inner_helper().
    const helper = index.findSymbolByName('helper')[0]!;
    const innerHelper = index.findSymbolByName('inner_helper')[0]!;
    expect(index.getCallees(helper.id).map((s) => s.id)).toContain(
      innerHelper.id,
    );

    // `pub fn` is exported; a private `fn` is not. The impl method's "class"
    // is the implementing type.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);
    expect(greet.fqn).toBe('lib.rs:Greeter.greet');
  });

  it('overview shows Rust language stats and the main.rs entry point', async () => {
    const deps = await setup('small-rust');
    const text = (await runOverview({}, deps)).content[0].text;

    expect(text).toContain('- Rust: 3 files (100%)');
    expect(text).toContain('### Entry Points');
    expect(text).toContain('main.rs');
  });

  it('rust tools: find_symbol, get_context callees, cross-file member callers', async () => {
    const deps = await setup('small-rust');

    const found = (await runFindSymbol({ name: 'greet' }, deps)).content[0].text;
    expect(found).toContain('lib.rs:');
    expect(found).toContain('| method');
    expect(found).toContain('pub fn greet(&self, name: &str) -> String');

    const ctx = (await runGetContext({ file: 'lib.rs', symbol: 'greet' }, deps))
      .content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('format');

    // Cross-file member ref: main calls g.greet(...) — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'lib.rs', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('main.rs:');
  });

  it('indexes the Swift fixture end-to-end', async () => {
    const { index } = await setup('small-swift');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'init',
      'greet',
      'format',
      'normalize',
      'MAX_LEN',
      'summary',
      'Shape',
      'Circle',
      'area',
      'Kind',
      'label',
      'defaultCircle',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // implicit-self bare call edge: greet() → format().
    const greet = index.findSymbolByName('greet')[0]!;
    const format = index.findSymbolByName('format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // bare call edge within a file: format() → normalize().
    const normalize = index.findSymbolByName('normalize')[0]!;
    expect(index.getCallees(format.id).map((s) => s.id)).toContain(normalize.id);

    // construction edge: defaultCircle() → Circle(radius:).
    const defaultCircle = index.findSymbolByName('defaultCircle')[0]!;
    const circle = index.findSymbolByName('Circle').find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultCircle.id).map((s) => s.id)).toContain(circle.id);

    // computed-property body self-call: summary → Greeter.describe.
    const summary = index.findSymbolByName('summary')[0]!;
    const greeterDescribe = index
      .findSymbolByName('describe')
      .find((s) => s.fqn === 'greeter.swift:Greeter.describe')!;
    expect(index.getCallees(summary.id).map((s) => s.id)).toContain(greeterDescribe.id);

    // extension self-call merged into the type: label → Circle.describe.
    const label = index.findSymbolByName('label')[0]!;
    const circleDescribe = index
      .findSymbolByName('describe')
      .find((s) => s.fqn === 'shape.swift:Circle.describe')!;
    expect(index.getCallees(label.id).map((s) => s.id)).toContain(circleDescribe.id);

    // exportedness: public exported, private not, internal (label) exported.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);
    expect(label.exported).toBe(true);
    expect(greet.fqn).toBe('greeter.swift:Greeter.greet');
  });

  it('overview shows Swift language stats', async () => {
    const deps = await setup('small-swift');
    const text = (await runOverview({}, deps)).content[0].text;
    expect(text).toContain('- Swift: 3 files (100%)');
  });

  it('swift tools: find_symbol, get_context callees, cross-file member callers', async () => {
    const deps = await setup('small-swift');

    const found = (await runFindSymbol({ name: 'greet' }, deps)).content[0].text;
    expect(found).toContain('greeter.swift:');
    expect(found).toContain('| method');

    const ctx = (await runGetContext({ file: 'greeter.swift', symbol: 'greet' }, deps))
      .content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('format');

    // Cross-file member ref: main.swift calls g.greet(...) — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'greeter.swift', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('main.swift:');
  });

  it('indexes the Kotlin fixture end-to-end', async () => {
    const { index } = await setup('small-kotlin');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'greet',
      'format',
      'normalize',
      'MAX_LEN',
      'summary',
      'Shape',
      'Circle',
      'area',
      'Kind',
      'label',
      'defaultCircle',
      'setup',
      'constructor',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // implicit-this bare call edge: greet() → format().
    const greet = index.findSymbolByName('greet')[0]!;
    const format = index.findSymbolByName('format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // bare call edge to a top-level function: format() → normalize().
    const normalize = index.findSymbolByName('normalize')[0]!;
    expect(index.getCallees(format.id).map((s) => s.id)).toContain(normalize.id);

    // construction edge: defaultCircle() → Circle(...).
    const defaultCircle = index.findSymbolByName('defaultCircle')[0]!;
    const circle = index.findSymbolByName('Circle').find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultCircle.id).map((s) => s.id)).toContain(circle.id);

    // computed-property getter self-call: summary → Greeter.describe.
    const summary = index.findSymbolByName('summary')[0]!;
    const greeterDescribe = index
      .findSymbolByName('describe')
      .find((s) => s.fqn === 'greeter.kt:Greeter.describe')!;
    expect(index.getCallees(summary.id).map((s) => s.id)).toContain(greeterDescribe.id);

    // extension self-call merged into the type: label → Circle.describe.
    const label = index.findSymbolByName('label')[0]!;
    const circleDescribe = index
      .findSymbolByName('describe')
      .find((s) => s.fqn === 'shape.kt:Circle.describe')!;
    expect(index.getCallees(label.id).map((s) => s.id)).toContain(circleDescribe.id);

    // exportedness: public exported, private not, public extension exported.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);
    expect(label.exported).toBe(true);
    expect(greet.fqn).toBe('greeter.kt:Greeter.greet');
  });

  it('overview shows Kotlin language stats', async () => {
    const deps = await setup('small-kotlin');
    const text = (await runOverview({}, deps)).content[0].text;
    expect(text).toContain('- Kotlin: 3 files (100%)');
  });

  it('kotlin tools: find_symbol, get_context callees, cross-file member callers', async () => {
    const deps = await setup('small-kotlin');

    const found = (await runFindSymbol({ name: 'greet' }, deps)).content[0].text;
    expect(found).toContain('greeter.kt:');
    expect(found).toContain('| method');

    const ctx = (await runGetContext({ file: 'greeter.kt', symbol: 'greet' }, deps))
      .content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('format');

    // Cross-file member ref: main.kt calls g.greet(...) — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'greeter.kt', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('main.kt:');
  });

  it('indexes the Dart fixture end-to-end', async () => {
    const { index } = await setup('small-dart');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'greet',
      '_format',
      'normalize',
      'maxLen',
      'summary',
      'Shape',
      'Circle',
      'area',
      'Kind',
      'label',
      'defaultCircle',
      'describe',
      'constructor',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // implicit-this bare call edge: greet() → _format().
    const greet = index.findSymbolByName('greet')[0]!;
    const format = index.findSymbolByName('_format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // bare call edge to a top-level function: _format() → normalize().
    const normalize = index.findSymbolByName('normalize')[0]!;
    expect(index.getCallees(format.id).map((s) => s.id)).toContain(normalize.id);

    // construction edge: defaultCircle() → Circle(...).
    const defaultCircle = index.findSymbolByName('defaultCircle')[0]!;
    const circle = index.findSymbolByName('Circle').find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultCircle.id).map((s) => s.id)).toContain(circle.id);

    // getter self-call: summary → Greeter.describe.
    const summary = index.findSymbolByName('summary')[0]!;
    const greeterDescribe = index
      .findSymbolByName('describe')
      .find((s) => s.fqn === 'greeter.dart:Greeter.describe')!;
    expect(index.getCallees(summary.id).map((s) => s.id)).toContain(greeterDescribe.id);

    // extension self-call merged into the type: label → Circle.describe.
    const label = index.findSymbolByName('label')[0]!;
    const circleDescribe = index
      .findSymbolByName('describe')
      .find((s) => s.fqn === 'shape.dart:Circle.describe')!;
    expect(index.getCallees(label.id).map((s) => s.id)).toContain(circleDescribe.id);

    // exportedness: leading-underscore privacy.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);
    expect(label.exported).toBe(true);
    expect(greet.fqn).toBe('greeter.dart:Greeter.greet');
  });

  it('overview shows Dart language stats', async () => {
    const deps = await setup('small-dart');
    const text = (await runOverview({}, deps)).content[0].text;
    expect(text).toContain('- Dart: 3 files (100%)');
  });

  it('dart tools: find_symbol, get_context callees, cross-file member callers', async () => {
    const deps = await setup('small-dart');

    const found = (await runFindSymbol({ name: 'greet' }, deps)).content[0].text;
    expect(found).toContain('greeter.dart:');
    expect(found).toContain('| method');

    const ctx = (await runGetContext({ file: 'greeter.dart', symbol: 'greet' }, deps))
      .content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('_format');

    // Cross-file member ref: main.dart calls g.greet(...) — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'greeter.dart', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('main.dart:');
  });

  it('indexes the C# fixture end-to-end', async () => {
    const { index } = await setup('small-cs');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'Greet',
      'Format',
      'Normalize',
      'Summary',
      'Describe',
      'constructor',
      'IShape',
      'Circle',
      'Area',
      'Shapes',
      'DefaultCircle',
      'Label',
      'Program',
      'Main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // implicit-this bare call edge: Greet() → Format().
    const greet = index.findSymbolByName('Greet')[0]!;
    const format = index.findSymbolByName('Format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // bare call edge: Format() → Normalize().
    const normalize = index.findSymbolByName('Normalize')[0]!;
    expect(index.getCallees(format.id).map((s) => s.id)).toContain(normalize.id);

    // construction edge: DefaultCircle() → new Circle(...).
    const defaultCircle = index.findSymbolByName('DefaultCircle')[0]!;
    const circle = index.findSymbolByName('Circle').find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultCircle.id).map((s) => s.id)).toContain(circle.id);

    // property getter self-call: Summary → Greeter.Describe.
    const summary = index.findSymbolByName('Summary')[0]!;
    const greeterDescribe = index
      .findSymbolByName('Describe')
      .find((s) => s.fqn === 'Greeter.cs:Greeter.Describe')!;
    expect(index.getCallees(summary.id).map((s) => s.id)).toContain(greeterDescribe.id);

    // exportedness: member default private, explicit public exports.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);
    expect(greet.fqn).toBe('Greeter.cs:Greeter.Greet');

    // extension method keyed on the receiver type (methods-apart).
    expect(index.findSymbolByName('Label')[0]!.fqn).toBe('Shape.cs:Circle.Label');
  });

  it('overview shows C# language stats', async () => {
    const deps = await setup('small-cs');
    const text = (await runOverview({}, deps)).content[0].text;
    expect(text).toContain('- C#: 3 files (100%)');
  });

  it('csharp tools: find_symbol, get_context callees, cross-file member callers', async () => {
    const deps = await setup('small-cs');

    const found = (await runFindSymbol({ name: 'Greet' }, deps)).content[0].text;
    expect(found).toContain('Greeter.cs:');
    expect(found).toContain('| method');

    const ctx = (await runGetContext({ file: 'Greeter.cs', symbol: 'Greet' }, deps))
      .content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('Format');

    // Cross-file member ref: Program.cs calls g.Greet() — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'Greeter.cs', symbol: 'Greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('Program.cs:');
  });

  it('indexes the PHP fixture end-to-end', async () => {
    const { index } = await setup('small-php');

    expect(index.getStats().totalFiles).toBe(3);

    for (const name of [
      'Greeter',
      'greet',
      'format',
      'summary',
      'describe',
      '__construct',
      'normalize',
      'Shape',
      'Tagged',
      'Circle',
      'area',
      'label',
      'radius',
      'defaultCircle',
      'main',
    ]) {
      expect(
        index.findSymbolByName(name).length,
        `expected to find symbol "${name}"`,
      ).toBeGreaterThan(0);
    }

    // self-call edge: greet() → $this->format().
    const greet = index.findSymbolByName('greet')[0]!;
    const format = index.findSymbolByName('format')[0]!;
    expect(index.getCallees(greet.id).map((s) => s.id)).toContain(format.id);

    // bare FREE-FUNCTION call edge (PHP-distinctive): format() → normalize().
    const normalize = index.findSymbolByName('normalize').find((s) => s.kind === 'function')!;
    expect(index.getCallees(format.id).map((s) => s.id)).toContain(normalize.id);

    // construction edge: defaultCircle() → new Circle(...).
    const defaultCircle = index.findSymbolByName('defaultCircle')[0]!;
    const circle = index.findSymbolByName('Circle').find((s) => s.kind === 'class')!;
    expect(index.getCallees(defaultCircle.id).map((s) => s.id)).toContain(circle.id);

    // self-call: summary() → $this->describe().
    const summary = index.findSymbolByName('summary')[0]!;
    const describe = index.findSymbolByName('describe')[0]!;
    expect(index.getCallees(summary.id).map((s) => s.id)).toContain(describe.id);

    // exportedness: public method exported, private not. trait → class kind.
    expect(greet.exported).toBe(true);
    expect(format.exported).toBe(false);
    expect(greet.fqn).toBe('Greeter.php:Greeter.greet');
    expect(index.findSymbolByName('Tagged')[0]!.kind).toBe('class');
    // constructor-promotion property keyed on the class.
    expect(index.findSymbolByName('radius')[0]!.fqn).toBe('Shape.php:Circle.radius');
  });

  it('overview shows PHP language stats', async () => {
    const deps = await setup('small-php');
    const text = (await runOverview({}, deps)).content[0].text;
    expect(text).toContain('- PHP: 3 files (100%)');
  });

  it('php tools: find_symbol, get_context callees, cross-file member callers', async () => {
    const deps = await setup('small-php');

    const found = (await runFindSymbol({ name: 'greet' }, deps)).content[0].text;
    expect(found).toContain('Greeter.php:');
    expect(found).toContain('| method');

    const ctx = (await runGetContext({ file: 'Greeter.php', symbol: 'greet' }, deps))
      .content[0].text;
    expect(ctx).toContain('### Body');
    expect(sectionAfter(ctx, '### Callees')).toContain('format');

    // Cross-file member ref: index.php calls $g->greet() — unknown receiver,
    // weakly included because the method target is exported.
    const memberRefs = (
      await runFindReferences({ file: 'Greeter.php', symbol: 'greet' }, deps)
    ).content[0].text;
    expect(sectionAfter(memberRefs, '### Callers')).toContain('index.php:');
  });
});
