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

// Both metrics for the named symbol (mirrors the `java` helper), each undefined
// when trivial (cyc 1 / cog 0). `tsCog` parses as .ts, `tsxCog` as .tsx (JSX).
function bothCx(
  src: string,
  name: string,
  language: string,
  path: string,
): { cyc: number | undefined; cog: number | undefined } {
  const sym = syms(src, language, path).find((s) => s.name === name);
  if (!sym) throw new Error(`no symbol named ${name}`);
  return { cyc: sym.complexity, cog: sym.cognitiveComplexity };
}
const tsCog = (src: string, name = 'f') => bothCx(src, name, 'typescript', 'src/test.ts');
const tsxCog = (src: string, name = 'f') => bothCx(src, name, 'tsx', 'src/test.tsx');
// Go carries both metrics (cognitive added this slice). Wraps `src` in `package p`.
const goCog = (src: string, name = 'f') =>
  bothCx(`package p\n${src}`, name, 'go', 'src/test.go');
// Python carries both metrics (cognitive added this slice). sonar-python-aligned.
const pyCog = (src: string, name = 'f') => bothCx(src, name, 'python', 'src/test.py');
// Rust carries both metrics: cyclomatic pinned to rust-code-analysis, cognitive
// whitepaper/sonar-rust-aligned. `src` is one or more top-level items.
const rustCog = (src: string, name = 'f') => bothCx(src, name, 'rust', 'src/test.rs');
// Swift carries both metrics: cyclomatic pinned to SwiftLint cyclomatic_complexity,
// cognitive whitepaper-aligned (no published Swift cognitive spec). `src` is one or more
// top-level declarations (a function `f` unless noted).
const swiftCog = (src: string, name = 'f') => bothCx(src, name, 'swift', 'src/test.swift');

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

