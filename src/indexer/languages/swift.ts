import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  collectAmbiguousTypeNames,
  commentDocLine,
  declSignature,
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

// Nested `func` declarations create their own scope — their calls must NOT
// attribute to an enclosing body, so they're pruned from the body walk (and
// aren't extracted, the top-level + member-only rule). `lambda_literal`
// (closures) is deliberately ABSENT: a closure can't be a symbol, so calls
// inside `items.forEach { f() }` attribute to the enclosing body (the Go
// func_literal / Java lambda rule, not the TS arrow rule).
const SWIFT_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['function_declaration']);

// walkCalls skip set: nested funcs (own scope, above) PLUS `modifiers` —
// attribute / property-wrapper arguments (`@Wrapper(call())`,
// `@Option(help: f())`) parse a REAL call_expression inside the declaration's
// `modifiers`, which the body and module-root walks would otherwise emit as
// spurious `calls` refs (a false edge from the decl, or a null-sourced
// module-level ref). Skipping `modifiers` drops attribute-arg calls everywhere.
const SWIFT_SKIP_TYPES: ReadonlySet<string> = new Set(['function_declaration', 'modifiers']);

// Swift's bare/constructor call callee is a `simple_identifier` (NOT the
// engine default `identifier`). `Point(x:1)` construction parses IDENTICALLY
// to a function call — there is no separate construction node (unlike Rust's
// struct_expression / Go's composite_literal) — so `simple_identifier` is the
// single plain callee type, declared as `plainCalleeType` so it routes through
// nameToId + the enclosing-class fallback rather than the constructor branch.
const SWIFT_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['simple_identifier']);

// A bare `simple_identifier` callee binds to free functions AND classes.
// 'class' is here — the inverse of Go/Rust — because Swift construction is
// shape-identical to a call and `bareCallableKinds` is the ONLY lever to
// resolve `Point(x:1)` to its type. Accepted error class: a bare call
// colliding with a same-named type resolves to the type, which for Swift
// `Type(...)` is construction by convention. The enclosing-class fallback runs
// FIRST (bareCallsBindToEnclosingClass), so an implicit-self method call beats
// a same-named type — which is what keeps 'class' safe.
const SWIFT_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'class']);

// Kinds sharing the simple-name FQN namespace — duplicates among these are
// excluded from extract-time resolution. (class/struct/actor→class,
// protocol→interface, enum→enum, typealias→type.) Extensions are NOT symbols,
// so two extensions of one type never make that type look ambiguous.
const SWIFT_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum', 'type']);

// Stdlib globals and scalar conversions that parse as bare calls and would
// otherwise flood the name-keyed reference store. Suppressed ONLY when
// unresolved (a file-local function/type shadowing the name keeps its refs).
// Scalar type names (`String(x)`, `Int(s)`) parse identically to calls — the
// Go conversion-callee analog. Start small; extend after dogfood measurement.
const SWIFT_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  // global functions
  'print', 'debugPrint', 'dump', 'assert', 'assertionFailure', 'precondition',
  'preconditionFailure', 'fatalError', 'min', 'max', 'abs', 'swap', 'zip',
  'stride', 'type',
  // scalar conversion / init callees
  'String', 'Int', 'UInt', 'Int8', 'Int16', 'Int32', 'Int64',
  'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Double', 'Float', 'Float32',
  'Float64', 'Bool', 'Character',
]);

// `import struct Mod.Sym` form: a kind keyword sits as a direct anon child
// between `import` and the dotted path, marking a single-symbol import.
const SWIFT_IMPORT_KINDS: ReadonlySet<string> = new Set([
  'typealias', 'struct', 'class', 'enum', 'protocol', 'let', 'var', 'func',
]);

// Callee of a call_expression = its first named child (simple_identifier for
// bare/constructor calls, navigation_expression for member/static calls).
// Returns null for SUBSCRIPT access (`arr[i]`, `dict[k]`, `self.items[i]`),
// which tree-sitter-swift ALSO models as a call_expression — but with a
// bracketed `value_arguments` ([...]) instead of (...). Without this guard
// every subscript read emits a spurious `calls` ref (and resolves to a
// same-named function/method if one exists). Trailing-closure calls
// (`items.forEach { }`) carry a lambda_literal and no value_arguments — kept.
function swiftCallCallee(node: Node): Node | null {
  const callee = node.firstNamedChild;
  if (!callee) return null;
  const suffix = node.namedChildren.find((c) => c.type === 'call_suffix');
  const args = suffix?.namedChildren.find((c) => c.type === 'value_arguments');
  if (args && args.child(0)?.text === '[') return null;
  return callee;
}

