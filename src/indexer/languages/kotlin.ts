import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportInfo, Symbol, SymbolKind } from '../../types.js';
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
import {
  cFamilyBooleanOperatorKind,
  computeComplexity,
  isCFamilyBooleanOperator,
} from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Nested `fun` declarations create their own scope — their calls must NOT
// attribute to an enclosing body, so they're pruned from the body walk (and
// aren't extracted, the top-level + member-only rule). `lambda_literal`
// (closures) is deliberately ABSENT: calls inside `items.forEach { f() }`
// attribute to the enclosing body (the Go func_literal / Java lambda rule, not
// the TS arrow rule).
const KOTLIN_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['function_declaration']);

// walkCalls skip set: nested funcs (above) PLUS `modifiers` (the Swift
// property-wrapper rule). Kotlin annotation arguments must be compile-time
// constants — never function calls — in valid code, so this is mostly
// defensive: when an annotation attaches in a declaration's `modifiers` (the
// normal form), skipping it keeps any nested constructor-invocation arg out of
// the call graph. (A real call inside an annotation arg only parses on invalid
// Kotlin, where tree-sitter detaches the annotation into a sibling expression
// the `modifiers` skip can't reach — an uncompilable, ignorable edge case.)
const KOTLIN_SKIP_TYPES: ReadonlySet<string> = new Set(['function_declaration', 'modifiers']);

// A bare `identifier` callee binds to free functions AND classes. 'class' is
// here — the inverse of Go/Rust — because Kotlin construction is
// shape-identical to a call (`Foo()` has no `new` and no distinct construction
// node, exactly like Swift), so `bareCallableKinds` is the ONLY lever to
// resolve `Foo()` to its type. Accepted error class: a bare call colliding with
// a same-named type resolves to the type, which for Kotlin `Type(...)` is
// construction by convention. The enclosing-class fallback runs FIRST
// (bareCallsBindToEnclosingClass), so an implicit-this method call beats a
// same-named type — which keeps 'class' safe. (Unlike Swift, the bare callee is
// the engine-default `identifier`, so no plainCalleeType override is needed.)
const KOTLIN_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'class']);

// Kinds sharing the simple-name FQN namespace — duplicates among these are
// excluded from extract-time resolution. (class/object/companion→class,
// interface→interface, enum→enum, typealias→type.)
const KOTLIN_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'type']);

// Kotlin scope functions and stdlib globals that parse as bare calls and would
// otherwise flood the name-keyed reference store. Suppressed ONLY when
// unresolved (a file-local function shadowing the name keeps its refs). Start
// small; extend after dogfood measurement.
const KOTLIN_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  // scope functions — appear in nearly every file, never resolve
  'let', 'run', 'apply', 'also', 'with', 'takeIf', 'takeUnless', 'use',
  // assertions / control
  'require', 'requireNotNull', 'check', 'checkNotNull', 'error', 'TODO',
  'assert',
  // printing
  'print', 'println',
  // collection / delegate builders — the dominant unresolvable bare-call flood
  // measured on okio/moshi (every `by lazy {}` + collection literal). All
  // gated on unresolved, so a file-local definition of the same name keeps refs.
  'lazy', 'lazyOf', 'listOf', 'listOfNotNull', 'mutableListOf', 'arrayListOf',
  'setOf', 'mutableSetOf', 'hashSetOf', 'linkedSetOf', 'sortedSetOf',
  'mapOf', 'mutableMapOf', 'hashMapOf', 'linkedMapOf', 'sortedMapOf',
  'arrayOf', 'emptyList', 'emptyMap', 'emptySet', 'emptyArray',
  'sequenceOf', 'buildList', 'buildMap', 'buildSet', 'buildString',
]);

// Type nodes that can carry an extension receiver (`fun String.f()`,
// `val String?.x`). Non-nominal receivers (function_type, tuple, etc.) are
// skipped — they have no single type name to key the member on.
const KOTLIN_RECEIVER_TYPES: ReadonlySet<string> = new Set(['user_type', 'nullable_type']);

// Callee of a call_expression = its first named child (identifier for
// bare/construction calls, navigation_expression for member/static calls).
function kotlinCallCallee(node: Node): Node | null {
  return node.firstNamedChild;
}

const KOTLIN_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call_expression', getCallee: kotlinCallCallee },
];

