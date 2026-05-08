import { createHash } from 'node:crypto';
import type { Node, Tree } from 'web-tree-sitter';

import { log } from '../logger.js';
import { NON_CALLABLE_KINDS } from '../types.js';
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
}

// Maps a call-like AST node to the identifier being "called" — function call,
// constructor in `new X()`, JSX component in `<X />`. Returning null skips the
// node (member-expression callees, lowercase JSX HTML tags).
export interface CallSelector {
  nodeType: string;
  getCallee: (node: Node) => Node | null;
}

// Selector for bare decorator forms (`@foo`, `@dataclass`). For `@foo()` the
// child is `call_expression`/`call` and the call selector emits the ref via
// walkCalls; for `@foo.bar` the child is `member_expression`/`attribute` and
// is correctly skipped as member access. Shared by TS and Python — both use
// `identifier` as the node type for plain names.
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
): Reference[] {
  const nameToId = new Map<string, string>();
  for (const sym of symbols) {
    if (NON_CALLABLE_KINDS.has(sym.kind)) continue;
    if (!nameToId.has(sym.name)) nameToId.set(sym.name, sym.id);
  }
  const calleeByType = new Map(selectors.map((s) => [s.nodeType, s.getCallee]));

  const references: Reference[] = [];
  const seenCallNodeIds = new Set<number>();
  const emit = (node: Node, sourceId: string | null): void => {
    if (seenCallNodeIds.has(node.id)) return;
    const getCallee = calleeByType.get(node.type);
    if (!getCallee) return;
    const callee = getCallee(node);
    // Skip member-expression callees (`obj.method()`, `new x.y()`,
    // `<ns.Cmp />`) and HTML JSX tags (filtered to null by the selector).
    if (!callee || callee.type !== 'identifier') return;
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
  };

  // Body walks first so a function-nested decorator gets attributed to the
  // enclosing body when reachable; the seen-set then drops the (null-sourced)
  // module-root duplicate.
  for (const { symbolId: sourceId, body } of bodies) {
    walkCalls(body, calleeByType, skipTypes, (call) => emit(call, sourceId));
    // TS decorators sit under skip-typed parents (class_declaration etc.)
    // that walkCalls can't enter — walkDecorators descends through them
    // so nested decorated classes attribute to the enclosing body.
    walkDecorators(body, calleeByType, skipTypes, functionBodySkipTypes, (call) =>
      emit(call, sourceId),
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