// VERIFIED-EXACT against SonarJS S3776 (eslint-plugin-sonarjs@4.1.0
// `cjs/S3776/rule.js`) — read clean-room AND ground-truthed at threshold 0 (every
// number below was emitted by the real `sonarjs/cognitive-complexity` rule). The
// SonarJS cognitive rule differs MATERIALLY from sonar-java's (booleans +
// JSX), so these are independent pins, not a copy of the Java block.
describe('cognitive complexity — TypeScript/JS (SonarJS S3776)', () => {
  it('omits the trivial value (cog 0)', () => {
    expect(tsCog('function f(){ return 1; }').cog).toBeUndefined();
  });

  // --- Booleans: ONLY maximal `&&` runs count; `||`/`??` never count but DO
  // break `&&` runs in SOURCE order (the sonar-java divergence) ---
  it('a single && run = cog 1; || and ?? never count', () => {
    expect(tsCog('function f(a,b){ return a && b; }').cog).toBe(1);
    expect(tsCog('function f(a,b){ return a || b; }').cog).toBeUndefined();
    expect(tsCog('function f(a,b){ return a ?? b; }').cog).toBeUndefined();
    expect(tsCog('function f(a,b,c){ return a && b && c; }').cog).toBe(1);
    expect(tsCog('function f(a,b,c){ return a || b || c; }').cog).toBeUndefined();
  });

  it('|| / ?? break && runs in source order (count = number of && runs)', () => {
    expect(tsCog('function f(a,b,c){ return a && b || c; }').cog).toBe(1);
    expect(tsCog('function f(a,b,c){ return a || b && c; }').cog).toBe(1);
    expect(tsCog('function f(a,b,c,d){ return a && b || c && d; }').cog).toBe(2);
    expect(tsCog('function f(a,b,c){ return a || (b && c); }').cog).toBe(1);
  });

  it('boolean runs linearize in SOURCE order: a&&b&&(c||d)&&(e||f) = cog 2 (NOT java 4, NOT 1)', () => {
    // The two parenthesized ||s split the && spine into two source-order && runs.
    const src = 'function f(a,b,c,d,e,g){ return a && b && (c || d) && (e || g); }';
    expect(tsCog(src).cog).toBe(2);
  });

  it('cyclomatic still counts || and ?? — the expected cyc/cog divergence', () => {
    // cyclomatic: 3 operators (&&,||) → 1+2 = 3; ?? → 1+1 = 2. cognitive: 1 / 0.
    expect(tsCog('function f(a,b,c){ return a && b || c; }')).toEqual({ cyc: 3, cog: 1 });
    expect(tsCog('function f(a,b){ return a ?? b; }')).toEqual({ cyc: 2, cog: undefined });
  });

  // --- Structural ---
  it('if = +1+nesting; else = +1 flat; else-if = +1 flat (else_clause unwrap)', () => {
    expect(tsCog('function f(a){ if(a){} else {} }').cog).toBe(2);
    // else-if must be FLAT — the else_clause-unwrap engine path. Without it the
    // else-if would surcharge and this would read 5.
    expect(tsCog('function f(a){ if(a){} else if(a){} else {} }').cog).toBe(3);
    expect(tsCog('function f(a){ if(a){ if(a){ if(a){} } } }').cog).toBe(6); // 1+2+3
  });

  it('nesting surcharge: for{ if{} } = cog 3 (loop 1 + nested if 2)', () => {
    expect(tsCog('function f(a){ for(;;){ if(a){} } }').cog).toBe(3);
  });

  it('the whole switch is cog +1 regardless of case count', () => {
    const sw = 'function f(x){ switch(x){ case 1: break; case 2: break; case 3: break; default: break; } }';
    expect(tsCog(sw)).toEqual({ cyc: 4, cog: 1 }); // cyc per non-default case
  });

  it('+1+nesting per loop and ternary', () => {
    expect(tsCog('function f(){ for(;;){} while(true){} do{}while(0); }').cog).toBe(3);
    expect(tsCog('function f(xs){ for(const x of xs){} }').cog).toBe(1);
    expect(tsCog('function f(a){ return a ? 1 : 2; }').cog).toBe(1);
  });

  it('catch is +1+nesting; try/finally/throw add nothing (cyc-trivial, cog 1)', () => {
    expect(tsCog('function f(){ try{} catch(e){} finally{} }')).toEqual({ cyc: undefined, cog: 1 });
    expect(tsCog('function f(){ throw new Error(); }')).toEqual({ cyc: undefined, cog: undefined });
  });

  it('labeled break/continue = +1 flat; a plain break adds nothing', () => {
    expect(tsCog('function f(){ OUT: for(;;){ for(;;){ break OUT; } } }').cog).toBe(4);
    expect(tsCog('function f(){ for(;;){ break; } }').cog).toBe(1);
  });

  // --- Per-symbol model: nested functions reported separately (== SonarJS) ---
  it('a nested function/callback does NOT fold into the enclosing symbol', () => {
    // SonarJS reports outer=1 and inner=3 separately; Probe extracts only `outer`
    // and its cognitive (1, just its own if) matches SonarJS's outer report.
    expect(tsCog('function outer(a){ if(a){} function inner(b,c){ if(b){ if(c){} } } }', 'outer').cog).toBe(1);
    // A callback arrow's branches count toward nobody (the cyclomatic gap, mirrored).
    expect(tsCog('function f(xs,a){ return xs.map(x => { if(a){ if(x){} } }); }').cog).toBeUndefined();
  });

  it('a top-level arrow-const gets its OWN cognitive number', () => {
    expect(bothCx('const g = (x) => x ? 1 : 2;', 'g', 'typescript', 'src/test.ts').cog).toBe(1);
  });

  // --- JSX short-circuit exclusion (.tsx) ---
  it('a uniform-operator logical directly in a JSX container scores 0', () => {
    expect(tsxCog('function f(a){ return <div>{a && <span/>}</div>; }').cog).toBeUndefined();
    expect(tsxCog('function f(a,b){ return <div>{a && b && <span/>}</div>; }').cog).toBeUndefined();
    expect(tsxCog('function f(){ return <div>{foo() && bar()}</div>; }').cog).toBeUndefined();
    // attribute-value `={...}` is also a jsx_expression → excluded.
    expect(tsxCog('function f(a){ return <div data-x={a && a}>hi</div>; }').cog).toBeUndefined();
    // cyclomatic still counts the JSX && (no cognitive-style exclusion there).
    expect(tsxCog('function f(a){ return <div>{a && <span/>}</div>; }').cyc).toBe(2);
  });

  it('a MIXED-operator JSX expression is NOT excluded; non-JSX-container && counts', () => {
    expect(tsxCog('function f(a,b){ return <div>{(a||b) && <span/>}</div>; }').cog).toBe(1);
    // `{...}` excluded, but the trailing `return a && y` is not in a container → 1.
    const src = 'function f(a,b){ const y = <div>{a && b && <span/>}</div>; return a && y; }';
    expect(tsxCog(src).cog).toBe(1);
  });

  it('counts cognitive on a method and in a .js file', () => {
    expect(tsCog('class C { m(a){ if(a){ if(a){} } } }', 'm').cog).toBe(3);
    expect(bothCx('function f(a){ if(a){} else {} }', 'f', 'javascript', 'src/test.js').cog).toBe(2);
  });

  // DOCUMENTED DIVERGENCE (Probe is whitepaper-correct; the ONLY mismatch in an
  // 800-fn ky/zod/recharts/express oracle run): when a ternary's branch is a
  // FUNCTION expression and control flow follows it in the same function, SonarJS
  // OVER-counts via a visitor-ordering artifact — the nesting-node enter-bump hits
  // the enclosing function's nesting counter but the exit-unbump hits the inner
  // function's, permanently elevating the encloser's nesting (compounds per such
  // ternary). The whitepaper scopes nesting; Probe does too. Here SonarJS reports
  // 3 (ternary 1 + if at a leaked nesting 1 = 2), Probe the correct 2.
  it('does NOT reproduce the SonarJS ternary-function-branch nesting leak (Probe = whitepaper)', () => {
    const src = 'function f(x){ const d = { fn: typeof x === "function" ? x : (v) => x(v) }; if (x) {} }';
    expect(tsCog(src).cog).toBe(2); // ternary +1, if +1 — SonarJS's quirk gives 3
  });

  // --- Review-found edge cases (all oracle-confirmed against SonarJS) ---
  it('a WHOLE-expression-parenthesized JSX short-circuit is still excluded', () => {
    // SonarJS's ESTree drops parens, so `{(a && b)}` sits directly under the JSX
    // container and scores 0 — the engine must walk up through parenthesized_expression.
    expect(tsxCog('function f(a,b){ return <div>{(a && b)}</div>; }').cog).toBeUndefined();
    expect(tsxCog('function f(c){ return <div>{(c && <span/>)}</div>; }').cog).toBeUndefined();
    expect(tsxCog('function f(a,b){ return <div>{((a && b))}</div>; }').cog).toBeUndefined();
    // mixed-operator paren'd is still NOT excluded; a non-container paren'd && counts.
    expect(tsxCog('function f(a,b){ return <div>{(a||b) && <span/>}</div>; }').cog).toBe(1);
    expect(tsxCog('function f(a,b){ const x = (a && b); return <div/>; }').cog).toBe(1);
  });

  it('comment nodes do not perturb labels, else bodies, or boolean operands', () => {
    // tree-sitter attaches comments as NAMED children, so positional access must
    // be comment-robust. All three values oracle-confirmed against SonarJS.
    // (a) an unlabeled break with a comment is NOT a labeled jump (+0).
    expect(tsCog('function f(){ for(;;){ break /*c*/; } }').cog).toBe(1);
    // (b) a comment between `else` and its body must not drop the body's complexity.
    expect(tsCog('function f(a){ if(a){} else /*c*/ { if(a){} } }').cog).toBe(4);
    // (c) a comment around a boolean operator must not drop a sub-run.
    expect(tsCog('function f(a,b,c){ return a || /*c*/ b && c; }').cog).toBe(1);
  });
});