// Peels transparent receiver wrappers off a navigation receiver so a wrapped
// receiver resolves like the bare form — non-null assertion `a!!`, parens `(a)`,
// and an `as`/`as?` cast — so `a!!.x()` / `(a).x()` resolve like `a.x()`. `a!!`,
// `a++`/`a--`, and a parenthesized prefix `-a`/`!a` are all `unary_expression`, so
// peel ONLY when the trailing child is the anon `!!` token (prefix forms have the
// named operand last → skipped). firstNamedChild is the operand. A peeled
// `(super)`/`(this)` lands on the super_expression/this_expression and re-hits
// kotlinMemberCallInfo's super-drop / self handling below. NOTE: an `as`-cast is
// peeled to its VALUE (the type is discarded) — `(this as Foo).m()` becomes a
// self-call on the enclosing class (correct for virtual members via dynamic
// dispatch; a rare wrong-target only for shadowing extension funcs — see
// MCR-java-cast-receiver, accepted).
function unwrapKotlinReceiver(node: Node): Node {
  let n = node;
  for (;;) {
    if (n.type === 'parenthesized_expression') {
      let inner = n.firstNamedChild;
      // tree-sitter-kotlin names comments `line_comment`/`block_comment`, never `comment`.
      while (inner && (inner.type === 'line_comment' || inner.type === 'block_comment'))
        inner = inner.nextNamedSibling;
      if (!inner) break;
      n = inner;
    } else if (n.type === 'unary_expression') {
      const last = n.child(n.childCount - 1);
      if (!last || last.isNamed || last.text !== '!!') break; // non-null assertion only
      const inner = n.firstNamedChild;
      if (!inner) break;
      n = inner;
    } else if (n.type === 'as_expression') {
      const inner = n.firstNamedChild;
      if (!inner) break;
      n = inner;
    } else break;
  }
  return n;
}

// Reduces a `navigation_expression` callee (`obj.m()`, `this.m()`, `C.make()`)
// to {receiver, property}, after unwrapKotlinReceiver peels any wrapper off the
// receiver. A chained `a.b.c()` receiver → RECEIVER_OPAQUE (findable by name,
// never resolved); `this`/labeled `this@Label` → self / label class (decided
// here like Swift/Python — no PendingBody.selfReceiverName); `super` → null
// (parent dispatch, not tracked); `::` callable refs (`Foo::bar`) and computed
// receivers (no `identifier` property) emit nothing.
function kotlinMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type !== 'navigation_expression') return null;
  // children: <receiver expr> <op '.'|'?.'|'::'> <identifier property>
  const rawReceiver = callee.namedChild(0);
  const property = callee.namedChild(1);
  if (!rawReceiver || property?.type !== 'identifier') return null;
  // `::` is a member/callable reference, not a member call — skip it.
  if (nodeHasAnonChild(callee, '::')) return null;
  const receiver = unwrapKotlinReceiver(rawReceiver);
  if (receiver.type === 'this_expression') {
    // `this@Label.m()` (a labeled this) names an OUTER receiver — resolve
    // against the labeled class, not the enclosing one (binding it as self
    // could resolve to a same-named method on the wrong, inner class). A plain
    // `this` has no identifier child and stays a self-call.
    const label = childOfType(receiver, 'identifier');
    if (label) return { receiver: label.text, property: property.text, isSelf: false };
    return { receiver: 'this', property: property.text, isSelf: true };
  }
  if (receiver.type === 'identifier') {
    return { receiver: receiver.text, property: property.text, isSelf: false };
  }
  // `super.m()` is a parent-class dispatch we deliberately don't track (the
  // TS/Java/Swift/C#/Dart rule) — `super` is its own `super_expression` node.
  if (receiver.type === 'super_expression') return null;
  return { receiver: RECEIVER_OPAQUE, property: property.text, isSelf: false }; // chained receiver
}

// Dominant Kotlin stdlib/collection/string/scope method names (>=4 chars)
// suppressed when a member call to them is unresolved — capturing chained
// `.map { }.filter { }` calls otherwise floods the name-keyed store. Domain
// method names are deliberately absent. <=3-char names (`.map`) are gated
// downstream by SHORT_NAME_THRESHOLD.
const KOTLIN_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'filter', 'filterNot', 'forEach', 'flatMap', 'reduce', 'fold', 'sortedBy',
  'sortedByDescending', 'groupBy', 'associateBy', 'distinct', 'first',
  'firstOrNull', 'last', 'lastOrNull', 'single', 'count', 'sumOf', 'maxOf',
  'minOf', 'maxByOrNull', 'minByOrNull', 'contains', 'containsKey', 'isEmpty',
  'isNotEmpty', 'toList', 'toSet', 'toMap', 'toMutableList', 'joinToString',
  'take', 'drop', 'plus', 'minus', 'indexOf', 'remove', 'clear',
  'startsWith', 'endsWith', 'substring', 'replace', 'split', 'trim',
  'lowercase', 'uppercase', 'getOrNull', 'getOrDefault', 'getOrElse',
  // Scope functions in MEMBER position (`x.apply{}`, `foo().also{}`) are THE
  // dominant chained Kotlin member call and pure-stdlib — measured on okio/moshi:
  // apply 73 call-sites/~1.4% in-repo, also 49/0% → flood, ~0 recall stake (the
  // bare `with(x){}` form is covered by KOTLIN_IGNORED_BARE_CALLEES, but the
  // member forms route through here). let/run/use (<=3 chars) are SHORT_NAME_THRESHOLD-gated.
  'apply', 'also', 'takeIf', 'takeUnless',
]);

