import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE } from '../../types.js';
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

// Reduces a member-expression OR cascade-call callee to {receiver, property}.
// Single-level receivers only: a chained `a.b().c()` has a `call_expression`
// object and returns null (same contract as the other languages). `this` is a
// fixed token (a `this` node), decided here like Swift/Kotlin/Python — Dart
// needs no PendingBody.selfReceiverName.
function dartMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'member_expression') {
    // unwrapClosureTail recovers the `() => obj.m()` arrow-closure misparse, where
    // the receiver `obj` is the function_expression object's arrow-body tail.
    const object = unwrapClosureTail(callee.childForFieldName('object'));
    const property = callee.childForFieldName('property');
    if (property?.type !== 'identifier') return null;
    if (object?.type === 'this') return { receiver: 'this', property: property.text, isSelf: true };
    if (object?.type === 'identifier') return { receiver: object.text, property: property.text, isSelf: false };
    return null; // chained call / computed / super receiver
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
    let first = section;
    while (first.previousSibling?.type === 'cascade_section') first = first.previousSibling;
    const target = first.previousSibling;
    if (target?.type === 'this') return { receiver: 'this', property: property.text, isSelf: true };
    if (target?.type === 'identifier') return { receiver: target.text, property: property.text, isSelf: false };
    return null; // construction/chained/computed cascade target — can't resolve
  }
  return null;
}

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
    },
  );
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
