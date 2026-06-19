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
  // CYCLOMATIC-ONLY child-skip override. When present, the cyclomatic DFS skips
  // these node types instead of `skipTypes`; the cognitive walk and root-skip
  // still use `skipTypes`. This exists because a lambda's boundary DIFFERS
  // between the two metrics for Java: sonar-java's `ComplexityVisitor`, when
  // computing a METHOD's cyclomatic number (root = the method), counts NEITHER
  // the lambda arrow NOR the lambda body — a lambda is a separate unit, excluded
  // from the enclosing method (verified against source + the oracle). But the
  // cognitive `CognitiveComplexityVisitor` DOES descend lambdas (rolling their
  // structure into the method with a nesting bump). So Java passes
  // `JAVA_SKIP_TYPES ∪ {lambda_expression}` here while leaving `skipTypes`
  // lambda-free (so cognitive descends and `resolveCalls` still attributes lambda
  // calls to the enclosing method). TS already skips arrows in `skipTypes`
  // itself (SonarJS-aligned) and Go intentionally descends closures
  // (gocyclo-aligned), so neither sets this.
  cyclomaticSkipTypes?: ReadonlySet<string>;
  // COGNITIVE complexity (proposal §1.2): when present, a second nesting-aware
  // walk runs alongside the cyclomatic one and writes `Symbol.cognitiveComplexity`.
  // Absent ⇒ cognitive stays undefined for that language (the cyclomatic-only
  // languages — Python, Go — and the not-yet-done Rust/Swift/Kotlin/Dart/C#/PHP).
  // Populated for **Java + TS/JS**. The algorithm is the SonarSource whitepaper's,
  // clean-room verified against `sonar-java`'s `CognitiveComplexityVisitor` (Java)
  // AND `eslint-plugin-sonarjs`'s S3776 (TS/JS) — the two analyzers DIVERGE, so the
  // per-language config differs: a +1 STRUCTURAL increment per break in linear
  // flow, plus a +1-per-nesting-level SURCHARGE when the flow-breaker is nested. It
  // is NOT expressible as the flat node-type sets cyclomatic uses (the if/else-if
  // chain, the catch-at-unbumped-nesting rule, boolean-run collapse, and labeled
  // jumps need structured handlers), so CognitiveOptions names each construct
  // explicitly. The three OPTIONAL fields below (`elseClauseType`, `booleanRunStarts`,
  // `excludeBooleanRun`) default to the Java/sonar-java behavior; TS sets all three
  // for SonarJS S3776 (else_clause wrapper, `&&`-runs-only, JSX exclusion). See
  // computeCognitive below + CLAUDE.md "Cognitive Complexity Rules".
  cognitive?: CognitiveOptions;
}

