import type { Node, Tree } from 'web-tree-sitter';

import { collectAmbiguousTypeNames } from '../extractor.js';
import { RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
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

// ── skip sets ────────────────────────────────────────────────────────────────

// walkDecorators uses this — C++ has no decorator selector, so it never runs;
// keep nested function_definition here for parity (local functions own a scope).
const CPP_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['function_definition']);

// Preprocessor conditional group nodes (`#if`/`#ifdef`/…). The member walk
// (extractScope/handleMember) recurses through these transparently to extract
// guarded members; the resolveCalls walk does NOT (they're in CPP_SKIP_TYPES,
// below). The continuations (`#else`/`#elif`) are nested CHILDREN of the head
// `#if` (under its `alternative:` field), each compiled independently.
// tree-sitter-cpp maps BOTH `#ifdef` and `#ifndef` to `preproc_ifdef`, and BOTH
// `#elifdef` and `#elifndef` to `preproc_elifdef` (verified) — so there is no
// `preproc_ifndef`/`preproc_elifndef` node type to list.
const PREPROC_GROUPS: ReadonlySet<string> = new Set([
  'preproc_if',
  'preproc_ifdef',
  'preproc_else',
  'preproc_elif',
  'preproc_elifdef',
]);

// `#else`/`#elif`-family continuation branches (a subset of PREPROC_GROUPS) — each
// compiles independently of the then-branch, so visibility resets to the enclosing
// baseline when entering one (see handleMember).
const PREPROC_CONTINUATIONS: ReadonlySet<string> = new Set([
  'preproc_else',
  'preproc_elif',
  'preproc_elifdef',
]);

// walkCalls skip set: each function/method/variable owns a per-member PendingBody,
// so the call walk must NOT re-descend into a function body or a type body (their
// calls are attributed via their own PendingBody) — pruning these also stops a
// nested local class/function's calls from mis-attributing to an enclosing body.
// The `preproc_*` conditionals are pruned HERE (but NOT from the member walk): a
// function-like-macro CONDITION (`#if FOO(3)`) parses as a `call_expression`, so
// descending into it would emit a SPURIOUS resolved call edge to a same-named real
// function. Guarded members keep their own PendingBodies (created by extractScope,
// which DOES descend preproc), so pruning here loses only top-level free-statement
// calls inside a guard (none exist in valid C++). `namespace_definition` stays
// ABSENT → DESCENDED (namespace-level free calls reach the module-root walk).
// `lambda_expression` is ABSENT → DESCENDED (a closure's calls roll into the
// enclosing function — the Go func_literal / Java lambda rule).
const CPP_SKIP_TYPES: ReadonlySet<string> = new Set([
  'function_definition',
  'class_specifier',
  'struct_specifier',
  'union_specifier',
  'enum_specifier',
  'template_declaration',
  ...PREPROC_GROUPS,
]);

// ── call resolution ──────────────────────────────────────────────────────────

// Bare callee is the engine-default `identifier`; `type_identifier` is added ONLY
// so the `new Foo()` callee (`new_expression`'s `type:` is a `type_identifier`)
// passes the bare-callee gate — `constructorSelectorTypes` then routes it through
// `typeNameToId` (constructorKinds={class}) by NODE type, so a `new Foo()` can
// never mis-bind to an enclosing method named Foo (the C# precedent). A call
// NEVER has a `type_identifier` callee (the grammar is syntactic — `Foo()` value
// construction parses with an `identifier` callee), so this only affects `new`.
const CPP_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier', 'type_identifier']);

// A bare `foo()` is either a free-function call or — inside a class body — an
// implicit-`this` member call, so it binds to the enclosing class first
// (bareCallsBindToEnclosingClass) then the callable-name map over {function}.
// Methods are NOT bare-callable (they need a receiver) — they resolve only via
// methodsByClass. Classes are NOT bare-callable, so a bare `Foo()` value
// construction stays unresolved (a documented recall gap), never a wrong edge.
const CPP_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function']);

// `new Foo()` resolves to a 'class'-kind symbol via the constructor-form path.
const CPP_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class']);

// `new X()` is the distinct construction NODE (the C# object_creation precedent):
// route it through constructorKinds/typeNameToId by node type so it never flows
// through the enclosing-class/nameToId path.
const CPP_CONSTRUCTOR_SELECTORS: ReadonlySet<string> = new Set(['new_expression']);

