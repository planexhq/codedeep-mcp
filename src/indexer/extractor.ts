import { createHash } from 'node:crypto';
import type { Node, Tree } from 'web-tree-sitter';

import { log } from '../logger.js';
import { NON_CALLABLE_KINDS, classNameFromFqn } from '../types.js';
import type { FileInfo, ImportInfo, Reference, Symbol } from '../types.js';
import { extractCSharp } from './languages/csharp.js';
import { extractDart } from './languages/dart.js';
import { extractGo } from './languages/go.js';
import { extractJava } from './languages/java.js';
import { extractKotlin } from './languages/kotlin.js';
import { extractPHP } from './languages/php.js';
import { extractRust } from './languages/rust.js';
import { extractSwift } from './languages/swift.js';
import { extractPython } from './languages/python.js';
import { extractTypeScript } from './languages/typescript.js';

export interface ExtractResult {
  symbols: Symbol[];
  references: Reference[];
  imports: ImportInfo[];
}

export interface PendingBody {
  symbolId: string;
  body: Node;
  // Set for class-scoped bodies (methods, field initializers, the class
  // body itself) so `this.x()` / `self.x()` calls resolve against the
  // enclosing class's methods.
  className?: string;
  // Go method receiver variable ('s' in `func (s *Server) ...`): the
  // language has no fixed this/self token, so selfness is per-body. When
  // set, a member call whose receiver token equals it resolves against
  // `className` and records selfReceiver — a local variable shadowing the
  // receiver name (`s := other; s.Handle()`) is mis-marked self, the same
  // accepted error class as Python's self-by-convention. Omitted for
  // blank/absent receivers and by TS/Py/Java, where it changes nothing.
  selfReceiverName?: string;
}

// A member-expression call site reduced to its two identifiers. Returned
// by per-language readers for single-level receivers only; chained or
// computed receivers (`a.b.c()`, `foo().bar()`) return null and emit
// nothing — their receiver can't be matched against imports or class
// names, so a ref would be pure name-noise.
export interface MemberCallInfo {
  // Literal receiver token: 'this', 'self', 'cls', 'utils', 'Class', ...
  receiver: string;
  // The called property/attribute name.
  property: string;
  // True for this/self/cls — resolve against the enclosing class.
  isSelf: boolean;
}

// Maps a call-like AST node to the identifier being "called" — function call,
// constructor in `new X()`, JSX component in `<X />`. Returning null skips the
// node (member-expression callees, lowercase JSX HTML tags).
export interface CallSelector {
  nodeType: string;
  getCallee: (node: Node) => Node | null;
}

