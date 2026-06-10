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
import { runOverview } from '../src/tools/overview.js';
import { runSearchStructure } from '../src/tools/search-structure.js';
import type { ProbeConfig } from '../src/types.js';
import {
  makeConfig,
  makeProjectDir,
  silenceStderr,
  writeTree,
} from './helpers.js';

const FIXTURES_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
);

const FIXTURE_FILES: Record<'small-ts' | 'small-py', readonly string[]> = {
  'small-ts': [
    'src/index.ts',
    'src/auth.ts',
    'src/utils.ts',
    'src/types.ts',
    'src/service.ts',
  ],
  'small-py': ['app/auth.py', 'app/models.py', 'app/service.py'],
};

async function copyFixtureToTmp(
  name: 'small-ts' | 'small-py',
): Promise<string> {
  const root = makeProjectDir(`probe-int-${name}-`);
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

  async function setup(
    fixture: 'small-ts' | 'small-py',
  ): Promise<{ index: CodeIndex; indexer: Indexer; config: ProbeConfig }> {
    // loadConfig (config.ts:81,115) reads PROBE_EXCLUDE and PROBE_CACHE_DIR.
    // Unset them so a developer's shell can't perturb the fixture's index.
    vi.stubEnv('PROBE_EXCLUDE', undefined);
    vi.stubEnv('PROBE_CACHE_DIR', undefined);
    root = await copyFixtureToTmp(fixture);
    const config = makeConfig(root);
    const index = new CodeIndex(root);
    const indexer = new Indexer(config, index);
    silenceStderr();
    await indexer.indexAll();
    return { index, indexer, config };
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
    // PLAN.md:1064 calls extractToken a "caller" of authenticate, but in the
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
});