// C / C++ standard-library free functions that parse as bare `identifier` callees
// but never resolve to a local symbol — they would flood the name-keyed reference
// store. Suppressed ONLY when unresolved (a file-local shadow keeps its refs).
// START small + tune by dogfood (the measure-don't-guess method).
const CPP_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  // <cstdio> / <cstdlib> / <cstring>
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'fscanf', 'sscanf',
  'puts', 'fputs', 'fopen', 'fclose', 'fread', 'fwrite', 'fflush', 'perror',
  'malloc', 'calloc', 'realloc', 'free', 'abort', 'exit', 'atexit', 'getenv',
  'memcpy', 'memset', 'memmove', 'memcmp', 'strlen', 'strcmp', 'strncmp',
  'strcpy', 'strncpy', 'strcat', 'strncat', 'strchr', 'strstr', 'atoi', 'atof',
  // assertions / common <algorithm>/<utility> globals reached via `using`
  'assert', 'static_assert', 'move', 'forward', 'swap', 'min', 'max',
  'make_unique', 'make_shared', 'make_pair', 'make_tuple', 'to_string',
]);

// STL container / iterator / smart-pointer / string method names whose chained
// captures are pure noise (`.push_back()`, `.begin()`, `.size()`, …). Suppressed
// only when UNRESOLVED, so a same-file `this->size()` that bound to a real
// sibling keeps its ref. Keep these to >=4 chars (SHORT_NAME_THRESHOLD gates the
// rest downstream). START small + tune by dogfood.
const CPP_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'push_back', 'emplace_back', 'push_front', 'emplace_front', 'pop_back',
  'pop_front', 'insert', 'emplace', 'erase', 'clear', 'empty', 'size',
  'begin', 'end', 'cbegin', 'cend', 'rbegin', 'rend', 'find', 'count',
  'reserve', 'resize', 'data', 'front', 'back', 'c_str', 'length', 'substr',
  'append', 'compare', 'str', 'first', 'second', 'reset', 'release', 'lock',
  'value', 'value_or', 'has_value', 'get', 'count_if', 'contains',
]);

const CPP_SELECTORS: ReadonlyArray<CallSelector> = [
  // Ordinary calls: bare `foo()`, member `obj.m()`/`ptr->m()`/`this->m()`, and
  // scope-resolution `Foo::bar()`/`ns::f()` — discriminated by the callee node.
  { nodeType: 'call_expression', getCallee: (n) => n.childForFieldName('function') },
  // Construction `new Foo()` (a distinct node). Only a simple `type_identifier`
  // target resolves; `new ns::Widget()` (qualified_identifier) and
  // `new Box<int>()` (template_type) are DROPPED — a documented recall gap, never
  // a wrong cross-namespace edge.
  {
    nodeType: 'new_expression',
    getCallee: (n) => {
      const t = n.childForFieldName('type');
      return t && t.type === 'type_identifier' ? t : null;
    },
  },
];

// Reduces a member-expression / scope-resolution callee to {receiver, property}.
//   `this->m()`             → self-call (resolve against the enclosing class)
//   `obj.m()` / `ptr->m()`  → receiver = `obj`/`ptr` (an identifier; unresolved
//                             name-keyed member ref unless a class shares the name)
//   `Foo::bar()` / `ns::f()`→ receiver = the innermost scope segment (the
//                             Rust/PHP/Ruby `::` single-level member-ref pattern)
//   chained `a.b().c()` / `f()->g()` / computed → RECEIVER_OPAQUE (findable, never
//                             resolved)
function cppMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'field_expression') {
    const field = callee.childForFieldName('field');
    if (!field || field.type !== 'field_identifier') return null; // `p->~Foo()` etc.
    const property = field.text;
    const arg = callee.childForFieldName('argument');
    if (!arg) return null;
    if (arg.type === 'this') return { receiver: 'this', property, isSelf: true };
    if (arg.type === 'identifier') return { receiver: arg.text, property, isSelf: false };
    // chained / parenthesized / subscript / call receiver → opaque
    return { receiver: RECEIVER_OPAQUE, property, isSelf: false };
  }
  if (callee.type === 'qualified_identifier') {
    const q = qualifiedName(callee);
    if (!q) return null;
    // The innermost scope segment is the receiver class; the final name is the
    // method. `Foo::bar()` → {Foo, bar}; `ns::Foo::bar()` → {Foo, bar}.
    return { receiver: q.classScope ?? RECEIVER_OPAQUE, property: q.name, isSelf: false };
  }
  return null;
}

// ── symbol extraction ─────────────────────────────────────────────────────────

type Visibility = 'public' | 'protected' | 'private';

// Per-file duplicate-id disambiguation (the Go/Ruby/C# OccurrenceCounter): two
// same-(name,kind,signature,qualifier) symbols get an ordinal qualifier. C++
// overloads differ by signature, but an in-class declaration + its out-of-line
// definition, or two identical-signature overloads in macro-expanded code, can
// still collide.
type OccurrenceCounter = Map<string, number>;

