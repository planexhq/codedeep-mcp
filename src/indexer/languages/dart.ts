import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportInfo, ImportedName, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  collectAmbiguousTypeNames,
  commentDocLine,
  isTrailingComment,
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
import { computeComplexity } from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Nested `local_function_declaration`s create their own scope — their calls
// must NOT attribute to an enclosing body, so they're pruned from the body walk
// (and aren't extracted, the top-level + member-only rule). `function_expression`
// (closures, `(e) => f(e)`) is deliberately ABSENT: a closure can't be a symbol,
// so calls inside `items.forEach((e) => f(e))` attribute to the enclosing body
// (the Go func_literal / Java lambda / Kotlin lambda rule, not the TS arrow rule).
const DART_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['local_function_declaration']);

// walkCalls skip set: nested funcs (own scope, above) PLUS `annotation` — Dart
// annotation arguments must be const expressions, but `@Foo(bar())` still parses
// a REAL call_expression inside the `annotation` node (a direct child of the
// declaration or class_member), which the body and module-root walks would
// otherwise emit as a spurious `calls` ref. Skipping `annotation` drops those.
const DART_SKIP_TYPES: ReadonlySet<string> = new Set(['local_function_declaration', 'annotation']);

// A bare `identifier` callee binds to free functions AND classes. 'class' is
// here — the inverse of Go/Rust — because Dart construction is shape-identical
// to a call (`Circle(3)` has no `new` and no distinct construction node, exactly
// like Swift/Kotlin), so `bareCallableKinds` is the ONLY lever to resolve
// `Circle(3)` to its type. Accepted error class: a bare call colliding with a
// same-named type resolves to the type, which for Dart `Type(...)` is
// construction by convention. The enclosing-class fallback runs FIRST
// (bareCallsBindToEnclosingClass), so an implicit-this method call beats a
// same-named type — which keeps 'class' safe. (Bare callee is the engine-default
// `identifier`, so no plainCalleeType override — unlike Swift.)
const DART_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'class']);

// Kinds sharing the simple-name FQN namespace — duplicates among these are
// excluded from extract-time resolution. (class/mixin→class, enum→enum,
// typedef→type.) Extensions are NOT symbols, so two extensions of one type never
// make that type look ambiguous.
const DART_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'enum', 'type']);

// Dart stdlib globals / scalar conversions that parse as bare calls and would
// otherwise flood the name-keyed reference store. Suppressed ONLY when
// unresolved (a file-local function shadowing the name keeps its refs). Scalar
// conversions (`int.parse`, `String(x)` is not a thing — Dart has no scalar
// conversion calls) are minimal here. Start small; extend after dogfood.
const DART_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  'print', 'identical', 'identityHashCode', 'assert',
  'min', 'max', 'pow', 'sqrt',
  'jsonEncode', 'jsonDecode',
]);

// Signature node types under a `method_signature` (bodied member) or a bodiless
// `declaration` member.
const DART_SIG_TYPES = [
  'function_signature',
  'getter_signature',
  'setter_signature',
  'operator_signature',
  'constructor_signature',
  'constant_constructor_signature',
  'factory_constructor_signature',
  'redirecting_factory_constructor_signature',
] as const;

// The subset that are constructors → method named 'constructor' (unnamed) or the
// named-ctor segment.
const DART_CTOR_SIG_TYPES: ReadonlySet<string> = new Set([
  'constructor_signature',
  'constant_constructor_signature',
  'factory_constructor_signature',
  'redirecting_factory_constructor_signature',
]);

// Callee of a `call_expression` = its `function:` field (identifier for
// bare/construction calls, member_expression for member/static/named-ctor calls).
//
// Grammar quirk recovery: an inline arrow closure whose body is itself a call —
// `(x) => f(x)` (bare) or `() => obj.m()` (member) — mis-parses as `((x) => f)(x)`,
// i.e. the trailing call args bind to the CLOSURE, leaving the real callee as the
// closure's arrow-body tail. `unwrapClosureTail` descends a function_expression to
// that tail. For a BARE-call body the function_expression sits directly in the
// call's `function:` slot (handled here); for a MEMBER-call body the slot is a
// member_expression whose `object:` is the function_expression (handled in
// dartMemberCallInfo, which unwraps the object). Inline arrow closures are
// ubiquitous in Dart (`.map`, `.where`, Flutter callbacks), so recovering both
// matters. NOT recoverable: a COMPOUND arrow body (`(e) => cond && f(e)`) — the
// misparse strips f's args, so that call is genuinely destroyed; the tail is a
// non-callee node and yields no ref (a documented recall gap, never a false edge).
function unwrapClosureTail(node: Node | null): Node | null {
  let n: Node | null = node;
  while (n?.type === 'function_expression') {
    const body = n.childForFieldName('body'); // function_expression_body
    // The arrow body expr is the LAST child (after the `=>` token). Use child()
    // not namedChildren — for `() => this` the body expr is the anonymous `this`
    // token, which namedChildren omits (so the self-receiver would be lost).
    const last = body && body.childCount > 0 ? body.child(body.childCount - 1) : null;
    n = last && last.type !== '=>' ? last : null;
  }
  return n;
}

