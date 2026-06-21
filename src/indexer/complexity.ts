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
  // An EXTRA per-node +1 cyclomatic-decision predicate (beyond `decisionNodeTypes`):
  // any node it returns true for adds +1. It exists for "extra decisions" a flat
  // node-type set can't express, and is reused by THREE kinds of consumer:
  //  - the C-family boolean trap (TS/Go): ONE `binary_expression` node covers ALL
  //    binary ops, so a flat set would miscount `a + b` / `a == b`; the predicate
  //    reads the operator TOKEN (`childForFieldName('operator')?.type`) and returns
  //    true only for the short-circuit logical operators `&&`/`||`/`??` (SonarJS
  //    counts `??`; Go never has it). See isCFamilyBooleanOperator below.
  //  - Java (`javaCyclomaticExtra`): a non-default `switch_label` OR a boolean.
  //  - Rust (`rustCyclomaticExtra`): a match-arm GUARD (a `match_pattern` with a
  //    `condition` field) OR a boolean.
  // Python omits it — its `boolean_operator` is a distinct node folded straight into
  // `decisionNodeTypes`. (Formerly named `isBooleanOperator`; renamed once a 2nd
  // non-boolean consumer (Rust guards, after Java switch-labels) made the old name
  // a misnomer.)
  extraDecisionPredicate?: (node: Node) => boolean;
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
  // Optional per-node −1 cyclomatic adjustment. A node it returns true for
  // SUBTRACTS 1 from the count (the only decrement path). It exists for
  // SwiftLint's `fallthrough` rule: each `fallthrough` does `complexity -= 1`,
  // cancelling the +1 of the `case` it falls through from (the two cases form one
  // path). Swift sets it to a `simple_identifier` whose text is `fallthrough` (a
  // reserved keyword, so it can't be a real identifier). The running count is
  // floored at 0 before `1 + count`, so a stray decrement (a `fallthrough` in a
  // broken parse) can't drive complexity below 1. The 6 other languages leave it
  // unset (their count never decrements).
  cyclomaticDecrement?: (node: Node) => boolean;
  // COGNITIVE complexity (proposal §1.2): when present, a second nesting-aware
  // walk runs alongside the cyclomatic one and writes `Symbol.cognitiveComplexity`.
  // Absent ⇒ cognitive stays undefined for that language (none remain — all wired).
  // Populated for ALL 11: **Java + TS/JS + Go + Python + Rust + Swift + Kotlin + Dart + C# + PHP**. The algorithm is the
  // SonarSource whitepaper's, clean-room verified against `sonar-java`'s
  // `CognitiveComplexityVisitor` (Java), `eslint-plugin-sonarjs`'s S3776 (TS/JS),
  // `uudashr/gocognit` (Go), AND `sonar-python`'s `CognitiveComplexityVisitor`
  // (Python) — the analyzers DIVERGE, so the per-language config differs (Swift has NO
  // open cognitive analyzer to oracle against, so it is hand-pinned to the
  // whitepaper). The algorithm: a +1
  // STRUCTURAL increment per break in linear flow, plus a +1-per-nesting-level
  // SURCHARGE when the flow-breaker is nested. It is NOT expressible as the flat
  // node-type sets cyclomatic uses (the if/else-if chain, the catch-at-unbumped-
  // nesting rule, boolean-run collapse, and labeled jumps need structured handlers),
  // so CognitiveOptions names each construct explicitly. The OPTIONAL fields below
  // (`elseClauseType`, `elifClauseType`, `initField`, `nestElseBody`, `loopBodyField`,
  // `booleanRunStarts`, `excludeBooleanRun`, `recursion`, `flatIncrement`) default to
  // the Java/sonar-java behavior; TS sets `elseClauseType`/`booleanRunStarts`/
  // `excludeBooleanRun` (SonarJS S3776), Go sets `initField`/`nestElseBody`/`recursion`
  // + sentinel `parenthesizedType` (gocognit), Python sets `elifClauseType`/
  // `loopBodyField` + sentinel `parenthesizedType` (sonar-python), Rust sets
  // `elseClauseType` (the TS unwrap) + `flatIncrement` (let-else) and unwraps
  // `parenthesized_expression` (whitepaper/sonar-rust), Swift sets `ifPositionalBlockType`
  // (its `if` has no consequence/alternative field) + `booleanLeftField`/`booleanRightField`
  // (`lhs`/`rhs` on its distinct conjunction/disjunction nodes) + `flatIncrement` (guard) +
  // a sentinel `parenthesizedType` (no-unwrap), and Kotlin sets `ifConsequenceFromNamedChildren`
  // + `elseKeywordType` + `elseChargeBlockType` (anonymous-else / brace-less positional if with
  // the sonar-kotlin else-body ternary gate) + a sentinel `parenthesizedType` (no-unwrap) and
  // puts `do_while_statement` in `nestOnlyTypes` (sonar-kotlin omits the do-while increment).
  // See computeCognitive below + CLAUDE.md "Cognitive Complexity Rules".
  cognitive?: CognitiveOptions;
}

