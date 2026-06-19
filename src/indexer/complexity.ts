import type { Node } from 'web-tree-sitter';

import type { Symbol } from '../types.js';
import type { PendingBody } from './extractor.js';

// Per-symbol CYCLOMATIC complexity, computed at extract time. The shape mirrors
// `ResolveCallsOptions`/`resolveCalls` (extractor.ts): a shared engine driven by
// per-language node-type sets, invoked at the same call site as `resolveCalls`
// while the tree is still alive. `complexity = 1 + decision points`, where each
// `if` / loop / non-default `case` / ternary / short-circuit boolean operator
// adds 1, and `else`/`default`/`finally`/the `switch` container add nothing. The
// EXACT increment set per language is verified against the real analyzers and
// lives in the `*_DECISION_NODE_TYPES` consts (the authoritative source — read
// those, not this summary): TS/JS is SonarJS-exact (`&&`/`||`/`??`, and NOTABLY
// NOT `throw`/`catch`/`&&=`/`||=`/`??=`); Python (radon-style) adds `and`/`or`/
// `elif`/`except`/comprehension-`if`/`case`; Go (gocyclo-style) adds `&&`/`||`
// and all three switch forms' cases. See each language file's comment + CLAUDE.md
// "Cyclomatic Complexity Rules" for the per-analyzer divergences.
export interface ComplexityOptions {
  // Each node whose type is in this set adds +1 (one per `case` label, etc.).
  // The `switch`/`select` CONTAINER and `default`/`else`/`finally` are
  // deliberately absent.
  decisionNodeTypes: ReadonlySet<string>;
  // The C-family boolean-operator trap (proposal §6 #2): TS and Go use ONE
  // `binary_expression` node for ALL binary ops, so a flat node-type set would
  // miscount `a + b` / `a == b`. This predicate reads the operator TOKEN
  // (`childForFieldName('operator')?.type`) and returns true for the
  // short-circuit logical operators — `&&`/`||`/`??` (SonarJS counts `??`; Go
  // simply never has it). See isCFamilyBooleanOperator below. Python is clean (a
  // distinct `boolean_operator` node folded straight into `decisionNodeTypes`),
  // so it omits this.
  isBooleanOperator?: (node: Node) => boolean;
  // Children of these types are NOT descended — pass the language's MAIN call
  // walk skip set (TS_SKIP_TYPES / PY_SKIP_TYPES / GO_SKIP_TYPES), so the number
  // tracks "this symbol's body" along the same boundary the resolved call graph
  // uses. That set also skips nested classes, so a nested class's static-block /
  // field-initializer branches don't leak into the enclosing function. (Go's
  // main set keeps `func_literal` descendable — a closure's branches count
  // toward the enclosing func, matching gocyclo; TS arrows / Py lambdas ARE in
  // their main set, so each is its own scope, matching SonarJS/ESLint.)
  // NOTE the boundary is not byte-identical to fan-out for a curried arrow-const
  // whose body field IS itself a skip-typed `arrow_function`: `walkCalls`
  // skip-tests only CHILDREN, so it attributes the inner arrow's CALLS to the
  // symbol, whereas computeComplexity's root-skip (below) drops that inner
  // region entirely. A deliberate, SonarJS-faithful choice (curried inner = its
  // own scope) at the cost of fan-out/complexity diverging on that one idiom.
  skipTypes: ReadonlySet<string>;
}

// Shared C-family boolean-operator reader (TS/JS + Go). One `binary_expression`
// node covers ALL binary operators, so read the operator TOKEN and count only
// the short-circuiting logical operators — the C-family boolean trap (`a + b`/
// `a == b` must NOT increment). VERIFIED against SonarJS source (S1541): its
// cyclomatic counts `&&`, `||`, AND `??` (all three are one ESTree
// LogicalExpression with no operator filter); it does NOT count the
// logical-ASSIGNMENT forms `&&=`/`||=`/`??=` (those are an AssignmentExpression,
// absent from the cyclomatic switch). tree-sitter groups `??` as a
// `binary_expression` (op token `??`), so reading the token catches it. Go has
// no `??` nor logical-assignment, so the `??` entry is simply never hit there
// (sonar-go counts `&&`/`||` only); Python uses a distinct `boolean_operator`
// node and does not pass this predicate.
const C_BOOLEAN_OPS: ReadonlySet<string> = new Set(['&&', '||', '??']);
export function isCFamilyBooleanOperator(node: Node): boolean {
  if (node.type !== 'binary_expression') return false;
  const op = node.childForFieldName('operator')?.type;
  return op !== undefined && C_BOOLEAN_OPS.has(op);
}

// Only function/method symbols carry a cyclomatic number. The gate excludes the
// class-body PendingBody that TS/Python push for call resolution (its symbolId
// is the CLASS symbol — counting it would fold member control flow into a
// phantom). Bodiless symbols (interface methods, declarations) never reach here.
const COMPLEXITY_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

// A guard against generated/minified files: a parser table can have cyclomatic
// in the thousands and would otherwise dominate tool output and the (future)
// risk ranking on code agents never touch.
const COMPLEXITY_CAP = 999;

// Walks each function/method PendingBody and writes `symbol.complexity` onto the
// live Symbol instances (omitting the trivial value 1, the `receiver?`-omit
// hygiene). Mutates `symbols` in place; returns nothing. MUST run in the
// live-tree window (before pipeline.ts deletes the tree), at the per-language
// `resolveCalls` call site.
export function computeComplexity(
  bodies: PendingBody[],
  symbols: Symbol[],
  opts: ComplexityOptions,
): void {
  const byId = new Map(symbols.map((s) => [s.id, s]));
  // Decision points accrue per symbolId so multiple bodies sharing an id
  // accumulate (matters for Kotlin/C# later; a no-op for the MVP three, where
  // each function/method has exactly one body). complexity = 1 + decisionPoints.
  const decisionPoints = new Map<string, number>();

  for (const { symbolId, body } of bodies) {
    const sym = byId.get(symbolId);
    if (!sym || !COMPLEXITY_KINDS.has(sym.kind)) continue;
    // If the body node is ITSELF a skip type — a curried/function-returning arrow
    // whose `body` field is the inner `arrow_function` (`const g = (x) => (y) =>
    // {…}`) — treat it as a separate scope and don't descend. The child loop
    // below only skip-tests CHILDREN, so without this guard the root would bypass
    // the skip check and leak the inner arrow's branches into this symbol.
    if (opts.skipTypes.has(body.type)) continue;

    let count = decisionPoints.get(symbolId) ?? 0;
    // Iterative DFS (not recursion): `walkCalls` recurses unbounded, and a
    // deeply-nested generated file could blow the stack. The skip test applies
    // to CHILDREN (the root is handled by the guard above), mirroring walkCalls.
    const stack: Node[] = [body];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (opts.decisionNodeTypes.has(node.type)) count++;
      else if (opts.isBooleanOperator?.(node)) count++;
      for (const child of node.namedChildren) {
        if (!opts.skipTypes.has(child.type)) stack.push(child);
      }
    }
    decisionPoints.set(symbolId, count);
  }

  for (const [id, count] of decisionPoints) {
    if (count === 0) continue; // complexity 1 → omit (kept clean in JSON)
    byId.get(id)!.complexity = Math.min(1 + count, COMPLEXITY_CAP);
  }
}
