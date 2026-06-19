import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../src/indexer/parser.js';
import type { Symbol } from '../../src/types.js';
import { makeFileInfo } from '../helpers.js';

function syms(src: string, language: string, path: string): Symbol[] {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path)).symbols;
}

// Complexity of the symbol named `name` (undefined when trivial/omitted).
function cx(src: string, name: string, language: string, path: string): number | undefined {
  const sym = syms(src, language, path).find((s) => s.name === name);
  if (!sym) throw new Error(`no symbol named ${name}`);
  return sym.complexity;
}

const ts = (src: string, name = 'f') => cx(src, name, 'typescript', 'src/test.ts');
const py = (src: string, name = 'f') => cx(src, name, 'python', 'src/test.py');
const go = (src: string, name = 'f') => cx(`package p\n${src}`, name, 'go', 'src/test.go');

beforeAll(async () => {
  await initParser();
});

describe('cyclomatic complexity — TypeScript/JS (SonarJS-faithful)', () => {
  it('omits the trivial value (=1)', () => {
    expect(ts('function f(){ return 1; }')).toBeUndefined();
  });

  it('+1 for an if; else adds nothing', () => {
    expect(ts('function f(a){ if(a) return 1; return 2; }')).toBe(2);
    expect(ts('function f(a){ if(a){} else {} }')).toBe(2);
  });

  it('+1 per case label, never the switch or default', () => {
    expect(
      ts('function f(x){ switch(x){ case 1: break; case 2: break; case 3: break; default: break; } }'),
    ).toBe(4);
  });

  it('a && b || c → +2 (per boolean operator)', () => {
    expect(ts('function f(a,b,c){ return a && b || c; }')).toBe(3);
    expect(ts('function f(a,b,c){ return a && b && c; }')).toBe(3);
  });

  it('counts && || and ?? (SonarJS), but not arithmetic/comparison or the assignment forms', () => {
    // SonarJS counts the nullish `??` (it is one LogicalExpression with &&/||)...
    expect(ts('function f(a,b){ return a ?? b; }')).toBe(2);
    expect(ts('function f(a,b,c){ return a && b || c; }')).toBe(3);
    // ...but NOT the logical-ASSIGNMENT forms (AssignmentExpression, not in the
    // cyclomatic switch), nor arithmetic/comparison (the token-read guard).
    expect(ts('function f(a,b){ a &&= b; a ||= b; a ??= b; }')).toBeUndefined();
    expect(ts('function f(a,b){ return a + b; }')).toBeUndefined();
    expect(ts('function f(a,b){ return a == b; }')).toBeUndefined();
  });

  it('+1 for a ternary', () => {
    expect(ts('function f(a){ return a ? 1 : 2; }')).toBe(2);
  });

  it('+1 per loop (for / while / do-while / for-of)', () => {
    expect(ts('function f(){ for(;;){} while(true){} do{}while(0); }')).toBe(4);
    expect(ts('function f(xs){ for(const x of xs){} }')).toBe(2);
  });

  it('does NOT count throw or catch (SonarJS omits both from cyclomatic)', () => {
    // try/catch/finally and throw add nothing; only the `if` counts.
    expect(ts('function f(a){ if (a) {} try {} catch (e) {} finally {} }')).toBe(2);
    expect(ts('function f(a){ if (a) {} throw new Error(); }')).toBe(2);
    // A function whose only "branching" is a throw/catch stays trivial (=1).
    expect(ts('function f(){ throw new Error(); }')).toBeUndefined();
  });

  it('a nested function does not leak its branches into the parent', () => {
    // `inner` is not extracted (nested functions are out of scope); outer must
    // count only its own `if`, not inner's two.
    const src = 'function outer(a){ if(a){} function inner(b,c){ if(b){} if(c){} } }';
    expect(ts(src, 'outer')).toBe(2);
    expect(syms(src, 'typescript', 'src/test.ts').map((s) => s.name)).toEqual(['outer']);
  });

  it('a top-level arrow-const is its own symbol; its ternary does not count toward an enclosing fn', () => {
    expect(ts('const g = (x) => x ? 1 : 2;', 'g')).toBe(2);
    // Inside a function the arrow is skipped (its own scope) and is not a symbol.
    const src = 'function outer(){ const g = (x) => x ? 1 : 2; return g(1); }';
    expect(ts(src, 'outer')).toBeUndefined();
  });

  it('a curried / function-returning arrow is a separate scope (body not folded in, no depth-dependent leak)', () => {
    // g's `body` field IS the inner arrow_function (a skip type); the root-skip
    // guard drops it consistently rather than leaking the inner branches into g.
    expect(ts('const g = (x) => (y) => { if (a) {} if (b) {} };', 'g')).toBeUndefined();
    // A plain expression-bodied arrow still counts its own branches.
    expect(ts('const h = (x) => (x ? 1 : 2);', 'h')).toBe(2);
  });

  it('counts JSX short-circuit && in a .tsx body', () => {
    expect(cx('function f(){ return <div>{cond && <X/>}</div>; }', 'f', 'tsx', 'src/test.tsx')).toBe(2);
  });

  it('counts complexity on a method', () => {
    expect(ts('class C { m(a){ if(a) return 1; return 2; } }', 'm')).toBe(2);
  });
});