interface CppCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
}

// The lexical scope a member is being extracted in.
interface Enclosing {
  // The immediate enclosing class/struct/union name (member FQN + methodsByClass
  // key), or null at namespace / top level.
  className: string | null;
  // Hashed-qualifier prefix: the namespace path + enclosing-type chain joined with
  // `::`. Folds into symbolId so same-name members in different namespaces/types
  // get distinct ids; the FQN itself stays simple-name (the C# rule).
  qualifier: string;
  // Whether the container is exported (propagates down — a member of a private
  // nested class is never exported).
  exported: boolean;
  // True inside a class/struct/union body, where `access_specifier` visibility
  // applies. False at namespace / top level (everything is "public").
  inClass: boolean;
  defaultVisibility: Visibility;
}

// A template wrapper applied to the immediately-enclosed declaration: its
// `template<…>` text prefixes the signature, and its node anchors the doc lookup
// (the comment is a sibling of the template_declaration, not the inner decl).
interface TemplateWrap {
  prefix: string;
  docNode: Node;
}

export function extractCpp(tree: Tree, content: string, fileInfo: FileInfo): ExtractResult {
  const ctx: CppCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  extractScope(ctx, tree.rootNode.namedChildren, {
    className: null,
    qualifier: '',
    exported: true,
    inClass: false,
    defaultVisibility: 'public',
  });

  // Same-name classes/structs share the simple-name FQN; resolving through them
  // first-wins would bind to the WRONG type, so exclude them from extract-time
  // resolution (the Go/Java/C# pattern). Function overloads are NOT excluded —
  // they are one logical family and first-wins binding to an overload is a
  // same-kind, accepted imprecision (the Java method-overload precedent), unlike
  // PHP/Ruby where same-name free functions are genuinely cross-namespace.
  const ambiguousClassNames = collectAmbiguousTypeNames(ctx.symbols, new Set(['class']));

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    CPP_SELECTORS,
    CPP_SKIP_TYPES,
    CPP_FUNCTION_BODY_SKIP_TYPES,
    cppMemberCallInfo,
    {
      bareCalleeTypes: CPP_BARE_CALLEE_TYPES,
      plainCalleeType: 'identifier',
      bareCallableKinds: CPP_BARE_CALLABLE_KINDS,
      bareCallsBindToEnclosingClass: true, // implicit this
      constructorKinds: CPP_CONSTRUCTOR_KINDS,
      constructorSelectorTypes: CPP_CONSTRUCTOR_SELECTORS,
      ambiguousClassNames,
      ignoredBareCallees: CPP_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: CPP_IGNORED_MEMBER_CALLEES,
    },
  );

  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Walks a translation-unit / namespace / class body in document order, tracking
// the current access visibility (C++ `public:`/`private:` are stateful positional
// labels — the Ruby visibility pattern). `preproc_*` conditionals are recursed
// through transparently (an `#ifndef` include guard wraps the whole header, and
// `#if`-guarded members must still be extracted; both branches are extracted, the
// OccurrenceCounter keeps ids unique).
function extractScope(ctx: CppCtx, children: readonly Node[], enclosing: Enclosing): void {
  const state = { visibility: enclosing.defaultVisibility };
  for (const child of children) handleMember(ctx, child, enclosing, state);
}

const RECORD_SPECIFIERS: ReadonlySet<string> = new Set([
  'class_specifier',
  'struct_specifier',
  'union_specifier',
]);