// Per-language knobs for resolveCalls. TS/Py pass nothing — every default
// reproduces their behavior exactly.
export interface ResolveCallsOptions {
  // Node types accepted as a bare (receiver-less) callee. Java adds
  // 'type_identifier': `object_creation_expression`'s type field is never a
  // plain identifier, so `new Widget()` refs are impossible without it.
  // Non-'identifier' callee types are CONSTRUCTOR-form and resolve via
  // `constructorKinds` only, never via the callable-name map.
  bareCalleeTypes?: ReadonlySet<string>;
  // Java implicit-this: a bare `foo()` inside a class body is a method call
  // on the enclosing class, so it resolves against that class's methods
  // before nameToId. TS/Py leave this off — a bare `save()` there really
  // does call a top-level function, never `C.prototype.save`.
  bareCallsBindToEnclosingClass?: boolean;
  // Symbol kinds an `identifier` callee may bind to via the name map.
  // Default: every kind outside NON_CALLABLE_KINDS (TS/Py semantics, where
  // functions and function-valued variables are bare-callable). Java passes
  // an EMPTY set: a bare `foo()` is always a method call — fields and
  // classes are never bare-callable — so only the enclosing-class fallback
  // may bind it.
  bareCallableKinds?: ReadonlySet<string>;
  // Symbol kinds a constructor-form callee (`new X()`) binds to. Java:
  // class + interface (`new Iface() { ... }` anonymous implementations are
  // real instantiation sites). Unset, constructor-form callees stay
  // unresolved.
  constructorKinds?: ReadonlySet<string>;
  // Class names excluded from extract-time resolution: two same-named
  // nested types in one file share the simple-name FQN, so their method
  // maps would merge first-wins and produce confidently WRONG resolved
  // edges. Calls in (and constructions of) those classes stay unresolved.
  ambiguousClassNames?: ReadonlySet<string>;
  // Bare identifier callees in this set emit NO reference unless they
  // resolved to a local symbol. Go passes its builtins (make/len/append/
  // ...): they are package-less names that would otherwise flood the
  // name-keyed reference store with unresolvable noise. The resolved
  // escape matters — builtins are shadowable, and pre-1.21 Go code
  // routinely defines its own max/min/clear, so a file-local definition
  // still gets its refs.
  ignoredBareCallees?: ReadonlySet<string>;
  // Callee node type treated as a plain bare name — resolved via the
  // enclosing-class fallback then nameToId, and subject to ignoredBareCallees.
  // Every OTHER bareCalleeType is constructor-form (resolves via
  // constructorKinds/typeNameToId only). Defaults to 'identifier'
  // (TS/JS/Py/Java/Go/Rust). Swift passes 'simple_identifier': its bare and
  // constructor callees are both `simple_identifier` nodes (no separate
  // construction node), so without this they'd misroute to the constructor-form
  // branch and never resolve to functions or implicit-self methods.
  plainCalleeType?: string;
  // Call-NODE types (not callee types) that are ALWAYS constructor-form,
  // routed through constructorKinds/typeNameToId regardless of callee node
  // type. C# passes {'object_creation_expression'}: `new Foo()`'s callee is a
  // plain `identifier` (indistinguishable from a bare call by callee type), so
  // without this it would flow through the enclosing-class/nameToId path and a
  // `new Foo()` could mis-bind to an enclosing METHOD named Foo. Languages that
  // leave this unset keep the callee-type heuristic (`callee.type !==
  // plainCalleeType`) unchanged.
  constructorSelectorTypes?: ReadonlySet<string>;
  // Bare-callable names that are AMBIGUOUS — the same simple name appears on more
  // than one bare-callable symbol (e.g. two same-named top-level functions in
  // different namespaces in ONE file, which share the simple-name FQN). Excluded
  // from nameToId so a bare call to that name stays UNRESOLVED rather than
  // first-wins binding to the wrong one — the bare-path analogue of
  // ambiguousClassNames (which only guards the constructor-form and method paths).
  ambiguousBareCallees?: ReadonlySet<string>;
}

const DEFAULT_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier']);

// Selector for bare decorator forms (`@foo`, `@dataclass`). For `@foo()` and
// `@ns.dec()` the child is `call_expression`/`call` and the call selector
// emits the ref via walkCalls (the latter as a member ref); bare `@foo.bar`
// has a `member_expression`/`attribute` child and stays skipped — it is an
// access, not a call. Shared by TS and Python — both use `identifier` as
// the node type for plain names.
export function bareDecoratorIdentifier(node: Node): Node | null {
  const child = node.firstNamedChild;
  return child?.type === 'identifier' ? child : null;
}

export function extractSymbols(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  switch (fileInfo.language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
      return extractTypeScript(tree, content, fileInfo);
    case 'python':
      return extractPython(tree, content, fileInfo);
    case 'java':
      return extractJava(tree, content, fileInfo);
    case 'go':
      return extractGo(tree, content, fileInfo);
    case 'rust':
      return extractRust(tree, content, fileInfo);
    case 'swift':
      return extractSwift(tree, content, fileInfo);
    case 'kotlin':
      return extractKotlin(tree, content, fileInfo);
    case 'dart':
      return extractDart(tree, content, fileInfo);
    case 'csharp':
      return extractCSharp(tree, content, fileInfo);
    case 'php':
      return extractPHP(tree, content, fileInfo);
    default:
      log.warn(`extractSymbols: unsupported language "${fileInfo.language}"`);
      return { symbols: [], references: [], imports: [] };
  }
}

export function symbolId(
  file: string,
  name: string,
  kind: string,
  signature: string,
  qualifier = '',
): string {
  const tail = qualifier ? `\0${qualifier}` : '';
  return createHash('sha1')
    .update(`${file}\0${name}\0${kind}\0${signature}${tail}`)
    .digest('hex')
    .slice(0, 16);
}