const SWIFT_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call_expression', getCallee: swiftCallCallee },
];

// Peels transparent receiver wrappers off a navigation target so a wrapped
// receiver resolves like the bare form — force-unwrap `a!` (postfix_expression
// with a `bang` child), bare parens `(a)` (a single-element tuple_expression —
// Swift has no 1-tuples; comments are NAMED children, so it counts non-comment
// elements), and an `as` cast (`a as T`, the value is firstNamedChild) — so
// `a!.x()` / `(a).x()` / `(a as T).x()` resolve like `a.x()`. A peeled `(super)`
// lands on the super_expression and is dropped by swiftMemberCallInfo's guard.
function unwrapSwiftReceiver(node: Node): Node {
  let n = node;
  for (;;) {
    if (n.type === 'postfix_expression') {
      if (n.child(n.childCount - 1)?.type !== 'bang') break; // only force-unwrap `!`
      const inner = n.firstNamedChild;
      if (!inner) break;
      n = inner;
    } else if (n.type === 'tuple_expression') {
      // A parenthesized single value `(a)` parses as a 1-element tuple. Comments
      // (`//`→comment, `/* */`→multiline_comment) are NAMED children, so count by
      // non-comment elements: exactly one means a transparent wrapper (a real
      // 2-tuple `(a, b)` is not), and that element is the operand.
      const elems = n.namedChildren.filter(
        (c) => c.type !== 'comment' && c.type !== 'multiline_comment',
      );
      if (elems.length !== 1) break;
      n = elems[0];
    } else if (n.type === 'as_expression') {
      const inner = n.firstNamedChild;
      if (!inner) break;
      n = inner;
    } else break;
  }
  return n;
}

// Reduces a `navigation_expression` callee (`obj.m()`, `self.m()`, `C.make()`,
// `Self.make()`) to {receiver, property}, after unwrapSwiftReceiver peels any
// wrapper off the target. A chained `a.b.c()` target → RECEIVER_OPAQUE (findable
// by name, never resolved); `self`/`Self` → isSelf (decided here like
// Python/Rust — no PendingBody.selfReceiverName); `super` → null (parent
// dispatch, not tracked); a computed/optional suffix (no `simple_identifier`
// property) emits nothing.
function swiftMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type !== 'navigation_expression') return null;
  const rawTarget = callee.childForFieldName('target');
  const suffix = callee.childForFieldName('suffix');
  if (!rawTarget || suffix?.type !== 'navigation_suffix') return null;
  const property = suffix.childForFieldName('suffix');
  if (property?.type !== 'simple_identifier') return null; // computed/optional suffix → skip
  const target = unwrapSwiftReceiver(rawTarget);
  if (target.type === 'self_expression') {
    return { receiver: 'self', property: property.text, isSelf: true };
  }
  if (target.type === 'simple_identifier') {
    if (target.text === 'Self') return { receiver: 'Self', property: property.text, isSelf: true };
    return { receiver: target.text, property: property.text, isSelf: false };
  }
  // `super.m()` is a parent-class dispatch we deliberately don't track (the
  // TS/Java/Kotlin/C#/Dart rule) — `super` is its own `super_expression` node.
  if (target.type === 'super_expression') return null;
  return { receiver: RECEIVER_OPAQUE, property: property.text, isSelf: false }; // chained receiver
}