// ── complexity (cyclomatic + cognitive, BOTH pinned to sonar-kotlin) ─────────
// CYCLOMATIC (sonar-kotlin CyclomaticComplexityVisitor): `1 + decision points`, +1 per
// `if` (incl. an if-used-as-EXPRESSION — every Kotlin `if` is one `if_expression`), per
// EACH `when_entry` INCLUDING the `else` entry (sonar-kotlin visits every whenEntry — a
// deliberate divergence from the `default`/`else`-EXCLUDED rule in TS/Go/Java/Swift), per
// loop, and per `&&`/`||`. NOT counted: Elvis `?:` (a `binary_expression` whose operator
// token `?:` isCFamilyBooleanOperator rejects), break/continue, catch, scope functions.
// Lambdas are DESCENDED (lambda_literal ∉ KOTLIN_SKIP_TYPES) so their branches count
// toward the enclosing function.
const KOTLIN_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_expression', 'for_statement', 'while_statement', 'do_while_statement', 'when_entry',
]);

// A labeled break/continue is a `labeled_expression` whose `label` child text is the jump
// keyword + `@` (`break@`/`continue@`); the target label name follows as an identifier.
// Labeled LOOPS attach `label` directly to the loop (not via labeled_expression), and a
// labeled non-jump (`tag@ run {}`) carries a different label text — so this gate fires
// only for labeled jumps (+1 flat cognitive, the whitepaper rule). Plain break/continue
// parse as bare `identifier`s (no labeled_expression) → +0.
function kotlinHasJumpLabel(node: Node): boolean {
  const label = childOfType(node, 'label')?.text;
  return label === 'break@' || label === 'continue@';
}

// COGNITIVE — pinned EXACTLY to sonar-kotlin's CognitiveComplexity (verbatim source read,
// NOT plain whitepaper: it diverges in three sonar-kotlin-specific ways, all replicated for
// SonarQube-parity). (1) Kotlin's `if` is POSITIONAL with an anonymous `else` and possibly
// brace-less branches → ifConsequenceFromNamedChildren (see complexity.ts), and the else +1 is
// charged ONLY when the else BODY is a `block` or an else-if (elseChargeBlockType) — a
// brace-less `else expr` is the ternary form, NO +1 (sonar-kotlin handleIfExpression's
// `it is KtBlockExpression || it is KtIfExpression` gate). (2) `when` is the switch analog
// (whole +1, entries nest). (3) Booleans are C-family with NO paren-unwrap (sonar-kotlin's
// flattenOperators recurses only into KtBinaryExpression operands, so `(a&&b)&&c` = 2 runs —
// unlike sonar-java). do-while NESTS its body but adds NO increment (sonar-kotlin's cognitive
// visit handles KtFor/KtWhile but NOT KtDoWhileExpression — a sibling, not a subclass — while
// KtLoopExpression still raises nesting); so do_while_statement is nestOnly, not a loopType.
// Cyclomatic still counts do-while (its visitLoopExpression covers all loops). NO recursion /
// Elvis (sonar-kotlin omits both).
const KOTLIN_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_expression',
  conditionField: 'condition',
  // Positional path (no consequence/alternative field): unused placeholders.
  consequenceField: '__kotlin_unused__',
  alternativeField: '__kotlin_unused__',
  ifConsequenceFromNamedChildren: true,
  elseKeywordType: 'else', // anon `else` token splits consequence/else (handles `;` empty branches)
  elseChargeBlockType: 'block', // else +1 ONLY for a block or else-if body (sonar-kotlin ternary gate)
  loopTypes: new Set(['for_statement', 'while_statement']), // NOT do_while (sonar-kotlin omits its increment)
  switchTypes: new Set(['when_expression']), // whole when +1, entries nest
  ternaryType: '__kotlin_no_ternary__', // the if-expression IS the ternary (handled by ifType)
  catchType: 'catch_block', // each catch surcharges; try/finally pass through
  // closures nest +0; do_while nests its body but adds NO increment (sonar-kotlin omits it).
  nestOnlyTypes: new Set(['lambda_literal', 'do_while_statement']),
  labeledJumpTypes: new Set(['labeled_expression']),
  hasLabel: kotlinHasJumpLabel,
  booleanOperatorKind: cFamilyBooleanOperatorKind, // &&/|| (Elvis ?: → null); default left/right
  parenthesizedType: '__kotlin_no_paren__', // NO unwrap: (a&&b)&&c = 2 runs (sonar-kotlin)
};

