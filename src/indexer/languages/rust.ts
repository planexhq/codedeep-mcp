import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportedName, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  collectAmbiguousTypeNames,
  declSignature,
  normalizeSignature,
  resolveCalls,
  symbolId,
} from '../extractor.js';
import type {
  CallSelector,
  ExtractResult,
  MemberCallInfo,
  PendingBody,
} from '../extractor.js';
import {
  cFamilyBooleanOperatorKind,
  computeComplexity,
  isCFamilyBooleanOperator,
} from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Nested `fn` items create their own scope — their calls must NOT attribute to
// an enclosing function, so they're pruned from the body walk (and aren't
// extracted as symbols, the "top-level + member only" rule). closure_expression
// is deliberately ABSENT: a closure can't be a symbol, so calls inside
// `it.map(|x| foo(x))` attribute to the enclosing fn (the Go func_literal / Java
// lambda rule). function_signature_item has no body, so it never reaches here.
const RUST_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['function_item']);

// Same set — Rust impl/trait/struct/enum/mod bodies are descended on the
// module-root walk (their methods are already PendingBodies, dropped by the
// seen-set; their const/static initializers attribute as module-level calls).
// ALSO the complexity boundary (cyclomatic DFS + cognitive walk): nested
// `function_item` is pruned (its control flow counts toward no symbol — the
// per-symbol model, like Java anon-classes / Python nested fns), while
// `closure_expression` is DESCENDED (absent here), so a closure's branches roll
// into the enclosing fn (matching rust-code-analysis, which merges the closure
// func-space upward).
const RUST_SKIP_TYPES: ReadonlySet<string> = RUST_FUNCTION_BODY_SKIP_TYPES;

// Cyclomatic decision set — pinned to Mozilla's `rust-code-analysis` (the
// empirical `rust-code-analysis-cli` oracle), DELIBERATELY divergent from
// SonarSource's sonar-rust on two points the two analyzers disagree on: (1) the
// `?` try operator (`try_expression`) COUNTS — rust-code-analysis treats each `?`
// as a decision point (an implicit early-return-on-`Err`), sonar-rust does NOT;
// pinned to count it (it's the dominant control construct in Result-heavy Rust,
// and a McCabe-faithful branch — the Go precedent, where codedeep-mcp pinned gocyclo
// over sonar-go for counting select-cases sonar-go dropped). (2) EVERY `match_arm`
// counts (incl. the wildcard `_`; an or-pattern `A | B =>` is ONE arm), where
// sonar-rust filters empty-bodied arms. `if let`/`while let` are plain
// `if_expression`/`while_expression` (the `let` lives in a `let_condition`/
// `let_chain` in the `condition` field) so they're counted automatically;
// `else if` is a nested `if_expression`. `closure_expression` counts +1 (the
// func-space base rust-code-analysis merges upward) and is descended (its inner
// branches also count). `match_expression` is NOT here (only its arms count);
// `let … else` (`let_declaration` + `alternative` block) is NOT counted (neither
// analyzer does). `&&`/`||` count via the shared isCFamilyBooleanOperator (Rust
// has no `??`, so that branch is inert, as in Go). VERIFIED against
// rust-code-analysis-cli on ripgrep + serde.
const RUST_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_expression',
  'while_expression',
  'for_expression',
  'loop_expression',
  'match_arm',
  'try_expression',
  'closure_expression',
]);