// Go cognitive is gocognit-aligned (uudashr/gocognit), the cognitive sibling of
// the gocyclo choice the cyclomatic side made — and DELIBERATELY diverges from
// sonar-go. Every value below is ORACLE-CONFIRMED EXACT against gocognit v1.2.1
// (376/376 functions on spf13/cobra + gin-gonic/gin + a synthetic edge-case file).
// The four gocognit-vs-sonar divergences each get a dedicated test.
describe('cognitive complexity — Go (gocognit-faithful)', () => {
  it('omits the trivial value (=0)', () => {
    expect(goCog('func f() {}').cog).toBeUndefined();
  });

  it('nesting surcharge: a nested if is +1 + its depth', () => {
    // outer if at nesting 0 (+1), inner if at nesting 1 (+2) → 3.
    expect(goCog('func f(a, b bool) { if a { if b {} } }').cog).toBe(3);
  });

  // --- DIVERGENCE 1: a plain `else` body is NOT nested (gocognit), vs sonar's
  // nesting+1. `else if` chains are unaffected. ---
  it('plain else does not nest its body (gocognit ≠ sonar)', () => {
    // if(1) + else(1) → 2.
    expect(goCog('func f(a bool) { if a {} else {} }').cog).toBe(2);
    // if(1) + else(1) + for at BASE nesting(1) → 3. sonar would nest the for → 4.
    expect(goCog('func f(a, b bool) { if a {} else { for b {} } }').cog).toBe(3);
    // chain: if(1) + else-if(1, flat) + terminal else(1) + for in the else at
    // BASE nesting(1) → 4. (else-if bodies ARE nesting+1; the terminal else isn't.)
    expect(goCog('func f(a, b, c bool) { if a {} else if b {} else { for c {} } }').cog).toBe(4);
  });

  // --- DIVERGENCE 2: the `if`-init clause is walked (gocognit). ---
  it('walks the if-init clause', () => {
    // if(1) + the init boolean a&&b(1) → 2.
    expect(goCog('func f(a, b bool) { if x := a && b; x {} }').cog).toBe(2);
  });

  // --- DIVERGENCE 3: parentheses are NOT unwrapped in a boolean chain, so a
  // parenthesized boolean is its own run (gocognit ≠ sonar). ---
  it('does not unwrap parens across boolean runs', () => {
    // (a&&b) is its own run(1) + the outer &&(1) → 2; sonar-unwrap would merge → 1.
    expect(goCog('func f(a, b, c bool) bool { return (a && b) && c }').cog).toBe(2);
    // un-parenthesized same-kind run collapses to 1.
    expect(goCog('func f(a, b, c bool) bool { return a && b && c }').cog).toBe(1);
    // a kind change starts a new run.
    expect(goCog('func f(a, b, c bool) bool { return a && b || c }').cog).toBe(2);
  });

  // --- DIVERGENCE 4: direct recursion = +1 per call-site, function-only. ---
  it('counts direct recursion +1 per call-site', () => {
    expect(goCog('func f() { f() }').cog).toBe(1);
    // if(1) + two recursive sites(2) → 3.
    expect(goCog('func f(n int) int { if n > 0 { return f(n-1) + f(n-2) }; return 0 }').cog).toBe(3);
  });

  it('a self-call inside a closure still counts as recursion', () => {
    // the func_literal raises nesting (+0); the f() inside → +1.
    expect(goCog('func f() { x := func() { f() }; x() }').cog).toBe(1);
  });

  it('a method does NOT recurse (bare-call rule excludes methods)', () => {
    // `m()` bare inside method m is a package-call, not method recursion; the
    // kind gate (function-only) excludes it. Selector self-calls never match.
    expect(goCog('type T struct{}\nfunc (s *T) m() { m() }', 'm').cog).toBeUndefined();
    expect(goCog('type T struct{}\nfunc (s *T) m() { s.m() }', 'm').cog).toBeUndefined();
  });

  it('the whole switch/select/type-switch is +1, not per-case (cyc/cog divergence)', () => {
    // cyclomatic counts each case; cognitive counts the container once.
    expect(goCog('func f(x int) { switch x { case 1: case 2: case 3: } }')).toEqual({
      cyc: 4,
      cog: 1,
    });
    expect(goCog('func f(a chan int) { select { case <-a: } }')).toEqual({ cyc: 2, cog: 1 });
    expect(goCog('func f(v any) { switch v.(type) { case int: } }')).toEqual({ cyc: 2, cog: 1 });
  });

  it('labeled break/continue and goto are +1; a bare break is 0', () => {
    // for(1) + labeled break(1) → 2.
    expect(goCog('func f() { L: for { break L } }').cog).toBe(2);
    // for(1) + labeled continue(1) → 2.
    expect(goCog('func f() { L: for { continue L } }').cog).toBe(2);
    // for(1) + bare break(0) → 1.
    expect(goCog('func f() { for { break } }').cog).toBe(1);
    // goto is always a labeled jump → +1.
    expect(goCog('func f() { L: for { goto L } }').cog).toBe(2);
  });

  it('a closure (func_literal) raises nesting for its body', () => {
    // the if inside the closure is at nesting 1 → 1+1 = 2.
    expect(goCog('func f(a bool) { x := func() { if a {} }; _ = x }').cog).toBe(2);
  });

  it('a top-level var func-literal carries its own cognitive number', () => {
    expect(goCog('var f = func(a, b bool) { if a { if b {} } }').cog).toBe(3);
  });
});