function handleMember(
  ctx: CppCtx,
  child: Node,
  enclosing: Enclosing,
  state: { visibility: Visibility },
  wrap: TemplateWrap | null = null,
): void {
  const t = child.type;
  if (PREPROC_GROUPS.has(t)) {
    // Transparent: a guarded region's members are flattened into this loop so its
    // members see the enclosing visibility. But an `access_specifier` INSIDE the
    // guard must not leak past `#endif` — we can't evaluate the preprocessor, so a
    // guarded `private:` shouldn't silently de-export every following member.
    // Snapshot the ENCLOSING visibility; restore it after the whole group, AND
    // reset to it before each `#else`/`#elif` continuation (nested as a child under
    // the head's `alternative:` field) — each preprocessor branch compiles
    // independently, so a then-branch label must not bleed into the else/elif.
    const saved = state.visibility;
    for (const c of child.namedChildren) {
      if (PREPROC_CONTINUATIONS.has(c.type)) state.visibility = saved;
      handleMember(ctx, c, enclosing, state, wrap); // thread wrap (a templated guarded decl)
    }
    state.visibility = saved;
    return;
  }
  if (t === 'linkage_specification') {
    // `extern "C" { … }` / `extern "C" <decl>` — a transparent grouping node (no
    // new scope): recurse its body declarations with the same enclosing/state.
    const body = child.childForFieldName('body');
    if (body?.type === 'declaration_list') {
      for (const c of body.namedChildren) handleMember(ctx, c, enclosing, state, wrap);
    } else if (body) {
      handleMember(ctx, body, enclosing, state, wrap);
    }
    return;
  }
  switch (t) {
    case 'access_specifier':
      if (enclosing.inClass) {
        const v = accessText(child);
        if (v) state.visibility = v;
      }
      return;
    case 'preproc_include':
      extractInclude(ctx, child);
      return;
    case 'namespace_definition':
      extractNamespace(ctx, child, enclosing);
      return;
    case 'class_specifier':
    case 'struct_specifier':
    case 'union_specifier':
      extractRecord(ctx, child, enclosing, state.visibility, wrap);
      return;
    case 'enum_specifier':
      extractEnum(ctx, child, enclosing, state.visibility, wrap);
      return;
    case 'template_declaration':
      handleTemplate(ctx, child, enclosing, state);
      return;
    case 'type_definition':
      extractTypedef(ctx, child, enclosing, state.visibility, wrap);
      return;
    case 'alias_declaration':
      extractAlias(ctx, child, enclosing, state.visibility, wrap);
      return;
    case 'function_definition':
      extractFunctionDef(ctx, child, enclosing, state.visibility, wrap);
      return;
    case 'declaration':
    case 'field_declaration':
      extractDeclaration(ctx, child, enclosing, state.visibility, wrap);
      return;
    default:
      // using_declaration / friend_declaration / static_assert / expression
      // statements / etc. — not symbols in v1.
      return;
  }
}

// `template<…> <decl>`: unwrap to the inner decl, carrying the `template<…>`
// preamble into the signature and the template_declaration as the doc anchor.
function handleTemplate(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  state: { visibility: Visibility },
): void {
  const params = decl.childForFieldName('parameters');
  const prefix = params ? `template${normalizeSignature(params.text)} ` : 'template ';
  const wrap: TemplateWrap = { prefix, docNode: decl };
  for (const c of decl.namedChildren) {
    if (c.type === 'template_parameter_list' || c.type === 'requires_clause') continue;
    handleMember(ctx, c, enclosing, state, wrap);
  }
}

function extractNamespace(ctx: CppCtx, decl: Node, enclosing: Enclosing): void {
  const nameNode = decl.childForFieldName('name');
  const body = decl.childForFieldName('body');
  if (!body) return; // namespace alias / extension without a body block
  const seg = nameNode ? nameNode.text : ''; // anonymous namespace → no segment
  extractScope(ctx, body.namedChildren, {
    className: null,
    qualifier: joinQualifier(enclosing.qualifier, seg),
    exported: enclosing.exported,
    inClass: false,
    defaultVisibility: 'public',
  });
}

function extractRecord(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
  wrap: TemplateWrap | null,
): void {
  const name = recordName(decl);
  if (!name) return; // anonymous struct/union (a field's inline type) — not a symbol
  const exported = memberExported(enclosing, visibility);
  ctx.symbols.push(
    makeCppSymbol(
      ctx,
      wrap?.docNode ?? decl,
      cppSignature(ctx, decl, wrap?.prefix),
      'class',
      name,
      topFqn(ctx, name),
      exported,
      cppDoc(wrap?.docNode ?? decl),
      enclosing.qualifier,
    ),
  );
  const body = decl.childForFieldName('body');
  if (!body) return; // forward declaration `class Foo;`
  extractScope(ctx, body.namedChildren, {
    className: name,
    qualifier: joinQualifier(enclosing.qualifier, name),
    exported,
    inClass: true,
    defaultVisibility: decl.type === 'class_specifier' ? 'private' : 'public',
  });
}

function extractEnum(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
  wrap: TemplateWrap | null,
): void {
  const name = recordName(decl);
  if (!name) return; // anonymous enum — enumerators leak to the enclosing scope (v1 gap)
  ctx.symbols.push(
    makeCppSymbol(
      ctx,
      wrap?.docNode ?? decl,
      cppSignature(ctx, decl, wrap?.prefix),
      'enum',
      name,
      topFqn(ctx, name),
      memberExported(enclosing, visibility),
      cppDoc(wrap?.docNode ?? decl),
      enclosing.qualifier,
    ),
  );
  // Enumerators are NOT extracted (the universal enum rule).
}