const SIGNATURE_WS = /\s+/g;

// Stored/displayed signatures are capped at this length; the symbol id
// hashes the FULL normalized signature. Capping the hash input too would
// collide overloads that differ only past the cap (rxjava's 10 `just`
// overloads produced 5 ids), silently merging their reference graphs.
export const SIGNATURE_DISPLAY_CAP = 120;

// Shared by every language module. The output feeds symbolId hashing, so
// all languages must normalize identically — never fork a local copy.
// Returns the FULL normalized signature; the language symbol constructors
// apply SIGNATURE_DISPLAY_CAP to the stored copy only.
export function normalizeSignature(raw: string): string {
  return raw.trim().replace(SIGNATURE_WS, ' ');
}

// First non-empty line of a `/** */`, `/* */`, or `//` comment, cleaned.
// Shared by the TS and Java doc extractors (Python docs are docstrings).
export function commentDocLine(text: string): string | null {
  if (text.startsWith('/**')) {
    const inner = text.slice(3, text.endsWith('*/') ? -2 : undefined);
    for (const line of inner.split('\n')) {
      const cleaned = line.replace(/^\s*\*?\s?/, '').trimEnd();
      if (cleaned) return cleaned;
    }
    return null;
  }
  if (text.startsWith('/*')) {
    const inner = text.slice(2, text.endsWith('*/') ? -2 : undefined);
    for (const line of inner.split('\n')) {
      const cleaned = line.trim();
      if (cleaned) return cleaned;
    }
    return null;
  }
  if (text.startsWith('//')) {
    const cleaned = text.replace(/^\/\/+\s?/, '').trim();
    return cleaned || null;
  }
  return null;
}

// Declaration signature = source from the declaration start to its body
// (or the declaration end when bodiless). Shared by the TS and Go
// extractors; feeds symbolId hashing, so — like normalizeSignature — it
// must stay one copy. Java forks its own (annotation exclusion + trailing
// `;` strip) and can't share this.
export function declSignature(decl: Node, content: string): string {
  const body = decl.childForFieldName('body');
  const sigEnd = body ? body.startIndex : decl.endIndex;
  return normalizeSignature(content.slice(decl.startIndex, sigEnd));
}

// A comment sharing its line with the END of an earlier sibling is a
// TRAILING comment on that statement (`var z int // about z`), not doc for
// the next declaration. Shared by the Go and Java doc extractors.
export function isTrailingComment(comment: Node): boolean {
  const before = comment.previousSibling;
  return before !== null && before.endPosition.row === comment.startPosition.row;
}

// Type names that appear more than once among `symbols` (restricted to
// `kinds`). Same-name types share a simple-name FQN, so resolving calls
// through them first-wins would bind to the WRONG type — callers pass the
// result as `ResolveCallsOptions.ambiguousClassNames` to exclude them from
// extract-time resolution. Shared by the Go and Java extractors (the kinds
// set differs: Go class/interface/type, Java class/interface/enum).
export function collectAmbiguousTypeNames(
  symbols: readonly Symbol[],
  kinds: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const ambiguous = new Set<string>();
  for (const s of symbols) {
    if (!kinds.has(s.kind)) continue;
    if (seen.has(s.name)) ambiguous.add(s.name);
    else seen.add(s.name);
  }
  return ambiguous;
}