// Per-construct node-type config for the cognitive walk. Each field is a
// tree-sitter node TYPE name (or set of names) for one whitepaper construct
// category; the SHARED algorithm in computeCognitive is language-agnostic, only
// the names differ per grammar. Currently filled for Java only (Phase 3 slice).
export interface CognitiveOptions {
  // The `if` node + the field names used to walk its chain. `else if` is detected
  // structurally: the `alternative` field holding another `ifType` node is an
  // else-if (+1 flat, NO surcharge); any other `alternative` is a plain `else`
  // (+1 flat). There is no dedicated else node in C-family grammars.
  ifType: string;
  conditionField: string;
  consequenceField: string;
  alternativeField: string;
  // Some grammars wrap the `else`/`else if` in a dedicated node under the
  // `alternativeField` instead of holding the if/block directly (tree-sitter-
  // typescript: `alternative: else_clause → if_statement|statement_block`,
  // UNLIKE tree-sitter-java where `alternative` is the if/block itself). When
  // set, handleAlternative unwraps it (first named child = the real else-if /
  // else body) before the else-if-vs-else test; without it an `else if` would be
  // mis-read as a nested (surcharged) if. Java/Go/Py leave it unset.
  elseClauseType?: string;
  // Surcharge (+1 + nesting) AND raise the nesting level for the whole subtree.
  // Loops + switch + ternary. A `switch` is +1 for the WHOLE switch regardless
  // of case count (the cognitive/cyclomatic divergence) — its case labels add
  // nothing, so only the container type goes here.
  loopTypes: ReadonlySet<string>;
  switchTypes: ReadonlySet<string>;
  ternaryType: string;
  // The catch clause: EACH `catchType` surcharges (+1 + nesting) at its current
  // (the try's) nesting, with its body scanned one level deeper. Handled as its
  // OWN node-type case (NOT gated on recognizing the try parent), so it works
  // for every try-like container — `try_statement`, `try_with_resources_statement`,
  // etc. — which are otherwise plain pass-through (the try body, resource specs,
  // and `finally` add nothing and don't raise nesting, so no parent node needs
  // naming).
  catchType: string;
  // Raise nesting for the subtree but add NOTHING (lambdas; later: nested fns).
  // The whitepaper-derived "hybrid +1 flat" hypothesis was WRONG — sonar-java's
  // visitLambdaExpression does `nesting++; super.visit; nesting--` with no
  // increment. So a lambda is nesting-only, +0.
  nestOnlyTypes: ReadonlySet<string>;
  // break/continue that count +1 FLAT (no nesting) IFF they jump to a label.
  labeledJumpTypes: ReadonlySet<string>;
  hasLabel: (node: Node) => boolean;
  // Boolean-run collapse: returns the operator KIND ('&&'/'||', or per-language
  // equivalent) for a logical-operator node, else null. The whole boolean tree is
  // linearized IN SOURCE ORDER (sonar's flattenLogicalExpression: in-order over
  // both operands, unwrapping parens) and a +1 is charged per maximal same-kind
  // run — `a&&b&&c`=1, `a&&b||c`=2, and crucially `a&&b&&(c||d)&&(e||f)`=4 (the
  // operator sequence &&,&&,||,&&,|| has 4 runs). Only kind EQUALITY is compared.
  booleanOperatorKind: (node: Node) => string | null;
  // Decides whether a flattened boolean-run node STARTS a counted +1, given its
  // operator `kind` and the previous flattened node's `prevKind` (null at the run
  // start). DEFAULT (sonar-java / current behavior) = `prevKind === null ||
  // prevKind !== kind` — a +1 at every operator-KIND change. SonarJS S3776 is
  // different: it counts ONLY maximal runs of `&&` (`||`/`??` never count but DO
  // break `&&` runs in source order), so TS passes
  // `(kind, prev) => kind === '&&' && prev !== '&&'`. The flatten still keeps
  // ALL operators in the source-order `run` (booleanOperatorKind must be non-null
  // for them) so `||`/`??` remain run-breakers; this predicate only decides which
  // contribute. VERIFIED against SonarJS source + oracle: `a&&b&&(c||d)&&(e||f)`=2
  // (two `&&` runs split by the `||`s in source order), NOT sonar-java's 4.
  booleanRunStarts?: (kind: string, prevKind: string | null) => boolean;
  // Optional: when it returns true for a boolean-run ROOT (the topmost not-yet-
  // counted logical node, which the top-down DFS hits first), the run's source-
  // order flatten STILL runs (so the subtree enters `counted` and isn't recounted)
  // but the count loop is skipped — the whole run contributes 0. Operands are
  // still descended (to catch a nested ternary/control structure). Used by TS for
  // SonarJS's JSX short-circuit exclusion: a uniform-operator logical expression
  // whose immediate parent is a `jsx_expression` (`{cond && <X/>}`, attribute
  // values) scores 0. Java/Go/Py leave it unset.
  excludeBooleanRun?: (root: Node) => boolean;
  // The parenthesized-expression node type, unwrapped while linearizing a boolean
  // sequence so `a && (b || c)` reads the inner `||` as part of the same source-
  // order run rather than a detached one (sonar's ExpressionUtils.skipParentheses).
  parenthesizedType: string;
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
// Returns the short-circuit logical operator KIND (`&&`/`||`/`??`) of a C-family
// `binary_expression` node, else null. The single source for "read a C-family
// boolean operator token": the cyclomatic predicate below counts any of the
// three; per-language cognitive `booleanOperatorKind` readers compare the kind
// for run-collapse (and filter out `??` where the language lacks it).
export function cFamilyBooleanOperatorKind(node: Node): string | null {
  if (node.type !== 'binary_expression') return null;
  const op = node.childForFieldName('operator')?.type;
  return op !== undefined && C_BOOLEAN_OPS.has(op) ? op : null;
}
export function isCFamilyBooleanOperator(node: Node): boolean {
  return cFamilyBooleanOperatorKind(node) !== null;
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

// The cognitive walk is RECURSIVE (the if/else-if chain, try/catch, and
// boolean-run flatten are irreducibly recursive — a frame stack would need
// synthetic marker frames and be more bug-prone). The Phase-2 stack-safety
// rationale (a generated file can be pathologically deep) is preserved by this
// explicit depth guard: descent stops past MAX_COGNITIVE_DEPTH. Real source
// nests orders of magnitude below this.
const MAX_COGNITIVE_DEPTH = 2000;

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
  // Cognitive points accrue the same way (sum across bodies, omit at 0). Null
  // until a language opts in via `opts.cognitive`.
  const cognitivePoints = opts.cognitive ? new Map<string, number>() : null;
  // The cyclomatic DFS may skip a wider set than the cognitive walk (Java
  // excludes lambdas from cyclomatic but descends them for cognitive).
  const cycSkip = opts.cyclomaticSkipTypes ?? opts.skipTypes;

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
        if (!cycSkip.has(child.type)) stack.push(child);
      }
    }
    decisionPoints.set(symbolId, count);

    if (cognitivePoints) {
      const prev = cognitivePoints.get(symbolId) ?? 0;
      cognitivePoints.set(symbolId, prev + computeCognitive(body, opts.cognitive!, opts.skipTypes));
    }
  }

  for (const [id, count] of decisionPoints) {
    if (count === 0) continue; // complexity 1 → omit (kept clean in JSON)
    byId.get(id)!.complexity = Math.min(1 + count, COMPLEXITY_CAP);
  }
  if (cognitivePoints) {
    for (const [id, points] of cognitivePoints) {
      if (points === 0) continue; // cognitive 0 → omit (the receiver?-omit hygiene)
      byId.get(id)!.cognitiveComplexity = Math.min(points, COMPLEXITY_CAP);
    }
  }
}