// When a `declaration`/`field_declaration`/`typedef`'s `type:` slot is an inline
// record/enum definition (`struct Named {…} g;`, `typedef struct Pt {…} Point;`, a
// nested type), that type is ALSO defined here — extract it alongside the declarators.
function extractInlineTypeInSlot(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
): void {
  const typeNode = decl.childForFieldName('type');
  if (!typeNode) return;
  if (RECORD_SPECIFIERS.has(typeNode.type)) extractRecord(ctx, typeNode, enclosing, visibility, null);
  else if (typeNode.type === 'enum_specifier') extractEnum(ctx, typeNode, enclosing, visibility, null);
}

function extractTypedef(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
  wrap: TemplateWrap | null,
): void {
  // A `typedef <type> Name;` whose <type> is a named record also defines that record.
  extractInlineTypeInSlot(ctx, decl, enclosing, visibility);
  const sig = cppSignature(ctx, decl, wrap?.prefix);
  const doc = cppDoc(wrap?.docNode ?? decl);
  const anchor = wrap?.docNode ?? decl;
  for (const d of decl.childrenForFieldName('declarator')) {
    const info = analyze(d);
    if (!info || info.qualified) continue;
    ctx.symbols.push(
      makeCppSymbol(ctx, anchor, sig, 'type', info.name, topFqn(ctx, info.name), memberExported(enclosing, visibility), doc, enclosing.qualifier),
    );
  }
}

function extractAlias(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
  wrap: TemplateWrap | null,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  ctx.symbols.push(
    makeCppSymbol(
      ctx,
      wrap?.docNode ?? decl,
      cppSignature(ctx, decl, wrap?.prefix),
      'type',
      name,
      topFqn(ctx, name),
      memberExported(enclosing, visibility),
      cppDoc(wrap?.docNode ?? decl),
      enclosing.qualifier,
    ),
  );
}

// A `function_definition` (has a body, or is `= default`/`= delete`).
function extractFunctionDef(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
  wrap: TemplateWrap | null,
): void {
  const declarator = decl.childForFieldName('declarator');
  if (!declarator) return;
  const info = analyze(declarator);
  if (!info || !info.isFunction) return;
  const tgt = resolveFunctionTarget(ctx, info, enclosing);
  const exported = info.qualified || !enclosing.inClass ? true : memberExported(enclosing, visibility);
  const sym = makeCppSymbol(
    ctx,
    wrap?.docNode ?? decl,
    cppSignature(ctx, decl, wrap?.prefix),
    tgt.kind,
    info.name,
    tgt.fqn,
    exported,
    cppDoc(wrap?.docNode ?? decl),
    tgt.qualifier,
  );
  ctx.symbols.push(sym);
  // The whole function_definition is the PendingBody so calls in parameter
  // defaults AND the ctor member-init list (`: v_(compute(x))`) attribute here
  // alongside the body. Only defined functions (a compound_statement body) get a
  // body; `= default`/`= delete` get the symbol but no body.
  if (decl.childForFieldName('body')) {
    ctx.bodies.push({ symbolId: sym.id, body: decl, className: tgt.className ?? undefined });
  }
}

// A `declaration` / `field_declaration`: function declaration(s), variable/field
// declaration(s), and/or an inline record/enum definition in the `type:` slot.
function extractDeclaration(
  ctx: CppCtx,
  decl: Node,
  enclosing: Enclosing,
  visibility: Visibility,
  wrap: TemplateWrap | null,
): void {
  extractInlineTypeInSlot(ctx, decl, enclosing, visibility); // `struct Named {…} g;` / nested type

  const declarators = decl.childrenForFieldName('declarator');
  // sig + doc are declaration-level (the function branch + each variable share
  // them) — compute once, not per declarator.
  const sig = cppSignature(ctx, decl, wrap?.prefix);
  const doc = cppDoc(wrap?.docNode ?? decl);
  const anchor = wrap?.docNode ?? decl;
  for (const d of declarators) {
    const info = analyze(d);
    if (!info) continue;
    if (info.isFunction) {
      const tgt = resolveFunctionTarget(ctx, info, enclosing);
      const exported = info.qualified || !enclosing.inClass ? true : memberExported(enclosing, visibility);
      ctx.symbols.push(
        makeCppSymbol(ctx, anchor, sig, tgt.kind, info.name, tgt.fqn, exported, doc, tgt.qualifier),
      );
      // Bodiless declaration → no PendingBody.
    } else {
      extractVariable(ctx, decl, d, info, enclosing, visibility, declarators.length === 1, doc);
    }
  }
}