// Python cognitive is sonar-python-aligned (SonarQube's own number), DELIBERATELY
// divergent from complexipy (the standalone tool — booleans only in some statement
// slots, except flat, try/with bodies nested). Every value below is ORACLE-CONFIRMED
// EXACT against sonar-python 5.5's CognitiveComplexityVisitor (the prototype matched
// it on all ~5034 functions WITHOUT a nested scope across flask + django; the real
// extractor matched the prototype 5122/5122). The one divergence — nested
// functions/lambdas/classes are EXCLUDED (the per-symbol model) — gets its own block.
describe('cognitive complexity — Python (sonar-python-faithful)', () => {
  it('omits the trivial value (=0)', () => {
    expect(pyCog('def f():\n  return 1').cog).toBeUndefined();
  });

  // --- the if/elif/else chain: head surcharges, each elif/else +1 FLAT, bodies +1.
  // Python's `alternative` is a flat sibling LIST (elif_clause/else_clause), not a
  // nested-if chain — the one genuinely-new engine path (elifClauseType). ---
  it('if/elif/else: head 1+nesting, each elif/else +1 flat', () => {
    expect(pyCog('def f(a,b):\n  if a:\n    g()\n  elif b:\n    h()\n  else:\n    k()').cog).toBe(3);
    // head if only → 1.
    expect(pyCog('def f(a):\n  if a:\n    g()').cog).toBe(1);
    // two elifs + else: 1 + 1 + 1 + 1 → 4.
    expect(
      pyCog('def f(a,b,c):\n  if a:\n    pass\n  elif b:\n    pass\n  elif c:\n    pass\n  else:\n    pass').cog,
    ).toBe(4);
  });

  it('nesting surcharge: a 3-deep if is 1+2+3 = 6', () => {
    expect(pyCog('def f(a,b,c):\n  if a:\n    if b:\n      if c:\n        g()').cog).toBe(6);
  });

  // --- elif/else bodies nest +1; a control structure inside them surcharges there ---
  it('elif/else bodies are one level deeper', () => {
    // if(1) + elif(1) + for in the elif body @ nesting 1 (1+1=2) → 4.
    expect(pyCog('def f(a,b,xs):\n  if a:\n    pass\n  elif b:\n    for x in xs:\n      g()').cog).toBe(4);
  });

  it('for/while loops surcharge; body nests', () => {
    // for(1) + if in the body @1 (2) → 3.
    expect(pyCog('def f(xs):\n  for x in xs:\n    if x:\n      g()').cog).toBe(3);
    // while-test booleans count flat: while(1) + a and b(1) → 2.
    expect(pyCog('def f(a,b):\n  while a and b:\n    g()').cog).toBe(2);
  });

  // --- except SURCHARGES (1+nesting) like Java — NOT complexipy's flat +1 ---
  it('except surcharges at the try nesting; try body is not nested', () => {
    // two except at nesting 0 → 1 + 1 = 2.
    expect(pyCog('def f():\n  try:\n    g()\n  except A:\n    h()\n  except B:\n    k()').cog).toBe(2);
    // if(1) + except nested in the if body @1 (1+1=2) → 3. complexipy gives 2 (flat except).
    expect(pyCog('def f(a):\n  if a:\n    try:\n      g()\n    except E:\n      h()').cog).toBe(3);
  });

  it('ternary surcharges (1+nesting)', () => {
    expect(pyCog('def f(a,c,b):\n  return a if c else b').cog).toBe(1);
  });

  // --- booleans: per-operator-kind run, NO paren unwrap (sonar flattenOperators
  // stops at parens — like gocognit, unlike complexipy/TS/Java) ---
  it('boolean runs: +1 per source-order kind change, parens NOT unwrapped', () => {
    expect(pyCog('def f(a,b):\n  return a and b').cog).toBe(1);
    expect(pyCog('def f(a,b,c):\n  return a and b and c').cog).toBe(1);
    expect(pyCog('def f(a,b,c):\n  return a and b or c').cog).toBe(2);
    // (a and b) is its own run + the outer `and` → 2; sonar does NOT unwrap parens.
    expect(pyCog('def f(a,b,c):\n  return (a and b) and c').cog).toBe(2);
    // a&&b&&(c||d)&&(e||f)-style: the &&-spine run once + each parenthesized or → 3.
    expect(pyCog('def f(a,b,c,d,e,g):\n  return a and b and (c or d) and (e or g)').cog).toBe(3);
  });

  it('booleans count EVERYWHERE (bare-call statement, comprehension filter)', () => {
    // bare expression statement — complexipy skips this; sonar-python (and Probe) count it.
    expect(pyCog('def f(a,b):\n  foo(a and b)').cog).toBe(1);
    // comprehension filter — complexipy skips; sonar-python counts.
    expect(pyCog('def f(xs):\n  return [x for x in xs if x and ok(x)]').cog).toBe(1);
  });

  // --- match: 0 STRUCTURAL (neither match nor case adds +1); case bodies nest +1 ---
  it('match is 0 structural; case bodies nest', () => {
    // plain match with trivial case bodies → 0 (omitted).
    expect(pyCog('def f(x):\n  match x:\n    case 1:\n      g()\n    case _:\n      h()').cog).toBeUndefined();
    // an if inside a case body is at nesting 1 → 1+1 = 2 (the match contributes 0).
    expect(pyCog('def f(x,a):\n  match x:\n    case 1:\n      if a:\n        g()').cog).toBe(2);
  });

  // --- with: NOT nested (sonar-python excludes WITH_STMT) — diverges from complexipy ---
  it('with body is NOT nested (diverges from complexipy)', () => {
    // if inside a `with` is at nesting 0 → 1. complexipy nests the with body → 2.
    expect(pyCog('def f(a):\n  with open("x") as fh:\n    if a:\n      g()').cog).toBe(1);
  });

  // --- for/while/try `else` clause: +1 flat, body nested (the else_clause dispatch) ---
  it('for-else / while-else / try-else are +1 flat with their body nested', () => {
    // for(1) + for-else(1) → 2.
    expect(pyCog('def f(xs):\n  for x in xs:\n    g()\n  else:\n    h()').cog).toBe(2);
    // while(1) + while-else(1) → 2 (same else_clause dispatch path as for-else).
    expect(pyCog('def f(a):\n  while a:\n    g()\n  else:\n    h()').cog).toBe(2);
    // except @0 (1) + try-else(1) + an if in the else body @1 (2) → 4. try body not nested.
    expect(pyCog('def f(a):\n  try:\n    g()\n  except E:\n    pass\n  else:\n    if a:\n      h()').cog).toBe(4);
  });

  // --- loopBodyField resolves the loop-header overbump for Python: a ternary in a
  // `for` iterable is at the loop's AMBIENT nesting, not bumped. ---
  it('a structural construct in a loop header is not over-nested (loopBodyField)', () => {
    // for(1) + the ternary in the iterable @ nesting 0 (1) → 2. (bump-all would give 3.)
    expect(pyCog('def f(a,xs,ys):\n  for x in (xs if a else ys):\n    g()').cog).toBe(2);
  });

  // Comment-robustness: comments are NAMED children, so a comment around the else
  // keyword / in the chain must not change the cognitive value (mirrors the TS block).
  it('comments in the if/elif/else chain do not change the value', () => {
    // if(1) + elif(1) + else(1) → 3, with comments interleaved throughout.
    expect(
      pyCog('def f(a,b):\n  if a:  # c\n    g()\n  elif b:  # c\n    h()\n  else:  # c\n    k()').cog,
    ).toBe(3);
  });

  it('carries both metrics (cyc counts each boolean_operator, cog collapses runs)', () => {
    // a and b or c: cyclomatic counts each boolean_operator (2 ops → 1+2=3),
    // cognitive collapses to 2 source-order runs.
    expect(pyCog('def f(a,b,c):\n  return a and b or c')).toEqual({ cyc: 3, cog: 2 });
  });
});

