import type { Node, Tree } from 'web-tree-sitter';

import {
  collectAmbiguousTypeNames,
  normalizeSignature,
  resolveCalls,
} from '../extractor.js';
import type { CallSelector, ExtractResult, MemberCallInfo } from '../extractor.js';
import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo } from '../../types.js';
import {
  analyze,
  cppDoc,
  cppMemberCallInfo,
  handleMember,
  makeCppSymbol,
  memberFqn,
  topFqn,
  CFAMILY_COMPLEXITY_OPTS,
  CPP_FUNCTION_BODY_SKIP_TYPES,
  CPP_SKIP_TYPES,
  PREPROC_GROUPS,
} from './cpp.js';
import { computeComplexity } from '../complexity.js';
// `#import`/`#include` (preproc_include) is handled INTERNALLY by handleMember's own
// dispatch — objc.ts never calls extractInclude directly, so it isn't imported here.
import type { CppCtx, Enclosing, Visibility } from './cpp.js';

// ── skip sets / call-resolution knobs ───────────────────────────────────────

// resolveCalls walk skip set: the C-subset bodies/conditionals (CPP_SKIP_TYPES,
// incl. the `preproc_*` spurious-`#if FOO(3)`-edge guard) PLUS the Objective-C OO
// container bodies — each method owns its own PendingBody, so the moduleRoot walk
// must not re-descend into them. `block_literal` is deliberately ABSENT → DESCENDED
// (a `^{ … }` closure's calls roll into the enclosing method, the Go func_literal rule).
const OBJC_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...CPP_SKIP_TYPES,
  'class_interface',
  'class_implementation',
  'protocol_declaration',
  'method_definition',
]);

// A bare `foo()` in Objective-C is ALWAYS a C free function — ObjC has NO
// implicit-this (a sibling method is called via `[self foo]`, a message_expression).
// So the callee stays the engine-default `identifier` and binds over {function} only,
// with `bareCallsBindToEnclosingClass:false` (THE divergence from cpp).
const OBJC_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier']);
const OBJC_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function']);

// libc free functions + the Foundation logging/assert macros that parse as bare
// `identifier` calls and never resolve to a local symbol. Suppressed ONLY when
// unresolved (a file-local shadow keeps its refs). START small + tune by dogfood.
const OBJC_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  'printf', 'fprintf', 'sprintf', 'snprintf', 'scanf', 'sscanf', 'puts', 'fputs',
  'malloc', 'calloc', 'realloc', 'free', 'memcpy', 'memset', 'memmove', 'memcmp',
  'strlen', 'strcmp', 'strncmp', 'strcpy', 'strncpy', 'strcat', 'abort', 'exit',
  'NSLog', 'NSLogv', 'NSAssert', 'NSCAssert', 'NSParameterAssert', 'NSCParameterAssert',
  'NSStringFromClass', 'NSStringFromSelector', 'NSStringFromProtocol', 'NSClassFromString',
]);

// Construction + memory-management + NSObject-protocol selectors that flood the
// member-ref store when unresolved (`[[Foo alloc] init]`, retain/release in MRC code,
// reflection). Suppressed ONLY when UNRESOLVED — a same-file `[self copy]` that bound
// to a real sibling keeps its ref. Note the FULL keyword selector `initWithName:age:`
// is NOT in this set, so designated initializers still resolve. START small.
const OBJC_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'alloc', 'init', 'new', 'retain', 'release', 'autorelease', 'dealloc', 'copy',
  'mutableCopy', 'class', 'superclass', 'description', 'debugDescription', 'hash',
  'isEqual', 'respondsToSelector', 'conformsToProtocol', 'isKindOfClass',
  'isMemberOfClass', 'performSelector',
]);

const OBJC_SELECTORS: ReadonlyArray<CallSelector> = [
  // C calls (bare `foo()`) and C-subset member calls (`p->fn()` — discriminated by
  // the callee node, delegated to cppMemberCallInfo).
  { nodeType: 'call_expression', getCallee: (n) => n.childForFieldName('function') },
  // Objective-C message sends `[recv sel:arg]`. The selector is spread across the
  // node, so the callee IS the node (objcMemberCallInfo reads it).
  { nodeType: 'message_expression', getCallee: (n) => n },
];