// Cognitive-complexity config. The CYCLOMATIC side pins to rust-code-analysis;
// the COGNITIVE side is whitepaper/sonar-rust-aligned and DELIBERATELY does NOT
// replicate two rust-code-analysis BUGS the empirical oracle surfaced (both make
// rca's cognitive number indefensible, so codedeep-mcp stays whitepaper-correct — the
// SonarJS-ternary-bug precedent): (1) rca's Rust cognitive visitor OMITS
// `loop_expression` entirely (it counts `while`/`for` but a bare `loop {}` adds
// nothing and doesn't nest its body — an obvious omission, inconsistent with rca's
// own cyclomatic which DOES count `Loop`); codedeep-mcp counts all three loops. (2) rca's
// boolean handling carries its run-state across the whole function (reset only on a
// nesting bump, unlike rca's own Python impl which resets per clause), so it both
// under-counts (merged else-if conditions: `if (c||d){} else if (e||f){}` scores 3
// vs codedeep-mcp's 4) and over-counts (`a && b && c || d || e` scores 3 vs codedeep-mcp's 2,
// worse with `!`/longer chains);
// codedeep-mcp counts per maximal same-kind run per expression = 2 (the whitepaper rule).
// Where rca is NOT buggy the two agree. Also: `?` is NOT counted
// cognitively (both analyzers agree — unlike cyclomatic), recursion is NOT counted,
// a whole `match` is +1 with arms nesting (the cyc/cog divergence), closures raise
// nesting (+0, the lambda rule) and roll into the enclosing fn (descended), and the
// plain-`else` body NESTS (the whitepaper/sonar default — rca agrees: its `Else`
// node inherits the if's bumped nesting via the nesting_map). VERIFIED against
// rust-code-analysis-cli on ripgrep + serde: every divergence decomposes into the
// two rca bugs above, `let … else` (rca's grammar parses its `else` as a counted
// node, codedeep-mcp's as a plain block — documented gap), macro-internal control flow
// (codedeep-mcp's grammar treats macro token-trees as opaque — documented), and nested
// fn/impl bodies (the per-symbol model, like Java anon-classes).
const RUST_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_expression',
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  // tree-sitter-rust wraps else/else-if in an `else_clause` (the TS shape, NOT
  // Java's direct alternative) — unwrap it to the inner if_expression/block.
  // nestElseBody is left unset (true): the plain-`else` body nests one level (the
  // sonar/whitepaper default; rca matches via its Else-inherits-bumped-nesting).
  elseClauseType: 'else_clause',
  loopTypes: new Set(['loop_expression', 'while_expression', 'for_expression']),
  // loopBodyField UNSET → bump-ALL children (matches rust-code-analysis, which
  // raises nesting for the whole loop subtree; keeps the accepted loop-header
  // overbump shared with Java/TS/Go, not Python's body-only nesting).
  switchTypes: new Set(['match_expression']),
  // Rust has no ternary (`if` is an expression) nor try/catch (`?` is separate
  // and uncounted cognitively) — sentinels that never match a real node.
  ternaryType: '__rust_no_ternary__',
  catchType: '__rust_no_catch__',
  // Closures raise nesting and roll their control flow into the enclosing fn
  // (+0 themselves; the cyclomatic side counts them +1 and descends them too).
  nestOnlyTypes: new Set(['closure_expression']),
  // `break 'outer` / `continue 'outer` carry a `label` NAMED CHILD (Rust break/
  // continue are expressions); unlabeled ones add nothing.
  labeledJumpTypes: new Set(['break_expression', 'continue_expression']),
  hasLabel: (n) => n.namedChildren.some((c) => c?.type === 'label'),
  // `&&`/`||` via the shared C-family reader (Rust has no `??`). booleanRunStarts
  // unset → the default (+1 at every operator-kind change) matches both analyzers.
  booleanOperatorKind: cFamilyBooleanOperatorKind,
  // Unwrap parens while linearizing a boolean run — rust-code-analysis does NOT
  // stop a run at a parenthesized expression (unlike Go's sentinel).
  parenthesizedType: 'parenthesized_expression',
  // `let … else` (`let_declaration` with an `alternative` block) adds +1 FLAT —
  // the irrefutable-binding analog of `if let … else` (which IS counted), so
  // counting it is the whitepaper-correct choice (and matches rust-code-analysis,
  // whose grammar parses the `else` as a counted node — one of the places rca's
  // cognitive is NOT buggy). CYCLOMATIC does not count it (neither analyzer does;
  // a let-else introduces no If/loop/&&/|| node of its own).
  flatIncrement: (n) => n.type === 'let_declaration' && n.childForFieldName('alternative') !== null,
  // No initField (Rust's `if` has no init clause — the let-chain is in `condition`)
  // and no recursion (rust-code-analysis does not count direct recursion).
};

// Cyclomatic extra-decision predicate (the engine's `extraDecisionPredicate` slot,
// as Java reuses it for switch labels). Counts `&&`/`||` via the
// shared C-family reader, PLUS a MATCH-ARM GUARD (`pat if cond => …`). The guard
// is a decision point rust-code-analysis counts (its grammar yields an `If` for
// the guard), but it has no dedicated node type here — it's a `condition` field
// on `match_pattern` (`match_arm → match_pattern{pattern, condition: <expr>}`), so
// a flat node-type set can't catch it without also counting every unguarded arm.
// CYCLOMATIC ONLY: rust-code-analysis does NOT count the guard cognitively (only
// its inner booleans, which the cognitive walk already descends). The guard's own
// `&&`/`||` are still counted separately by the C-family reader (so `A if c && d`
// is +2: the guard +1 and the `&&` +1 — matching rca).
//
// KNOWN RECALL GAP (safe under-count, grammar-driven, like macro-opacity): the
// `&&`/`||` that join an `if let`/`while let` LET-CHAIN (`if let Some(x) = o && x > 0`)
// are ANONYMOUS tokens inside the `let_chain` node, NOT `binary_expression` nodes, so
// neither this predicate nor the DFS (which walks named children) sees them — codedeep-mcp
// under-counts such a chain by its `&&`/`||` count where rust-code-analysis (whose
// grammar exposes them) counts each. The `if`/`while` itself is still counted, and
// the cognitive side agrees (rca's cognitive boolean reader also misses let-chain
// `&&`). Never an over-count; counting them would need anonymous-token machinery for
// a low-frequency pattern.
function rustCyclomaticExtra(node: Node): boolean {
  if (isCFamilyBooleanOperator(node)) return true;
  return node.type === 'match_pattern' && node.childForFieldName('condition') !== null;
}

// `struct_expression`'s callee is a type_identifier (`Point { .. }`), never a
// plain identifier — without this, every brace-construction ref is dropped.
const RUST_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier', 'type_identifier']);