function extractVariable(
  ctx: CppCtx,
  decl: Node,
  declarator: Node,
  info: DeclInfo,
  enclosing: Enclosing,
  visibility: Visibility,
  soleDeclarator: boolean,
  doc: string | null,
): void {
  if (info.qualified) return; // out-of-line static-member definition `int C::n = …;` — skip (the in-class decl already exists)
  const className = enclosing.inClass ? enclosing.className : null;
  const fqn = className ? memberFqn(ctx, className, info.name) : topFqn(ctx, info.name);
  const sym = makeCppSymbol(
    ctx,
    decl,
    variableSig(decl, declarator),
    'variable',
    info.name,
    fqn,
    memberExported(enclosing, visibility),
    doc,
    enclosing.qualifier,
  );
  ctx.symbols.push(sym);
  // Attribute initializer calls (`Logger log = makeLogger();`) to the variable —
  // only for a sole declarator, where the initializer pairs unambiguously.
  if (soleDeclarator) {
    const init = initializerNode(declarator) ?? decl.childForFieldName('default_value');
    if (init) ctx.bodies.push({ symbolId: sym.id, body: init, className: className ?? undefined });
  }
}

// ── declarator analysis ───────────────────────────────────────────────────────

interface DeclInfo {
  name: string;
  isFunction: boolean;
  qualified: boolean; // out-of-line `Class::name` (or `ns::name`)
  classScope: string | null; // for qualified: the immediate scope segment (the "class")
  nsScopes: string[]; // for qualified: outer namespace scope segments
}

const WRAPPER_DECLARATORS: ReadonlySet<string> = new Set([
  'pointer_declarator',
  'reference_declarator',
  'parenthesized_declarator',
  'array_declarator',
  'init_declarator',
]);

// Innermost name-bearing nodes (everything in DECL_OR_NAME that is NOT a
// wrapper/function declarator). Used to tell a REAL function (its name sits
// DIRECTLY under the function_declarator) from a function POINTER (a
// parenthesized_declarator is interposed — `int (*fp)(int)` → a variable).
const NAME_NODES: ReadonlySet<string> = new Set([
  'identifier',
  'field_identifier',
  'qualified_identifier',
  'operator_name',
  'destructor_name',
  'operator_cast',
  'type_identifier',
  'template_function',
  'template_method',
]);

const DECL_OR_NAME: ReadonlySet<string> = new Set([
  ...WRAPPER_DECLARATORS,
  'function_declarator',
  'abstract_function_declarator',
  ...NAME_NODES,
]);

// Descends pointer/reference/parenthesized/array/init wrappers and the
// function_declarator to the innermost name node, recording whether a
// function_declarator was crossed (→ it's a function/method).
function analyze(declarator: Node): DeclInfo | null {
  let node: Node | null = declarator;
  let sawFunc = false;
  for (let i = 0; node && i < 24; i++) {
    const t = node.type;
    if (t === 'function_declarator' || t === 'abstract_function_declarator') {
      const inner = innerDeclaratorChild(node);
      // A REAL function/method has its name DIRECTLY under the function_declarator
      // (`int foo()`, `int* C::bar()`). A function POINTER interposes a
      // parenthesized_declarator (`int (*cb)(int)`) → it is a VARIABLE/field, not a
      // function: descend WITHOUT marking it a function so it routes to a variable.
      if (inner && NAME_NODES.has(inner.type)) sawFunc = true;
      node = inner;
      continue;
    }
    if (WRAPPER_DECLARATORS.has(t)) {
      node = innerDeclaratorChild(node);
      continue;
    }
    break;
  }
  if (!node) return null;
  if (node.type === 'qualified_identifier') {
    const q = qualifiedName(node);
    if (!q || !q.name) return null;
    return { name: q.name, isFunction: sawFunc || q.isConversion, qualified: true, classScope: q.classScope, nsScopes: q.nsScopes };
  }
  const s = simpleName(node);
  // Empty name = a synthetic/degenerate declarator (e.g. the empty `identifier`
  // tree-sitter inserts for an unbraced `extern "C" struct S {…};` record) — no
  // symbol; the record + fields are emitted separately by extractInlineTypeInSlot.
  if (!s || !s.name) return null;
  return { name: s.name, isFunction: sawFunc || s.isConversion, qualified: false, classScope: null, nsScopes: [] };
}

function innerDeclaratorChild(node: Node): Node | null {
  const field = node.childForFieldName('declarator');
  if (field) return field;
  for (const c of node.namedChildren) {
    if (DECL_OR_NAME.has(c.type)) return c; // positional (reference_declarator holds it un-fielded)
  }
  return null;
}

