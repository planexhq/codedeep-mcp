import { runSearchStructure } from '../../../src/tools/search-structure.js';
import { captureCall } from '../capture.js';
import type { HarnessEnv } from '../harness-env.js';
import type { Selection } from '../input-selection.js';
import type { ToolCallRecord } from '../types.js';

export async function runSearchStructureSuite(
  env: HarnessEnv,
  sel: Selection,
): Promise<ToolCallRecord[]> {
  const out: ToolCallRecord[] = [];

  // Query mode — salient docstring words + bare names.
  for (const [i, q] of sel.queryTerms.entries()) {
    out.push(
      await captureCall('search_structure', { query: q.term }, `query/${q.from}`, () =>
        runSearchStructure({ query: q.term }, env),
      ),
    );
    if (i === 0) {
      out.push(
        await captureCall(
          'search_structure',
          { query: q.term, language: 'typescript' },
          `query-lang-filter`,
          () => runSearchStructure({ query: q.term, language: 'typescript' }, env),
        ),
      );
    }
  }

  // Pattern mode (TS/JS only) — synthesize from real call targets.
  for (const s of sel.patternSymbols) {
    const bare = `${s.name}($$$ARGS)`;
    out.push(
      await captureCall('search_structure', { pattern: bare }, `pattern-bare/${s.name}`, () =>
        runSearchStructure({ pattern: bare }, env),
      ),
    );
    if (s.kind === 'method') {
      const member = `$RECV.${s.name}($$$ARGS)`;
      out.push(
        await captureCall('search_structure', { pattern: member }, `pattern-member/${s.name}`, () =>
          runSearchStructure({ pattern: member }, env),
        ),
      );
    }
  }

  // Generic member-call recall probe.
  out.push(
    await captureCall(
      'search_structure',
      { pattern: '$OBJ.$METHOD($$$ARGS)' },
      'pattern-generic-member',
      () => runSearchStructure({ pattern: '$OBJ.$METHOD($$$ARGS)' }, env),
    ),
  );

  // Invalid pattern -> parse-error path.
  out.push(
    await captureCall(
      'search_structure',
      { pattern: 'function f() {' },
      'pattern-invalid',
      () => runSearchStructure({ pattern: 'function f() {' }, env),
    ),
  );

  // Python-pattern refusal, only meaningful when python is indexed.
  if (sel.byLanguage.python) {
    out.push(
      await captureCall(
        'search_structure',
        { pattern: 'app.get($PATH)', language: 'python' },
        'pattern-python-refusal',
        () => runSearchStructure({ pattern: 'app.get($PATH)', language: 'python' }, env),
      ),
    );
  }

  return out;
}