// Dominant Swift stdlib/collection/string/Optional method names (>=4 chars)
// suppressed when a member call to them is unresolved — capturing chained
// `.map().filter()` calls otherwise floods the name-keyed store. Domain method
// names are deliberately absent. <=3-char names (`.map`) are gated downstream
// by SHORT_NAME_THRESHOLD.
const SWIFT_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'append', 'insert', 'remove', 'removeAll', 'removeFirst', 'removeLast',
  'contains', 'filter', 'reduce', 'forEach', 'flatMap', 'compactMap',
  'sorted', 'reversed', 'first', 'last', 'count', 'isEmpty', 'joined',
  'prefix', 'suffix', 'dropFirst', 'dropLast', 'enumerated',
  'replacingOccurrences', 'components', 'split', 'hasPrefix', 'hasSuffix',
  'lowercased', 'uppercased', 'trimmingCharacters', 'description',
  'allSatisfy', 'firstIndex', 'lastIndex', 'updateValue',
  'removeValue', 'sink', 'store', 'receive', 'assign',
]);

// === Complexity (cyclomatic + cognitive) ===
// CYCLOMATIC pins SwiftLint's `cyclomatic_complexity` (the exact runnable oracle;
// counts guard/catch — Swift's dominant constructs — the gocyclo/rust-code-analysis
// precedent of pinning the community tool rather than a closed analyzer). Each
// node here adds +1: `if`/`else if` (if_statement), the three loops, `guard`, each
// `catch_block`, and EVERY switch case INCL. `default` (switch_entry covers both).
// SwiftLint does NOT count `&&`/`||`, ternary, or `??` — so Swift is the only Probe
// language without cyclomatic booleans (cognitive still counts them). A `fallthrough`
// subtracts 1 (cancelling the case it falls through from) via `cyclomaticDecrement`
// at the call site. Nested funcs are skipped (SWIFT_SKIP_TYPES); closures
// (lambda_literal) are descended, so their branches count toward the enclosing
// function (the gocyclo / Go func_literal closure model).
const SWIFT_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement', 'for_statement', 'while_statement', 'repeat_while_statement',
  'guard_statement', 'catch_block', 'switch_entry',
]);

// `&&`/`||` are DISTINCT node types in tree-sitter-swift (not a C-family
// binary_expression with an operator field), so the shared cFamilyBooleanOperatorKind
// can't read them — Swift needs its own reader. `??` (nil_coalescing_expression) is
// NOT a logical operator → null (uncounted, like the whitepaper's &&/|| scope).
function swiftBooleanOperatorKind(node: Node): string | null {
  if (node.type === 'conjunction_expression') return '&&';
  if (node.type === 'disjunction_expression') return '||';
  return null;
}

// COGNITIVE pins the SonarSource whitepaper (no published cognitive spec for Swift
// exists, so there is no tool oracle; validated
// against hand-computed whitepaper fixtures, NOT a tool diff).
const SWIFT_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  // Swift's if_statement is POSITIONAL (no consequence/alternative field) — the
  // engine routes to its positional handler when ifPositionalBlockType is set, and
  // consequenceField/alternativeField are unused there (placeholders).
  consequenceField: '__swift_unused__',
  alternativeField: '__swift_unused__',
  ifPositionalBlockType: 'statements',
  // The `else` KEYWORD (a named token) — splits the consequence from the else branch so
  // an EMPTY `{}` consequence/else body doesn't drop the else's +1 (an empty block emits
  // no `statements` node, so the else must be detected by the keyword, not a 2nd block).
  elseKeywordType: 'else',
  loopTypes: new Set(['for_statement', 'while_statement', 'repeat_while_statement']),
  // loopBodyField UNSET → bump-all (Swift loop headers hold only expressions, so the
  // accepted loop-header overbump never bites — booleans there are flat anyway).
  switchTypes: new Set(['switch_statement']), // whole switch +1, cases nest
  ternaryType: 'ternary_expression',
  catchType: 'catch_block', // each catch surcharges; do_statement is pass-through
  // Closures raise nesting +0 and are descended (Go func_literal rule; matches the
  // extractor, which also descends lambda_literal for call resolution).
  nestOnlyTypes: new Set(['lambda_literal']),
  // break/continue/return/fallthrough are ALL `control_transfer_statement`; only a
  // labeled break/continue (the keyword + a simple_identifier `result`) is +1 flat.
  // `return x` also has a `result`, so the keyword gate is required.
  labeledJumpTypes: new Set(['control_transfer_statement']),
  hasLabel: (n) => {
    const kw = n.child(0)?.text;
    if (kw !== 'break' && kw !== 'continue') return false;
    return n.childForFieldName('result')?.type === 'simple_identifier';
  },
  booleanOperatorKind: swiftBooleanOperatorKind,
  // conjunction/disjunction nodes use lhs/rhs operand fields (not left/right).
  booleanLeftField: 'lhs',
  booleanRightField: 'rhs',
  // No-unwrap SENTINEL: a parenthesized boolean is its own run (`(a&&b)&&c`=2, the
  // gocognit/sonar-python convention). tree-sitter-swift wraps parens in a
  // `tuple_expression`, which the engine's skipParens would mis-unwrap (it takes
  // namedChild(0) with no single-element guard, so a real 2-tuple `(a,b)` or a
  // leading comment would be misread) — and there is NO oracle to pin unwrap-vs-not,
  // so the safe choice is no unwrap.
  parenthesizedType: '__swift_no_paren__',
  // `guard` = +1 FLAT (descend at same nesting): the irrefutable-binding analog of
  // Rust's let-else, and Swift's nesting-REDUCING idiom (guard exists to AVOID the
  // nesting an `if let` would add), so no surcharge. Its condition's `&&`/`||` are
  // still counted (flatIncrement descends children). A whitepaper-PRINCIPLE pin — no
  // Swift cognitive oracle exists, so this is documented and fixture-pinned.
  flatIncrement: (n) => n.type === 'guard_statement',
};