// Per-file duplicate-id disambiguation. An extension method duplicating a type
// method, or two same-signature constructors, can be byte-identical in
// (name, kind, signature, qualifier). Repeats get an ordinal qualifier.
type OccurrenceCounter = Map<string, number>;

interface KotlinCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
}

export function extractKotlin(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const ctx: KotlinCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  extractTopLevel(ctx, tree.rootNode);

  // Same-name types in one file are invalid Kotlin, so this only fires on
  // broken parses — where refusing resolution beats binding through a
  // half-parsed type.
  const ambiguousTypeNames = collectAmbiguousTypeNames(ctx.symbols, KOTLIN_TYPE_KINDS);

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    KOTLIN_SELECTORS,
    KOTLIN_SKIP_TYPES,
    KOTLIN_FUNCTION_BODY_SKIP_TYPES,
    kotlinMemberCallInfo,
    {
      // Bare/construction callee is the engine-default `identifier` — no
      // plainCalleeType override.
      // Kotlin allows implicit-this bare method calls (`fun a(){ b() }` calls
      // this.b()), so a bare call resolves against the enclosing class first.
      bareCallsBindToEnclosingClass: true,
      bareCallableKinds: KOTLIN_BARE_CALLABLE_KINDS,
      // No constructorKinds: construction has no distinct node; it resolves as
      // a bare call to a 'class'-kind symbol via bareCallableKinds.
      ambiguousClassNames: ambiguousTypeNames,
      ignoredBareCallees: KOTLIN_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: KOTLIN_IGNORED_MEMBER_CALLEES,
    },
  );
  // Per-symbol cyclomatic + cognitive complexity, computed while the tree is alive
  // (same boundary as resolveCalls: nested funcs skipped, lambdas descended).
  computeComplexity(ctx.bodies, ctx.symbols, {
    decisionNodeTypes: KOTLIN_DECISION_NODE_TYPES,
    extraDecisionPredicate: isCFamilyBooleanOperator, // &&/|| (+1 each); Elvis excluded
    skipTypes: KOTLIN_SKIP_TYPES,
    cognitive: KOTLIN_COGNITIVE_OPTIONS,
  });
  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Top-level source_file items. containerExported is true (the file is the
// module surface); qualifier is empty.
function extractTopLevel(ctx: KotlinCtx, root: Node): void {
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'import':
        extractImport(ctx, child);
        break;
      case 'class_declaration':
        extractClass(ctx, child, '', true);
        break;
      case 'object_declaration':
        extractObject(ctx, child, '', true);
        break;
      case 'function_declaration':
        extractFunction(ctx, child, undefined, '', true);
        break;
      case 'property_declaration':
        extractProperty(ctx, child, undefined, '', true);
        break;
      case 'type_alias':
        extractTypeAlias(ctx, child, undefined, '', true);
        break;
      // package_header, comments, top-level statements, ERROR nodes — no symbols.
      default:
        break;
    }
  }
}

// class / interface / data / sealed / enum — one `class_declaration` node,
// discriminated by the `interface` keyword token and the `enum_class_body`.
function extractClass(
  ctx: KotlinCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const kind = classKind(decl);
  const exported = containerExported && !isHidden(decl);
  const sym = makeKotlinSymbol(
    ctx,
    decl,
    declSignature(decl, ctx.content),
    kind,
    name,
    memberFqn(ctx, undefined, name),
    exported,
    kotlinDoc(decl),
    parentQualifier,
  );
  ctx.symbols.push(sym);
  const qualifier = joinQualifier(parentQualifier, name);
  // Primary-constructor `val`/`var` parameters are class properties; the
  // constructor surface (init blocks + default args) becomes a synthesized
  // 'constructor' method.
  const primary = childOfType(decl, 'primary_constructor');
  if (primary) extractPrimaryCtorProperties(ctx, primary, name, qualifier, exported);

  // class/enum are constructable (synthesize a 'constructor'); interface has no
  // construction surface but never triggers synthesis anyway.
  const body = childOfType(decl, 'class_body', 'enum_class_body');
  if (body) extractClassBody(ctx, body, name, qualifier, exported, primary, sym.id, true);
  else if (primary) maybeSynthesizeConstructor(ctx, primary, [], [], name, qualifier, exported);
}