// A bare `foo()` binds to free functions only. Tuple-struct / enum-variant
// constructors (`Tuple(1, 2)`, `Variant(x)`) parse as identical call_expressions
// with identifier callees, so struct/enum kinds stay out — a constructor is
// emitted as an unresolved name-keyed ref, never a confidently-wrong edge (the
// Go type-conversion rule).
const RUST_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function']);

// Brace construction `Point { .. }` binds to structs/unions (both 'class').
// Enums can't be brace-constructed (only their variants, via a scoped name that
// reaches memberCallInfo); traits/type-aliases never can.
const RUST_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class']);

// Kinds sharing the simple-name FQN namespace — duplicates among these are
// excluded from extract-time resolution. (struct/union→class, trait→interface,
// enum→enum, type alias→type.)
const RUST_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'type']);

// Prelude enum-variant constructors used as bare calls everywhere
// (`Ok(x)`, `Some(v)`, `Err(e)`). They parse as call_expression with an
// identifier callee and would otherwise flood the name-keyed reference store —
// the Rust analog of Go's builtins. Suppressed ONLY when unresolved (a file-
// local function shadowing the name still keeps its refs). Extend after
// measuring on real repos.
const RUST_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set(['Some', 'Ok', 'Err']);

const RUST_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call_expression', getCallee: (n) => n.childForFieldName('function') },
  { nodeType: 'struct_expression', getCallee: structExpressionCallee },
];

// `Point { .. }` → type_identifier (bare constructor-form, binds via
// constructorKinds); `Shape::Circle { .. }` / `mod::Type { .. }` →
// scoped_type_identifier (member path, handled by rustMemberCallInfo).
// `Self { .. }` is suppressed: as a bare type_identifier it would resolve
// against a (non-existent) symbol literally named `Self` and flood the ref
// store with junk `Self` targets — ignoredBareCallees can't catch it (that
// gate is identifier-only). Self-construction edges aren't worth the noise.
function structExpressionCallee(node: Node): Node | null {
  let name = node.childForFieldName('name');
  // `Pair::<i32> { .. }` — turbofish wraps the real type in its `type` field
  // (type_identifier for `Pair`, scoped_identifier for `m::Pair`).
  if (name?.type === 'generic_type_with_turbofish') name = name.childForFieldName('type');
  if (!name) return null;
  if (name.type === 'type_identifier') return name.text === 'Self' ? null : name;
  // scoped_type_identifier from `Enum::Variant { .. }`; scoped_identifier from
  // a turbofish-unwrapped `m::Pair::<T>` — both reach rustMemberCallInfo.
  if (name.type === 'scoped_type_identifier' || name.type === 'scoped_identifier') return name;
  return null;
}

// Reduces a `.`/`::` call callee to {receiver, property}. Mirrors TS/Python/
// Java/Go for the `.` form; the `::` form additionally captures MULTI-segment
// paths so fully-qualified calls aren't dropped (the cross-file recall gap).
//  - field_expression: `self.x()` (value is the fixed `self` token → isSelf),
//    `obj.x()` (identifier receiver). Chained/computed receivers (`a.b().c()`,
//    `obj.inner.m()`) → RECEIVER_OPAQUE (findable by method name, never resolved).
//  - scoped_identifier / scoped_type_identifier (the `::` path form):
//    * single-segment `foo::bar()` / `Type::assoc()` / `Enum::Variant {}` —
//      `Self::x()` → isSelf (resolve against the enclosing impl type);
//    * multi-segment `crate::defs::f()` / `std::mem::swap()` / `a::b::c::d()` —
//      the IMMEDIATE qualifier (the path's own last name) is the receiver, so
//      the ref takes the same shape as `qualifier::name()` and resolves
//      cross-file through the existing member-ref machinery. External paths
//      (std::…) stay unresolved name-keyed refs, like any cross-file member;
//    * root-relative `crate::f()` / `super::f()` / `self::f()` — the root
//      keyword is the only receiver token available.
// Rust needs no PendingBody.selfReceiverName (Go's mechanism): `self` is a
// fixed token and `Self` is a fixed identifier, decided here like Python.
//
// Dominant Rust stdlib/iterator/Option/Result/string method names (>=4 chars)
// suppressed when a member call to them is unresolved — capturing chained
// `.iter().map().collect()` calls otherwise floods the name-keyed store. Domain
// method names are deliberately absent. <=3-char names (`.len`, `.get`) are
// gated downstream by SHORT_NAME_THRESHOLD.
//
// Composition trimmed after a ripgrep dogfood measured flood-vs-recall PER name
// (member-call sites vs in-repo `pub fn` defs). The kept names are
// canonical-by-usage: even where ripgrep also defines one, ~0–28% of `.name()`
// sites target it, so capturing would inject mostly-FALSE weak-include callers
// onto a boilerplate/look-alike method (the precision-over-recall stance that
// already drops external multi-segment path calls). Notably `parse` stays —
// its in-repo defs are private/free-fns and every `.parse()` site is stdlib
// `str::parse`, so trimming it surfaces ZERO real callers. `bytes`/`remove` were
// REMOVED (now captured): distinctive domain methods (Sink/printer accessors;
// ByteSet/Dir mutators) with real in-repo recall stake and ~0 stdlib false-include.
const RUST_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'unwrap', 'expect', 'unwrap_or', 'unwrap_or_else', 'unwrap_or_default',
  'clone', 'into', 'into_iter', 'iter', 'iter_mut', 'collect',
  'map_err', 'filter', 'filter_map', 'flat_map', 'fold', 'reduce',
  'for_each', 'count', 'take', 'skip', 'chain', 'enumerate',
  'next', 'peekable', 'cloned', 'copied', 'as_ref', 'as_mut', 'as_str',
  'as_slice', 'to_string', 'to_owned', 'to_vec', 'borrow', 'borrow_mut',
  'push', 'insert', 'contains', 'contains_key',
  'is_empty', 'is_some', 'is_none', 'is_ok', 'is_err', 'ok_or', 'and_then',
  'or_else', 'ok_or_else', 'trim', 'split', 'splitn', 'replace', 'starts_with',
  'ends_with', 'parse', 'lock', 'read', 'write', 'lines', 'chars',
]);

function rustMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'field_expression') {
    const value = callee.childForFieldName('value');
    const field = callee.childForFieldName('field');
    if (!value || field?.type !== 'field_identifier') return null;
    if (value.type === 'self') return { receiver: 'self', property: field.text, isSelf: true };
    if (value.type === 'identifier') {
      return { receiver: value.text, property: field.text, isSelf: false };
    }
    // Chained/computed `.` receiver (`obj.inner.method()`, `f().g()`) → opaque:
    // findable by the called method name (recall) but never resolved.
    return { receiver: RECEIVER_OPAQUE, property: field.text, isSelf: false };
  }
  if (callee.type === 'scoped_identifier' || callee.type === 'scoped_type_identifier') {
    const name = callee.childForFieldName('name');
    const path = callee.childForFieldName('path');
    if (!name || !path) return null;
    // `::` path calls are pathQualified: a small intra-crate population (not the
    // dot-method flood), so emit() exempts them from RUST_IGNORED_MEMBER_CALLEES
    // — `crate::cfg::parse()` to an in-repo `fn parse` stays findable even though
    // `.parse()` method calls are suppressed.
    if (path.type === 'identifier') {
      if (path.text === 'Self')
        return { receiver: 'Self', property: name.text, isSelf: true, pathQualified: true };
      return { receiver: path.text, property: name.text, isSelf: false, pathQualified: true };
    }
    // Multi-segment path (`A::B::name()`). Emit ONLY when the path is rooted at
    // crate/self/super — those are reliably INTRA-crate, so the immediate
    // qualifier (path's own last name) as receiver resolves to a same-crate
    // symbol cross-file. Paths rooted at an external/workspace crate name
    // (`std::io::stdout()`, `grep::…`) are dropped: their final segment
    // routinely collides with a same-named in-repo member, and the weak
    // member-include can't see the receiver, so capturing them injects FALSE
    // cross-file callers (measured on ripgrep: 217/230 multi-segment calls are
    // external, and std::io::stdout() was being attributed to a local `stdout`).
    if (path.type === 'scoped_identifier' || path.type === 'scoped_type_identifier') {
      if (!isCrateRooted(path)) return null;
      const qualifier = path.childForFieldName('name');
      if (!qualifier) return null;
      return { receiver: qualifier.text, property: name.text, isSelf: false, pathQualified: true };
    }
    // Two-segment root-relative path (`crate::f()`, `super::f()`, `self::f()`):
    // the path IS the keyword node — intra-crate, the keyword is the receiver.
    if (path.type === 'crate' || path.type === 'super' || path.type === 'self') {
      return { receiver: path.text, property: name.text, isSelf: false, pathQualified: true };
    }
    return null;
  }
  return null;
}