// DOCUMENTED DIVERGENCE (the only one vs sonar-python): nested functions, lambdas,
// and nested classes are EXCLUDED from the enclosing symbol's cognitive number,
// because PY_SKIP_TYPES is the cognitive boundary and Probe does not extract them as
// symbols. sonar-python ROLLS them into the encloser (+1 nesting, with a decorator-
// wrapper exception). This is the per-symbol model — identical to the Java anon-class
// and TS-arrow callback under-counts. Magnitude on flask/django: ~2% of functions.
describe('cognitive complexity — Python nested-scope exclusion (documented divergence)', () => {
  it('a nested function`s control flow counts toward NOBODY', () => {
    // outer if(1); inner fn`s if is EXCLUDED. sonar-python would roll it in → 3.
    expect(pyCog('def f(a):\n  def inner(b):\n    if b:\n      pass\n  if a:\n    pass').cog).toBe(1);
  });

  it('a lambda body is excluded', () => {
    // the if(1) counts; the lambda`s booleans do not. sonar-python counts them.
    expect(pyCog('def f(a):\n  g = lambda x: x and a and a\n  if a:\n    pass').cog).toBe(1);
  });

  it('a nested class`s method control flow is excluded from the enclosing function', () => {
    // outer if(1); the nested class method`s if is EXCLUDED (the method isn`t even a
    // Probe symbol — Probe extracts top-level-class methods only).
    expect(
      pyCog('def f(a):\n  class C:\n    def m(self, b):\n      if b:\n        pass\n  if a:\n    pass').cog,
    ).toBe(1);
  });
});