// File scope: a C function/struct/global in a `.m`/`.h` is never inside an ObjC
// `@interface` body, so there is no positional access state — `inClass:false` routes
// `declExported` to `!hasStaticStorage` (C internal linkage). Shared, never mutated.
const FILE_SCOPE: Enclosing = {
  className: null,
  qualifier: '',
  exported: true,
  inClass: false,
  defaultVisibility: 'public',
};

// ── selector reconstruction (THE byte-identity invariant) ────────────────────

// The selector concat rule MUST be byte-identical on the declaration side
// (method_declaration / method_definition) and the call side (message_expression),
// or `[self initWithName:age:]` would never resolve to the `initWithName:age:`
// method. `joinSelector` is the SOLE place a `:` is appended.
function joinSelector(labels: readonly string[], hasArgs: boolean): string {
  return hasArgs ? labels.map((l) => `${l}:`).join('') : labels.join('');
}

// Declaration side: the labels are the method node's DIRECT `identifier` children
// (the leading selector segment + one bare identifier before each keyword
// `method_parameter`); the parameter NAMES live INSIDE each `method_parameter`, not
// as direct children. `hasArgs` ⟺ the method takes ≥1 `method_parameter`.
function selectorFromMethodDecl(node: Node): string {
  const labels: string[] = [];
  let hasArgs = false;
  for (const c of node.namedChildren) {
    if (c.type === 'identifier') labels.push(c.text);
    else if (c.type === 'method_parameter') hasArgs = true;
  }
  return joinSelector(labels, hasArgs);
}

// Call side: the labels are the `method:` fields; `hasArgs` ⟺ the message carries a
// `:` token (a keyword message has one per labelled argument; a unary message — `[x
// draw]` — has none, so its single `method` field stays colon-free).
function selectorFromMessage(node: Node): string {
  const labels = node.childrenForFieldName('method').map((m) => m.text);
  const hasArgs = node.children.some((c) => c.type === ':');
  return joinSelector(labels, hasArgs);
}

// ── call resolution ──────────────────────────────────────────────────────────

// Reduces an Objective-C message send OR a C-subset member callee to {receiver,
// property, isSelf}. Message sends:
//   `[self sel]`            → self-call (resolve against the enclosing @implementation)
//   `[super sel]`           → null (parent dispatch — the cpp super:: drop rule)
//   `[Greeter make]`        → receiver = `Greeter` (a class send RESOLVES via
//                             methodsByClass['Greeter'])
//   `[obj greet]`           → receiver = `obj` (an instance send — stays
//                             unresolved-but-findable: dynamic typing, no receiver type)
//   `[[Foo alloc] init]`    → RECEIVER_OPAQUE (nested-message receiver — findable, never
//                             resolved; the construction recall gap)
// C-subset member callees (`p->fn()`, `Foo::bar()`) → the shared cppMemberCallInfo.
function objcMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'message_expression') {
    const property = selectorFromMessage(callee);
    if (!property) return null;
    const receiver = callee.childForFieldName('receiver');
    if (!receiver) return null;
    if (receiver.type === 'identifier') {
      const text = receiver.text;
      if (text === 'self') return { receiver: 'self', property, isSelf: true };
      if (text === 'super') return null;
      return { receiver: text, property, isSelf: false };
    }
    // nested message / field / computed receiver → opaque (findable, never resolved)
    return { receiver: RECEIVER_OPAQUE, property, isSelf: false };
  }
  return cppMemberCallInfo(callee);
}

// ── entry point ────────────────────────────────────────────────────────────