// True when a multi-segment path's deepest root is the crate/self/super keyword
// (reliably the current crate), as opposed to an external/workspace crate name.
function isCrateRooted(scoped: Node): boolean {
  let node: Node | null = scoped;
  while (node && (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier')) {
    node = node.childForFieldName('path');
  }
  return node !== null && (node.type === 'crate' || node.type === 'super' || node.type === 'self');
}

// Per-file duplicate-id disambiguation. Two trait impls can define the same-
// named, same-signature method on one type (`impl A for T { fn id() }` +
// `impl B for T { fn id() }`), byte-identical in (name, kind, signature,
// qualifier). Repeats get an ordinal qualifier; ids shift only when an EARLIER
// duplicate is added/removed — the best line-free option (Go's `func init()`
// rule).
type OccurrenceCounter = Map<string, number>;

export function extractRust(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const bodies: PendingBody[] = [];
  const occurrences: OccurrenceCounter = new Map();

  extractItems(tree.rootNode.namedChildren, content, fileInfo, '', true, occurrences, symbols, imports, bodies);

  // Same-name types in one file are invalid Rust, so this only fires on broken
  // parses — where refusing resolution beats binding through a half-parsed type.
  const ambiguousTypeNames = collectAmbiguousTypeNames(symbols, RUST_TYPE_KINDS);

  const references = resolveCalls(
    bodies,
    tree.rootNode,
    symbols,
    fileInfo,
    RUST_SELECTORS,
    RUST_SKIP_TYPES,
    RUST_FUNCTION_BODY_SKIP_TYPES,
    rustMemberCallInfo,
    {
      bareCalleeTypes: RUST_BARE_CALLEE_TYPES,
      // A bare `foo()` in a method body is a free-function call — Rust has no
      // implicit `self` receiver (the Go rule, opposite of Java).
      bareCallsBindToEnclosingClass: false,
      bareCallableKinds: RUST_BARE_CALLABLE_KINDS,
      constructorKinds: RUST_CONSTRUCTOR_KINDS,
      ambiguousClassNames: ambiguousTypeNames,
      ignoredBareCallees: RUST_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: RUST_IGNORED_MEMBER_CALLEES,
    },
  );
  computeComplexity(bodies, symbols, {
    decisionNodeTypes: RUST_DECISION_NODE_TYPES,
    extraDecisionPredicate: rustCyclomaticExtra,
    skipTypes: RUST_SKIP_TYPES,
    cognitive: RUST_COGNITIVE_OPTIONS,
  });
  return { symbols, references, imports };
}

// Walks a list of items (source_file children, or a mod/foreign-mod body) and
// dispatches by node type. `modulePath` is the `::`-joined enclosing module
// chain (folded into hashed qualifiers for id uniqueness, never into the FQN).
// `containerExported` is false inside a private module, so its `pub` items
// aren't reachable from outside and stay exported=false.
function extractItems(
  children: readonly Node[],
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outImports: ImportInfo[],
  outBodies: PendingBody[],
): void {
  for (const child of children) {
    switch (child.type) {
      case 'use_declaration':
        extractUse(child, fileInfo, outImports);
        break;
      // function_signature_item appears here only inside an extern block
      // (transparent — see foreign_mod_item); both forms are top-level fns.
      case 'function_item':
      case 'function_signature_item':
        extractFunction(child, content, fileInfo, modulePath, containerExported, occurrences, outSymbols, outBodies);
        break;
      case 'const_item':
      case 'static_item':
        extractConstStatic(child, content, fileInfo, modulePath, containerExported, occurrences, outSymbols);
        break;
      case 'struct_item':
      case 'union_item':
        extractStructLike(child, content, fileInfo, modulePath, containerExported, occurrences, outSymbols);
        break;
      case 'enum_item':
        extractSimpleType(child, content, fileInfo, 'enum', modulePath, containerExported, occurrences, outSymbols);
        break;
      case 'type_item':
        extractSimpleType(child, content, fileInfo, 'type', modulePath, containerExported, occurrences, outSymbols);
        break;
      case 'trait_item':
        extractTrait(child, content, fileInfo, modulePath, containerExported, occurrences, outSymbols, outBodies);
        break;
      case 'impl_item':
        extractImpl(child, content, fileInfo, modulePath, containerExported, occurrences, outSymbols, outBodies);
        break;
      case 'mod_item':
        extractMod(child, content, fileInfo, modulePath, containerExported, occurrences, outSymbols, outImports, outBodies);
        break;
      case 'foreign_mod_item': {
        // `extern "C" { .. }` is transparent: its fns/statics live in the
        // enclosing module's namespace, so recurse with the same path.
        const body = child.childForFieldName('body');
        if (body) {
          extractItems(body.namedChildren, content, fileInfo, modulePath, containerExported, occurrences, outSymbols, outImports, outBodies);
        }
        break;
      }
      case 'macro_definition':
        extractMacro(child, content, fileInfo, modulePath, occurrences, outSymbols);
        break;
      // attribute_item, line_comment, inner attributes, etc. — no symbols.
      default:
        break;
    }
  }
}

function extractFunction(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  // `fn main` at the crate root is the entry point even without `pub`.
  const exported =
    (containerExported && hasPubVisibility(decl)) || (modulePath === '' && name === 'main');
  const sym = makeRustSymbol(
    decl,
    declSignature(decl, content),
    fileInfo,
    'function',
    name,
    `${fileInfo.path}:${name}`,
    exported,
    rustDoc(decl),
    occurrences,
    modulePath,
  );
  outSymbols.push(sym);
  // function_signature_item (extern/trait-required) is bodiless — symbol only.
  const body = decl.childForFieldName('body');
  if (body) outBodies.push({ symbolId: sym.id, body });
}

function extractConstStatic(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  outSymbols.push(
    makeRustSymbol(
      decl,
      declSignature(decl, content),
      fileInfo,
      'variable',
      name,
      `${fileInfo.path}:${name}`,
      containerExported && hasPubVisibility(decl),
      rustDoc(decl),
      occurrences,
      modulePath,
    ),
  );
}

// struct / union → 'class'; fields (named structs/unions only) → 'variable'
// members. Tuple structs (ordered_field_declaration_list) and unit structs
// have no named members.
function extractStructLike(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && hasPubVisibility(decl);
  outSymbols.push(
    makeRustSymbol(
      decl,
      declSignature(decl, content),
      fileInfo,
      'class',
      name,
      `${fileInfo.path}:${name}`,
      exported,
      rustDoc(decl),
      occurrences,
      modulePath,
    ),
  );
  const body = decl.childForFieldName('body');
  if (body?.type !== 'field_declaration_list') return;
  for (const field of body.namedChildren) {
    if (field.type !== 'field_declaration') continue;
    const fieldName = field.childForFieldName('name')?.text;
    if (!fieldName) continue;
    outSymbols.push(
      makeRustSymbol(
        field,
        normalizeSignature(field.text),
        fileInfo,
        'variable',
        fieldName,
        `${fileInfo.path}:${name}.${fieldName}`,
        exported && hasPubVisibility(field),
        rustDoc(field),
        occurrences,
        joinQualifier(modulePath, name),
      ),
    );
  }
}

// enum / type-alias: a single declaration-only symbol (enum variants are not
// extracted — the TS/Java/Go enum-member rule).
function extractSimpleType(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  kind: SymbolKind,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  outSymbols.push(
    makeRustSymbol(
      decl,
      declSignature(decl, content),
      fileInfo,
      kind,
      name,
      `${fileInfo.path}:${name}`,
      containerExported && hasPubVisibility(decl),
      rustDoc(decl),
      occurrences,
      modulePath,
    ),
  );
}

// trait → 'interface'; its body members are declaration-only (or default-bodied)
// methods + associated consts/types. Trait items carry no visibility modifier —
// they inherit the trait's visibility.
function extractTrait(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const traitExported = containerExported && hasPubVisibility(decl);
  outSymbols.push(
    makeRustSymbol(
      decl,
      declSignature(decl, content),
      fileInfo,
      'interface',
      name,
      `${fileInfo.path}:${name}`,
      traitExported,
      rustDoc(decl),
      occurrences,
      modulePath,
    ),
  );
  const body = decl.childForFieldName('body');
  if (body?.type !== 'declaration_list') return;
  extractMembers(body, content, fileInfo, name, modulePath, () => traitExported, occurrences, outSymbols, outBodies);
}

// impl block: not a symbol itself. Its methods become `file:ImplType.method`
// (keyed on the IMPLEMENTING type, not the trait — `impl Drawable for Point`
// gives `Point.draw`, so `self.draw()` resolves against Point). Members carry
// their own `pub` (inherent `pub fn`); trait-impl conformance methods have no
// `pub` and stay exported=false (discoverable via the type, not the API surface).
function extractImpl(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const typeName = implTypeName(decl);
  if (!typeName) return; // non-nominal impl target (&T, (A,B), dyn Trait, [T]) — skip its methods.
  const body = decl.childForFieldName('body');
  if (body?.type !== 'declaration_list') return;
  extractMembers(
    body,
    content,
    fileInfo,
    typeName,
    modulePath,
    (member) => containerExported && hasPubVisibility(member),
    occurrences,
    outSymbols,
    outBodies,
  );
}

// Shared trait/impl body extraction. `memberExported` decides exportedness per
// member (traits: constant; impls: own-pub). Methods key into methodsByClass
// under `className`; their bodies (default trait methods, impl methods) become
// PendingBodies with className set so self-calls resolve.
function extractMembers(
  body: Node,
  content: string,
  fileInfo: FileInfo,
  className: string,
  modulePath: string,
  memberExported: (member: Node) => boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const qualifier = joinQualifier(modulePath, className);
  for (const member of body.namedChildren) {
    switch (member.type) {
      case 'function_item':
      case 'function_signature_item': {
        const name = member.childForFieldName('name')?.text;
        if (!name) break;
        const sym = makeRustSymbol(
          member,
          declSignature(member, content),
          fileInfo,
          'method',
          name,
          `${fileInfo.path}:${className}.${name}`,
          memberExported(member),
          rustDoc(member),
          occurrences,
          qualifier,
        );
        outSymbols.push(sym);
        const methodBody = member.childForFieldName('body');
        if (methodBody) outBodies.push({ symbolId: sym.id, body: methodBody, className });
        break;
      }
      case 'const_item':
      case 'static_item': {
        const name = member.childForFieldName('name')?.text;
        if (!name) break;
        outSymbols.push(
          makeRustSymbol(
            member,
            declSignature(member, content),
            fileInfo,
            'variable',
            name,
            `${fileInfo.path}:${className}.${name}`,
            memberExported(member),
            rustDoc(member),
            occurrences,
            qualifier,
          ),
        );
        break;
      }
      // Associated types: `type Output;` (trait) or `type Output = T;` (impl).
      case 'associated_type':
      case 'type_item': {
        const name = member.childForFieldName('name')?.text;
        if (!name) break;
        outSymbols.push(
          makeRustSymbol(
            member,
            declSignature(member, content),
            fileInfo,
            'type',
            name,
            `${fileInfo.path}:${className}.${name}`,
            memberExported(member),
            rustDoc(member),
            occurrences,
            qualifier,
          ),
        );
        break;
      }
      // macro_invocation, attribute_item, comments — no member symbol.
      default:
        break;
    }
  }
}

// Inline `mod m { .. }` → a 'module' symbol plus recursion into the body with
// `m` appended to the module path. External `mod m;` (no body) → a declaration-
// only 'module' symbol (the target file is indexed separately via the .rs scan).
function extractMod(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  containerExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outImports: ImportInfo[],
  outBodies: PendingBody[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && hasPubVisibility(decl);
  outSymbols.push(
    makeRustSymbol(
      decl,
      declSignature(decl, content),
      fileInfo,
      'module',
      name,
      `${fileInfo.path}:${name}`,
      exported,
      rustDoc(decl),
      occurrences,
      modulePath,
    ),
  );
  const body = decl.childForFieldName('body');
  if (body?.type !== 'declaration_list') return;
  extractItems(
    body.namedChildren,
    content,
    fileInfo,
    joinQualifier(modulePath, name),
    exported,
    occurrences,
    outSymbols,
    outImports,
    outBodies,
  );
}

// `macro_rules! m { .. }` → a findable 'function'-kind symbol. Macros carry no
// visibility node (even `#[macro_export]` is a separate attribute_item sibling),
// so they're always exported=false. Macro INVOCATIONS emit no refs (token-tree
// args are opaque to tree-sitter) — a documented recall gap.
function extractMacro(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  modulePath: string,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  outSymbols.push(
    makeRustSymbol(
      decl,
      declSignature(decl, content),
      fileInfo,
      'function',
      name,
      `${fileInfo.path}:${name}`,
      false,
      rustDoc(decl),
      occurrences,
      modulePath,
    ),
  );
}

// Impl target type name: unwrap the `type:` field (NOT `trait:` — methods
// belong to the implementing type). generic_type → its `type` field;
// scoped_type_identifier → last `name` segment. Non-nominal targets
// (reference/tuple/array/dynamic/pointer types) return null and their methods
// are skipped (no name to key on).
function implTypeName(decl: Node): string | null {
  let type = decl.childForFieldName('type');
  if (type?.type === 'generic_type') type = type.childForFieldName('type');
  if (!type) return null;
  if (type.type === 'type_identifier') return type.text;
  if (type.type === 'scoped_type_identifier') return type.childForFieldName('name')?.text ?? null;
  return null;
}

function hasPubVisibility(decl: Node): boolean {
  for (const child of decl.namedChildren) {
    if (child.type === 'visibility_modifier') return child.text.startsWith('pub');
  }
  return false;
}

// Module path and enclosing-type chain are opaque to FQN parsing — they only
// disambiguate hashed ids — so any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}::${b}`;
}

function makeRustSymbol(
  node: Node,
  signature: string,
  fileInfo: FileInfo,
  kind: SymbolKind,
  name: string,
  fqn: string,
  exported: boolean,
  doc: string | null,
  occurrences: OccurrenceCounter,
  qualifier = '',
): Symbol {
  // Repeated identical (name, kind, signature, qualifier) tuples — legal for
  // same-signature methods across two trait impls on one type — get an ordinal
  // so ids stay unique per file.
  const key = `${name}\0${kind}\0${signature}\0${qualifier}`;
  const n = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, n);
  const effectiveQualifier = n === 1 ? qualifier : `${qualifier}#${n}`;
  return {
    // The id hashes the FULL signature; only the stored copy is capped.
    id: symbolId(fileInfo.path, name, kind, signature, effectiveQualifier),
    name,
    fqn,
    kind,
    file: fileInfo.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
    doc,
    exported,
    language: fileInfo.language,
  };
}