describe('cyclomatic complexity — Python (Probe convention / radon-grounded)', () => {
  it('omits the trivial value (=1)', () => {
    expect(py('def f():\n  return 1')).toBeUndefined();
  });

  it('if/elif/else → +2 (elif counts, else does not)', () => {
    expect(py('def f(a,b):\n  if a:\n    pass\n  elif b:\n    pass\n  else:\n    pass')).toBe(3);
  });

  it('+1 for a loop', () => {
    expect(py('def f(y):\n  for x in y:\n    pass')).toBe(2);
    expect(py('def f(a):\n  while a:\n    pass')).toBe(2);
  });

  it('+1 per except clause; finally adds nothing', () => {
    expect(py('def f():\n  try:\n    pass\n  except E:\n    pass\n  finally:\n    pass')).toBe(2);
    expect(py('def f():\n  try:\n    pass\n  except A:\n    pass\n  except B:\n    pass')).toBe(3);
  });

  it('+1 for a conditional expression (ternary)', () => {
    expect(py('def f(a,c,b):\n  x = a if c else b')).toBe(2);
  });

  it('and / or each +1 (distinct boolean_operator node)', () => {
    expect(py('def f(a,b,c):\n  return a and b or c')).toBe(3);
  });

  it('+1 per match case, including the wildcard case _ (Probe convention)', () => {
    expect(
      py('def f(v):\n  match v:\n    case 1:\n      pass\n    case 2:\n      pass\n    case _:\n      pass'),
    ).toBe(4);
  });

  it('+1 for a comprehension if filter (radon + sonar-python both count it)', () => {
    expect(py('def f(y):\n  return [x for x in y if x > 0]')).toBe(2);
    // ...and a match-case guard (same if_clause node) also counts.
    expect(py('def f(v):\n  match v:\n    case 1 if v > 0:\n      pass')).toBe(3);
  });

  it('a nested function does not leak its branches into the parent', () => {
    const src = 'def outer(a):\n  if a:\n    pass\n  def inner(b,c):\n    if b:\n      pass\n    if c:\n      pass';
    expect(py(src, 'outer')).toBe(2);
    expect(syms(src, 'python', 'src/test.py').map((s) => s.name)).toEqual(['outer']);
  });
});

describe('cyclomatic complexity — Go (Probe convention / gocyclo-grounded)', () => {
  it('omits the trivial value (=1)', () => {
    expect(go('func f() {}')).toBeUndefined();
  });

  it('+1 for an if; else adds nothing', () => {
    expect(go('func f(a bool) { if a {} else {} }')).toBe(2);
  });

  it('+1 per expression-switch case, never switch or default', () => {
    expect(go('func f(x int) { switch x { case 1: case 2: case 3: default: } }')).toBe(4);
  });

  it('+1 per type-switch case', () => {
    expect(go('func f(v any) { switch v.(type) { case int: case string: } }')).toBe(3);
  });

  it('+1 per select communication case', () => {
    expect(go('func f(a, b chan int) { select { case <-a: case <-b: } }')).toBe(3);
  });

  it('a && b || a → +2 (per boolean operator); arithmetic is not counted', () => {
    expect(go('func f(a, b bool) bool { return a && b || a }')).toBe(3);
    expect(go('func f(a, b int) int { return a + b }')).toBeUndefined();
  });

  it('+1 per loop (for is Go’s only loop node, all forms)', () => {
    expect(go('func f() { for {} }')).toBe(2);
    expect(go('func f(n int) { for i := 0; i < n; i++ {} }')).toBe(2);
    expect(go('func f(m map[int]int) { for k := range m { _ = k } }')).toBe(2);
  });

  it('a descended closure (func_literal) counts toward the enclosing function', () => {
    // `g` is a local `:=`, not a symbol; its `if` attributes to `f` (gocyclo rule).
    expect(go('func f(a bool) { g := func() { if a {} }; _ = g }')).toBe(2);
  });

  it('a top-level var func-literal is its own symbol, counted exactly once', () => {
    expect(go('var f = func(x bool) { if x {} }')).toBe(2);
  });
});