// Computes the cognitive complexity of ONE body subtree (whitepaper §1.2,
// clean-room verified against sonar-java's CognitiveComplexityVisitor). Returns
// the increment total (0 when trivial). Reuses the SAME skipTypes boundary as
// the cyclomatic walk so "this symbol's body" means the same thing for both
// metrics — methods containing anon/local classes therefore UNDER-COUNT vs
// sonar-java (which rolls those bodies into the enclosing method); a deliberate
// per-symbol-model divergence, like the TS/Py arrow-callback gap.
//
// Nesting starts at 0; a SURCHARGE node adds `1 + nesting` (the whitepaper
// "+1 plus one per level of nesting"; sonar-java's base-1 + `+= nesting` is
// algebraically identical). Booleans, labeled jumps, and `else`/`else if` are
// FLAT (+1, no surcharge). Lambdas raise nesting but add nothing.
// Unwraps nested parenthesized expressions to the inner expression (sonar's
// ExpressionUtils.skipParentheses), used while linearizing a boolean sequence.
function skipParens(node: Node | null, parenthesizedType: string): Node | null {
  let n = node;
  while (n && n.type === parenthesizedType) n = n.namedChild(0);
  return n;
}

// First named child that is not a comment. tree-sitter attaches comments as
// NAMED children ("extras"), so positional access (namedChild(0)) can land on a
// comment instead of the real node — e.g. the body of `else /*c*/ {…}`. Every
// grammar wired so far names this node type `comment`.
function firstNonComment(node: Node): Node | null {
  let child = node.namedChild(0);
  while (child && child.type === 'comment') child = child.nextNamedSibling;
  return child;
}