function dartCallCallee(node: Node): Node | null {
  return unwrapClosureTail(node.childForFieldName('function'));
}

const DART_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call_expression', getCallee: dartCallCallee },
  // Cascade method-calls (`obj..a()..b()`). The node IS its own "callee": it
  // carries the property but its receiver is a SIBLING of the enclosing
  // cascade_section, reached via parent navigation in dartMemberCallInfo.
  // Field-assignment cascades (`obj..x = 1`) use `cascade_selector` + `=`, NOT
  // `cascade_call_expression`, so they emit nothing (correct — not a call).
  { nodeType: 'cascade_call_expression', getCallee: (n) => n },
];

// Peels transparent receiver wrappers — null-assertion `a!` (null_assertion_
// expression) and parens `(a)` (parenthesized_expression) — so `a!.x()` / `(a).x()`
// resolve like `a.x()`. The operand is the lone non-punctuation child, found by
// scanning ALL children (NOT firstNamedChild): `this`/`super` are ANONYMOUS tokens,
// so firstNamedChild misses them — skipping the wrapper's own `(`/`)`/`!` punctuation
// and comments instead recovers them, so `(this).x()` self-resolves and `(super).x()`
// hits the super-drop (rather than leaking an opaque ref past it). A genuine chain
// (`a.b().c()`) is not a wrapper → stays intact → opaque.
function unwrapDartReceiver(node: Node | null): Node | null {
  let n = node;
  while (n && (n.type === 'null_assertion_expression' || n.type === 'parenthesized_expression')) {
    let inner: Node | null = null;
    for (let i = 0; i < n.childCount; i++) {
      const c = n.child(i);
      if (!c || c.type === '(' || c.type === ')' || c.type === '!' || c.type === 'comment') continue;
      inner = c;
      break;
    }
    if (!inner) break;
    n = inner;
  }
  return n;
}

// Reduces a member-expression (`a.m()`), null-aware member call (`a?.m()` —
// `null_aware_member_expression`, the dominant Dart null-safety call shape, which
// shares object/property fields), OR cascade-call callee to {receiver, property}.
// `this` is a fixed token (a `this` node), decided here like Swift/Kotlin/Python.
// A non-null `a!.m()` or parenthesized `(a).m()` receiver is unwrapped to its token
// too. A chained/computed receiver (`a.b().c()`, `list[0].run()`) carries
// RECEIVER_OPAQUE: findable by name but never resolved. `super.m()` / `super..m()`
// and computed/non-identifier property names emit nothing.
function dartMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'member_expression' || callee.type === 'null_aware_member_expression') {
    // unwrapClosureTail recovers the `() => obj.m()` arrow-closure misparse; then
    // peel `!`/parens wrappers to recover a resolvable single-identifier receiver.
    const object = unwrapDartReceiver(unwrapClosureTail(callee.childForFieldName('object')));
    const property = callee.childForFieldName('property');
    if (property?.type !== 'identifier') return null;
    if (object?.type === 'this') return { receiver: 'this', property: property.text, isSelf: true };
    if (object?.type === 'identifier') return { receiver: object.text, property: property.text, isSelf: false };
    if (object?.type === 'super') return null; // parent-class call, skipped (the TS/Java rule)
    return { receiver: RECEIVER_OPAQUE, property: property.text, isSelf: false };
  }
  if (callee.type === 'cascade_call_expression') {
    const property = callee.childForFieldName('property');
    if (property?.type !== 'identifier') return null;
    // Receiver = the cascade target: the sibling immediately before THIS chain's
    // first `cascade_section`. Walk back over the CONTIGUOUS run of cascade_sections
    // from the current one (so `f(a..x(), b..y())` correctly keeps `b` for `..y()`
    // rather than the host's globally-first target `a`). previousSibling is used
    // (not namedChildren) because the `this` target is an ANONYMOUS token.
    const section = callee.parent;
    if (section?.type !== 'cascade_section') return null;
    // Skip comments while navigating siblings — `obj /*c*/ ..m()` and
    // `obj..m() /*c*/ ..n()` would otherwise land the target/walk on a comment node.
    const prevNonComment = (x: Node): Node | null => {
      let p = x.previousSibling;
      while (p && p.type === 'comment') p = p.previousSibling;
      return p;
    };
    let first = section;
    while (prevNonComment(first)?.type === 'cascade_section') first = prevNonComment(first)!;
    const target = unwrapDartReceiver(prevNonComment(first));
    if (target?.type === 'this') return { receiver: 'this', property: property.text, isSelf: true };
    if (target?.type === 'identifier') return { receiver: target.text, property: property.text, isSelf: false };
    if (target?.type === 'super') return null; // `super..m()` parent-class call (the member-form rule)
    // construction/chained/computed cascade target → opaque (findable, unresolved).
    return { receiver: RECEIVER_OPAQUE, property: property.text, isSelf: false };
  }
  return null;
}