// A `fallthrough` STATEMENT triggers SwiftLint's `complexity -= 1` (it cancels the +1
// of the switch case it falls through from — the two cases are one path).
// tree-sitter-swift parses `fallthrough` in TWO shapes depending on context, and the
// cyclomatic DFS only walks NAMED children, so both must be detected at a VISITED node:
//   (A) ALONE in a block — a case whose ONLY statement is `fallthrough`, or a
//       `fallthrough` nested inside an if/loop/do (even alongside siblings THERE): a
//       NAMED `simple_identifier` text `fallthrough` whose parent is `statements`.
//       The parent gate is REQUIRED: `fallthrough` is reserved ONLY as a statement, so
//       a member/property/enum-case name or labeled arg (`o.fallthrough()`,
//       `E.fallthrough`, `f(fallthrough:)`) is ALSO a `simple_identifier` text
//       `fallthrough` but sits under `navigation_suffix`/`value_argument_label`, not
//       `statements` — without the gate those spuriously decrement (oracle-confirmed).
//   (B) a case body's TOP-LEVEL statement alongside siblings (`case 1: work();
//       fallthrough`): an ANONYMOUS `fallthrough` node, a DIRECT child of
//       `switch_entry`, which is NOT a `simple_identifier` AND not a NAMED child (so the
//       DFS never visits it). Detected on the `switch_entry` itself (a visited decision
//       node, +1): a switch_entry with a direct `fallthrough` child nets to 0.
// Both shapes decrement exactly once per fallthrough (a case falls through at most once;
// shape A is under `statements`, shape B is a direct switch_entry child — never both).
function swiftFallthroughDecrement(n: Node): boolean {
  if (n.type === 'simple_identifier') {
    return n.text === 'fallthrough' && n.parent?.type === 'statements';
  }
  if (n.type === 'switch_entry') {
    return n.children.some((c) => c?.type === 'fallthrough');
  }
  return false;
}

// Per-file duplicate-id disambiguation. Two trait-conformance methods, or an
// extension method duplicating a type method, can be byte-identical in
// (name, kind, signature, qualifier). Repeats get an ordinal qualifier; ids
// shift only when an EARLIER duplicate is added/removed (Rust/Go's rule).
type OccurrenceCounter = Map<string, number>;

interface SwiftCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
}