// Rust — CYCLOMATIC pinned to Mozilla's rust-code-analysis (the rust-code-analysis-cli
// oracle), COGNITIVE whitepaper/sonar-rust-aligned. Every value below is
// oracle-confirmed against rust-code-analysis-cli on the same snippet EXCEPT the
// loop-cognitive cases, where Probe is whitepaper-correct and rust-code-analysis is
// buggy (its cognitive visitor omits `loop` — those rca values are noted inline).
describe('complexity — Rust (rust-code-analysis cyclomatic / whitepaper cognitive)', () => {
  // --- cyclomatic ---
  it('if / else-if / else chain: only the `if`s count', () => {
    // base + if + else-if(an if) = 3; `else` adds nothing.
    expect(rustCog('fn f(a: bool, b: bool) { if a { x(); } else if b { y(); } else { z(); } }').cyc).toBe(3);
  });

  it('each match arm counts (+1); a whole match does not', () => {
    expect(rustCog('fn f(x: i32) -> i32 { match x { 1 => a(), 2 => b(), _ => c() } }').cyc).toBe(4);
  });

  it('an or-pattern arm (A | B | C =>) is ONE arm, not N', () => {
    // 2 arms (+2), not 4 — the `|` alternatives are part of one match_pattern.
    expect(rustCog('fn f(x: i32) { match x { 1 | 2 | 3 => a(), _ => c() } }').cyc).toBe(3);
  });

  it('a match-arm GUARD adds +1 (the rust-code-analysis convention)', () => {
    // 2 arms (+2) + the `if c` guard (+1) = base+3 = 4.
    expect(rustCog('fn f(x: i32) -> i32 { match x { A if c => 1, _ => 2 } }').cyc).toBe(4);
  });

  it('a guard`s own &&/|| count on top of the guard +1', () => {
    // 2 arms + guard(+1) + the `&&` inside it(+1) = base+4 = 5.
    expect(rustCog('fn f(x: i32) -> i32 { match x { A if c && d => 1, _ => 2 } }').cyc).toBe(5);
  });

  it('all three loops count (loop / while / for)', () => {
    expect(rustCog('fn f() { loop { a(); } while b() { c(); } for i in r() { d(); } }').cyc).toBe(4);
  });

  it('&& and || each count (C-family; Rust has no ??)', () => {
    expect(rustCog('fn f(a: bool) { if a && b || c { x(); } }').cyc).toBe(4);
  });

  it('the `?` try operator counts (+1 each) — the rust-code-analysis pin', () => {
    expect(rustCog('fn f() -> Result<(), E> { foo()?; bar()?; Ok(()) }').cyc).toBe(3);
  });

  it('if-let / while-let count as if / while', () => {
    expect(rustCog('fn f(o: Option<i32>) { if let Some(x) = o { a(); } while let Some(y) = n() { b(); } }').cyc).toBe(3);
  });

  it('`let … else` is NOT counted cyclomatically (trivial → omitted)', () => {
    // neither analyzer counts let-else cyclomatically; cyc 1 is omitted as undefined.
    expect(rustCog('fn f(o: Option<i32>) { let Some(x) = o else { return; }; }').cyc).toBeUndefined();
  });

  it('a closure counts (+1) and its body is descended', () => {
    // closure(+1) + the if inside it(+1) = base+2 = 3.
    expect(rustCog('fn f() { let g = |n: i32| if n > 0 { 1 } else { 2 }; }').cyc).toBe(3);
  });

  it('a nested `fn` is excluded (the per-symbol model)', () => {
    // the inner fn`s `if` counts toward nobody → outer f is trivial (both omitted).
    const r = rustCog('fn f() { fn inner() { if a { b(); } } }');
    expect(r.cyc).toBeUndefined();
    expect(r.cog).toBeUndefined();
  });

  // --- cognitive ---
  it('if / else-if / else: head surcharges, else-if & else are +1 flat', () => {
    expect(rustCog('fn f(a: bool, b: bool) { if a { x(); } else if b { y(); } else { z(); } }').cog).toBe(3);
  });

  it('nesting surcharges: a nested if is +1+nesting', () => {
    // if(+1) + inner if(+1+1) = 3.
    expect(rustCog('fn f(a: bool, b: bool) { if a { if b { x(); } } }').cog).toBe(3);
  });

  it('`loop` IS counted cognitively (whitepaper-correct; rust-code-analysis omits it → would give 1)', () => {
    // loop(+1) + if at nesting 1(+2) = 3. rca bug: loop=0, if at nesting 0 → cog 1.
    expect(rustCog('fn f(a: bool) { loop { if a { x(); } } }').cog).toBe(3);
  });

  it('`while` surcharges and nests its body', () => {
    expect(rustCog('fn f(a: bool) { while a { if b() { x(); } } }').cog).toBe(3);
  });

  it('a whole match is +1 with its arms nesting', () => {
    // if(+1) + match at nesting 1(+2) = 3.
    expect(rustCog('fn f(a: bool, x: i32) { if a { match x { 1 => b(), _ => c() } } }').cog).toBe(3);
  });

  it('booleans: +1 per maximal same-kind run, per expression', () => {
    // a&&b&&c || d||e = one && run + one || run = 2 (whitepaper). This is a
    // DIVERGING shape: rust-code-analysis over-counts it to 3 via its cross-expression
    // boolean carry (a `&&`-run followed by a `||`-run). A `(a&&b)||c||d` shape, by
    // contrast, happens to score 2 on both — so it would be a vacuous guard.
    expect(rustCog('fn f(a: bool) -> bool { a && b && c || d || e }').cog).toBe(2);
  });

  it('a labeled break is +1 flat (and `loop` is counted)', () => {
    // loop(+1) + while at nesting 1(+2) + labeled break(+1 flat) = 4. rca (loop
    // omitted): while at nesting 0(+1) + break(+1) = 2.
    expect(rustCog("fn f() { 'outer: loop { while a() { break 'outer; } } }").cog).toBe(4);
  });

  it('a break/continue carrying a VALUE descends that value`s control flow', () => {
    // Rust break/continue are expressions. loop(+1) + the break value `if a {} else {}`
    // at nesting 1: if(+2) + else(+1 flat) = 4. (A bare/early-return guard here would
    // wrongly score 1.)
    expect(rustCog('fn f(a: bool) -> i32 { loop { break if a { 1 } else { 2 }; } }').cog).toBe(4);
  });

  it('`let … else` is +1 flat cognitively (the if-let-else analog)', () => {
    expect(rustCog('fn f(o: Option<i32>) { let Some(x) = o else { return; }; }').cog).toBe(1);
  });

  it('a let-else`s else-block control flow is descended at the binding`s nesting', () => {
    // let-else(+1 flat) + the else block `if a() { return } else { panic!() }` at the
    // binding`s (base) nesting: if(+1) + else(+1 flat) = 3. Cyclomatically only the
    // inner if counts (the let-else itself does not) → cyc 2.
    const r = rustCog('fn f(o: Option<i32>) { let Some(x) = o else { if a() { return; } else { panic!() } }; }');
    expect(r.cyc).toBe(2);
    expect(r.cog).toBe(3);
  });

  it('the plain-else body nests one level (whitepaper / sonar default)', () => {
    // if(+1) + else(+1 flat) + if-in-else at nesting 1(+2) = 4. If the else body
    // did NOT nest this would be 3 — guards the nestElseBody-unset (true) choice.
    expect(rustCog('fn f(a: bool, b: bool) { if a { x(); } else { if b { y(); } } }').cog).toBe(4);
  });

  it('a closure raises nesting (+0 itself) and rolls its control flow in', () => {
    // closure nests its body: if-a at nesting 1(+2) + if-b at nesting 2(+3) = 5.
    expect(rustCog('fn f(a: bool) { let g = || if a { if b() { x(); } }; }').cog).toBe(5);
  });
});