// Dominant Dart Iterable/collection/string/Future method names (>=4 chars)
// suppressed when a member call to them is unresolved — capturing chained
// `.where().map().toList()` calls otherwise floods the name-keyed store. Domain
// method names are deliberately absent. <=3-char names (`.map`) are gated
// downstream by SHORT_NAME_THRESHOLD.
const DART_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'where', 'expand', 'reduce', 'fold', 'forEach', 'firstWhere', 'lastWhere',
  'singleWhere', 'every', 'contains', 'containsKey', 'containsValue', 'elementAt',
  'toList', 'toSet', 'toString', 'join', 'skip', 'take', 'takeWhile',
  'skipWhile', 'followedBy', 'whereType', 'cast', 'asMap', 'indexOf',
  'sublist', 'insert', 'remove', 'removeAt', 'removeWhere', 'removeLast',
  'clear', 'sort', 'shuffle', 'addAll', 'getRange',
  'substring', 'replaceAll', 'replaceFirst', 'split', 'trim', 'startsWith',
  'endsWith', 'padLeft', 'padRight', 'toLowerCase', 'toUpperCase', 'then',
  'catchError', 'whenComplete', 'listen', 'cancel', 'noSuchMethod',
]);

// ── complexity (cyclomatic S1541 + cognitive S3776), pinned for behavioral
// compatibility with SonarQube's Dart rules, per the published Cognitive Complexity
// whitepaper and the public S1541/S3776 rule definitions. ──

// CYCLOMATIC decision nodes (+1 each). if + collection-`if` (`if_element`); ternary;
// all loops (C-`for`/`for-in`/`await for` all parse as `for_statement`; `while`/`do`)
// + collection-`for` (`for_element`); each switch-STATEMENT `case` AND switch-
// EXPRESSION arm (incl the `_` wildcard arm — `switch_*_default`/the container add
// nothing); and the per-OPERATOR null-aware/boolean nodes `&&`/`||`
// (logical_and/or_expression), `??` (if_null_expression — note `??` is cyclomatic
// but FREE cognitively), `?.` (null_aware_member_expression). `??=` is added by
// dartCyclomaticExtra; `?..` (a cascade, not a null_aware_member_expression) is not.
const DART_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'if_element',
  'conditional_expression',
  'for_statement',
  'for_element',
  'while_statement',
  'do_statement',
  'switch_statement_case',
  'switch_expression_case',
  'logical_and_expression',
  'logical_or_expression',
  'if_null_expression',
  'null_aware_index_expression', // `a?[i]` null-aware index access (read) — always +1
  // `null_aware_member_expression` (`?.`) is NOT here — its counting is context-
  // dependent (property access counts, method-call callee does not), handled in
  // dartCyclomaticExtra.
]);

// Two cyclomatic decisions a flat node-type set can't express:
//   1. `??=` shares `assignment_expression` with `=`/`+=`/etc. (told apart by the
//      `operator:` field text).
//   2. `?.` (`null_aware_member_expression`) counts as a null-aware PROPERTY ACCESS
//      (`a?.length` → +1) but NOT as the callee of a null-aware INVOCATION
//      (`a?.m()` → +0) — measured EXACT (`a?.length` = cyc 2, `a?.m()` = cyc 1,
//      `a?.b?.c()` = cyc 2: the `?.b` property counts, the `?.c()` call does not).
//      Detected by whether the node is the `function:` child of a `call_expression`.
//   3. A null-aware WRITE `a?.b = …` / `a?[i] = …` (incl compound `+=`) parses as an
//      `assignable_expression` whose trailing null-aware selector is an ANONYMOUS
//      token — `?.` for a property write, a bare `?` (before `[`) for an index write
//      (the read forms are a null_aware_member_expression / null_aware_index_expression
//      above). The cyclomatic DFS visits only NAMED children, so the token is counted
//      here via its parent. One null-aware selector per assignable_expression level
//      (a deeper `a?.b?.c =` nests the inner read).
// True when a `null_aware_member_expression` is the callee of a (possibly generic)
// null-aware invocation `a?.m(...)` / `a?.m<T>(...)` — those don't count, while a
// bare null-aware property access `a?.x` does. A generic call wraps the callee in an
// `instantiation_expression` (`function: instantiation_expression{ function: a?.m,
// type_arguments: <T> }`) before the `call_expression`, so step through it.
function dartNullAwareMemberIsCallee(node: Node): boolean {
  let cur: Node = node;
  let parent = cur.parent;
  if (
    parent?.type === 'instantiation_expression' &&
    parent.childForFieldName('function')?.id === cur.id
  ) {
    cur = parent;
    parent = cur.parent;
  }
  return parent?.type === 'call_expression' && parent.childForFieldName('function')?.id === cur.id;
}

function dartCyclomaticExtra(node: Node): boolean {
  switch (node.type) {
    case 'assignment_expression':
      return node.childForFieldName('operator')?.text === '??='; // null-aware compound assign
    case 'null_aware_member_expression':
      return !dartNullAwareMemberIsCallee(node); // access `a?.x` → +1; call `a?.m()` → 0
    case 'assignable_expression': // null-aware WRITE `a?.b = …` / `a?[i] = …` (anonymous `?.`/`?` token)
      return node.children.some((c) => c?.type === '?.' || c?.type === '?');
    case 'spread_element': // null-aware spread `...?x` (token `...?`); plain `...x` is not a decision
      return node.children.some((c) => c?.type === '...?');
    default:
      return false;
  }
}