function simpleName(node: Node): { name: string; isConversion: boolean } | null {
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
    case 'operator_name':
    case 'destructor_name':
      return { name: node.text.trim(), isConversion: false };
    case 'operator_cast': {
      // `operator bool() const` — name it `operator <type>` (drop the params/quals).
      const ty = node.childForFieldName('type');
      return { name: normalizeSignature(`operator ${ty?.text ?? ''}`), isConversion: true };
    }
    case 'template_function':
    case 'template_method': {
      const n = node.childForFieldName('name');
      return n ? simpleName(n) : null;
    }
    default:
      return null;
  }
}

// Walks the right-nested `qualified_identifier` scope chain. The final `name`
// segment is the symbol; the immediately-enclosing scope is the "class"; earlier
// scopes are namespaces. Scope segments may be namespace_identifier,
// type_identifier, or template_type (`Box<T>::get`).
function qualifiedName(
  qi: Node,
): { name: string; classScope: string | null; nsScopes: string[]; isConversion: boolean } | null {
  const scopes: string[] = [];
  let cur: Node | null = qi;
  let finalName: Node | null = null;
  for (let i = 0; cur && i < 24; i++) {
    if (cur.type !== 'qualified_identifier') {
      finalName = cur;
      break;
    }
    const scope = cur.childForFieldName('scope');
    if (scope) {
      const s = scopeSimpleName(scope);
      if (s) scopes.push(s);
    }
    const nm = cur.childForFieldName('name');
    if (!nm) break;
    if (nm.type === 'qualified_identifier') {
      cur = nm;
      continue;
    }
    finalName = nm;
    break;
  }
  if (!finalName) return null;
  const base = simpleName(finalName);
  if (!base) return null;
  const classScope = scopes.length ? scopes[scopes.length - 1]! : null;
  return { name: base.name, classScope, nsScopes: scopes.slice(0, -1), isConversion: base.isConversion };
}

function scopeSimpleName(node: Node): string | null {
  switch (node.type) {
    case 'namespace_identifier':
    case 'type_identifier':
    case 'identifier':
      return node.text;
    case 'template_type':
      return node.childForFieldName('name')?.text ?? null;
    default:
      return null;
  }
}

// Kind / FQN / qualifier for a function-shaped declarator. A qualified
// `Class::name` is an out-of-line method keyed on the class scope (the
// Go-receiver pattern, but cross-file); a `ns::freeFn` (namespace-qualified free
// function) is also keyed as a method on its last scope segment — a known,
// wrong-edge-free imperfection (the qualified-call `ns::freeFn()` still resolves
// correctly). In-class declarators are methods; everything else is a free
// function. Out-of-line defs/decls are exported=true (the in-class declaration in
// the header carries the real access; marking the def exported only widens
// cross-file recall, never adds a wrong edge).
function resolveFunctionTarget(
  ctx: CppCtx,
  info: DeclInfo,
  enclosing: Enclosing,
): { kind: SymbolKind; className: string | null; fqn: string; qualifier: string } {
  if (info.qualified) {
    const scopeQual = [...info.nsScopes, info.classScope].filter((x): x is string => !!x).join('::');
    const qualifier = joinQualifier(enclosing.qualifier, scopeQual);
    if (!info.classScope) return { kind: 'function', className: null, fqn: topFqn(ctx, info.name), qualifier };
    return { kind: 'method', className: info.classScope, fqn: memberFqn(ctx, info.classScope, info.name), qualifier };
  }
  if (enclosing.inClass) {
    return {
      kind: 'method',
      className: enclosing.className,
      fqn: memberFqn(ctx, enclosing.className!, info.name),
      qualifier: enclosing.qualifier,
    };
  }
  return { kind: 'function', className: null, fqn: topFqn(ctx, info.name), qualifier: enclosing.qualifier };
}

// ── helpers ────────────────────────────────────────────────────────────────

function accessText(node: Node): Visibility | null {
  // `access_specifier` text is `public` / `private` / `protected` (the trailing
  // `:` is a separate token).
  const t = node.text.replace(':', '').trim();
  return t === 'public' || t === 'private' || t === 'protected' ? t : null;
}

// Exported = public access. Free functions / top-level / namespace decls are
// always exported; class members need public visibility AND an exported container.
// (Private/protected members are NOT exported — the handoff rule; class default is
// private, struct/union default public.)
function memberExported(enclosing: Enclosing, visibility: Visibility): boolean {
  if (!enclosing.inClass) return true;
  return enclosing.exported && visibility === 'public';
}