// Rustdoc — diverges from BOTH Go and Java: outer doc comments (`///`, `/**`)
// sit ABOVE any `#[attr]` siblings (attributes are separate nodes, not inside
// the decl), so walk back over attribute_item nodes first. `///` parses as a
// line_comment with a `doc:` field child (text pre-stripped of the slashes) and
// an `outer:` marker; `//!` carries an `inner:` marker and documents the
// ENCLOSING item, so it's excluded. Plain `//` / `/* */` have a null `doc`
// field. Take the first content line of the contiguous outer-doc block.
function rustDoc(decl: Node): string | null {
  // Anchor = top of the contiguous attribute block (or the decl), so the doc
  // block's adjacency is measured against whatever sits directly below it.
  let anchorRow = decl.startPosition.row;
  let prev = decl.previousNamedSibling;
  while (prev && prev.type === 'attribute_item') {
    anchorRow = prev.startPosition.row;
    prev = prev.previousNamedSibling;
  }
  if (!prev || !isOuterDocComment(prev) || rustIsTrailingComment(prev)) return null;
  if (commentEndContentRow(prev) !== anchorRow - 1) return null;

  const chain: Node[] = [prev];
  for (;;) {
    // chain is seeded with `prev` and only grows, so the last element is
    // always defined (no need for the defensive guard go.ts carries).
    const bottom = chain[chain.length - 1]!;
    const p = bottom.previousNamedSibling;
    if (
      !p ||
      !isOuterDocComment(p) ||
      rustIsTrailingComment(p) ||
      commentEndContentRow(p) !== bottom.startPosition.row - 1
    ) {
      break;
    }
    chain.push(p);
  }
  chain.reverse(); // document order
  for (const comment of chain) {
    const line = docCommentFirstLine(comment);
    if (line) return line;
  }
  return null;
}