export function extractSwift(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const ctx: SwiftCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  extractTopLevel(ctx, tree.rootNode);

  // Same-name types in one file are invalid Swift, so this only fires on
  // broken parses — where refusing resolution beats binding through a
  // half-parsed type.
  const ambiguousTypeNames = collectAmbiguousTypeNames(ctx.symbols, SWIFT_TYPE_KINDS);

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    SWIFT_SELECTORS,
    SWIFT_SKIP_TYPES,
    SWIFT_FUNCTION_BODY_SKIP_TYPES,
    swiftMemberCallInfo,
    {
      bareCalleeTypes: SWIFT_BARE_CALLEE_TYPES,
      plainCalleeType: 'simple_identifier',
      // Swift allows implicit-self bare method calls (`func a(){ b() }` calls
      // self.b()), so a bare call resolves against the enclosing class first.
      bareCallsBindToEnclosingClass: true,
      bareCallableKinds: SWIFT_BARE_CALLABLE_KINDS,
      // No constructorKinds: construction has no distinct node; it resolves as
      // a bare call to a 'class'-kind symbol via bareCallableKinds.
      ambiguousClassNames: ambiguousTypeNames,
      ignoredBareCallees: SWIFT_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: SWIFT_IGNORED_MEMBER_CALLEES,
    },
  );
  // Per-symbol cyclomatic + cognitive complexity, computed while the tree is alive
  // (the same boundary as resolveCalls: nested funcs skipped, closures descended).
  computeComplexity(ctx.bodies, ctx.symbols, {
    decisionNodeTypes: SWIFT_DECISION_NODE_TYPES,
    skipTypes: SWIFT_SKIP_TYPES,
    // SwiftLint's `fallthrough` −1 — see swiftFallthroughDecrement (two parse shapes).
    cyclomaticDecrement: swiftFallthroughDecrement,
    cognitive: SWIFT_COGNITIVE_OPTIONS,
  });
  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Top-level source_file items. containerExported is true (the file is the
// module surface); qualifier is empty.
function extractTopLevel(ctx: SwiftCtx, root: Node): void {
  for (const child of root.namedChildren) {
    switch (child.type) {
      case 'import_declaration':
        extractImport(ctx, child);
        break;
      case 'class_declaration':
        extractType(ctx, child, '', true);
        break;
      case 'protocol_declaration':
        extractProtocol(ctx, child, '', true);
        break;
      case 'function_declaration':
        extractFunctionLike(ctx, child, 'function', undefined, '', true);
        break;
      case 'property_declaration':
        extractProperty(ctx, child, undefined, '', true);
        break;
      case 'typealias_declaration':
        extractTypealias(ctx, child, undefined, '', true);
        break;
      // comments, operator/precedencegroup declarations, top-level statements,
      // ERROR nodes from #if directive lines — no symbols.
      default:
        break;
    }
  }
}

// class / struct / actor / enum (one `class_declaration` node, discriminated by
// the `declaration_kind` field token) — or an extension, which is methods-apart
// and not a symbol.
function extractType(
  ctx: SwiftCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const declKind = decl.childForFieldName('declaration_kind')?.text;
  if (declKind === 'extension') {
    extractExtension(ctx, decl, parentQualifier, containerExported);
    return;
  }
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const kind: SymbolKind = declKind === 'enum' ? 'enum' : 'class';
  const exported = containerExported && !isHidden(decl);
  ctx.symbols.push(
    makeSwiftSymbol(
      ctx,
      decl,
      declSignature(decl, ctx.content),
      kind,
      name,
      `${ctx.fileInfo.path}:${name}`,
      exported,
      swiftDoc(decl),
      parentQualifier,
    ),
  );
  const body = decl.childForFieldName('body'); // class_body | enum_class_body
  if (body) extractTypeBody(ctx, body, name, joinQualifier(parentQualifier, name), exported);
}

// `extension Foo { ... }` — not a symbol. Its members key on the EXTENDED type
// (`file:Foo.member`), merging into the same methodsByClass[Foo] as Foo's own
// methods (the Rust impl-merge / Go-receiver pattern), so `self.m()` here and
// `foo.m()` elsewhere both resolve. The extension's own visibility is the
// container default for its members (`public extension` exports them).
function extractExtension(
  ctx: SwiftCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const name = extensionTypeName(decl);
  if (!name) return;
  const exported = containerExported && !isHidden(decl);
  const body = decl.childForFieldName('body');
  if (body) extractTypeBody(ctx, body, name, joinQualifier(parentQualifier, name), exported);
}

// protocol → 'interface'; its body members are declaration-only methods (no
// body → populate methodsByClass so conformance and `obj.m()` resolve),
// property requirements, and associated types.
function extractProtocol(
  ctx: SwiftCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const exported = containerExported && !isHidden(decl);
  ctx.symbols.push(
    makeSwiftSymbol(
      ctx,
      decl,
      declSignature(decl, ctx.content),
      'interface',
      name,
      `${ctx.fileInfo.path}:${name}`,
      exported,
      swiftDoc(decl),
      parentQualifier,
    ),
  );
  const body = decl.childForFieldName('body'); // protocol_body
  if (!body) return;
  const qualifier = joinQualifier(parentQualifier, name);
  for (const member of body.namedChildren) {
    switch (member.type) {
      case 'protocol_function_declaration': {
        const mname = member.childForFieldName('name')?.text;
        if (!mname) break;
        // Declaration-only (no body) — never a PendingBody.
        ctx.symbols.push(
          makeSwiftSymbol(
            ctx,
            member,
            declSignature(member, ctx.content),
            'method',
            mname,
            `${ctx.fileInfo.path}:${name}.${mname}`,
            exported && !isHidden(member),
            swiftDoc(member),
            qualifier,
          ),
        );
        break;
      }
      case 'protocol_property_declaration':
        extractProperty(ctx, member, name, qualifier, exported);
        break;
      case 'associatedtype_declaration': {
        const aname = member.childForFieldName('name')?.text;
        if (!aname) break;
        ctx.symbols.push(
          makeSwiftSymbol(
            ctx,
            member,
            declSignature(member, ctx.content),
            'type',
            aname,
            `${ctx.fileInfo.path}:${name}.${aname}`,
            exported && !isHidden(member),
            swiftDoc(member),
            qualifier,
          ),
        );
        break;
      }
      default:
        break;
    }
  }
}

// A type/extension body (class_body | enum_class_body). enum_entry cases are
// NOT extracted (the TS/Java/Go/Rust enum-member rule).
function extractTypeBody(
  ctx: SwiftCtx,
  body: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  for (const member of body.namedChildren) {
    switch (member.type) {
      case 'function_declaration':
        extractFunctionLike(ctx, member, 'method', className, qualifier, containerExported);
        break;
      case 'init_declaration':
        extractNamedMethod(ctx, member, 'init', className, qualifier, containerExported);
        break;
      case 'deinit_declaration':
        extractNamedMethod(ctx, member, 'deinit', className, qualifier, containerExported);
        break;
      case 'subscript_declaration':
        extractSubscript(ctx, member, className, qualifier, containerExported);
        break;
      case 'property_declaration':
        extractProperty(ctx, member, className, qualifier, containerExported);
        break;
      // Nested types: simple-name FQN, the enclosing chain folds into the
      // hashed qualifier only (Java/Rust nested-type rule).
      case 'class_declaration':
        extractType(ctx, member, qualifier, containerExported);
        break;
      case 'protocol_declaration':
        extractProtocol(ctx, member, qualifier, containerExported);
        break;
      case 'typealias_declaration':
        extractTypealias(ctx, member, className, qualifier, containerExported);
        break;
      default:
        break;
    }
  }
}

// function_declaration as a top-level 'function' (className undefined) or a
// 'method' (className set). Operator funcs name to the operator token text
// (`+`, `==`). The body becomes a PendingBody so its calls attribute here and
// self-calls resolve against className.
function extractFunctionLike(
  ctx: SwiftCtx,
  decl: Node,
  kind: 'function' | 'method',
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const fqn = className
    ? `${ctx.fileInfo.path}:${className}.${name}`
    : `${ctx.fileInfo.path}:${name}`;
  const sym = makeSwiftSymbol(
    ctx,
    decl,
    declSignature(decl, ctx.content),
    kind,
    name,
    fqn,
    containerExported && !isHidden(decl),
    swiftDoc(decl),
    qualifier,
  );
  ctx.symbols.push(sym);
  const body = decl.childForFieldName('body');
  if (body) ctx.bodies.push({ symbolId: sym.id, body, className });
}

// init / deinit → a 'method' with a fixed name (TS/Java convention adapted —
// `init` matches the Swift keyword so find_symbol works and `self.init(...)`
// delegating calls resolve via methodsByClass[Type]['init']).
function extractNamedMethod(
  ctx: SwiftCtx,
  decl: Node,
  name: string,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const sym = makeSwiftSymbol(
    ctx,
    decl,
    declSignature(decl, ctx.content),
    'method',
    name,
    `${ctx.fileInfo.path}:${className}.${name}`,
    containerExported && !isHidden(decl),
    swiftDoc(decl),
    qualifier,
  );
  ctx.symbols.push(sym);
  const body = decl.childForFieldName('body');
  if (body) ctx.bodies.push({ symbolId: sym.id, body, className });
}

// subscript → a 'method' named 'subscript' (its `name` field is the RETURN
// TYPE, so the name is fixed manually). Signature stops at the accessor block.
function extractSubscript(
  ctx: SwiftCtx,
  decl: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const computed = decl.namedChildren.find((c) => c.type === 'computed_property');
  const sigEnd = computed ? computed.startIndex : decl.endIndex;
  const sym = makeSwiftSymbol(
    ctx,
    decl,
    normalizeSignature(ctx.content.slice(decl.startIndex, sigEnd)),
    'method',
    'subscript',
    `${ctx.fileInfo.path}:${className}.subscript`,
    containerExported && !isHidden(decl),
    swiftDoc(decl),
    qualifier,
  );
  ctx.symbols.push(sym);
  if (computed) ctx.bodies.push({ symbolId: sym.id, body: computed, className });
}

// property_declaration / protocol_property_declaration → one 'variable' per
// bound name. Walk children in order: each `name` pattern opens a binding, and
// the `value` initializer, `computed_property` (getter/setter), and
// `willset_didset_block` observers that FOLLOW it belong to THAT binding —
// so `let a = foo(), b = bar()` attributes bar() to b, not a. Each becomes a
// PendingBody (className set in a type) so its calls attribute to the property
// and self-calls resolve — the densest recall surface in idiomatic Swift. The
// PendingBody body is the accessor/initializer subtree, never the whole
// declaration, so property-wrapper attribute arguments aren't attributed here
// (the module-root walk skips them too — `modifiers` ∈ SWIFT_SKIP_TYPES).
function extractProperty(
  ctx: SwiftCtx,
  decl: Node,
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const signature = propertySignature(decl, ctx.content);
  const exported = containerExported && !isHidden(decl);
  const doc = swiftDoc(decl);
  let currentId: string | null = null;
  for (let i = 0; i < decl.childCount; i++) {
    const child = decl.child(i);
    if (!child) continue;
    const field = decl.fieldNameForChild(i);
    if (field === 'name' && child.type === 'pattern') {
      const id = child.childForFieldName('bound_identifier');
      if (id?.type === 'simple_identifier') {
        const fqn = className
          ? `${ctx.fileInfo.path}:${className}.${id.text}`
          : `${ctx.fileInfo.path}:${id.text}`;
        const sym = makeSwiftSymbol(ctx, decl, signature, 'variable', id.text, fqn, exported, doc, qualifier);
        ctx.symbols.push(sym);
        currentId = sym.id;
      } else {
        currentId = null; // tuple/wildcard binding — no symbol to attribute to
      }
    } else if (
      currentId !== null &&
      (field === 'value' || child.type === 'computed_property' || child.type === 'willset_didset_block')
    ) {
      ctx.bodies.push({ symbolId: currentId, body: child, className });
    }
  }
}

// typealias / associatedtype → 'type'. The `name` field is the alias name
// (childForFieldName returns the first such field, not the aliased type).
function extractTypealias(
  ctx: SwiftCtx,
  decl: Node,
  className: string | undefined,
  qualifier: string,
  containerExported: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const fqn = className
    ? `${ctx.fileInfo.path}:${className}.${name}`
    : `${ctx.fileInfo.path}:${name}`;
  ctx.symbols.push(
    makeSwiftSymbol(
      ctx,
      decl,
      declSignature(decl, ctx.content),
      'type',
      name,
      fqn,
      containerExported && !isHidden(decl),
      swiftDoc(decl),
      qualifier,
    ),
  );
}

// `import Foundation` → namespace import of the whole module; `import struct
// Foundation.Data` → a single-symbol import (last segment = name, the rest =
// module). Dotted module paths (`import A.B`) stay whole-module namespaces.
function extractImport(ctx: SwiftCtx, decl: Node): void {
  const idNode = decl.namedChildren.find((c) => c.type === 'identifier');
  if (!idNode) return;
  const segments = idNode.namedChildren
    .filter((c) => c.type === 'simple_identifier')
    .map((c) => c.text);
  if (segments.length === 0) return;
  const line = decl.startPosition.row + 1;
  const hasKind = decl.children.some(
    (c) => c != null && !c.isNamed && SWIFT_IMPORT_KINDS.has(c.text),
  );
  if (hasKind && segments.length >= 2) {
    const name = segments[segments.length - 1]!;
    ctx.imports.push({
      file: ctx.fileInfo.path,
      sourceModule: segments.slice(0, -1).join('.'),
      importedNames: [{ name }],
      line,
    });
  } else {
    ctx.imports.push({
      file: ctx.fileInfo.path,
      sourceModule: segments.join('.'),
      importedNames: [{ name: IMPORT_NAMESPACE, kind: 'namespace' }],
      line,
    });
  }
}

// Extended type's simple name = the LAST direct `type_identifier` child of the
// `user_type` name node. `extension Swift.String` → String (scoped, last
// segment); `extension Array<Int>` → Array (the type_arguments node is a
// separate child, not a type_identifier); `extension Dictionary` → Dictionary.
function extensionTypeName(decl: Node): string | null {
  const nameNode = decl.childForFieldName('name');
  if (!nameNode) return null;
  let result: string | null = null;
  for (const child of nameNode.namedChildren) {
    if (child.type === 'type_identifier') result = child.text;
  }
  return result;
}

// Property signature stops before the accessor/observer/requirement block so a
// long computed body doesn't blow the 120-char display cap (the initializer
// value is kept — it's informative for constants).
function propertySignature(decl: Node, content: string): string {
  let cut = decl.endIndex;
  for (const child of decl.namedChildren) {
    if (
      child.type === 'computed_property' ||
      child.type === 'willset_didset_block' ||
      child.type === 'protocol_property_requirements'
    ) {
      cut = child.startIndex;
      break;
    }
  }
  return normalizeSignature(content.slice(decl.startIndex, cut));
}

// exported = NO `private`/`fileprivate` visibility modifier (so absent =
// internal, public, and open all export — internal is the module's default and
// counts as exported). `private(set)` keeps a getter at the declared level, so
// its visibility_modifier text is `private(set)` (≠ `private`) and stays
// visible. Members AND-in their container's exportedness via the caller.
function isHidden(decl: Node): boolean {
  const mods = decl.namedChildren.find((c) => c.type === 'modifiers');
  if (!mods) return false;
  for (const m of mods.namedChildren) {
    if (m.type === 'visibility_modifier' && (m.text === 'private' || m.text === 'fileprivate')) {
      return true;
    }
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

function makeSwiftSymbol(
  ctx: SwiftCtx,
  node: Node,
  signature: string,
  kind: SymbolKind,
  name: string,
  fqn: string,
  exported: boolean,
  doc: string | null,
  qualifier = '',
): Symbol {
  // Repeated identical (name, kind, signature, qualifier) tuples — e.g. a
  // same-signature method across an extension and the type — get an ordinal so
  // ids stay unique per file.
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

// Doc = the immediately-preceding `///` line block or a `/** */` block. Swift
// attributes live INSIDE the declaration (no Rust-style sibling skipping) and
// comments carry no trailing newline, so this is the Go contiguous-block walk:
// nearest adjacent non-trailing doc comment, first line with content. Plain
// `//` / `/* */` are NOT doc comments (DocC convention).
function swiftDoc(decl: Node): string | null {
  const nearest = decl.previousNamedSibling;
  if (!nearest || !isDocComment(nearest)) return null;
  if (nearest.endPosition.row !== decl.startPosition.row - 1) return null;
  if (isTrailingComment(nearest)) return null;
  // A `/** */` block is a single node.
  if (nearest.type === 'multiline_comment') return commentDocLine(nearest.text);

  // Walk up the contiguous `///` line block.
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

function isDocComment(node: Node): boolean {
  if (node.type === 'comment') return node.text.startsWith('///');
  if (node.type === 'multiline_comment') return node.text.startsWith('/**');
  return false;
}