export function resolveCalls(
  bodies: PendingBody[],
  moduleRoot: Node | null,
  symbols: Symbol[],
  fileInfo: FileInfo,
  selectors: ReadonlyArray<CallSelector>,
  skipTypes: ReadonlySet<string>,
  functionBodySkipTypes: ReadonlySet<string>,
  memberCallInfo: (callee: Node) => MemberCallInfo | null,
  opts?: ResolveCallsOptions,
): Reference[] {
  const bareCalleeTypes = opts?.bareCalleeTypes ?? DEFAULT_BARE_CALLEE_TYPES;
  const bindToEnclosingClass = opts?.bareCallsBindToEnclosingClass ?? false;
  const bareCallableKinds = opts?.bareCallableKinds;
  const constructorKinds = opts?.constructorKinds;
  const ambiguousClassNames = opts?.ambiguousClassNames;
  const ignoredBareCallees = opts?.ignoredBareCallees;
  const plainCalleeType = opts?.plainCalleeType ?? 'identifier';
  const constructorSelectorTypes = opts?.constructorSelectorTypes;
  const ambiguousBareCallees = opts?.ambiguousBareCallees;
  const nameToId = new Map<string, string>();
  for (const sym of symbols) {
    if (bareCallableKinds ? !bareCallableKinds.has(sym.kind) : NON_CALLABLE_KINDS.has(sym.kind)) {
      continue;
    }
    // An ambiguous bare-callable name (same name on >1 symbol — e.g. cross-namespace
    // same-name functions in one file) stays out: first-wins would bind a bare call
    // to the wrong one, so leave it unresolved instead.
    if (ambiguousBareCallees?.has(sym.name)) continue;
    if (!nameToId.has(sym.name)) nameToId.set(sym.name, sym.id);
  }
  // Constructor-form name map (`new X()` callees), built only when the
  // language configures it. Ambiguous names stay out: binding first-wins
  // between two same-named types would be confidently wrong.
  const typeNameToId = new Map<string, string>();
  if (constructorKinds) {
    for (const sym of symbols) {
      if (!constructorKinds.has(sym.kind)) continue;
      if (ambiguousClassNames?.has(sym.name)) continue;
      if (!typeNameToId.has(sym.name)) typeNameToId.set(sym.name, sym.id);
    }
  }
  // Methods stay out of `nameToId` (a bare `m()` never binds to one) but
  // member calls resolve through their class: `this.m()` / `Class.m()`.
  // The class name only lives in the fqn (`file:Class.method`).
  const methodsByClass = new Map<string, Map<string, string>>();
  for (const sym of symbols) {
    if (sym.kind !== 'method') continue;
    const cls = classNameFromFqn(sym.fqn);
    if (!cls || ambiguousClassNames?.has(cls)) continue;
    let methods = methodsByClass.get(cls);
    if (!methods) methodsByClass.set(cls, (methods = new Map()));
    if (!methods.has(sym.name)) methods.set(sym.name, sym.id);
  }
  const calleeByType = new Map(selectors.map((s) => [s.nodeType, s.getCallee]));

  const references: Reference[] = [];
  const seenCallNodeIds = new Set<number>();
  const emit = (
    node: Node,
    sourceId: string | null,
    className?: string,
    selfReceiverName?: string,
  ): void => {
    if (seenCallNodeIds.has(node.id)) return;
    const getCallee = calleeByType.get(node.type);
    if (!getCallee) return;
    const callee = getCallee(node);
    if (!callee) return;

    if (bareCalleeTypes.has(callee.type)) {
      seenCallNodeIds.add(node.id);
      const targetName = callee.text;
      // Constructor-form callees resolve against type symbols only. This is
      // either a callee node type that isn't the plain bare type (Java's
      // type_identifier from `new X()`) OR a call NODE in
      // constructorSelectorTypes (C#'s object_creation_expression, whose callee
      // IS a plain identifier — so it must be recognized by node, not callee,
      // type; otherwise `new Foo()` would mis-bind to an enclosing METHOD Foo).
      // Identifier callees that are NOT constructor-form resolve via the
      // enclosing class when configured, then the callable-name map. Either way
      // the ref stays a plain bare ref — the call site has no receiver token.
      const isConstructorForm =
        (constructorSelectorTypes?.has(node.type) ?? false) || callee.type !== plainCalleeType;
      const targetId = isConstructorForm
        ? typeNameToId.get(targetName) ?? null
        : ((bindToEnclosingClass && className !== undefined
            ? methodsByClass.get(className)?.get(targetName)
            : undefined) ??
          nameToId.get(targetName) ??
          null);
      // Ignored names (Go builtins) are dropped only when unresolved — the
      // node is already in seenCallNodeIds, so the moduleRoot re-walk stays
      // cheap and never re-emits it.
      if (targetId === null && !isConstructorForm && ignoredBareCallees?.has(targetName)) {
        return;
      }
      references.push({
        sourceId,
        targetId,
        targetName,
        kind: 'calls',
        file: fileInfo.path,
        line: node.startPosition.row + 1,
      });
      return;
    }

    // Member-expression callee (`obj.method()`, `this.x()`, `new ns.X()`).
    // Single-level receivers only; the reader returns null for chains,
    // `super`, and computed receivers, which are skipped entirely.
    // (JSX member components and bare member decorators never reach here —
    // their selectors return null for non-identifier names.)
    const member = memberCallInfo(callee);
    if (!member) return;
    seenCallNodeIds.add(node.id);
    // Selfness comes from the reader (TS `this` node, Python self/cls) or,
    // for Go, from the receiver token matching the enclosing method's
    // declared receiver variable (PendingBody.selfReceiverName).
    const isSelf =
      member.isSelf ||
      (selfReceiverName !== undefined && member.receiver === selfReceiverName);
    const lookupClass = isSelf ? className : member.receiver;
    const targetId =
      (lookupClass ? methodsByClass.get(lookupClass)?.get(member.property) : undefined) ??
      null;
    const ref: Reference = {
      sourceId,
      targetId,
      targetName: member.property,
      kind: 'calls',
      file: fileInfo.path,
      line: node.startPosition.row + 1,
      receiver: member.receiver,
    };
    // Recorded so isCallerOf can reject unresolved self-calls without
    // guessing from the receiver token (`self` is a legal TS identifier).
    // Gated on an enclosing class actually existing: `self.x()` in a
    // plain Python function (or `this.x()` in a plain JS function) has
    // no class instance to refer to and stays an ordinary member ref.
    if (isSelf && className !== undefined) ref.selfReceiver = true;
    references.push(ref);
  };

  // Languages without a decorator selector (Java) skip the decorator walk
  // entirely — it could never match and would re-traverse every subtree.
  const hasDecoratorSelector = calleeByType.has('decorator');

  // Body walks first so a function-nested decorator gets attributed to the
  // enclosing body when reachable; the seen-set then drops the (null-sourced)
  // module-root duplicate.
  for (const { symbolId: sourceId, body, className, selfReceiverName } of bodies) {
    walkCalls(body, calleeByType, skipTypes, (call) =>
      emit(call, sourceId, className, selfReceiverName),
    );
    // TS decorators sit under skip-typed parents (class_declaration etc.)
    // that walkCalls can't enter — walkDecorators descends through them
    // so nested decorated classes attribute to the enclosing body.
    if (hasDecoratorSelector) {
      walkDecorators(body, calleeByType, skipTypes, functionBodySkipTypes, (call) =>
        emit(call, sourceId, className, selfReceiverName),
      );
    }
  }
  if (moduleRoot) {
    walkCalls(moduleRoot, calleeByType, skipTypes, (call) => emit(call, null));
    if (hasDecoratorSelector) {
      walkDecorators(moduleRoot, calleeByType, skipTypes, functionBodySkipTypes, (call) =>
        emit(call, null),
      );
    }
  }
  return references;
}