// `object Foo { ... }` (named singleton) → 'class' kind, members keyed on Foo.
function extractObject(
  ctx: KotlinCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && !isHidden(decl);
  const sym = makeKotlinSymbol(
    ctx,
    decl,
    declSignature(decl, ctx.content),
    'class',
    name,
    memberFqn(ctx, undefined, name),
    exported,
    kotlinDoc(decl),
    parentQualifier,
  );
  ctx.symbols.push(sym);
  const body = childOfType(decl, 'class_body');
  // An object is a singleton — NOT constructable. Its init-block calls attribute
  // to the object symbol itself, not a phantom 'constructor'.
  if (body) extractClassBody(ctx, body, name, joinQualifier(parentQualifier, name), exported, null, sym.id, false);
}

// A class/object/enum body. Members key on `className`. A companion object's
// members merge into the SAME className (so `Outer.foo()` resolves) — its name
// is intentionally ignored. enum_entry cases are NOT extracted (the
// TS/Java/Go/Rust/Swift enum-member rule); member declarations after the `;`
// ARE. `primary` (the enclosing class's primary constructor, if any) is folded
// into the synthesized constructor alongside any init blocks.
function extractClassBody(
  ctx: KotlinCtx,
  body: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
  primary: Node | null,
  containerId: string,
  constructable: boolean,
): void {
  const initBlocks: Node[] = [];
  const enumEntries: Node[] = [];
  for (const member of body.namedChildren) {
    switch (member.type) {
      case 'function_declaration':
        extractFunction(ctx, member, className, qualifier, containerExported);
        break;
      case 'property_declaration':
        extractProperty(ctx, member, className, qualifier, containerExported);
        break;
      case 'secondary_constructor':
        extractSecondaryConstructor(ctx, member, className, qualifier, containerExported);
        break;
      case 'anonymous_initializer':
        initBlocks.push(member);
        break;
      // Entries aren't symbols, but their constructor-argument calls
      // (`RED(make())`) run at enum init — owned by the synthesized constructor.
      case 'enum_entry':
        enumEntries.push(member);
        break;
      case 'companion_object': {
        // Members key on the ENCLOSING class (companions are accessed via the
        // class name). The companion's own visibility gates them. A companion is
        // NOT constructable: its init-block calls attribute to the enclosing
        // class symbol, never a phantom/duplicate `<Class>.constructor`.
        const compExported = containerExported && !isHidden(member);
        const compBody = childOfType(member, 'class_body');
        if (compBody) extractClassBody(ctx, compBody, className, qualifier, compExported, null, containerId, false);
        break;
      }
      // Nested types: simple-name FQN, the enclosing chain folds into the
      // hashed qualifier only (Java/Rust/Swift nested-type rule).
      case 'class_declaration':
        extractClass(ctx, member, qualifier, containerExported);
        break;
      case 'object_declaration':
        extractObject(ctx, member, qualifier, containerExported);
        break;
      case 'type_alias':
        extractTypeAlias(ctx, member, className, qualifier, containerExported);
        break;
      default:
        break;
    }
  }
  if (constructable) {
    // An entry's `value_arguments` (`RED(make())`) AND its anonymous class_body
    // (`RED { val x = compute() }`) are both construction-time code to own.
    const enumHasCtorCode = enumEntries.some(
      (e) => childOfType(e, 'value_arguments') != null || childOfType(e, 'class_body') != null,
    );
    if (primary || initBlocks.length > 0 || enumHasCtorCode) {
      maybeSynthesizeConstructor(ctx, primary, initBlocks, enumEntries, className, qualifier, containerExported);
    }
  } else {
    // object / companion: no constructor — own any init-block calls on the
    // container symbol directly (objects/companions have no primary ctor or
    // enum entries, so init blocks are the only construction-time code here).
    for (const init of initBlocks) {
      ctx.bodies.push({ symbolId: containerId, body: childOfType(init, 'block') ?? init, className });
    }
  }
}