// tree-sitter-rust line_comment nodes INCLUDE their trailing newline (a `///`
// on row N reports endPosition.row N+1), while block_comment nodes do not. Use
// the last row that actually holds comment text so adjacency math is uniform.
function commentEndContentRow(node: Node): number {
  return node.text.endsWith('\n') ? node.endPosition.row - 1 : node.endPosition.row;
}

// A comment sharing its line with the END of an earlier sibling is a trailing
// comment on that statement, not doc for the next item. The shared
// isTrailingComment can't be reused: a preceding `///` line's newline-inflated
// endPosition.row equals the next comment's startPosition.row, which would
// misflag every second line of a multi-line doc block as trailing. Comparing
// content-end rows (newline-stripped) fixes it and still catches real trailing
// comments (`let x = 1; // c`), whose code sibling has no trailing newline.
function rustIsTrailingComment(comment: Node): boolean {
  const before = comment.previousSibling;
  if (!before) return false;
  return commentEndContentRow(before) === comment.startPosition.row;
}

function isOuterDocComment(node: Node): boolean {
  if (node.type !== 'line_comment' && node.type !== 'block_comment') return false;
  return node.childForFieldName('doc') !== null && node.childForFieldName('inner') === null;
}

// First non-empty line of a doc comment's `doc` field. The field text keeps a
// leading space, a trailing newline, and (for `/** */`) ` * ` continuation
// markers — strip a leading `*` and surrounding whitespace per line.
function docCommentFirstLine(node: Node): string | null {
  const doc = node.childForFieldName('doc');
  if (!doc) return null;
  for (const raw of doc.text.split('\n')) {
    const cleaned = raw.replace(/^\s*\*?\s?/, '').trim();
    if (cleaned) return cleaned;
  }
  return null;
}