// Per-construct node-type config for the cognitive walk. Each field is a
// tree-sitter node TYPE name (or set of names) for one whitepaper construct
// category; the SHARED algorithm in computeCognitive is language-agnostic, only
// the names differ per grammar. Filled for all 14 languages (Java, TS/JS, Go, Python,
// Rust, Swift, Kotlin, Dart, C#, PHP, Ruby, C++, C, Objective-C).
export interface CognitiveOptions {
  // The `if` node + the field names used to walk its chain. `else if` is detected
  // structurally: the `alternative` field holding another `ifType` node is an
  // else-if (+1 flat, NO surcharge); any other `alternative` is a plain `else`
  // (+1 flat). There is no dedicated else node in C-family grammars.
  ifType: string;
  conditionField: string;
  consequenceField: string;
  alternativeField: string;
  // A SECOND node type treated identically to `ifType` (Dart's collection-`if`
  // `if_element`, which lives inside list/set/map literals). It surcharges as the
  // head if, charges its `else`/`else if` +1 flat, and nests — measured EXACT vs
  // the SonarQube Dart model (`[if(b) 1 else 2]` = cog 2, not 1; a bare `switchTypes` mapping
  // would drop the else). Routed through the same if-branch + handleAlternative
  // else-if test. Only Dart sets it; the engine's single `ifType` is unchanged.
  collectionIfType?: string;
  // Some grammars give the `if` NO condition field — the condition (and Dart-3
  // `case`/pattern/`when`-guard) are POSITIONAL children (Dart's `if_statement`).
  // When set, the if-case (and handleAlternative's else-if) walk every named child
  // that is NOT the consequence/alternative field-child (and not a comment) at base
  // nesting, so the condition's booleans/pattern guards count. `conditionField`/
  // `initField` are then unused. Dart's collection `if_element` ALSO routes through
  // this (it HAS a `condition` field, but that field-child is simply the lone
  // non-consequence/alternative named child, so the same walk reaches it). Other
  // languages expose a condition field and leave this unset (field-based path).
  conditionFromNamedChildren?: boolean;
  // Some grammars wrap the `else`/`else if` in a dedicated node under the
  // `alternativeField` instead of holding the if/block directly (tree-sitter-
  // typescript: `alternative: else_clause → if_statement|statement_block`,
  // UNLIKE tree-sitter-java where `alternative` is the if/block itself). When
  // set, handleAlternative unwraps it (first named child = the real else-if /
  // else body) before the else-if-vs-else test; without it an `else if` would be
  // mis-read as a nested (surcharged) if. Java/Go leave it unset. Python sets it
  // too — but used differently (see elifClauseType): it identifies the terminal
  // `else_clause` both inside the multi-alternative chain AND as a for/while/try
  // `else` reached via general descent (the else_clause dispatch in visit).
  elseClauseType?: string;
  // Python's `if_statement` holds a flat LIST of `elif_clause`/`else_clause`
  // SIBLINGS under a REPEATED `alternative` field — NOT a nested-if chain (Java),
  // NOR a single `else_clause` wrapper (TS). When set, handleAlternative iterates
  // `childrenForFieldName(alternativeField)`, charging +1 FLAT per `elifClauseType`
  // (its `conditionField` at base nesting for booleans, `consequenceField` body at
  // nesting+1) and +1 FLAT per `elseClauseType` (body at nesting+1). It ALSO gates
  // the for/while/try `else_clause` dispatch in visit (a loop/try `else` reached via
  // general descent — the `if`'s own else is consumed here and the if-case returns).
  // Java/TS/Go leave it unset (the single-child C-family recursion). Python: 'elif_clause'.
  elifClauseType?: string;
  // PHP only (used with elifClauseType): a two-word `else if` is NOT a one-word
  // `else_if_clause` — the grammar nests it as an `elseClauseType` whose
  // `consequenceField` child is itself an `ifType`. SonarPHP flattens that inner `if`
  // (treats it like an else-if: +1 FLAT, and the `else` keyword adds NOTHING) BUT
  // visits it INSIDE the else clause's own nesting bump, so the inner if's body lands
  // one level DEEPER than a one-word elseif would (oracle-verified: `else if`-nested
  // cog 5 vs `elseif`-nested cog 4). When set, handleAlternative's else-clause case
  // detects this shape and recurses the inner if FLAT at nesting+1. Other languages
  // leave it unset; Python's else_clause body is never an `ifType` (it uses elif), so
  // it always falls through to visitElseClauseBody.
  elseChainsIf?: boolean;
  // POSITIONAL `if` shape (Swift): the grammar's `if_statement` has NO
  // consequence/alternative field — the consequence is a positional block child of
  // this type, an `else if` is a sibling `ifType` child, and a plain `else` body is a
  // block child of this type AFTER the `else` keyword (see elseKeywordType). When set,
  // the if-case routes to a positional handler: surcharge the head if, visit ALL
  // `childrenForFieldName(conditionField)` (plural — Swift allows `if a, let b = c`)
  // at base nesting, visit the consequence block (before `else`) at nesting+1, then the
  // flat else/else-if chain (each +1, no surcharge; bodies nest).
  // `consequenceField`/`alternativeField` are unused in this mode. The other languages
  // leave it unset (field-based if). Swift: 'statements'.
  ifPositionalBlockType?: string;
  // The `else` KEYWORD node type for the positional-if handler (Swift: 'else', a
  // NAMED token). It is the ONLY reliable signal that an else clause EXISTS: an empty
  // `{}` block emits NO `ifPositionalBlockType` node, so inferring the else from a
  // second block child silently drops the `+1 FLAT` whenever the consequence OR the
  // else body is empty (`if c {} else {x}`, `if c {x} else {}`). The handler splits the
  // namedChildren at this keyword: the consequence is the block child BEFORE it, the
  // else branch (an `ifType` else-if, or a block else body that MAY be absent) is
  // AFTER it. Required alongside ifPositionalBlockType. Other languages leave it unset.
  elseKeywordType?: string;
  // POSITIONAL `if` variant for grammars whose `else` is ANONYMOUS and whose branches
  // may be BRACE-LESS (Kotlin: `if(a) g() else h()` — the consequence is a bare
  // `call_expression`, not a block, and the `else` token is absent from namedChildren,
  // so neither the elseKeywordType split nor the ifPositionalBlockType filter works).
  // When set, visitPositionalIfBody finds the consequence as the FIRST named child that
  // is neither a `conditionField` child nor a comment, and the else/else-if body as the
  // SECOND such child (a nested `ifType` = else-if, else a plain-else body that nests).
  // This is sound for Kotlin because EVERY branch emits a node (an empty `{}` IS a
  // `block`, UNLIKE Swift where it vanishes) — so positional detection never drops a
  // branch. Routes into the positional handler alongside ifPositionalBlockType. Swift
  // leaves it unset and keeps the keyword-split path. Kotlin: true.
  ifConsequenceFromNamedChildren?: boolean;
  // For the ifConsequenceFromNamedChildren path: the block node type whose presence as the
  // ELSE BODY (alongside an else-if `ifType`) charges the else +1. sonar-kotlin's
  // handleIfExpression charges the else keyword ONLY when the else body is a KtBlockExpression
  // or a KtIfExpression — a BRACE-LESS `else expr` is the ternary form and is NOT charged. Set
  // to the grammar's block node ('block' for Kotlin); the else body is descended/nested either
  // way. The sole consumer of ifConsequenceFromNamedChildren (Kotlin) sets it, so it is
  // effectively required on that path (unset ⇒ only an else-if would charge). Others unset.
  elseChargeBlockType?: string;
  // Some grammars put an INITIALIZER statement on the `if` (C-family `if (init;
  // cond)` — Go's `if x := f(); cond {}`). When set, the if-case AND the else-if
  // branch of handleAlternative visit this field at the if's BASE nesting (the
  // init runs before the then-body's nesting bump — gocognit walks it there).
  // Without it the init subtree is never walked, undercounting any decision
  // point it hosts — notably Go's `if err := recurse(); err != nil` idiom, where
  // the recursive call lives in the init. Java/TS have no if-init field → unset.
  initField?: string;
  // Whether a plain (terminal) `else { … }` block raises the nesting level for
  // its body. DEFAULT true (sonar-java / the original behavior: the else body is
  // at nesting+1). gocognit does NOT nest the else body — it `decNesting`s after
  // the then-body and walks `n.Else` at the if's BASE nesting — so Go sets this
  // false (else body at `nesting`). MUST be read as `=== false`, not truthiness:
  // an unset value is falsy and would wrongly switch Java/TS to base-nesting.
  // Only the TERMINAL plain `else` differs; `else if` bodies are nesting+1 in
  // both conventions (handled by the chain recursion, unaffected by this flag).
  nestElseBody?: boolean;
  // Surcharge (+1 + nesting) AND raise the nesting level for the whole subtree.
  // Loops + switch + ternary. A `switch` is +1 for the WHOLE switch regardless
  // of case count (the cognitive/cyclomatic divergence) — its case labels add
  // nothing, so only the container type goes here.
  loopTypes: ReadonlySet<string>;
  // When set, a loop surcharges and nests ONLY this field's child (the body),
  // visiting all OTHER children (iterable/condition/target, and a for/while-`else`)
  // at the loop's AMBIENT nesting — matching sonar-python, which nests only the loop
  // body StatementList. This RESOLVES the loop-header overbump (a nested structural
  // construct in a loop header — e.g. a ternary in a `for` iterable — would otherwise
  // be over-surcharged by the bump-all-children default) for the language that sets
  // it. Unset (Java/TS/Go) keeps the bump-ALL-children behavior (the documented
  // COG-loopheader-overbump, deferred for those grammars). Python: 'body' (both
  // `for_statement` and `while_statement` use the `body` field). switch/ternary are
  // unaffected — sonar-python nests the WHOLE ternary subtree, so they keep bump-all.
  loopBodyField?: string;
  switchTypes: ReadonlySet<string>;
  ternaryType: string;
  // When set, a `ternaryType` node surcharges and nests ONLY these field children (the
  // true/false branches), visiting all OTHER children (the CONDITION) at the ternary's
  // AMBIENT nesting — the loopBodyField analog for ternaries. This RESOLVES the
  // ternary-condition overbump for a CHAINED elvis `a ?: b ?: c` (`((a ?: b) ?: c)`),
  // where each inner conditional sits in the next one's CONDITION position and would
  // otherwise be over-surcharged by the bump-all default (compounding per link). Only
  // PHP sets it (chained `?:` is idiomatic there, so the overbump is material — 5 real
  // Laravel cases; SonarPHP visits the condition at ambient nesting); switch is
  // unaffected (it's in switchTypes, the bump-all branch). Java/TS/Go/Dart leave it
  // unset → bump-ALL (the documented COG-loopheader-overbump, deferred for them — 0
  // oracle cases because their ternaries rarely chain in the condition).
  ternaryBranchFields?: ReadonlyArray<string>;
  // Extra node types that surcharge (+1 + nesting) but descend their children at the
  // SAME nesting — a flow-breaker with the full nesting surcharge that does NOT nest
  // its operand. C#'s `goto`/`goto case`: SonarC# scores it at +1+nesting (a `goto`
  // 3 levels deep adds 4), unlike a labeled jump's flat +1; and a structural construct
  // in its case-label expression (`goto case (p ? 1 : 2)`) is counted at the goto's
  // OWN nesting, NOT one level deeper — so this routes through a DEDICATED branch
  // (surcharge, descend children flat), distinct from the switch/ternary branch which
  // nests its children. Only C# sets it (Java/TS/Go/… have no goto-like surcharged jump).
  surchargeTypes?: ReadonlySet<string>;
  // The catch clause: EACH `catchType` surcharges (+1 + nesting) at its current
  // (the try's) nesting, with its body scanned one level deeper. Handled as its
  // OWN node-type case (NOT gated on recognizing the try parent), so it works
  // for every try-like container — `try_statement`, `try_with_resources_statement`,
  // etc. — which are otherwise plain pass-through (the try body, resource specs,
  // and `finally` add nothing and don't raise nesting, so no parent node needs
  // naming).
  catchType: string;
  // A try container whose catch BODIES are SIBLINGS of the catch clause rather
  // than children of it (Dart: `try_statement` holds `body:` block, then flat
  // `on`/type/`catch_clause` headers each FOLLOWED BY a sibling `block`, then a
  // `finally_clause`). The generic `catchType` branch can't nest such a body, so a
  // dedicated handler surcharges (+1 + nesting) once per catch-body block and nests
  // it at +1, while the try body, on-type/catch headers, and finally stay at base
  // nesting. The try body is found by `bodyField`; every OTHER direct child of
  // `catchBodyType` is a catch body — which also covers a binding-less `on E {}`
  // (a block with no `catch_clause`). Only Dart sets it; others leave it unset and
  // keep the `catchType` branch (their catch clause CONTAINS its body).
  tryType?: { node: string; bodyField: string; catchBodyType: string };
  // Raise nesting for the subtree but add NOTHING (lambdas; Go's func_literal;
  // Python's match_statement — 0 structural with its case bodies nested; later:
  // nested fns). The whitepaper-derived "hybrid +1 flat" hypothesis was WRONG —
  // sonar-java's visitLambdaExpression does `nesting++; super.visit; nesting--` with no
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
  // The FIELD names of a logical node's two operands, read while linearizing a
  // boolean run. DEFAULT `'left'`/`'right'` (Java/TS/Go `binary_expression` and
  // Python `boolean_operator` all use those). Swift's `conjunction_expression`/
  // `disjunction_expression` use `'lhs'`/`'rhs'`, so it sets these — without them
  // the run-collapse reads null operands and mis-counts (`a && b && c` would not
  // collapse to one run). Read by FIELD (not positionally) so an interleaved
  // comment can't shift the operands.
  booleanLeftField?: string;
  booleanRightField?: string;
  // TREE-SCOPED boolean counting (the SonarQube Dart model) instead of the source-order flatten.
  // A logical node adds +1 iff its operator KIND differs from its nearest LOGICAL
  // ANCESTOR's kind (skipping `parenthesizedType` wrappers) — i.e. a top-of-tree
  // logical node, or one whose enclosing logical operator is the other kind, starts
  // a run. This is a THIRD distinct boolean algorithm: `a&&b&&(c||d)&&(e||f)` is 4 in
  // sonar-java (source-order), 2 in SonarJS (`&&`-runs only), and 3 in the SonarQube Dart model
  // (tree-scoped) — and parenthesized vs precedence-grouped operands count
  // identically (`(a&&b)||(c&&d)||(e&&g)` = `a&&b||c&&d||e&&g` = 4). When set, the
  // boolean branch skips the flatten entirely and processes each logical node as the
  // DFS reaches it (operands descend via namedChildren), so booleanRunStarts /
  // excludeBooleanRun / the operand fields are unused. Only Dart sets it.
  booleanByTreeParent?: boolean;
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
  // The parenthesis-like wrapper(s) treated as transparent while linearizing a
  // boolean sequence, so `a && (b || c)` reads the inner `||` as part of the same
  // source-order run rather than a detached one (sonar's ExpressionUtils.skip-
  // Parentheses). Usually a single node type; Go sets a NEVER-MATCHING sentinel so
  // skipParens is a no-op (gocognit's `collectBinaryOps` stops at a parenthesized
  // expression rather than unwrapping it, so `(a&&b)&&c` = 2, not 1). A grammar with
  // MORE THAN ONE wrapper passes a SET (matched by membership): C# needs both
  // `parenthesized_expression` (`(c||d)`) AND `parenthesized_pattern` (`(int and >0)`)
  // transparent, so a same-kind pattern combinator grouped by parens stays ONE run
  // (`is (A and B) and C` = cog 2, not 3) — a single string would skip only the
  // expression paren and over-count the pattern one.
  parenthesizedType: string | ReadonlySet<string>;
  // Direct-recursion increment (whitepaper's recursion rule; gocognit implements
  // it, sonar-java/SonarJS do not). When set AND `eligibleKinds` contains the
  // enclosing symbol's kind, a node of type `callType` whose `bareCalleeName`
  // equals the symbol's own name adds +1 FLAT, PER call-site (no surcharge, no
  // return — the call's arguments still descend). gocognit keys on a bare-
  // identifier callee matching the enclosing FuncDecl name, so member self-calls
  // (`s.m()`, a selector) never match and methods are excluded via eligibleKinds.
  // Java/TS leave it unset (their analyzers omit recursion → matches the oracle).
  // ACCEPTED DIVERGENCE (Go): gocognit also checks the callee's resolved OBJECT
  // identity (`obj == fn.Name.Obj`), so a LOCAL that shadows the function name
  // (`func f(g func()){ f := g; f() }`) is not recursion there but is +1 here.
  // bareCalleeName is name-only (no resolver at extract time), the same accepted
  // class as Go self-call receiver shadowing — rare, 0 cases in the oracle corpus.
  // A language supplies EITHER `bareCalleeName` (name-only, Go) OR `isSelfCall`
  // (a full predicate, C#): SonarC# counts a self-call only when the callee NAME
  // AND the ARGUMENT COUNT match the enclosing method (a `Foo(2 args)` call inside
  // `Foo(3 params)` is overload forwarding, NOT recursion — name-only over-counts
  // it, the dominant C# false positive). `isSelfCall` gets the call node, the
  // symbol's body (whose enclosing declaration carries the parameter list), and the
  // symbol, so the language can compare arity. The engine prefers `isSelfCall` when
  // present, else falls back to `bareCalleeName(node) === sym.name`.
  // `oncePerSymbol`: gocognit (Go) adds +1 PER self-call SITE (`mapping` ×2 → +2);
  // SonarC# adds +1 ONCE per method that recurses at all (its visitor records a
  // boolean and adds the increment once at the end), so a method with 4 self-calls
  // gets +1, not +4. Set it for C#; unset (per-site) for Go.
  recursion?: {
    callType: string;
    bareCalleeName?: (node: Node) => string | null;
    isSelfCall?: (callNode: Node, body: Node, sym: Symbol) => boolean;
    eligibleKinds: ReadonlySet<string>;
    oncePerSymbol?: boolean;
  };
  // Optional FLAT-increment predicate: a node it returns true for adds +1 FLAT
  // (no nesting surcharge, no nesting bump) and is then descended normally. For a
  // single conditional flow-breaker that has no dedicated construct branch — Rust's
  // `let … else` (`let PAT = EXPR else { diverge }`), the irrefutable-binding analog
  // of `if let … else`: it adds one branch but, having no "then" arm and a
  // divergent `else`, doesn't raise nesting (matching how a guard or labeled jump
  // is flat). Checked AFTER skipTypes but the node must not match another branch
  // (a let_declaration matches none). Java/TS/Go/Python leave it unset.
  flatIncrement?: (node: Node) => boolean;
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
  // symbolIds that have already taken the direct-recursion +1 (for `recursion.
  // oncePerSymbol`). Owned here, across ALL of a symbol's bodies — a C# primary
  // constructor pushes >1 body for one symbolId, so a per-body flag would re-count.
  const recursedSymbols = new Set<string>();
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
      else if (opts.extraDecisionPredicate?.(node)) count++;
      if (opts.cyclomaticDecrement?.(node)) count--; // SwiftLint fallthrough −1
      for (const child of node.namedChildren) {
        if (!cycSkip.has(child.type)) stack.push(child);
      }
    }
    decisionPoints.set(symbolId, count);

    if (cognitivePoints) {
      const prev = cognitivePoints.get(symbolId) ?? 0;
      cognitivePoints.set(
        symbolId,
        prev + computeCognitive(body, opts.cognitive!, opts.skipTypes, sym, recursedSymbols),
      );
    }
  }

  for (const [id, count] of decisionPoints) {
    const dp = Math.max(0, count); // floor: a SwiftLint `fallthrough` −1 in a broken
    if (dp === 0) continue; // parse can't drive complexity below 1; trivial omitted
    byId.get(id)!.complexity = Math.min(1 + dp, COMPLEXITY_CAP);
  }
  if (cognitivePoints) {
    for (const [id, points] of cognitivePoints) {
      if (points === 0) continue; // cognitive 0 → omit (the receiver?-omit hygiene)
      byId.get(id)!.cognitiveComplexity = Math.min(points, COMPLEXITY_CAP);
    }
  }
}