export function extractObjc(tree: Tree, content: string, fileInfo: FileInfo): ExtractResult {
  const ctx: CppCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  // C-subset nodes route through cpp's handleMember, which mutates a visibility state
  // for in-class access labels — irrelevant at ObjC file scope, but the signature
  // needs it. One shared object suffices (never flipped at top level).
  const state: { visibility: Visibility } = { visibility: 'public' };
  // A class is declared by an `@interface` AND defined by an `@implementation`; in ONE
  // file (a private helper class, a single-file program, an umbrella header) BOTH would
  // emit a `class` symbol named C, making C ambiguous → excluded from methodsByClass →
  // every `[self …]`/`[C …]` send fails to resolve. Emit the class symbol only ONCE per
  // name per file (first-wins); both blocks still contribute members. Cross-file
  // interface/impl stay separate symbols (separate extractions) — the decl/def split.
  const emittedClasses = new Set<string>();
  for (const child of tree.rootNode.namedChildren) handleTopLevel(ctx, child, state, emittedClasses);

  // Same-name classes share the simple-name FQN; resolving through them first-wins
  // would bind to the WRONG class (the cpp/Go/C# pattern). Categories/class-extensions
  // do NOT emit a duplicate class symbol — they merge into the existing class — so the
  // only genuine duplicates are distinct same-name @interface/@implementation blocks.
  const ambiguousClassNames = collectAmbiguousTypeNames(ctx.symbols, new Set(['class']));

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    OBJC_SELECTORS,
    OBJC_SKIP_TYPES,
    CPP_FUNCTION_BODY_SKIP_TYPES,
    objcMemberCallInfo,
    {
      bareCalleeTypes: OBJC_BARE_CALLEE_TYPES,
      plainCalleeType: 'identifier',
      bareCallableKinds: OBJC_BARE_CALLABLE_KINDS,
      bareCallsBindToEnclosingClass: false, // ObjC has NO implicit-this
      ambiguousClassNames,
      ignoredBareCallees: OBJC_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: OBJC_IGNORED_MEMBER_CALLEES,
      // NO constructorKinds/constructorSelectorTypes — `[[Foo alloc] init]` is a nested
      // message send (opaque), not a distinct construction node.
    },
  );

  // Cyclomatic + cognitive complexity — the SAME shared `CFAMILY_COMPLEXITY_OPTS` as cpp/c
  // (one source of truth in cpp.ts). The AST dump confirmed tree-sitter-objc reuses the C
  // control-flow node names (incl. `catch_clause` for `@catch`), so the shared options apply
  // unchanged; objc method bodies are `method_definition` PendingBodies (NOT in the skip set,
  // so they're descended) and `block_literal` (`^{}`) nests +0 like a C++ lambda.
  computeComplexity(ctx.bodies, ctx.symbols, CFAMILY_COMPLEXITY_OPTS);

  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

function handleTopLevel(
  ctx: CppCtx,
  node: Node,
  state: { visibility: Visibility },
  emittedClasses: Set<string>,
): void {
  const t = node.type;
  // `#ifndef GUARD … #endif` include guards / `#if` blocks wrap the real declarations
  // (the dominant ObjC header shape). Recurse transparently so an @interface inside a
  // guard is still reached — handleMember can't (it has no OO cases). Both branches are
  // extracted (over-extraction; the OccurrenceCounter keeps ids unique).
  if (PREPROC_GROUPS.has(t)) {
    for (const c of node.namedChildren) handleTopLevel(ctx, c, state, emittedClasses);
    return;
  }
  switch (t) {
    case 'class_interface':
      extractInterface(ctx, node, emittedClasses);
      return;
    case 'class_implementation':
      extractImplementation(ctx, node, emittedClasses);
      return;
    case 'protocol_declaration':
      extractProtocol(ctx, node);
      return;
    case 'module_import':
      extractModuleImport(ctx, node);
      return;
    case 'class_declaration': // `@class A, B;` forward declaration
    case 'protocol_forward_declaration': // `@protocol P;` forward declaration
      return;
    case 'type_definition': {
      // `typedef NS_ENUM(NSInteger, Color) { … }` — the macro is opaque to the grammar
      // (mis-parses; the enum NAME + members are buried in an ERROR). Skip the whole
      // typedef rather than emit its mis-parsed enumerators as spurious `type` symbols
      // (a documented macro-opacity recall gap, never a wrong edge).
      if (node.childForFieldName('type')?.type === 'macro_type_specifier') return;
      handleMember(ctx, node, FILE_SCOPE, state, null);
      return;
    }
    default:
      // C subset (function_definition / declaration / struct / union / enum / typedef)
      // + `#import` → the shared cpp dispatcher at file scope. Inert on the OO /
      // namespace / template nodes it doesn't recognize.
      handleMember(ctx, node, FILE_SCOPE, state, null);
      return;
  }
}

// ── Objective-C OO surface ───────────────────────────────────────────────────