// function_declaration as a top-level 'function' (className undefined) or a
// 'method' (className set). An extension function (`fun Type.name()`) is
// methods-apart: keyed on the EXTENDED type, merged into methodsByClass[Type]
// (the Go-receiver / Rust-impl / Swift-extension pattern), exported per its OWN
// visibility. The body becomes a PendingBody so its calls attribute here and
// self-calls resolve against the class.
function extractFunction(
  ctx: KotlinCtx,
  decl: Node,
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const nameNode = decl.childForFieldName('name');
  const name = nameNode?.text;
  if (!name) return;

  // An extension (`fun Type.name()`) keys on the receiver type (methods-apart);
  // a plain member keys on its enclosing class. Either way exportedness is
  // container-gated AND-ed with own visibility — for a TOP-LEVEL extension
  // containerExported is true, so this reduces to own visibility; for a MEMBER
  // extension (declared inside a class) it correctly inherits the container.
  const effClass = extensionReceiverName(decl, nameNode) ?? className;
  const exported = containerExported && !isHidden(decl);
  const kind: SymbolKind = effClass ? 'method' : 'function';
  const sym = makeKotlinSymbol(
    ctx,
    decl,
    declSignature(decl, ctx.content),
    kind,
    name,
    memberFqn(ctx, effClass, name),
    exported,
    kotlinDoc(decl),
    qualifier,
  );
  ctx.symbols.push(sym);
  const fnBody = childOfType(decl, 'function_body');
  if (fnBody) ctx.bodies.push({ symbolId: sym.id, body: fnBody, className: effClass });
}

// secondary_constructor → a 'method' named 'constructor' (Java convention). The
// `block` becomes a PendingBody so its calls attribute here and self-calls
// resolve.
function extractSecondaryConstructor(
  ctx: KotlinCtx,
  decl: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const sym = makeKotlinSymbol(
    ctx,
    decl,
    declSignature(decl, ctx.content),
    'method',
    'constructor',
    memberFqn(ctx, className, 'constructor'),
    containerExported && !isHidden(decl),
    kotlinDoc(decl),
    qualifier,
  );
  ctx.symbols.push(sym);
  // Push the WHOLE declaration so calls in the `: this(...)`/`: super(...)`
  // delegation args (a `constructor_delegation_call` sibling of `block`) and any
  // param default-args attribute to the constructor, not module scope. The
  // `block` body is walked too; `modifiers` is skipped, and `this`/`super` are
  // anon tokens (no spurious ref).
  ctx.bodies.push({ symbolId: sym.id, body: decl, className });
}

// The primary constructor surface: a single synthesized 'constructor' method
// owning init-block bodies, primary-ctor default-argument expressions, and
// enum-entry constructor arguments (all run at construction / enum init). Only
// emitted when there's primary-ctor params or init code — a plain `class Empty`
// gets no phantom constructor.
function maybeSynthesizeConstructor(
  ctx: KotlinCtx,
  primary: Node | null,
  initBlocks: Node[],
  enumEntries: Node[],
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const params = primary ? childOfType(primary, 'class_parameters') : null;
  const hasParams = params != null && childOfType(params, 'class_parameter') != null;
  // An enum entry's ctor args (`RED(make())`) and its anonymous class_body
  // (`RED { val x = compute() }`) are both construction-time code.
  const enumBodies = enumEntries.flatMap((e) =>
    [childOfType(e, 'value_arguments'), childOfType(e, 'class_body')].filter((n): n is Node => n != null),
  );
  if (!hasParams && initBlocks.length === 0 && enumBodies.length === 0) return;

  const signature = primary
    ? normalizeSignature(`constructor${params ? ctx.content.slice(params.startIndex, params.endIndex) : '()'}`)
    : 'constructor';
  // Primary constructors are public unless explicitly restricted on the
  // `constructor` keyword (rare); follow the class's exportedness.
  const sym = makeKotlinSymbol(
    ctx,
    primary ?? initBlocks[0] ?? enumEntries[0]!,
    signature,
    'method',
    'constructor',
    memberFqn(ctx, className, 'constructor'),
    containerExported,
    null,
    qualifier,
  );
  ctx.symbols.push(sym);
  // Default-argument expressions live inside the primary constructor's params.
  if (primary) ctx.bodies.push({ symbolId: sym.id, body: primary, className });
  for (const init of initBlocks) {
    ctx.bodies.push({ symbolId: sym.id, body: childOfType(init, 'block') ?? init, className });
  }
  // Enum-entry ctor args (`RED(make())`) and anonymous-class-body property
  // initializers (`RED { val x = compute() }`) evaluate at enum init — attribute
  // their calls here, not to module scope. (Per-entry override-method bodies stay
  // pruned: function_declaration is in the skip set, so walking the class_body
  // descends property initializers but not the override fun bodies.)
  for (const body of enumBodies) {
    ctx.bodies.push({ symbolId: sym.id, body, className });
  }
}