// True when `t` is one of the language's parenthesis-like wrappers. `spec` is a
// single `parenthesizedType` string for most languages, or a SET (C# — expression
// AND pattern parens) matched by membership.
function matchesParen(t: string, spec: string | ReadonlySet<string>): boolean {
  return typeof spec === 'string' ? t === spec : spec.has(t);
}
// Unwraps nested parenthesized expressions to the inner expression (sonar's
// ExpressionUtils.skipParentheses), used while linearizing a boolean sequence.
function skipParens(node: Node | null, parenSpec: string | ReadonlySet<string>): Node | null {
  let n = node;
  while (n && matchesParen(n.type, parenSpec)) n = n.namedChild(0);
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
function computeCognitive(
  body: Node,
  cog: CognitiveOptions,
  skipTypes: ReadonlySet<string>,
  sym: Symbol,
  // symbolIds that already took the recursion +1 (for `recursion.oncePerSymbol`).
  // Owned by computeComplexity and SHARED across all of a symbol's bodies, so a
  // C# primary constructor (which pushes >1 body for one symbolId) counts recursion
  // ONCE per method, not once per body.
  recursedSymbols: Set<string>,
): number {
  let total = 0;
  // Direct recursion (gocognit): +1 per bare self-call, but only for symbol
  // kinds the language opts in (Go: 'function' — methods self-call via a
  // selector, never a bare identifier, so they're excluded). Hoisted once; the
  // `rec` capture lets TS narrow it inside visit() (no non-null assertions).
  const rec = cog.recursion;
  const recEligible = rec !== undefined && rec.eligibleKinds.has(sym.kind);
  // node.id of every logical-operator node already counted as part of a boolean
  // run, so the DFS doesn't recount them when it later descends the left spine.
  // Keyed on node.id (stable across web-tree-sitter wrapper objects); MUST be
  // call-local (per body) — hoisting it would undercount across symbols.
  const counted = new Set<number>();
  // Per-language run-start rule; default = +1 at every operator-KIND change
  // (sonar-java). TS overrides to count only `&&`-run-starts (SonarJS S3776).
  const runStarts =
    cog.booleanRunStarts ?? ((kind: string, prev: string | null) => prev === null || prev !== kind);
  // Logical-operand field names: default left/right; Swift's conjunction/disjunction
  // nodes use lhs/rhs.
  const leftField = cog.booleanLeftField ?? 'left';
  const rightField = cog.booleanRightField ?? 'right';
  // Parenthesis-like wrapper(s) to treat as transparent — a single type, or C#'s set
  // of expression+pattern parens. Used by the source-order flatten AND the tree-scoped
  // ancestor walk (both via `matchesParen`, which handles string or set).
  const parenSpec = cog.parenthesizedType;
  // A second if-like node type (Dart's collection `if_element`) is treated as `ifType`.
  const isIfLike = (t: string): boolean =>
    t === cog.ifType || (cog.collectionIfType !== undefined && t === cog.collectionIfType);

  const visitField = (node: Node, field: string, nesting: number, depth: number): void => {
    const child = node.childForFieldName(field);
    if (child) visit(child, nesting, depth + 1);
  };

  // Walks an `if`'s condition at base nesting. Field-based by default (`initField`
  // + `conditionField`); when `conditionFromNamedChildren` is set (Dart's fieldless
  // condition/pattern/`when`-guard), walks every named child that is NOT the
  // consequence/alternative field-child (and not a comment) so the condition's
  // booleans and Dart-3 pattern guards count. Shared by the head-if and the
  // else-if branch so the two never drift.
  const visitIfCondition = (ifNode: Node, nesting: number, depth: number): void => {
    if (cog.conditionFromNamedChildren) {
      const cons = ifNode.childForFieldName(cog.consequenceField);
      const alt = ifNode.childForFieldName(cog.alternativeField);
      for (const c of ifNode.namedChildren) {
        if (c.type === 'comment') continue;
        if ((cons && c.id === cons.id) || (alt && c.id === alt.id)) continue;
        visit(c, nesting, depth + 1);
      }
      return;
    }
    if (cog.initField) visitField(ifNode, cog.initField, nesting, depth);
    visitField(ifNode, cog.conditionField, nesting, depth);
  };

  // Python's `else_clause` (+1 FLAT, body one level deeper). Shared by BOTH the
  // handleAlternative path (an `if`'s own terminal else, consumed there so it isn't
  // re-dispatched) and the visit() dispatch (a for/while/try `else` reached via
  // general descent) — one helper so the two mutually-exclusive paths can't drift.
  const visitElseClauseBody = (clause: Node, nesting: number, depth: number): void => {
    total += 1;
    for (const child of clause.namedChildren) visit(child, nesting + 1, depth + 1);
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
    // Python: the `alternative` field is a flat LIST of elif_clause / else_clause
    // SIBLINGS (not a nested-if chain). Each elif/else is +1 FLAT; the elif
    // condition stays at base nesting (its booleans are flat anyway), every clause
    // BODY is one level deeper. No recursion — the clauses are siblings, not nested.
    if (cog.elifClauseType) {
      for (const alt of ifNode.childrenForFieldName(cog.alternativeField)) {
        if (alt.type === cog.elifClauseType) {
          total += 1;
          visitField(alt, cog.conditionField, nesting, depth);
          visitField(alt, cog.consequenceField, nesting + 1, depth);
        } else if (cog.elseClauseType && alt.type === cog.elseClauseType) {
          // PHP two-word `else if`: an `else` clause whose body is itself an `if`.
          // SonarPHP gives the inner if +1 FLAT (no `else` +1) but inside the else
          // clause's own nesting bump, so its body is one level deeper than a one-word
          // elseif (elseChainsIf). Otherwise a plain `else`: +1 flat, body nested.
          const innerIf = cog.elseChainsIf ? alt.childForFieldName(cog.consequenceField) : null;
          if (innerIf && innerIf.type === cog.ifType) {
            const n2 = nesting + 1; // the else clause's nesting bump wraps the inner if
            total += 1; // inner if: +1 FLAT (SonarPHP's ifStatementWithoutNesting)
            visitIfCondition(innerIf, n2, depth);
            visitField(innerIf, cog.consequenceField, n2 + 1, depth);
            handleAlternative(innerIf, n2, depth + 1);
          } else {
            visitElseClauseBody(alt, nesting, depth);
          }
        }
      }
      return;
    }
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
    if (isIfLike(alt.type)) {
      visitIfCondition(alt, nesting, depth);
      visitField(alt, cog.consequenceField, nesting + 1, depth);
      handleAlternative(alt, nesting, depth + 1);
    } else {
      // Plain (terminal) else: body at nesting+1 (sonar default) or at base
      // nesting (gocognit, via nestElseBody === false). `=== false` so an unset
      // value keeps the sonar-java/TS behavior unchanged.
      visit(alt, cog.nestElseBody === false ? nesting : nesting + 1, depth + 1);
    }
  };

  // Swift's POSITIONAL `if` (cog.ifPositionalBlockType set): no consequence/
  // alternative field. Conditions are `conditionField` children (possibly several:
  // `if a, let b = c`); the consequence is the block child BEFORE the `else` keyword;
  // the else branch (an `ifType` else-if, or a plain-else block AFTER `else`) is split
  // off at the `else` keyword (elseKeywordType) — NOT inferred from a second block
  // child, because an empty `{}` body emits NO block node, which would otherwise drop
  // the `+1 FLAT` for an empty-consequence or empty-else branch. The head if's surcharge
  // is added by the caller; this walks the conditions (base nesting, booleans flat), the
  // consequence (nesting+1), and the FLAT else/else-if chain (each +1, no surcharge —
  // recurses for else-if WITHOUT a head surcharge). Depth-guarded like handleAlternative
  // (a long else-if chain recurses here, not through `visit`).
  const visitPositionalIfBody = (ifNode: Node, nesting: number, depth: number): void => {
    if (depth > MAX_COGNITIVE_DEPTH) return;
    // Conditions: base nesting, booleans flat (Swift allows several — `if a, let b = c`).
    // condIds is built ONLY for the Kotlin path (it excludes the condition field-children —
    // a field child is also a named child — when locating the consequence/else among
    // namedChildren); Swift finds the consequence by block type and never reads it, so it
    // stays null (no allocation on the Swift path).
    const condIds = cog.ifConsequenceFromNamedChildren ? new Set<number>() : null;
    for (const cond of ifNode.childrenForFieldName(cog.conditionField)) {
      condIds?.add(cond.id);
      visit(cond, nesting, depth + 1);
    }
    // Kotlin: the `else` keyword is ANONYMOUS and a branch may be BRACE-LESS, so SPLIT at
    // the `else` keyword (always emitted for a real else, even when a branch is a `;` empty
    // statement that emits no named child — the empty-branch lesson). The consequence is the
    // first named non-condition non-comment child BEFORE `else`; the else body is the first
    // such child AFTER it (each may be absent for a `;` branch).
    if (cog.ifConsequenceFromNamedChildren) {
      const isBody = (c: Node) =>
        c.isNamed && !condIds!.has(c.id) && c.type !== 'line_comment' && c.type !== 'block_comment';
      const kids = ifNode.children;
      const elseIdx = cog.elseKeywordType ? kids.findIndex((c) => c.type === cog.elseKeywordType) : -1;
      const consequence = (elseIdx === -1 ? kids : kids.slice(0, elseIdx)).find(isBody);
      if (consequence) visit(consequence, nesting + 1, depth + 1);
      if (elseIdx === -1) return; // no else clause
      const elseBody = kids.slice(elseIdx + 1).find(isBody);
      // sonar-kotlin charges the else +1 ONLY when the else body is a block (`{}`, the
      // elseChargeBlockType) or an else-if (`ifType`) — a BRACE-LESS `else expr` is the
      // ternary form and gets NO +1. The else body still NESTS regardless.
      const isElseIf = elseBody?.type === cog.ifType;
      if (isElseIf || elseBody?.type === cog.elseChargeBlockType) total += 1; // +1 FLAT, no surcharge
      if (isElseIf) visitPositionalIfBody(elseBody!, nesting, depth + 1); // else-if chain, no head surcharge
      else if (elseBody) visit(elseBody, nesting + 1, depth + 1); // plain else body nests
      return;
    }
    const blockType = cog.ifPositionalBlockType!;
    const kids = ifNode.namedChildren;
    // The `else` keyword (a named token) signals the else clause and splits the body
    // from it — even when either block is the empty `{}` that emits no block node.
    const elseIdx = cog.elseKeywordType ? kids.findIndex((c) => c.type === cog.elseKeywordType) : -1;
    const beforeElse = elseIdx === -1 ? kids : kids.slice(0, elseIdx);
    const consequence = beforeElse.find((c) => c.type === blockType);
    if (consequence) visit(consequence, nesting + 1, depth + 1);
    if (elseIdx === -1) return; // no else clause
    total += 1; // else / else-if: +1 FLAT, no surcharge
    const afterElse = kids.slice(elseIdx + 1);
    const elseIf = afterElse.find((c) => c.type === cog.ifType);
    if (elseIf) {
      visitPositionalIfBody(elseIf, nesting, depth + 1); // recurse the chain
    } else {
      const elseBody = afterElse.find((c) => c.type === blockType);
      if (elseBody) visit(elseBody, nesting + 1, depth + 1); // may be absent (empty else)
    }
  };

  function visit(node: Node, nesting: number, depth: number): void {
    if (depth > MAX_COGNITIVE_DEPTH) return;
    const t = node.type;
    if (skipTypes.has(t)) return; // nested classes / methods: own symbols' bodies

    // --- direct recursion: +1 FLAT per self-call site (no surcharge, no return:
    // the call's arguments still descend below to catch nested control flow). A
    // call node is never a boolean (so never in `counted`) and matches no other
    // dispatch branch, so this can't double-count. The walk descends func_literal
    // (nestOnly), so a self-call inside a closure counts toward the enclosing
    // function — matching gocognit, whose FuncDecl-rooted walk doesn't reset the
    // target across closures. ---
    if (recEligible && rec && t === rec.callType) {
      // null/undefined callee never equals the (always-non-empty) symbol name.
      const isSelf = rec.isSelfCall
        ? rec.isSelfCall(node, body, sym)
        : rec.bareCalleeName?.(node) === sym.name;
      if (isSelf) {
        // oncePerSymbol (C#): +1 only the FIRST time across the symbol's bodies.
        // Per-site (Go, oncePerSymbol unset): +1 every time, `recursedSymbols` untouched.
        if (!rec.oncePerSymbol || !recursedSymbols.has(sym.id)) total += 1;
        if (rec.oncePerSymbol) recursedSymbols.add(sym.id);
      }
    }

    // --- if / else-if / else chain (head if surcharges; chain links are flat).
    // `isIfLike` also matches Dart's collection `if_element` (an if inside a
    // collection literal — same surcharge/else handling). ---
    if (isIfLike(t)) {
      total += 1 + nesting;
      if (cog.ifPositionalBlockType || cog.ifConsequenceFromNamedChildren) {
        // Positional consequence/else (no fields): Swift (keyword-split) or Kotlin
        // (anon `else` + brace-less branches). See visitPositionalIfBody.
        visitPositionalIfBody(node, nesting, depth);
      } else {
        visitIfCondition(node, nesting, depth);
        visitField(node, cog.consequenceField, nesting + 1, depth);
        handleAlternative(node, nesting, depth);
      }
      return;
    }

    // --- for/while/try `else` clause (Python): +1 flat, body one level deeper.
    // Gated on elifClauseType (Python mode). The `if`'s OWN else is consumed by
    // handleAlternative (the if-case returns), so this fires only for a loop/try
    // `else_clause` reached via general descent — matching sonar-python's
    // `visitElseClause` (+1 flat) with the else body StatementList nesting one level. ---
    if (cog.elifClauseType && cog.elseClauseType && t === cog.elseClauseType) {
      visitElseClauseBody(node, nesting, depth);
      return;
    }

    // --- loops: surcharge, then nest the body. With loopBodyField set (Python),
    // ONLY the body child nests and the iterable/condition/target/`else` stay at the
    // loop's ambient nesting (sonar-python). Without it, ALL children nest — the
    // KNOWN DIVERGENCE (Java/TS/Go, accepted): sonar nests ONLY the body, not the
    // loop header, so a nested STRUCTURAL construct in the header (`for(;cond?a:b;)`)
    // over-counts; booleans are flat (unaffected) and headers rarely hold control
    // flow (0 cases in the TS/gson/gocognit oracles). The precise per-construct-body
    // fix landed for Python (loopBodyField); generalizing it needs re-oracling the
    // other grammars, deferred. ---
    if (cog.loopTypes.has(t)) {
      total += 1 + nesting;
      const bodyChild = cog.loopBodyField ? node.childForFieldName(cog.loopBodyField) : null;
      for (const child of node.namedChildren) {
        const inner = cog.loopBodyField
          ? bodyChild && child.id === bodyChild.id
            ? nesting + 1
            : nesting
          : nesting + 1;
        visit(child, inner, depth + 1);
      }
      return;
    }

    // --- surcharge-FLAT (C# `goto`/`goto case`): surcharge (+1 + nesting) but
    // descend children at the SAME nesting — the construct itself is a flow-breaker,
    // but a structural construct in its operand (`goto case (p ? 1 : 2)`) is NOT
    // nested by SonarC# (it's counted at the goto's own nesting). Kept separate from
    // the switch/ternary branch, which DOES nest its children. ---
    if (cog.surchargeTypes?.has(t)) {
      total += 1 + nesting;
      for (const child of node.namedChildren) visit(child, nesting, depth + 1);
      return;
    }

    // --- ternary with BRANCH-ONLY nesting (PHP): surcharge, but nest ONLY the
    // configured branch fields (true/false); the CONDITION stays at the ternary's
    // ambient nesting. Resolves the overbump for a chained elvis `a ?: b ?: c`
    // (`((a ?: b) ?: c)`), whose inner conditionals sit in the CONDITION position —
    // bump-all would compound the surcharge per link (SonarPHP visits the condition at
    // ambient). The loopBodyField analog for ternaries; only PHP sets ternaryBranchFields. ---
    if (t === cog.ternaryType && cog.ternaryBranchFields) {
      total += 1 + nesting;
      const branchIds = new Set<number>();
      for (const f of cog.ternaryBranchFields) {
        const c = node.childForFieldName(f);
        if (c) branchIds.add(c.id);
      }
      for (const child of node.namedChildren) {
        visit(child, branchIds.has(child.id) ? nesting + 1 : nesting, depth + 1);
      }
      return;
    }

    // --- switch / ternary: surcharge, then ALL children one level deeper. (sonar
    // nests the WHOLE ternary subtree — incl. its test — so bump-all is correct for
    // a ternary; the header-overbump caveat above applies to switch discriminants.) ---
    if (cog.switchTypes.has(t) || t === cog.ternaryType) {
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

    // --- try container with FLAT catch bodies (Dart): the try body (`bodyField`
    // child) and the `on`/type/`catch_clause` headers + `finally` stay at base
    // nesting; EACH other direct `catchBodyType` child is a catch body that
    // surcharges (+1 + nesting) and nests at +1. This covers `catch(e){}`,
    // `on E catch(e){}`, AND a binding-less `on E {}` (a block with no catch_clause),
    // all of which the SonarQube Dart rule counts as a catch. Other languages leave tryType unset
    // (their catch clause contains its body — handled by the catchType branch). ---
    if (cog.tryType && t === cog.tryType.node) {
      const tryBody = node.childForFieldName(cog.tryType.bodyField);
      for (const child of node.namedChildren) {
        // A catch body = a `catchBodyType` child that is NOT the try body. The
        // `tryBody &&` guard matters on a malformed parse where the `body:` field
        // didn't bind (tryBody null): without it the try body itself would be
        // mis-surcharged as a catch (an over-count); instead descend everything at
        // base nesting (a safe under-count). Valid Dart always binds `body:`.
        if (tryBody && child.type === cog.tryType.catchBodyType && child.id !== tryBody.id) {
          total += 1 + nesting;
          visit(child, nesting + 1, depth + 1);
        } else {
          visit(child, nesting, depth + 1);
        }
      }
      return;
    }

    // --- nesting-only (lambda): raise nesting, add nothing ---
    if (cog.nestOnlyTypes.has(t)) {
      for (const child of node.namedChildren) visit(child, nesting + 1, depth + 1);
      return;
    }

    // --- labeled break/continue: +1 flat if it jumps to a label, then DESCEND. In
    // Rust `break`/`continue` are EXPRESSIONS that can carry a value (`break a && b`,
    // `break if c {1} else {2}`) whose control flow counts (flat, no extra bump); the
    // label is a `label` leaf that matches no branch, so descending it is a no-op.
    // Go/Java/TS/Python jumps hold only a label/nothing, so the descent is a no-op
    // there too (verified: the full suite is unchanged). ---
    if (cog.labeledJumpTypes.has(t)) {
      if (cog.hasLabel(node)) total += 1;
      for (const child of node.namedChildren) visit(child, nesting, depth + 1);
      return;
    }

    // --- boolean runs (TREE-SCOPED, the SonarQube Dart model): a logical node adds +1 iff its
    // operator kind differs from its nearest LOGICAL ANCESTOR (skipping parens) —
    // a top-of-tree logical node or a kind-change starts a run. No flatten: each
    // logical node is processed once as the DFS reaches it, operands descend below. ---
    if (cog.booleanByTreeParent) {
      const kind = cog.booleanOperatorKind(node);
      if (kind !== null) {
        let anc = node.parent;
        while (anc && matchesParen(anc.type, parenSpec)) anc = anc.parent;
        const ancKind = anc ? cog.booleanOperatorKind(anc) : null;
        if (ancKind !== kind) total += 1; // new run (different or no logical parent)
        for (const child of node.namedChildren) visit(child, nesting, depth + 1);
        return;
      }
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
          const inner = skipParens(n, parenSpec);
          if (inner && cog.booleanOperatorKind(inner) !== null) {
            counted.add(inner.id);
            // Operands via the operand FIELDS (default `left`/`right`, Swift
            // `lhs`/`rhs` via booleanLeftField/booleanRightField), not positional
            // namedChild(0)/(1): a comment interleaved around the operator
            // (`a && /*c*/ b`) is a named child, so positional access would read
            // the comment as the right operand and drop a parenthesized sub-run.
            // Every logical node so far (Java/TS/Go/Rust `binary_expression`,
            // Python `boolean_operator`, Swift `conjunction_expression`/
            // `disjunction_expression`) exposes a left/right operand field pair;
            flatten(inner.childForFieldName(leftField), d + 1);
            run.push(inner);
            flatten(inner.childForFieldName(rightField), d + 1);
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

    // --- flat conditional (Rust `let … else`): +1 flat, then descend at the
    // SAME nesting (no surcharge, no bump — the value expr and the divergent else
    // block both stay at the binding's level). ---
    if (cog.flatIncrement?.(node)) {
      total += 1;
      for (const child of node.namedChildren) visit(child, nesting, depth + 1);
      return;
    }

    // --- default: pass through, nesting unchanged ---
    for (const child of node.namedChildren) visit(child, nesting, depth + 1);
  }

  visit(body, 0, 0);
  return total;
}