// `@interface C : Super <P…> {ivars} … @end`, a category `@interface C (Cat)`, OR a
// class-extension `@interface C ()` — all are `class_interface`. The class NAME is the
// first `identifier` child (no `name:` field); `superclass:`/`category:`/protocol
// arguments are display-only. A category/extension (it carries `(`/`)` tokens) emits
// NO class symbol — it only merges members into the existing class via the shared
// simple-name FQN `file:C.<member>` (the Go/Swift extension-apart pattern).
function extractInterface(ctx: CppCtx, node: Node, emittedClasses: Set<string>): void {
  const className = firstIdentifier(node);
  if (!className) return;
  const isCategoryOrExtension = node.children.some((c) => c.type === '(');
  if (!isCategoryOrExtension && !emittedClasses.has(className)) {
    emittedClasses.add(className);
    ctx.symbols.push(
      makeCppSymbol(ctx, node, headSignature(ctx, node), 'class', className, topFqn(ctx, className), true, cppDoc(node), className),
    );
  }
  extractMembers(ctx, node, className);
}

// `@implementation C … @end` (or a category implementation `@implementation C (Cat)`).
// A NON-category impl emits the class symbol (a `.m`-only private class has no
// `@interface`; a header decl is in a DIFFERENT file so its id differs by path; a
// same-file @interface/@implementation pair emits the class symbol only ONCE via the
// shared `emittedClasses` set, first-wins). A CATEGORY impl (it carries `(`/`)` tokens)
// emits NO class symbol either — the class is defined elsewhere; a second same-name
// `class` symbol in one file would make `C` ambiguous and EXCLUDE its methods from
// methodsByClass, breaking every `[self …]`/`[C …]` resolution. Methods are wrapped one
// level deep in `implementation_definition` (handled by extractMembers).
function extractImplementation(ctx: CppCtx, node: Node, emittedClasses: Set<string>): void {
  const className = firstIdentifier(node);
  if (!className) return;
  const isCategory = node.children.some((c) => c.type === '(');
  if (!isCategory && !emittedClasses.has(className)) {
    emittedClasses.add(className);
    ctx.symbols.push(
      makeCppSymbol(ctx, node, headSignature(ctx, node), 'class', className, topFqn(ctx, className), true, cppDoc(node), className),
    );
  }
  extractMembers(ctx, node, className);
}

// `@protocol P <Base> … @end` → an `interface` symbol with declaration-only members.
// Members sit under `qualified_protocol_interface_declaration` wrappers (one per
// `@required`/`@optional`), recursed transparently by extractMembers.
function extractProtocol(ctx: CppCtx, node: Node): void {
  const name = firstIdentifier(node);
  if (!name) return;
  ctx.symbols.push(
    makeCppSymbol(ctx, node, headSignature(ctx, node), 'interface', name, topFqn(ctx, name), true, cppDoc(node), name),
  );
  extractMembers(ctx, node, name);
}

// Walks an @interface / @implementation / @protocol body for method + property
// members. Methods are DIRECT children (interfaces, categories) or wrapped one level
// deep in `implementation_definition` (impl) / `qualified_protocol_interface_declaration`
// (a protocol's @required/@optional block) — descend those transparently. ivars
// (`instance_variables`) are NOT extracted in v1 (private implementation detail; the
// public API surface is `@property`).
function extractMembers(ctx: CppCtx, container: Node, className: string): void {
  for (const child of container.namedChildren) {
    switch (child.type) {
      case 'implementation_definition':
      case 'qualified_protocol_interface_declaration':
        extractMembers(ctx, child, className);
        break;
      case 'method_declaration':
      case 'method_definition':
        extractMethod(ctx, child, className);
        break;
      case 'property_declaration':
        extractProperty(ctx, child, className);
        break;
      default:
        break;
    }
  }
}

// A `method_declaration` (header, bodiless) or `method_definition` (impl, with a
// `compound_statement` body). BOTH `+` (class) and `-` (instance) → **method** kind
// keyed on the class (the Ruby `def self.x` precedent — a class send `[C sel]` resolves
// via methodsByClass['C']). Name = the full selector. The decl→def cross-file pairing
// produces two symbols for one method (the documented C++ decl/def split); same-file
// duplicates dedup via the OccurrenceCounter.
function extractMethod(ctx: CppCtx, node: Node, className: string): void {
  const selector = selectorFromMethodDecl(node);
  if (!selector) return;
  const sym = makeCppSymbol(
    ctx, node, methodSignature(ctx, node), 'method', selector,
    memberFqn(ctx, className, selector), true, cppDoc(node), className,
  );
  ctx.symbols.push(sym);
  // The impl `method_definition` owns a PendingBody (className set so `[self sel]`
  // resolves same-file); the header `method_declaration` is bodiless (the cross-file
  // decl→def self-call gap, the C++ precedent).
  if (node.type === 'method_definition' && node.namedChildren.some((c) => c.type === 'compound_statement')) {
    ctx.bodies.push({ symbolId: sym.id, body: node, className });
  }
}