function recordName(decl: Node): string | null {
  const n = decl.childForFieldName('name');
  if (!n) return null;
  if (n.type === 'template_type') return n.childForFieldName('name')?.text ?? null; // `Box<int>` specialization → Box
  return n.text; // type_identifier (covers scoped/unscoped enums and records)
}

// `#include <foo>` / `#include "foo.h"` → import (sourceModule = the header path).
function extractInclude(ctx: CppCtx, node: Node): void {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return;
  let header: string | null = null;
  if (pathNode.type === 'system_lib_string') {
    header = pathNode.text.replace(/^<|>$/g, ''); // strip the angle brackets
  } else if (pathNode.type === 'string_literal') {
    header = pathNode.namedChildren.find((c) => c.type === 'string_content')?.text ?? null;
  }
  if (!header) return;
  ctx.imports.push({
    file: ctx.fileInfo.path,
    sourceModule: header,
    importedNames: [{ name: '*' }], // a header has no named binding — namespace-style
    line: node.startPosition.row + 1,
  });
}

// Doc = a `//` or `/** */`/`/* */` comment block immediately above the decl (the
// Go/Dart `commentDocLine` + `isTrailingComment` pattern). For a templated decl
// the anchor is the template_declaration (the comment is its sibling).
function cppDoc(anchor: Node): string | null {
  const prev = anchor.previousNamedSibling;
  if (
    prev &&
    prev.type === 'comment' &&
    prev.endPosition.row === anchor.startPosition.row - 1 &&
    !isTrailingComment(prev)
  ) {
    return commentDocLine(prev.text);
  }
  return null;
}

// Signature = source from the decl start (after an optional `template<…>` prefix)
// to the body / member-init list, with a trailing `;`/`{` stripped. Keeps the
// `template<…>` preamble and trailing `const`/`noexcept`/`override`/`= default`/
// `= 0` qualifiers for display.
function cppSignature(ctx: CppCtx, decl: Node, prefix = ''): string {
  let cut = decl.endIndex;
  const body = decl.childForFieldName('body');
  if (body) cut = Math.min(cut, body.startIndex);
  for (const c of decl.namedChildren) {
    if (c.type === 'field_initializer_list') cut = Math.min(cut, c.startIndex);
  }
  let sig = normalizeSignature(prefix + ctx.content.slice(decl.startIndex, cut));
  sig = sig.replace(/[;{]\s*$/, '').trimEnd();
  return sig;
}

// Variable signature = `<storage/quals> <type> <declarator-core>`, dropping the
// `= initializer`. Built from the type + declarator so a multi-declarator
// `int a = 1, b` yields a clean "int a" / "int b" per symbol. When the type slot
// is an inline record/enum (`struct Named {…} g;`), use the type's NAME, not its
// whole `{…}` body (which would bloat the signature + the hashed id).
function variableSig(decl: Node, declarator: Node): string {
  const parts: string[] = [];
  for (const c of decl.namedChildren) {
    if (c.type === 'storage_class_specifier' || c.type === 'type_qualifier') parts.push(c.text);
  }
  const typeNode = decl.childForFieldName('type');
  if (typeNode) {
    const isRecordOrEnum = RECORD_SPECIFIERS.has(typeNode.type) || typeNode.type === 'enum_specifier';
    const nameNode = isRecordOrEnum ? typeNode.childForFieldName('name') : null;
    parts.push(isRecordOrEnum ? (nameNode ? nameNode.text : '(anonymous)') : typeNode.text);
  }
  parts.push(declaratorCore(declarator));
  return normalizeSignature(parts.join(' '));
}

// The declarator text without a trailing `= initializer` (so the signature/hash
// stay stable across initializer edits).
function declaratorCore(d: Node): string {
  if (d.type === 'init_declarator') {
    const inner = d.childForFieldName('declarator');
    return inner ? inner.text : d.text;
  }
  return d.text;
}

// The initializer expression of a variable declarator, if any (for call
// attribution). `init_declarator` carries it in `value:`; an in-class field
// carries it as the declaration's `default_value:` (handled by the caller).
function initializerNode(d: Node): Node | null {
  if (d.type === 'init_declarator') return d.childForFieldName('value');
  return null;
}

function topFqn(ctx: CppCtx, name: string): string {
  return `${ctx.fileInfo.path}:${name}`;
}

function memberFqn(ctx: CppCtx, className: string, name: string): string {
  return `${ctx.fileInfo.path}:${className}.${name}`;
}

// The qualifier only disambiguates hashed ids — any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}::${b}`;
}

function makeCppSymbol(
  ctx: CppCtx,
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
