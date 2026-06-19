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

// Java carries BOTH metrics (Phase 3). `src` is one or more member declarations;
// they're wrapped in `class T { … }`. Returns { cyc, cog } for the named member
// (default `m`), each undefined when trivial (cyc 1 / cog 0).
function java(src: string, name = 'm'): { cyc: number | undefined; cog: number | undefined } {
  const sym = syms(`class T {\n${src}\n}`, 'java', 'src/T.java').find((s) => s.name === name);
  if (!sym) throw new Error(`no symbol named ${name}`);
  return { cyc: sym.complexity, cog: sym.cognitiveComplexity };
}

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

describe('Java — cyclomatic (sonar-java ComplexityVisitor) + cognitive (CognitiveComplexityVisitor)', () => {
  it('omits both trivial values (cyc 1 / cog 0)', () => {
    expect(java('void m(){}')).toEqual({ cyc: undefined, cog: undefined });
    expect(java('void m(int a){ return; }')).toEqual({ cyc: undefined, cog: undefined });
  });

  // --- Whitepaper worked examples (cognitive), transcribed clean-room ---
  it('getWords → cog 1 (whole switch), cyc 3 (per non-default case)', () => {
    const src =
      'String getWords(int number){ switch (number) {' +
      ' case 1: return "one"; case 2: return "a couple"; default: return "lots"; } }';
    expect(java(src, 'getWords')).toEqual({ cyc: 3, cog: 1 });
  });

  it('sumOfPrimes → cog 7 (nesting surcharge + labeled continue), cyc 4', () => {
    const src =
      'int sumOfPrimes(int max){ int total = 0;' +
      ' OUT: for (int i = 2; i <= max; ++i) {' +
      '   for (int j = 2; j < i; ++j) {' +
      '     if (i % j == 0) { continue OUT; } } total += i; } return total; }';
    expect(java(src, 'sumOfPrimes')).toEqual({ cyc: 4, cog: 7 });
  });

  it('myMethod → cog 9 (try/catch + deep nesting), cyc 5', () => {
    const src =
      'void myMethod(boolean condition1, boolean condition2){' +
      ' try {' +
      '   if (condition1) {' +
      '     for (int i = 0; i < 10; i++) {' +
      '       while (condition2) {} } }' +
      ' } catch (IllegalArgumentException | IllegalStateException e) {' +
      '   if (condition2) {} } }';
    expect(java(src, 'myMethod')).toEqual({ cyc: 5, cog: 9 });
  });

  it('a && b || c → cog 2, cyc 3 (per boolean operator)', () => {
    expect(java('boolean m(boolean a, boolean b, boolean c){ return a && b || c; }')).toEqual({
      cyc: 3,
      cog: 2,
    });
  });

  // --- Cyclomatic Java invariants ---
  it('a lambda is excluded from the method cyclomatic (sonar per-method behavior)', () => {
    // sonar-java's ComplexityVisitor (root = method) counts neither the lambda
    // arrow nor the lambda body. So an empty lambda leaves the method trivial,
    // and a lambda's INTERNAL branch does NOT lift the method's cyclomatic.
    expect(java('void m(){ Runnable r = () -> {}; }')).toEqual({ cyc: undefined, cog: undefined });
    // The `if` lives inside the lambda → excluded from cyclomatic, but cognitive
    // descends the lambda (nest-only) so the if surcharges at nesting 1 → cog 2.
    expect(java('void m(boolean a){ Runnable r = () -> { if (a) {} }; }')).toEqual({
      cyc: undefined,
      cog: 2,
    });
  });

  it('+1 per non-default switch_label, default excluded (colon and arrow)', () => {
    expect(
      java('void m(int x){ switch(x){ case 1: break; case 2: break; case 3: break; default: break; } }'),
    ).toEqual({ cyc: 4, cog: 1 });
    // Arrow switch: `case 2, 3 ->` is ONE label (one non-default case) → cyc 3.
    expect(
      java('int m(int x){ return switch(x){ case 1 -> 1; case 2, 3 -> 2; default -> 0; }; } '),
    ).toEqual({ cyc: 3, cog: 1 });
  });

  it('if/else-if/else → cyc 3 (two if nodes, else free), cog 3 (all flat in a chain)', () => {
    expect(java('void m(int a){ if(a>0){} else if(a<0){} else {} }')).toEqual({ cyc: 3, cog: 3 });
    expect(java('void m(boolean a){ if(a){} else {} }')).toEqual({ cyc: 2, cog: 2 });
  });

  it('throw/catch/finally add nothing to cyclomatic (a try/catch is cyc-trivial)', () => {
    // catch is +1 for COGNITIVE but nothing for cyclomatic → cyc omitted, cog 1.
    expect(java('void m(){ try {} catch(RuntimeException e){} finally {} }')).toEqual({
      cyc: undefined,
      cog: 1,
    });
    expect(java('void m(){ throw new RuntimeException(); }')).toEqual({
      cyc: undefined,
      cog: undefined,
    });
  });

  it('try-with-resources catch is counted like a plain try (distinct grammar node)', () => {
    // `try (R r = …) {} catch (E e) { if(c){} }` is `try_with_resources_statement`,
    // a DISTINCT node from `try_statement`. Catch is matched by its own node type,
    // so the catch (+1) and the nested if (+1+1) score the same as a plain try.
    const twr = 'void m(boolean c){ try (AutoCloseable r = open()){} catch (Exception e){ if (c) {} } }';
    const plain = 'void m(boolean c){ try {} catch (Exception e){ if (c) {} } }';
    expect(java(plain, 'm').cog).toBe(3);
    expect(java(twr, 'm').cog).toBe(3);
  });

  // The catch refactor (catch handled as its own node case; try containers are
  // plain pass-through) — edge cases ground-truthed against sonar-java itself.
  it('try/finally with NO catch: body + finally are flat pass-through (no surcharge)', () => {
    // try body if(a) at nesting 0 (+1); finally body if(b) at nesting 0 (+1, no
    // bump, no catch) → cog 2. sonar-java: cyc 3 / cog 2.
    expect(java('void m(boolean a, boolean b){ try { if(a){} } finally { if(b){} } }', 'm')).toEqual({
      cyc: 3,
      cog: 2,
    });
  });

  it('nested try inside a catch body: the inner catch surcharges at the bumped nesting', () => {
    // outer catch +1 (n0); inner catch +1+1 (n1); inner-catch-body if +1+2 (n2)
    // → cog 1+2+3 = 6. sonar-java: cyc 2 / cog 6.
    const src =
      'void m(boolean a){ try {} catch (RuntimeException e){' +
      ' try {} catch (RuntimeException e2){ if(a){} } } }';
    expect(java(src, 'm')).toEqual({ cyc: 2, cog: 6 });
  });

  it('nested try inside the try BODY: outer try is pass-through, inner catch surcharges at base', () => {
    // inner try-body if(a) at n0 (+1); inner catch +1 (n0), its if(b) at n1 (+2);
    // outer catch +1 (n0) → cog 1+1+2+1 = 5. sonar-java: cyc 3 / cog 5.
    const src =
      'void m(boolean a, boolean b){ try {' +
      ' try { if(a){} } catch (RuntimeException e){ if(b){} }' +
      ' } catch (RuntimeException e2){} }';
    expect(java(src, 'm')).toEqual({ cyc: 3, cog: 5 });
  });

  it('+1 per loop (for / enhanced-for / while / do-while)', () => {
    expect(java('void m(int[] a){ for(int i=0;i<1;i++){} while(true){} do{}while(false); }').cyc).toBe(4);
    expect(java('void m(int[] a){ for(int v : a){} }').cyc).toBe(2);
  });

  // --- Cognitive invariants ---
  it('nesting surcharge accumulates: triple-nested if → cog 6 (1+2+3), cyc 4', () => {
    expect(java('void m(boolean a){ if(a){ if(a){ if(a){} } } }')).toEqual({ cyc: 4, cog: 6 });
  });

  it('lambdas raise the cognitive nesting level but are excluded from cyclomatic', () => {
    // 3 lambdas nest the `if` to cognitive level 3 → cog = 1 + 3 = 4. For
    // cyclomatic the lambdas (and the if inside them) are excluded → trivial.
    // The metric asymmetry: lambdas count for cognitive nesting, never cyclomatic.
    const src =
      'void m(boolean a){ Runnable r = () -> { Runnable s = () -> { Runnable t = () -> {' +
      ' if (a) {} }; }; }; }';
    expect(java(src)).toEqual({ cyc: undefined, cog: 4 });
  });

  it('else is +1 flat with NO surcharge, but a real nested if inside it surcharges', () => {
    // if(a) +1 (n0); else +1 flat; else body at n1; nested if +2 (n1) → cog 4.
    expect(java('void m(boolean a){ if(a){} else { if(a){} } }')).toEqual({ cyc: 3, cog: 4 });
  });

  it('boolean-run collapse: a&&b&&c → cog 1 (one run); a&&b||c → cog 2 (kind change)', () => {
    expect(java('boolean m(boolean a, boolean b, boolean c){ return a && b && c; }')).toEqual({
      cyc: 3,
      cog: 1,
    });
    expect(java('boolean m(boolean a, boolean b, boolean c){ return a && b || c; }').cog).toBe(2);
  });

  it('boolean runs linearize in SOURCE order, not by left-spine (sonar flatten)', () => {
    // a && b && (c||d) && (e||f) → operator sequence [&&,&&,||,&&,||] = 4 runs.
    // A left-spine-only flatten would merge the &&s split by the parenthesized ||
    // and give 3; sonar (and Probe) descend both operands through parens → 4.
    const src =
      'boolean m(boolean a,boolean b,boolean c,boolean d,boolean e,boolean f){' +
      ' return a && b && (c || d) && (e || f); }';
    expect(java(src).cog).toBe(4);
    // The simple parenthesized-mix case from the whitepaper: a || (b && c) = 2.
    expect(java('boolean m(boolean a,boolean b,boolean c){ return a || (b && c); }').cog).toBe(2);
  });

  it('labeled break = +1 cognitive; a plain break adds nothing', () => {
    expect(java('void m(){ OUT: for(;;){ for(;;){ break OUT; } } }')).toEqual({ cyc: 3, cog: 4 });
    expect(java('void m(){ for(;;){ break; } }')).toEqual({ cyc: 2, cog: 1 });
  });

  it('the whole switch is cognitive +1 regardless of case count (vs cyclomatic per-case)', () => {
    const sw = 'void m(int x){ switch(x){ case 1: break; case 2: break; case 3: break; case 4: break; } }';
    expect(java(sw)).toEqual({ cyc: 5, cog: 1 });
  });
});
