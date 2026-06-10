import { createHash } from 'node:crypto';
import type { Node, Tree } from 'web-tree-sitter';

import { log } from '../logger.js';
import { NON_CALLABLE_KINDS, classNameFromFqn } from '../types.js';
import type { FileInfo, ImportInfo, Reference, Symbol } from '../types.js';
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

export function resolveCalls(
  bodies: PendingBody[],
  moduleRoot: Node | null,
  symbols: Symbol[],
  fileInfo: FileInfo,
  selectors: ReadonlyArray<CallSelector>,
  skipTypes: ReadonlySet<string>,
  functionBodySkipTypes: ReadonlySet<string>,
  memberCallInfo: (callee: Node) => MemberCallInfo | null,
): Reference[] {
  const nameToId = new Map<string, string>();
  for (const sym of symbols) {
    if (NON_CALLABLE_KINDS.has(sym.kind)) continue;
    if (!nameToId.has(sym.name)) nameToId.set(sym.name, sym.id);
  }
  // Methods stay out of `nameToId` (a bare `m()` never binds to one) but
  // member calls resolve through their class: `this.m()` / `Class.m()`.
  // The class name only lives in the fqn (`file:Class.method`).
  const methodsByClass = new Map<string, Map<string, string>>();
  for (const sym of symbols) {
    if (sym.kind !== 'method') continue;
    const cls = classNameFromFqn(sym.fqn);
    if (!cls) continue;
    let methods = methodsByClass.get(cls);
    if (!methods) methodsByClass.set(cls, (methods = new Map()));
    if (!methods.has(sym.name)) methods.set(sym.name, sym.id);
  }
  const calleeByType = new Map(selectors.map((s) => [s.nodeType, s.getCallee]));

  const references: Reference[] = [];
  const seenCallNodeIds = new Set<number>();
  const emit = (node: Node, sourceId: string | null, className?: string): void => {
    if (seenCallNodeIds.has(node.id)) return;
    const getCallee = calleeByType.get(node.type);
    if (!getCallee) return;
    const callee = getCallee(node);
    if (!callee) return;

    if (callee.type === 'identifier') {
      seenCallNodeIds.add(node.id);
      const targetName = callee.text;
      references.push({
        sourceId,
        targetId: nameToId.get(targetName) ?? null,
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
    const lookupClass = member.isSelf ? className : member.receiver;
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
    if (member.isSelf && className !== undefined) ref.selfReceiver = true;
    references.push(ref);
  };

  // Body walks first so a function-nested decorator gets attributed to the
  // enclosing body when reachable; the seen-set then drops the (null-sourced)
  // module-root duplicate.
  for (const { symbolId: sourceId, body, className } of bodies) {
    walkCalls(body, calleeByType, skipTypes, (call) => emit(call, sourceId, className));
    // TS decorators sit under skip-typed parents (class_declaration etc.)
    // that walkCalls can't enter — walkDecorators descends through them
    // so nested decorated classes attribute to the enclosing body.
    walkDecorators(body, calleeByType, skipTypes, functionBodySkipTypes, (call) =>
      emit(call, sourceId, className),
    );
  }
  if (moduleRoot) {
    walkCalls(moduleRoot, calleeByType, skipTypes, (call) => emit(call, null));
    walkDecorators(moduleRoot, calleeByType, skipTypes, functionBodySkipTypes, (call) =>
      emit(call, null),
    );
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