// `use` declarations → one ImportInfo per imported leaf. The argument is a
// scoped_identifier, scoped_use_list, use_as_clause, use_wildcard, use_list, or
// bare identifier; nested `{ .. }` lists recurse, accumulating the path prefix.
function extractUse(decl: Node, fileInfo: FileInfo, out: ImportInfo[]): void {
  const arg = decl.childForFieldName('argument');
  if (!arg) return;
  walkUse(arg, '', fileInfo, decl.startPosition.row + 1, out);
}

function walkUse(node: Node, prefix: string, fileInfo: FileInfo, line: number, out: ImportInfo[]): void {
  const push = (sourceModule: string, imported: ImportedName): void => {
    out.push({ file: fileInfo.path, sourceModule: stripPathAnchor(sourceModule), importedNames: [imported], line });
  };
  switch (node.type) {
    case 'identifier':
      push(prefix, { name: node.text });
      return;
    case 'scoped_identifier': {
      const name = node.childForFieldName('name');
      const path = node.childForFieldName('path');
      if (!name) return;
      push(joinPath(prefix, path?.text), { name: name.text });
      return;
    }
    case 'self': {
      // `use a::b::{self}` binds the module `b` (last segment of the prefix).
      const sep = prefix.lastIndexOf('::');
      const seg = sep === -1 ? prefix : prefix.slice(sep + 2);
      if (seg) push(prefix, { name: seg, kind: 'module' });
      return;
    }
    case 'use_as_clause': {
      const path = node.childForFieldName('path');
      const alias = node.childForFieldName('alias');
      if (path?.type === 'scoped_identifier') {
        const inner = path.childForFieldName('name');
        const innerPath = path.childForFieldName('path');
        if (inner) push(joinPath(prefix, innerPath?.text), { name: inner.text, alias: alias?.text });
      } else if (path) {
        push(prefix, { name: path.text, alias: alias?.text });
      }
      return;
    }
    case 'use_wildcard': {
      // The scoped path is a positional child (no field).
      const inner = node.namedChild(0);
      push(joinPath(prefix, inner?.text), { name: IMPORT_NAMESPACE });
      return;
    }
    case 'scoped_use_list': {
      const path = node.childForFieldName('path');
      const list = node.childForFieldName('list');
      const newPrefix = joinPath(prefix, path?.text);
      if (list) for (const item of list.namedChildren) walkUse(item, newPrefix, fileInfo, line, out);
      return;
    }
    case 'use_list':
      for (const item of node.namedChildren) walkUse(item, prefix, fileInfo, line, out);
      return;
    // crate / super / metavariable path roots — no usable binding.
    default:
      return;
  }
}

function joinPath(prefix: string, seg: string | undefined): string {
  if (!seg) return prefix;
  if (!prefix) return seg;
  return `${prefix}::${seg}`;
}

// Drops a leading crate::/self::/super:: anchor chain from a use-path's module.
// These anchors locate the path but don't identify the module for the name-
// based cross-file resolution Rust uses, so `use crate::foo::Bar` and a
// re-exported `use foo::Bar` normalize to the same sourceModule ('foo') instead
// of the inconsistent 'crate::foo' vs 'foo'.
function stripPathAnchor(mod: string): string {
  return mod.replace(/^(?:(?:crate|self|super)::)+/, '');
}