// COGNITIVE boolean-run reader: `&&`/`||` count (their own distinct nodes), while `??`
// (if_null_expression) is FREE cognitively — the expected cyc/cog divergence (cyclomatic
// counts `??`). Counted TREE-SCOPED (booleanByTreeParent): a `&&`/`||` adds +1 iff its
// nearest logical ancestor (skipping parens) is a different kind — the SonarQube Dart model,
// distinct from sonar-java's source-order flatten and SonarJS's `&&`-only runs.
function dartCognitiveBooleanKind(node: Node): string | null {
  if (node.type === 'logical_and_expression') return '&&';
  if (node.type === 'logical_or_expression') return '||';
  return null;
}

// Complexity body boundary — skip ONLY `annotation` (its args are const expressions,
// not executable: `@Foo(c ? a : b)` must not count). `local_function_declaration` and
// `function_expression` (closures) are DELIBERATELY ABSENT (so descended): the SonarQube
// Dart model rolls a local fn / lambda's control flow INTO the enclosing member with a nesting
// bump (measured: a member with a local-fn/lambda `if` reads cyc 2 / cog 2 with ONE
// per-member message). This is a SEPARATE set from DART_SKIP_TYPES (the resolveCalls
// boundary, which DOES prune local functions from call attribution) — complexity and
// call-graph have different boundaries here, both correct for their purpose.
const DART_COMPLEXITY_SKIP_TYPES: ReadonlySet<string> = new Set(['annotation']);

// Cognitive config (SonarQube Dart cognitive rule S3776). Grammar + algorithm shapes forced:
// the `if_statement` condition/pattern/`when`-guard are POSITIONAL (no condition field) →
// conditionFromNamedChildren; catch bodies are SIBLINGS of `catch_clause` → the `tryType`
// handler; collection-`if` (`if_element`) charges its `else` like a statement if →
// collectionIfType (NOT a switch); `&&`/`||` runs are TREE-SCOPED (a kind-change vs the
// logical ancestor, distinct from sonar-java/SonarJS) → booleanByTreeParent.
const DART_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  collectionIfType: 'if_element', // collection-if charges its else (`[if(b)1 else 2]` = cog 2)
  conditionFromNamedChildren: true, // positional condition/pattern/`when`-guard (booleans + guards count)
  conditionField: '__dart_unused__', // sentinel — conditionFromNamedChildren replaces the field walk
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  loopTypes: new Set(['for_statement', 'for_element', 'while_statement', 'do_statement']),
  // No loopBodyField: the SonarQube Dart rule nests the WHOLE loop (a ternary in a `for` init reads
  // cog 3 — the header IS bumped, unlike sonar-python). Bump-all-children is correct here.
  switchTypes: new Set(['switch_statement', 'switch_expression']), // whole-switch +1 (stmt AND expr)
  ternaryType: 'conditional_expression',
  tryType: { node: 'try_statement', bodyField: 'body', catchBodyType: 'block' }, // flat sibling catch bodies
  catchType: '__dart_no_catch__', // sentinel — tryType handles every catch (incl binding-less `on E {}`)
  nestOnlyTypes: new Set(['function_expression', 'local_function_declaration']), // closures + local fns roll in (+0, nest)
  labeledJumpTypes: new Set(['break_statement', 'continue_statement']),
  hasLabel: (n) => n.namedChildren.some((c) => c.type === 'identifier'), // labeled = a positional identifier child
  booleanOperatorKind: dartCognitiveBooleanKind,
  booleanByTreeParent: true, // tree-scoped runs (a logical op counts iff != its logical-ancestor kind)
  parenthesizedType: 'parenthesized_expression', // skipped when finding the logical ancestor
  // No recursion (a self-call adds 0 cognitively — measured). No initField (for-init isn't a distinct if-init).
};

// Per-file duplicate-id disambiguation. A named ctor duplicating a method name,
// or an extension method duplicating a type method, can be byte-identical in
// (name, kind, signature, qualifier). Repeats get an ordinal qualifier.
type OccurrenceCounter = Map<string, number>;

interface DartCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
}