// Primary-constructor parameters declared `val`/`var` are class properties.
// Plain parameters (no val/var) are not. Default-value calls are owned by the
// synthesized constructor, not here.
function extractPrimaryCtorProperties(
  ctx: KotlinCtx,
  primary: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const params = childOfType(primary, 'class_parameters');
  if (!params) return;
  for (const param of params.namedChildren) {
    if (param.type !== 'class_parameter') continue;
    const isProp = nodeHasAnonChild(param, 'val') || nodeHasAnonChild(param, 'var');
    if (!isProp) continue;
    const id = childOfType(param, 'identifier');
    if (!id) continue;
    ctx.symbols.push(
      makeKotlinSymbol(
        ctx,
        param,
        normalizeSignature(ctx.content.slice(param.startIndex, param.endIndex)),
        'variable',
        id.text,
        memberFqn(ctx, className, id.text),
        containerExported && !isHidden(param),
        null,
        qualifier,
      ),
    );
  }
}

// property_declaration → 'variable' member(s). A single `val`/`var x = init`
// gets one symbol plus a PendingBody (the whole declaration, so initializer and
// getter/setter calls attribute here and self-calls resolve; `modifiers` is
// skipped by the walk so annotation args don't leak in). A destructuring
// `val (a, b) = f()` extracts each name but owns no body — the initializer has
// no single owner, so its calls stay module-level (the Swift tuple-binding
// rule). Extension properties (`val Type.x`) key on the extended type.
function extractProperty(
  ctx: KotlinCtx,
  decl: Node,
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const signature = propertySignature(decl, ctx.content);
  const doc = kotlinDoc(decl);

  const varDecl = childOfType(decl, 'variable_declaration');
  const multiDecl = childOfType(decl, 'multi_variable_declaration');

  // Extension property keys on the receiver type; container-gated AND own
  // visibility (top-level → own visibility since containerExported is true).
  const effClass = (varDecl ? extensionReceiverName(decl, varDecl) : null) ?? className;
  const exported = containerExported && !isHidden(decl);

  if (multiDecl) {
    for (const sub of multiDecl.namedChildren) {
      if (sub.type !== 'variable_declaration') continue;
      const id = childOfType(sub, 'identifier');
      if (!id) continue;
      ctx.symbols.push(
        makeKotlinSymbol(ctx, decl, signature, 'variable', id.text, memberFqn(ctx, effClass, id.text), exported, doc, qualifier),
      );
    }
    return; // destructuring initializer has no single owner — no PendingBody
  }

  const id = varDecl ? childOfType(varDecl, 'identifier') : null;
  if (!id) return;
  const sym = makeKotlinSymbol(ctx, decl, signature, 'variable', id.text, memberFqn(ctx, effClass, id.text), exported, doc, qualifier);
  ctx.symbols.push(sym);
  ctx.bodies.push({ symbolId: sym.id, body: decl, className: effClass });
}

// typealias → 'type'. The alias name is the `type` FIELD (not the aliased type,
// which is the trailing `type` child).
function extractTypeAlias(
  ctx: KotlinCtx,
  decl: Node,
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('type')?.text;
  if (!name) return;
  ctx.symbols.push(
    makeKotlinSymbol(
      ctx,
      decl,
      normalizeSignature(ctx.content.slice(decl.startIndex, decl.endIndex)),
      'type',
      name,
      memberFqn(ctx, className, name),
      containerExported && !isHidden(decl),
      kotlinDoc(decl),
      qualifier,
    ),
  );
}

// `import a.b.C` → single-symbol import (name = last segment, module = the
// rest). `import a.b.*` → whole-package namespace import. `import a.b.C as D` →
// the binding D. Lower cross-file value than Go (Kotlin paths don't map to
// files, no directory carve-out) — same framing as Rust.
function extractImport(ctx: KotlinCtx, decl: Node): void {
  const qi = childOfType(decl, 'qualified_identifier');
  if (!qi) return;
  const segments = qi.namedChildren.filter((c) => c.type === 'identifier').map((c) => c.text);
  if (segments.length === 0) return;
  const line = decl.startPosition.row + 1;
  const wildcard = nodeHasAnonChild(decl, '*');
  // An alias identifier sits AFTER the qualified_identifier (`... as Alias`).
  const alias = decl.namedChildren.find((c) => c.type === 'identifier' && c.startIndex > qi.endIndex);

  if (wildcard) {
    ctx.imports.push({
      file: ctx.fileInfo.path,
      sourceModule: segments.join('.'),
      importedNames: [{ name: IMPORT_NAMESPACE, kind: 'namespace' }],
      line,
    });
    return;
  }
  const name = segments[segments.length - 1]!;
  const sourceModule = segments.slice(0, -1).join('.');
  const importedName = alias ? { name, alias: alias.text } : { name };
  ctx.imports.push({ file: ctx.fileInfo.path, sourceModule, importedNames: [importedName], line });
}

// ── helpers ──────────────────────────────────────────────────────────────