// Swift — CYCLOMATIC pinned to SwiftLint's `cyclomatic_complexity` (the only EXACT
// runnable oracle; its ComplexityVisitor counts if/else-if, the 3 loops, guard, each
// catch, every switch case incl. default, `fallthrough` −1; it does NOT count
// `&&`/`||`/ternary/`??`). Every cyc value below is what SwiftLint reports + 1 (Probe's
// base; SwiftLint's visitor starts at 0). COGNITIVE is SonarSource-whitepaper-aligned
// (no published cognitive spec for Swift — no tool oracle; values hand-computed from the
// whitepaper). Each `it` notes the derivation.
describe('cyclomatic complexity — Swift (SwiftLint cyclomatic_complexity)', () => {
  it('a trivial function omits complexity (decisions 0 → complexity 1)', () => {
    expect(swiftCog('func f() { g() }').cyc).toBeUndefined();
  });

  it('`if` + each `else if` count; plain `else` does not', () => {
    expect(swiftCog('func f(a: Int) { if a > 0 { g() } }').cyc).toBe(2);
    // if + else-if = 2 decisions (the plain else adds nothing) → cyc 3.
    expect(swiftCog('func f(a: Int) { if a > 0 { g() } else if a < 0 { h() } else { k() } }').cyc).toBe(3);
  });

  it('`guard` counts +1 (SwiftLint; some cyclomatic rules would NOT)', () => {
    expect(swiftCog('func f(x: Int?) { guard let y = x else { return }; use(y) }').cyc).toBe(2);
  });

  it('for / while / repeat each count +1', () => {
    expect(swiftCog('func f(xs: [Int]) { for x in xs { g() }; while c { h() }; repeat { k() } while c }').cyc).toBe(4);
  });

  it('every switch case counts +1 INCLUDING default; a multi-pattern case is ONE', () => {
    // case 1 + case 2 + default = 3 entries → cyc 4.
    expect(swiftCog('func f(x: Int) { switch x { case 1: a(); case 2: b(); default: c() } }').cyc).toBe(4);
    // case 1,2,3 (ONE entry) + default = 2 entries → cyc 3.
    expect(swiftCog('func f(x: Int) { switch x { case 1, 2, 3: a(); default: b() } }').cyc).toBe(3);
  });

  it('`fallthrough` subtracts 1 — BOTH parse shapes (oracle-confirmed vs SwiftLint)', () => {
    // case 1 nets 0 (+1 case, −1 fallthrough), case 2 (+1) = 1 decision → cyc 2.
    // Shape A — `fallthrough` ALONE in the case: a named simple_identifier under
    // `statements` (SwiftLint raw 1).
    expect(swiftCog('func f(x: Int) { switch x { case 1: fallthrough; case 2: g() } }').cyc).toBe(2);
    // Shape B — work THEN `fallthrough` (the common real pattern): `fallthrough` is an
    // ANONYMOUS node, a DIRECT child of switch_entry, never visited by the namedChildren
    // DFS — so it's detected on the switch_entry itself (SwiftLint raw 1, cyc 2).
    expect(swiftCog('func f(x: Int) { switch x { case 1: a(); fallthrough; case 2: g() } }').cyc).toBe(2);
  });

  it('the `fallthrough` −1 fires ONLY for the statement, not a member/arg named fallthrough', () => {
    // `fallthrough` is reserved only AS A STATEMENT (parent `statements`); as a method/
    // property/enum-case name or labeled arg it is a plain identifier and must NOT
    // decrement. Each body below has exactly one `if` → SwiftLint complexity 1 → cyc 2.
    expect(swiftCog('func f(o: O) { if c { o.fallthrough() } }').cyc).toBe(2); // method call
    expect(swiftCog('func f(o: O) { if c { let v = o.fallthrough; use(v) } }').cyc).toBe(2); // property
    expect(swiftCog('func f() { if c { let v = E.fallthrough; use(v) } }').cyc).toBe(2); // enum case
    expect(swiftCog('func f(o: O) { if c { o.g(fallthrough: 1) } }').cyc).toBe(2); // labeled arg
    // …while a genuine statement-position fallthrough inside a nested `if` in a case
    // STILL decrements: case(+1) + if(+1) − fallthrough(−1) + default(+1) = 2 → cyc 3.
    expect(swiftCog('func f(x: Int) { switch x { case 1: if c { fallthrough }; default: g() } }').cyc).toBe(3);
  });

  it('each `catch` clause counts +1 (the `do` itself does not)', () => {
    expect(swiftCog('func f() { do { try g() } catch let e { h(e) } catch { k() } }').cyc).toBe(3);
  });

  it('`&&`/`||`, ternary, and `??` are NOT counted cyclomatically (SwiftLint)', () => {
    // The `if` is the only decision; the && / || inside its condition add nothing.
    expect(swiftCog('func f(a: Bool, b: Bool, c: Bool) { if a && b || c { g() } }').cyc).toBe(2);
    // A ternary + nil-coalescing with no branch statement is trivial.
    expect(swiftCog('func f(a: Bool, b: Int?) -> Int { return a ? 1 : (b ?? 0) }').cyc).toBeUndefined();
  });

  it('closures are DESCENDED (their branches count toward the enclosing function)', () => {
    expect(swiftCog('func f(xs: [Int]) { xs.forEach { x in if x > 0 { g() } } }').cyc).toBe(2);
  });

  it('a nested `func` is its own scope (its branches do NOT count toward the parent)', () => {
    expect(swiftCog('func f() { func g() { if a { h() } }; k() }').cyc).toBeUndefined();
  });

  it('all method-kind decls (func/method/init/deinit/subscript) ARE measured; computed properties are NOT', () => {
    // init + method + subscript + deinit are all 'method'-kind → measured by the
    // {function,method} gate. NOTE: only func+init match SwiftLint's rule scope; Probe
    // ADDITIONALLY measures subscripts/deinit (same algorithm, extra coverage beyond
    // SwiftLint — NOT an oracle divergence on the NUMBER, just on which decls report).
    expect(swiftCog('struct S { init(a: Int) { if a > 0 { x() } } }', 'init').cyc).toBe(2);
    expect(swiftCog('class C { func m(a: Int) { if a > 0 { x() } } }', 'm').cyc).toBe(2);
    expect(swiftCog('struct S { subscript(i: Int) -> Int { if i > 0 { return 1 }; return 2 } }', 'subscript').cyc).toBe(2);
    expect(swiftCog('class C { deinit { if a { x() } } }', 'deinit').cyc).toBe(2);
    // A computed property is a 'variable' symbol → excluded by the {function,method}
    // gate. This exclusion IS oracle-aligned (SwiftLint's rule does not measure
    // accessors either) — distinct from the subscript/deinit EXTRA coverage above.
    const x = swiftCog('struct S { var p: Int { if a { return 1 }; return 2 } }', 'p');
    expect(x.cyc).toBeUndefined();
    expect(x.cog).toBeUndefined();
  });

  it('the `Math.max(0, count)` floor: a net-negative decision count omits complexity (never < 1)', () => {
    // A stray `fallthrough` outside a switch (only in a broken/odd parse) drives the
    // decision count to −1 via swiftFallthroughDecrement; the floor clamps it to 0 so
    // the symbol is omitted (trivial), never emitting an invalid complexity 0.
    expect(swiftCog('func f() { fallthrough }').cyc).toBeUndefined();
  });
});