export function extractDart(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const ctx: DartCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  extractTopLevel(ctx, tree.rootNode);

  // Same-name types in one file are invalid Dart, so this only fires on broken
  // parses — where refusing resolution beats binding through a half-parsed type.
  const ambiguousTypeNames = collectAmbiguousTypeNames(ctx.symbols, DART_TYPE_KINDS);

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    DART_SELECTORS,
    DART_SKIP_TYPES,
    DART_FUNCTION_BODY_SKIP_TYPES,
    dartMemberCallInfo,
    {
      // Bare/construction callee is the engine-default `identifier` — no
      // plainCalleeType override. Dart allows implicit-this bare method calls
      // (`m(){ helper() }` → this.helper()), so a bare call resolves against the
      // enclosing class first.
      bareCallsBindToEnclosingClass: true,
      bareCallableKinds: DART_BARE_CALLABLE_KINDS,
      // No constructorKinds: construction has no distinct node; it resolves as a
      // bare call to a 'class'-kind symbol via bareCallableKinds.
      ambiguousClassNames: ambiguousTypeNames,
      ignoredBareCallees: DART_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: DART_IGNORED_MEMBER_CALLEES,
    },
  );

  // Cyclomatic + cognitive complexity, computed while the tree is alive (the
  // Go/Kotlin call-site pattern). Uses its OWN skip set (local fns + closures roll
  // into the enclosing member — the SonarQube Dart per-member model), not DART_SKIP_TYPES.
  computeComplexity(ctx.bodies, ctx.symbols, {
    decisionNodeTypes: DART_DECISION_NODE_TYPES,
    extraDecisionPredicate: dartCyclomaticExtra,
    skipTypes: DART_COMPLEXITY_SKIP_TYPES,
    cognitive: DART_COGNITIVE_OPTIONS,
  });

  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Top-level source_file items. containerExported is true (the file is the
// module surface); qualifier is empty.
function extractTopLevel(ctx: DartCtx, root: Node): void {
  for (const child of root.namedChildren) {
    const doc = dartDoc(child);
    switch (child.type) {
      case 'import_or_export':
        extractImport(ctx, child);
        break;
      case 'class_declaration':
      case 'mixin_declaration':
        extractClass(ctx, child, doc, '', true);
        break;
      case 'extension_declaration':
        extractExtension(ctx, child, '', true);
        break;
      case 'extension_type_declaration':
        extractExtensionType(ctx, child, doc, '', true);
        break;
      case 'enum_declaration':
        extractEnum(ctx, child, doc, '', true);
        break;
      case 'type_alias':
        extractTypeAlias(ctx, child, doc, '', true);
        break;
      // function / getter / setter, plus their `external` interop forms (dart:ffi,
      // dart:js_interop), all carry a `signature:` field with a `name:`.
      case 'function_declaration':
      case 'external_function_declaration':
      case 'getter_declaration':
      case 'setter_declaration':
      case 'external_getter_declaration':
      case 'external_setter_declaration':
        extractTopLevelFunction(ctx, child, doc, '', true);
        break;
      case 'top_level_variable_declaration':
      case 'external_variable_declaration':
        extractVariableDecl(ctx, child, doc, undefined, '', true);
        break;
      // library_name, part_directive, part_of_directive, comments, ERROR — no symbols.
      default:
        break;
    }
  }
}

// class / mixin → 'class' kind (one shared handler — both have a `name` field and
// a `class_body`). Dart has no nested type declarations, so there is no recursion
// into nested classes (only local functions, which aren't members).
function extractClass(
  ctx: DartCtx,
  decl: Node,
  doc: string | null,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && !isPrivate(name);
  ctx.symbols.push(
    makeDartSymbol(ctx, decl, dartSig(ctx, decl), 'class', name, topFqn(ctx, name), exported, doc, parentQualifier),
  );
  const body = decl.childForFieldName('body'); // class_body
  if (body) extractMemberBody(ctx, body, name, joinQualifier(parentQualifier, name), exported);
}

// enum → 'enum' kind. enum_constant cases are NOT extracted (the TS/Java/Go/Rust/
// Swift/Kotlin enum-member rule); enhanced-enum members after the `;` (methods,
// fields, constructors) ARE — keyed on the enum name. Enum-constant constructor
// arguments (`earth(5.9)`) run at enum init but have no symbol owner, so their
// calls fall to the module-root walk (a documented minor recall gap).
function extractEnum(
  ctx: DartCtx,
  decl: Node,
  doc: string | null,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && !isPrivate(name);
  ctx.symbols.push(
    makeDartSymbol(ctx, decl, dartSig(ctx, decl), 'enum', name, topFqn(ctx, name), exported, doc, parentQualifier),
  );
  const body = decl.childForFieldName('body'); // enum_body
  if (body) extractMemberBody(ctx, body, name, joinQualifier(parentQualifier, name), exported);
}

// `extension Name on Type { ... }` — not a symbol. Its members key on the
// EXTENDED type (`file:Type.member`), merging into the same methodsByClass[Type]
// as the type's own methods (the Rust impl-merge / Go-receiver / Swift-extension
// pattern), so `self.m()` here and `obj.m()` elsewhere both resolve. Anonymous
// extensions (`extension on Type`) are kept — they still key on the on-type.
function extractExtension(
  ctx: DartCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const onType = extensionOnTypeName(decl);
  if (!onType) return; // non-nominal on-type (function/record type) — no key
  const extName = decl.childForFieldName('name')?.text;
  // An extension's members are exported per the EXTENSION's own visibility (the
  // leading-underscore on its NAME — the Swift/Kotlin rule), NOT the extended
  // type's: a `private` extension makes its members library-private regardless of
  // the on-type. An anonymous extension (no name) is public. Members AND-in their
  // own underscore.
  const exported = containerExported && !(extName !== undefined && isPrivate(extName));
  const body = decl.childForFieldName('body'); // extension_body
  if (body) extractMemberBody(ctx, body, onType, joinQualifier(parentQualifier, extName ?? onType), exported);
}

// A class_body / extension_body / enum_body. Each member is a `class_member`
// wrapper (enum_body also carries leading `enum_constant`s, skipped). The
// payload inside class_member is either `method_declaration` (bodied) or a
// bodiless `declaration`.
function extractMemberBody(
  ctx: DartCtx,
  body: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  for (const member of body.namedChildren) {
    if (member.type !== 'class_member') continue; // enum_constant, comments, ERROR
    const doc = dartDoc(member);
    const payload = childOfType(member, 'method_declaration', 'declaration');
    if (!payload) continue;
    dispatchMember(ctx, payload, doc, className, qualifier, containerExported);
  }
}

// Route a member payload (method_declaration | declaration) to method, ctor, or
// field handling.
function dispatchMember(
  ctx: DartCtx,
  payload: Node,
  doc: string | null,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  if (payload.type === 'method_declaration') {
    const sig = payload.childForFieldName('signature'); // method_signature
    const inner = sig ? childOfType(sig, ...DART_SIG_TYPES) : null;
    const body = payload.childForFieldName('body');
    if (inner) handleCallable(ctx, inner, payload, body, doc, className, qualifier, containerExported);
    return;
  }
  // bodiless `declaration`: abstract method / getter / setter / ctor, or a field.
  const inner = childOfType(payload, ...DART_SIG_TYPES);
  if (inner) {
    handleCallable(ctx, inner, payload, null, doc, className, qualifier, containerExported);
    return;
  }
  extractVariableDecl(ctx, payload, doc, className, qualifier, containerExported);
}

// A method / getter / setter / operator / constructor signature.
function handleCallable(
  ctx: DartCtx,
  inner: Node,
  payload: Node,
  body: Node | null,
  doc: string | null,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  if (DART_CTOR_SIG_TYPES.has(inner.type)) {
    // A return-type-less method (`f() => g();`) parses as `constructor_signature`
    // — the classic Dart ctor/method parse ambiguity. A REAL constructor always
    // leads with the class name (`A()` / `A.named()`); factories likewise. If the
    // first name segment isn't the class name, it's actually a method, so fall
    // through to the method branch (childForFieldName('name') yields its name).
    const isFactory =
      inner.type === 'factory_constructor_signature' ||
      inner.type === 'redirecting_factory_constructor_signature';
    const firstName = inner.namedChildren.find((c) => c.type === 'identifier')?.text;
    if (isFactory || firstName === className) {
      extractConstructor(ctx, inner, payload, doc, className, qualifier, containerExported);
      return;
    }
  }
  const name =
    inner.type === 'operator_signature'
      ? inner.childForFieldName('operator')?.text
      : inner.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && !isPrivate(name);
  const sym = makeDartSymbol(
    ctx,
    payload,
    dartSig(ctx, payload),
    'method',
    name,
    memberFqn(ctx, className, name),
    exported,
    doc,
    qualifier,
  );
  ctx.symbols.push(sym);
  // Abstract members (no body) populate methodsByClass for resolution but own no
  // PendingBody.
  if (body) ctx.bodies.push({ symbolId: sym.id, body, className });
}

// A constructor (generative / const / factory / redirecting-factory) → a
// 'method'. Unnamed (`Box`) → name 'constructor' (TS convention; construction
// `Box(...)` resolves to the CLASS via bareCallableKinds, this symbol exists for
// find_symbol + to OWN its body's calls). Named (`Box.named`) → the last name
// segment, FQN `file:Box.named`, so `Box.named()` member calls resolve via
// methodsByClass[Box]. The PendingBody is the whole payload so default-arg, the
// `: a = f()` initializer list, the `: this.y()` redirect, and any factory body
// all attribute here and self-calls resolve.
function extractConstructor(
  ctx: DartCtx,
  inner: Node,
  payload: Node,
  doc: string | null,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const nameIds = inner.namedChildren.filter((c) => c.type === 'identifier');
  const ctorName = nameIds.length > 1 ? nameIds[nameIds.length - 1]!.text : 'constructor';
  const exported = containerExported && !isPrivate(ctorName);
  const sym = makeDartSymbol(
    ctx,
    payload,
    dartSig(ctx, payload),
    'method',
    ctorName,
    memberFqn(ctx, className, ctorName),
    exported,
    doc,
    qualifier,
  );
  ctx.symbols.push(sym);
  ctx.bodies.push({ symbolId: sym.id, body: payload, className });
}

// A field / top-level variable declaration → one 'variable' per name. Member
// fields and top-level vars share three list shapes: `initialized_identifier_list`
// (typed `int a, b = f()`), `static_final_declaration_list` (const/final), and
// `identifier_list` (an `external int a, b;` interop var — bare identifiers, no
// initializer). Each named binding with an initializer owns a PendingBody on its
// `value:` expression (the Swift per-binding rule), so `final x = compute()`
// attributes compute() to x; a value-less name (`int a;`) owns nothing.
function extractVariableDecl(
  ctx: DartCtx,
  declNode: Node,
  doc: string | null,
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const list = childOfType(
    declNode,
    'initialized_identifier_list',
    'static_final_declaration_list',
    'identifier_list',
  );
  if (!list) return;
  const signature = dartSig(ctx, declNode);
  for (const item of list.namedChildren) {
    // `identifier_list` holds bare `identifier`s (no name field/value); the other
    // two hold `initialized_identifier`/`static_final_declaration` with fields.
    const nameNode = item.type === 'identifier' ? item : item.childForFieldName('name');
    if (
      !nameNode ||
      (item.type !== 'identifier' &&
        item.type !== 'initialized_identifier' &&
        item.type !== 'static_final_declaration')
    ) {
      continue;
    }
    const name = nameNode.text;
    const exported = containerExported && !isPrivate(name);
    const sym = makeDartSymbol(
      ctx,
      declNode,
      signature,
      'variable',
      name,
      memberFqn(ctx, className, name),
      exported,
      doc,
      qualifier,
    );
    ctx.symbols.push(sym);
    const value = item.childForFieldName('value');
    if (value) ctx.bodies.push({ symbolId: sym.id, body: value, className });
  }
}

// Top-level function / getter / setter (and their `external` interop forms) →
// 'function'. All carry a `signature:` field (function_signature / getter_signature
// / setter_signature) whose `name:` is the symbol name; a body, when present
// (external decls have none), becomes a PendingBody so its calls attribute here.
function extractTopLevelFunction(
  ctx: DartCtx,
  decl: Node,
  doc: string | null,
  qualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('signature')?.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && !isPrivate(name);
  const sym = makeDartSymbol(ctx, decl, dartSig(ctx, decl), 'function', name, topFqn(ctx, name), exported, doc, qualifier);
  ctx.symbols.push(sym);
  const body = decl.childForFieldName('body');
  if (body) ctx.bodies.push({ symbolId: sym.id, body, className: undefined });
}

// `extension type Name(T repr) { ... }` (Dart 3.3+ zero-cost wrapper) → 'class'
// kind: construction `Name(x)` resolves to it like a normal class, and its body
// members (getters/methods) key on it. The name lives under `extension_type_name`
// (not a direct `name:` identifier), and the `representation:` declares the wrapped
// field, extracted as a variable member.
function extractExtensionType(
  ctx: DartCtx,
  decl: Node,
  doc: string | null,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const nameNode = decl.childForFieldName('name'); // extension_type_name
  const name = nameNode ? childOfType(nameNode, 'identifier')?.text : undefined;
  if (!name) return;
  const exported = containerExported && !isPrivate(name);
  ctx.symbols.push(
    makeDartSymbol(ctx, decl, dartSig(ctx, decl), 'class', name, topFqn(ctx, name), exported, doc, parentQualifier),
  );
  const qualifier = joinQualifier(parentQualifier, name);
  const repr = decl.childForFieldName('representation');
  const reprName = repr?.childForFieldName('name')?.text;
  if (reprName) {
    ctx.symbols.push(
      makeDartSymbol(
        ctx,
        repr,
        normalizeSignature(ctx.content.slice(repr.startIndex, repr.endIndex)),
        'variable',
        reprName,
        memberFqn(ctx, name, reprName),
        exported && !isPrivate(reprName),
        null,
        qualifier,
      ),
    );
  }
  const body = decl.childForFieldName('body'); // class_body
  if (body) extractMemberBody(ctx, body, name, qualifier, exported);
}

// typedef → 'type'. The alias name is the first `type_identifier` child (the
// aliased type follows, as a `type` node).
function extractTypeAlias(
  ctx: DartCtx,
  decl: Node,
  doc: string | null,
  qualifier: string,
  containerExported: boolean,
): void {
  const name = decl.namedChildren.find((c) => c.type === 'type_identifier')?.text;
  if (!name) return;
  const exported = containerExported && !isPrivate(name);
  ctx.symbols.push(
    makeDartSymbol(ctx, decl, dartSig(ctx, decl), 'type', name, topFqn(ctx, name), exported, doc, qualifier),
  );
}

// `import 'uri' [as a] [show A, B] [hide C];` → an ImportInfo. `show` → the named
// list; `hide`/no-combinator → a whole-library namespace import (aliased to the
// prefix when `as` is present). `export`/`part`/`library` directives are skipped
// (low cross-file value: Dart URIs don't map to indexed paths — the Rust/Kotlin
// framing).
function extractImport(ctx: DartCtx, node: Node): void {
  const lib = childOfType(node, 'library_import');
  if (!lib) return; // library_export — skipped
  const spec = childOfType(lib, 'import_specification');
  if (!spec) return;
  const uriNode = spec.childForFieldName('uri');
  if (!uriNode) return;
  const sourceModule = stripQuotes(uriNode.text);
  const line = node.startPosition.row + 1;
  const alias = spec.childForFieldName('alias')?.text;

  const showCombinator = spec.namedChildren.find(
    (c) => c.type === 'combinator' && nodeHasAnonChild(c, 'show'),
  );
  if (showCombinator) {
    // `import 'x' as p show A, B;` binds the shown names under the prefix, so
    // carry the alias onto each (the Kotlin named-import rule).
    const names: ImportedName[] = showCombinator.namedChildren
      .filter((c) => c.type === 'identifier')
      .map((c) => (alias ? { name: c.text, alias } : { name: c.text }));
    if (names.length > 0) {
      ctx.imports.push({ file: ctx.fileInfo.path, sourceModule, importedNames: names, line });
      return;
    }
  }
  const ns: ImportedName = alias
    ? { name: IMPORT_NAMESPACE, kind: 'namespace', alias }
    : { name: IMPORT_NAMESPACE, kind: 'namespace' };
  ctx.imports.push({ file: ctx.fileInfo.path, sourceModule, importedNames: [ns], line });
}

// ── helpers ──────────────────────────────────────────────────────────────

// Extended type's simple name = the LAST direct `type_identifier` of the `class:`
// (on-)type node. `extension on Map<String,int>` → Map (type_arguments is a
// separate child); a non-nominal on-type (function/record type) has no
// type_identifier → null (skip the whole extension).
function extensionOnTypeName(decl: Node): string | null {
  const classField = decl.childForFieldName('class');
  if (!classField) return null;
  let result: string | null = null;
  for (const c of classField.namedChildren) {
    if (c.type === 'type_identifier') result = c.text;
  }
  return result;
}

function topFqn(ctx: DartCtx, name: string): string {
  return `${ctx.fileInfo.path}:${name}`;
}

function memberFqn(ctx: DartCtx, className: string | undefined, name: string): string {
  return className ? `${ctx.fileInfo.path}:${className}.${name}` : `${ctx.fileInfo.path}:${name}`;
}

// First direct named child of one of the given types (or null).
function childOfType(node: Node, ...types: string[]): Node | null {
  return node.namedChildren.find((c) => types.includes(c.type)) ?? null;
}

// Declaration signature = source from the declaration start to its body (the
// `body:` field, present on function/method/getter/setter declarations), cut
// before a constructor `initializers` list, with a trailing `;` (carried by
// top-level/typedef nodes) stripped. Feeds symbolId hashing; the stored copy is
// capped by makeDartSymbol.
function dartSig(ctx: DartCtx, node: Node): string {
  let end = node.endIndex;
  const body = node.childForFieldName('body');
  if (body) end = Math.min(end, body.startIndex);
  const initializers = node.namedChildren.find((c) => c.type === 'initializers');
  if (initializers) end = Math.min(end, initializers.startIndex);
  let sig = normalizeSignature(ctx.content.slice(node.startIndex, end));
  if (sig.endsWith(';')) sig = sig.slice(0, -1).trimEnd();
  return sig;
}

// Dart privacy is the leading-underscore convention — there is no `private`
// keyword. A name starting `_` is library-private; everything else is public.
// (Operator names `+`/`==`/`[]` and the synthesized 'constructor' never start
// with `_`.) Members AND-in their container's exportedness via the caller.
function isPrivate(name: string): boolean {
  return name.startsWith('_');
}

// True if `node` has a direct anonymous child whose token text is `text`.
function nodeHasAnonChild(node: Node, text: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === text) return true;
  }
  return false;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"]/, '').replace(/['"]$/, '');
}