function computeCognitive(
  body: Node,
  cog: CognitiveOptions,
  skipTypes: ReadonlySet<string>,
): number {
  let total = 0;
  // node.id of every logical-operator node already counted as part of a boolean
  // run, so the DFS doesn't recount them when it later descends the left spine.
  // Keyed on node.id (stable across web-tree-sitter wrapper objects); MUST be
  // call-local (per body) — hoisting it would undercount across symbols.
  const counted = new Set<number>();
  // Per-language run-start rule; default = +1 at every operator-KIND change
  // (sonar-java). TS overrides to count only `&&`-run-starts (SonarJS S3776).
  const runStarts =
    cog.booleanRunStarts ?? ((kind: string, prev: string | null) => prev === null || prev !== kind);

  const visitField = (node: Node, field: string, nesting: number, depth: number): void => {
    const child = node.childForFieldName(field);
    if (child) visit(child, nesting, depth + 1);
  };

  // Walks an `if`'s else/else-if chain. The head `if` is handled by the caller
  // (it surcharges); each link here is +1 FLAT. An `else if` (alternative is
  // another `if`) keeps the chain's base nesting for its own condition and
  // surcharge-free body; a plain `else` scans its body one level deeper.
  const handleAlternative = (ifNode: Node, nesting: number, depth: number): void => {
    // Bound the else-if chain recursion by the same depth guard as `visit` — a
    // pathologically long `if/else if/else if/…` chain would otherwise blow the
    // native stack despite MAX_COGNITIVE_DEPTH (the chain recurses here, not
    // through `visit`).
    if (depth > MAX_COGNITIVE_DEPTH) return;
    const rawAlt = ifNode.childForFieldName(cog.alternativeField);
    if (!rawAlt) return;
    // Unwrap an else-wrapper node (TS `else_clause`) to the real else-if / else
    // body; grammars that hold the if/block directly (Java) leave elseClauseType
    // unset and use rawAlt as-is. SKIP a leading comment: tree-sitter attaches a
    // comment sitting between `else` and the body as a NAMED child of the wrapper
    // (`else /*c*/ {…}`), so a bare namedChild(0) would grab the comment and drop
    // the entire else body's complexity.
    const alt =
      cog.elseClauseType && rawAlt.type === cog.elseClauseType
        ? firstNonComment(rawAlt)
        : rawAlt;
    if (!alt) return;
    total += 1; // the `else` / `else if` keyword: +1 flat, no surcharge
    if (alt.type === cog.ifType) {
      visitField(alt, cog.conditionField, nesting, depth);
      visitField(alt, cog.consequenceField, nesting + 1, depth);
      handleAlternative(alt, nesting, depth + 1);
    } else {
      visit(alt, nesting + 1, depth + 1);
    }
  };

  function visit(node: Node, nesting: number, depth: number): void {
    if (depth > MAX_COGNITIVE_DEPTH) return;
    const t = node.type;
    if (skipTypes.has(t)) return; // nested classes / methods: own symbols' bodies

    // --- if / else-if / else chain (head if surcharges; chain links are flat) ---
    if (t === cog.ifType) {
      total += 1 + nesting;
      visitField(node, cog.conditionField, nesting, depth);
      visitField(node, cog.consequenceField, nesting + 1, depth);
      handleAlternative(node, nesting, depth);
      return;
    }

    // --- loops / switch / ternary: surcharge, then ALL children one level deeper ---
    // KNOWN DIVERGENCE (shared by Java + TS, pre-dates this slice, accepted): sonar
    // nests ONLY the body/consequent/alternate, NOT the loop header / switch
    // discriminant / ternary TEST, whereas this bumps every child. So a nested
    // STRUCTURAL construct in those positions (`switch(a?b:c)`, `(a?b:c)?d:e`,
    // `for(;cond?a:b;)`) over-counts by the bump. Booleans are flat (unaffected),
    // and these positions rarely hold control flow — 0 cases in the 800-fn TS oracle
    // (ky/zod/recharts/express) or gson. A precise fix needs per-construct body
    // fields + re-oracling Java; deferred to a dedicated engine pass.
    if (cog.loopTypes.has(t) || cog.switchTypes.has(t) || t === cog.ternaryType) {
      total += 1 + nesting;
      for (const child of node.namedChildren) visit(child, nesting + 1, depth + 1);
      return;
    }

    // --- catch clause: surcharge at the current (try's) nesting, body one level
    // deeper. Handled as its own case rather than nested inside a try-node
    // branch, so it fires for ANY try container — `try_statement` AND
    // `try_with_resources_statement` — which are themselves plain pass-through
    // (the try body / resource spec / `finally` add nothing and don't bump). ---
    if (t === cog.catchType) {
      total += 1 + nesting;
      for (const child of node.namedChildren) visit(child, nesting + 1, depth + 1);
      return;
    }

    // --- nesting-only (lambda): raise nesting, add nothing ---
    if (cog.nestOnlyTypes.has(t)) {
      for (const child of node.namedChildren) visit(child, nesting + 1, depth + 1);
      return;
    }

    // --- labeled break/continue: +1 flat (the only break/continue that counts) ---
    if (cog.labeledJumpTypes.has(t)) {
      if (cog.hasLabel(node)) total += 1;
      return; // the only named child is the label identifier — nothing to descend
    }

    // --- boolean runs: +1 per maximal same-kind sequence in SOURCE order ---
    if (cog.booleanOperatorKind(node) !== null) {
      if (!counted.has(node.id)) {
        // Linearize the whole boolean tree IN SOURCE ORDER (sonar's
        // flattenLogicalExpression): in-order over BOTH operands, unwrapping
        // parens, so `a && b && (c||d)` → [&&, &&, ||]. A +1 is charged at the
        // start and at each operator-kind change. (A left-spine-only flatten
        // would wrongly merge &&s split by a parenthesized || — oracle-caught.)
        const run: Node[] = [];
        // `d` carries the visit depth so a pathologically long boolean spine
        // (`a && a && … `, tens of thousands of operands in generated code)
        // can't overflow the native stack — bounded by the same guard as `visit`.
        const flatten = (n: Node | null, d: number): void => {
          if (d > MAX_COGNITIVE_DEPTH) return;
          const inner = skipParens(n, cog.parenthesizedType);
          if (inner && cog.booleanOperatorKind(inner) !== null) {
            counted.add(inner.id);
            // Operands via the `left`/`right` FIELDS, not positional
            // namedChild(0)/(1): a comment interleaved around the operator
            // (`a && /*c*/ b`) is a named child, so positional access would
            // read the comment as the right operand and drop a parenthesized
            // sub-run. Every logical node in the cognitive grammars (Java/TS
            // `binary_expression`) exposes `left`/`right`.
            flatten(inner.childForFieldName('left'), d + 1);
            run.push(inner);
            flatten(inner.childForFieldName('right'), d + 1);
          }
        };
        flatten(node, depth); // marks the whole subtree `counted`
        // A run whose ROOT is excluded (TS JSX short-circuit) contributes 0 —
        // but the flatten above still ran, so its inner logical nodes won't be
        // recounted when the DFS descends below.
        if (!cog.excludeBooleanRun?.(node)) {
          let prevKind: string | null = null;
          for (const n of run) {
            const kind = cog.booleanOperatorKind(n)!; // non-null: it's in `run`
            if (runStarts(kind, prevKind)) total += 1;
            prevKind = kind;
          }
        }
      }
      // Descend operands at the SAME nesting (booleans are flat). The flattened
      // logical nodes are in `counted` so they skip the run-count but are still
      // descended (to catch a nested ternary / control structure in an operand).
      for (const child of node.namedChildren) visit(child, nesting, depth + 1);
      return;
    }

    // --- default: pass through, nesting unchanged ---
    for (const child of node.namedChildren) visit(child, nesting, depth + 1);
  }

  visit(body, 0, 0);
  return total;
}