type CalleeByType = ReadonlyMap<string, (n: Node) => Node | null>;

function walkCalls(
  node: Node,
  calleeByType: CalleeByType,
  skipTypes: ReadonlySet<string>,
  onCall: (n: Node) => void,
): void {
  if (calleeByType.has(node.type)) onCall(node);
  for (const child of node.namedChildren) {
    if (skipTypes.has(child.type)) continue;
    walkCalls(child, calleeByType, skipTypes, onCall);
  }
}

function walkDecorators(
  node: Node,
  calleeByType: CalleeByType,
  skipTypes: ReadonlySet<string>,
  functionBodySkipTypes: ReadonlySet<string>,
  onCall: (n: Node) => void,
): void {
  if (node.type === 'decorator') {
    walkCalls(node, calleeByType, skipTypes, onCall);
    return;
  }
  for (const child of node.namedChildren) {
    // Skip nested function bodies — decorators inside a nested function
    // only fire when that function is invoked, so they shouldn't
    // attribute to the enclosing body. Class types stay descended so
    // top-level decorators on inner classes still attribute correctly
    // (the original walkDecorators rationale, mirrored by walkCalls
    // skipping classes via skipTypes).
    if (functionBodySkipTypes.has(child.type)) continue;
    walkDecorators(child, calleeByType, skipTypes, functionBodySkipTypes, onCall);
  }
}