// Module path / enclosing-type chain only disambiguate hashed ids — they never
// reach FQN parsing — so any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}.${b}`;
}

function makeDartSymbol(
  ctx: DartCtx,
  node: Node,
  signature: string,
  kind: SymbolKind,
  name: string,
  fqn: string,
  exported: boolean,
  doc: string | null,
  qualifier = '',
): Symbol {
  const key = `${name}\0${kind}\0${signature}\0${qualifier}`;
  const n = (ctx.occurrences.get(key) ?? 0) + 1;
  ctx.occurrences.set(key, n);
  const effectiveQualifier = n === 1 ? qualifier : `${qualifier}#${n}`;
  return {
    // The id hashes the FULL signature; only the stored copy is capped.
    id: symbolId(ctx.fileInfo.path, name, kind, signature, effectiveQualifier),
    name,
    fqn,
    kind,
    file: ctx.fileInfo.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
    doc,
    exported,
    language: ctx.fileInfo.language,
  };
}

// Doc = the immediately-preceding DocC-style comment: a contiguous `///` line
// block or a single `/** */`. Dart uses ONE `comment` node type for every form,
// so the doc is discriminated by text prefix (`///` / `/**`); plain `//` and
// `/* */` are NOT docs. Annotations live INSIDE the declaration (no Rust-style
// sibling skip). For members the anchor is the `class_member` wrapper (the
// comment is its sibling, not the inner declaration's). `///` lines are SEPARATE
// comment nodes → Go/Swift contiguous-block walk, first line with content.
function dartDoc(anchor: Node): string | null {
  const nearest = anchor.previousNamedSibling;
  if (!nearest || nearest.type !== 'comment') return null;
  if (nearest.endPosition.row !== anchor.startPosition.row - 1) return null; // adjacency
  if (isTrailingComment(nearest)) return null;
  const text = nearest.text;
  if (text.startsWith('/**')) return commentDocLine(text); // single block doc
  if (!text.startsWith('///')) return null; // plain // or /* */ — not a doc

  const chain: Node[] = [nearest];
  for (;;) {
    const bottom = chain[chain.length - 1]!;
    const prev = bottom.previousNamedSibling;
    if (
      !prev ||
      prev.type !== 'comment' ||
      !prev.text.startsWith('///') ||
      prev.endPosition.row !== bottom.startPosition.row - 1 ||
      isTrailingComment(prev)
    ) {
      break;
    }
    chain.push(prev);
  }
  chain.reverse(); // document order
  for (const comment of chain) {
    const line = commentDocLine(comment.text);
    if (line) return line;
  }
  return null;
}