describe('cognitive complexity — Swift (SonarSource whitepaper)', () => {
  it('if / else-if / else: head if surcharges, chain links are +1 FLAT', () => {
    expect(swiftCog('func f(a: Int) { if a > 0 { g() } }').cog).toBe(1);
    expect(swiftCog('func f(a: Int) { if a > 0 { g() } else { h() } }').cog).toBe(2);
    // if(+1) + else-if(+1 flat) + else(+1 flat) = 3 (NOT a surcharged nested if).
    expect(swiftCog('func f(a: Int) { if a > 0 { g() } else if a < 0 { h() } else { k() } }').cog).toBe(3);
  });

  it('a nested `if` surcharges by nesting (the positional-if handler)', () => {
    // outer if(+1) + inner if at nesting 1(+2) = 3.
    expect(swiftCog('func f(a: Int, b: Int) { if a > 0 { if b > 0 { g() } } }').cog).toBe(3);
  });

  it('an EMPTY `{}` consequence or else still counts the else (detected by the `else` keyword)', () => {
    // An empty block emits NO `statements` node, so the else must be detected by the
    // `else` keyword, not by a second block child. Each = head if(+1) + else(+1 flat) = 2.
    expect(swiftCog('func f(a: Int) { if a > 0 {} else { k() } }').cog).toBe(2); // empty consequence
    expect(swiftCog('func f(a: Int) { if a > 0 { g() } else {} }').cog).toBe(2); // empty else
    expect(swiftCog('func f(a: Int) { if a > 0 {} else {} }').cog).toBe(2); // both empty
    // Compounds in chains: if(+1) + else-if(+1) + else(+1) = 3 even with empty bodies.
    expect(swiftCog('func f(a: Int, b: Int) { if a > 0 { g() } else if b > 0 {} else { k() } }').cog).toBe(3);
    // A nested if inside an empty-consequence else body still nests: if(+1) + else(+1) +
    // nested if at nesting 1(+2) = 4.
    expect(swiftCog('func f(a: Int, b: Int) { if a > 0 {} else { if b > 0 { x() } } }').cog).toBe(4);
  });

  it('booleans: one +1 per maximal same-kind run in SOURCE order', () => {
    expect(swiftCog('func f(a: Bool, b: Bool) { if a && b { g() } }').cog).toBe(2); // if + 1 run
    expect(swiftCog('func f(a: Bool, b: Bool, c: Bool) { if a && b && c { g() } }').cog).toBe(2); // one && run
    expect(swiftCog('func f(a: Bool, b: Bool, c: Bool) { if a && b || c { g() } }').cog).toBe(3); // && run + || run
  });

  it('a parenthesized boolean is its OWN run (no-unwrap sentinel)', () => {
    // (a && b) && c → the inner && and outer && are separate runs (tree-sitter wraps
    // the parens in a tuple_expression the engine does NOT unwrap) → if(1) + 2 = 3.
    expect(swiftCog('func f(a: Bool, b: Bool, c: Bool) { if (a && b) && c { g() } }').cog).toBe(3);
  });

  it('`guard` is +1 FLAT (the let-else analog; no surcharge, condition booleans count)', () => {
    expect(swiftCog('func f(x: Int?) { guard let y = x else { return }; use(y) }').cog).toBe(1);
    expect(swiftCog('func f(a: Bool, b: Bool) { guard a && b else { return } }').cog).toBe(2);
    // The guard's else body is descended at the SAME nesting (flat), so its `if y` is
    // at base nesting: guard(+1) + if(+1) = 2 (NOT 3 — guard does not nest its else).
    expect(swiftCog('func f(a: Bool, y: Bool) { guard a else { if y { log() }; return } }').cog).toBe(2);
  });

  it('loops surcharge and nest their body', () => {
    // for(+1) + if at nesting 1(+2) = 3.
    expect(swiftCog('func f(xs: [Int]) { for x in xs { if x > 0 { g() } } }').cog).toBe(3);
  });

  it('a `switch` is +1 for the WHOLE switch; case bodies nest', () => {
    expect(swiftCog('func f(x: Int) { switch x { case 1: a(); default: b() } }').cog).toBe(1);
    // switch(+1) + if in a case body at nesting 1(+2) = 3.
    expect(swiftCog('func f(x: Int, b: Bool) { switch x { case 1: if b { a() }; default: b() } }').cog).toBe(3);
  });

  it('each `catch` surcharges (+1); the `do` body adds nothing', () => {
    expect(swiftCog('func f() { do { try g() } catch let e { h(e) } catch { k() } }').cog).toBe(2);
  });

  it('a closure raises nesting (+0 itself) and rolls its control flow in', () => {
    // lambda nests its body (+0); the inner `if` at nesting 1 → +2.
    expect(swiftCog('func f(xs: [Int]) { xs.forEach { x in if x > 0 { g() } } }').cog).toBe(2);
  });

  it('a labeled break is +1 FLAT; a plain break and `return x` are not', () => {
    // for(+1) + for nesting1(+2) + if nesting2(+3) + labeled break(+1 flat) = 7.
    expect(
      swiftCog('func f(xs: [Int], ys: [Int]) { outer: for x in xs { for y in ys { if a { break outer } } } }').cog,
    ).toBe(7);
    // plain break adds nothing: while(+1) + if nesting1(+2) = 3.
    expect(swiftCog('func f() { while c { if a { break } } }').cog).toBe(3);
    // `return x` is ALSO a control_transfer_statement with a `result` simple_identifier,
    // but the hasLabel keyword gate (kw ∈ {break,continue}) excludes it — so a bare
    // `return v` adds NOTHING (cog 0/undefined), proving the gate, not just the result field.
    expect(swiftCog('func f(v: Int) -> Int { return v }').cog).toBeUndefined();
    // …and a labeled `continue` IS +1 flat: for(+1) + if nesting1(+2) + continue(+1) = 4.
    expect(swiftCog('func f(xs: [Int]) { outer: for x in xs { if a { continue outer } } }').cog).toBe(4);
  });

  it('a ternary surcharges (+1)', () => {
    expect(swiftCog('func f(a: Bool) -> Int { return a ? 1 : 2 }').cog).toBe(1);
  });
});