// `@property (attrs) Type *name;` → a **variable** member `file:C.name`. The name lives
// in a C-style `struct_declaration > struct_declarator > (identifier | pointer/…
// declarator)` — `analyze` resolves it through any pointer/function-pointer wrapper.
// v1 emits the variable only; synthesizing getter/setter `method` symbols (`name`/
// `setName:`) so a dotted/message access resolves is a noted v2.
function extractProperty(ctx: CppCtx, node: Node, className: string): void {
  const sd = node.namedChildren.find((c) => c.type === 'struct_declaration');
  if (!sd) return;
  const sig = propertySignature(ctx, node);
  const doc = cppDoc(node);
  // One variable per declarator: `@property (assign) int a, b;` declares both a and b.
  // `analyze` resolves the name through any pointer / block-pointer / function-pointer
  // wrapper (`void (^handler)(int)` → `handler`).
  for (const declarator of sd.namedChildren) {
    if (declarator.type !== 'struct_declarator') continue;
    const inner = declarator.namedChildren[0];
    if (!inner) continue;
    const info = analyze(inner);
    if (!info || !info.name) continue;
    ctx.symbols.push(
      makeCppSymbol(
        ctx, node, sig, 'variable', info.name,
        memberFqn(ctx, className, info.name), true, doc, className,
      ),
    );
  }
}

// `@import Module;` → a namespace-style import (a module has no named binding). The
// `path:` field is the module name (`UIKit`, `Foo.Bar`). `#import`/`#include` are
// handled by the shared extractInclude via handleMember.
function extractModuleImport(ctx: CppCtx, node: Node): void {
  // The `path:` field has MULTIPLE children for a dotted submodule import
  // (`@import Foo.Bar;` → identifier `Foo`, `.`, identifier `Bar`); the `.` tokens are
  // themselves path children, so a plain join reproduces the full `Foo.Bar`.
  const segments = node.childrenForFieldName('path');
  if (segments.length === 0) return;
  const sourceModule = segments.map((c) => c.text).join('');
  if (!sourceModule) return;
  ctx.imports.push({
    file: ctx.fileInfo.path,
    sourceModule,
    importedNames: [{ name: IMPORT_NAMESPACE }],
    line: node.startPosition.row + 1,
  });
}

// ── helpers ───────────────────────────────────────────────────────────────

function firstIdentifier(node: Node): string | null {
  for (const c of node.namedChildren) {
    if (c.type === 'identifier') return c.text;
  }
  return null;
}

// Member nodes / `@end` / the ivar block that mark the END of an @interface /
// @protocol / @implementation HEAD line. cppSignature is unusable on these OO nodes
// (no `body:` field — it would slurp the whole interface), so cut at the first such.
const HEAD_STOP: ReadonlySet<string> = new Set([
  'instance_variables',
  'property_declaration',
  'method_declaration',
  'method_definition',
  'implementation_definition',
  'qualified_protocol_interface_declaration',
  '@end',
]);

// Signature for an @interface/@protocol/@implementation head: source from the node
// start to the first member / ivar block / `@end`, trimmed of a trailing `{`.
function headSignature(ctx: CppCtx, node: Node): string {
  let cut = node.endIndex;
  for (const c of node.children) {
    if (HEAD_STOP.has(c.type)) cut = Math.min(cut, c.startIndex);
  }
  return normalizeSignature(ctx.content.slice(node.startIndex, cut)).replace(/\{\s*$/, '').trimEnd();
}

// `- (Type)selector …` up to the body (a definition) or end (a declaration), trimmed
// of a trailing `;`.
function methodSignature(ctx: CppCtx, node: Node): string {
  const body = node.namedChildren.find((c) => c.type === 'compound_statement');
  const cut = body ? body.startIndex : node.endIndex;
  return normalizeSignature(ctx.content.slice(node.startIndex, cut)).replace(/;\s*$/, '').trimEnd();
}

// The whole `@property (…) Type *name` line, trimmed of a trailing `;`.
function propertySignature(ctx: CppCtx, node: Node): string {
  return normalizeSignature(ctx.content.slice(node.startIndex, node.endIndex)).replace(/;\s*$/, '').trimEnd();
}