// class_declaration covers class / interface / enum. interface = the literal
// `interface` keyword token; enum = an `enum_class_body` (or an `enum`
// class_modifier for a bodiless enum); everything else (incl. data/sealed/value
// /annotation) → class.
function classKind(decl: Node): SymbolKind {
  if (nodeHasAnonChild(decl, 'interface')) return 'interface';
  if (childOfType(decl, 'enum_class_body')) return 'enum';
  const mods = childOfType(decl, 'modifiers');
  if (mods?.namedChildren.some((m) => m.type === 'class_modifier' && m.text === 'enum')) return 'enum';
  return 'class';
}

// An extension receiver = a user_type/nullable_type child appearing BEFORE the
// declaration's name (the hidden `_receiver_type`). Returns the receiver's
// simple type name (scoped `a.b.C`→C, generic `List<Int>`→List, nullable
// `String?`→String); null for a plain (non-extension) declaration or a
// non-nominal receiver.
function extensionReceiverName(decl: Node, nameNode: Node): string | null {
  for (const c of decl.namedChildren) {
    if (c.startIndex >= nameNode.startIndex) break;
    if (KOTLIN_RECEIVER_TYPES.has(c.type)) return receiverTypeName(c);
  }
  return null;
}

function receiverTypeName(typeNode: Node): string | null {
  let t = typeNode;
  if (t.type === 'nullable_type') {
    const inner = childOfType(t, 'user_type');
    if (!inner) return null;
    t = inner;
  }
  if (t.type !== 'user_type') return null;
  // The last direct `identifier` child is the simple type name (type_arguments
  // is a separate node; a scoped `a.b.C` keeps its last segment).
  let result: string | null = null;
  for (const c of t.namedChildren) {
    if (c.type === 'identifier') result = c.text;
  }
  return result;
}

function memberFqn(ctx: KotlinCtx, className: string | undefined, name: string): string {
  return className
    ? `${ctx.fileInfo.path}:${className}.${name}`
    : `${ctx.fileInfo.path}:${name}`;
}

// First direct named child of one of the given types (or null). Collapses the
// many `namedChildren.find(c => c.type === 'X')` body/node lookups.
function childOfType(node: Node, ...types: string[]): Node | null {
  return node.namedChildren.find((c) => types.includes(c.type)) ?? null;
}

// Declaration signature = source from the declaration start to its body. The
// body is NOT a named field in tree-sitter-kotlin, so it's found by type.
function declSignature(decl: Node, content: string): string {
  const body = childOfType(decl, 'function_body', 'block', 'class_body', 'enum_class_body');
  const sigEnd = body ? body.startIndex : decl.endIndex;
  return normalizeSignature(content.slice(decl.startIndex, sigEnd));
}

// Property signature stops before the getter/setter/delegate so a long computed
// body doesn't blow the 120-char cap (the `= initializer` is kept — informative
// for constants).
function propertySignature(decl: Node, content: string): string {
  let cut = decl.endIndex;
  for (const child of decl.namedChildren) {
    if (child.type === 'getter' || child.type === 'setter' || child.type === 'property_delegate') {
      cut = child.startIndex;
      break;
    }
  }
  return normalizeSignature(content.slice(decl.startIndex, cut));
}

// exported = NO `private` visibility modifier (so absent = public, internal,
// protected, and public/open all export — Kotlin's default is public, there is
// no directory→package carve-out, and treating internal-and-up as exported
// preserves cross-file member-call recall, the Swift rule). Members AND-in
// their container's exportedness via the caller.
function isHidden(decl: Node): boolean {
  const mods = childOfType(decl, 'modifiers');
  if (!mods) return false;
  for (const m of mods.namedChildren) {
    if (m.type === 'visibility_modifier' && m.text === 'private') return true;
  }
  return false;
}

// True if `node` has a direct anonymous child whose token text is `text`.
function nodeHasAnonChild(node: Node, text: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c && !c.isNamed && c.type === text) return true;
  }
  return false;
}

// Module path / enclosing-type chain only disambiguate hashed ids — they never
// reach FQN parsing — so any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}.${b}`;
}

function makeKotlinSymbol(
  ctx: KotlinCtx,
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

// Doc = the immediately-preceding KDoc `/** */` block_comment. Plain `//` /
// `/* */` are NOT doc comments (KDoc convention). Annotations live INSIDE the
// declaration (in `modifiers`), so no Rust-style sibling skipping is needed.
function kotlinDoc(decl: Node): string | null {
  const prev = decl.previousNamedSibling;
  if (!prev || prev.type !== 'block_comment' || !prev.text.startsWith('/**')) return null;
  if (prev.endPosition.row !== decl.startPosition.row - 1) return null; // adjacency
  if (isTrailingComment(prev)) return null;
  return commentDocLine(prev.text);
}
