import { createHash } from 'node:crypto';
import type { Node, Tree } from 'web-tree-sitter';

import { log } from '../logger.js';
import type { FileInfo, ImportInfo, Reference, Symbol, SymbolKind } from '../types.js';
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

const NON_CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'interface',
  'type',
]);

export function resolveCalls(
  bodies: PendingBody[],
  symbols: Symbol[],
  fileInfo: FileInfo,
  callNodeType: 'call_expression' | 'call',
  skipTypes: ReadonlySet<string>,
): Reference[] {
  const nameToId = new Map<string, string>();
  for (const sym of symbols) {
    if (NON_CALLABLE_KINDS.has(sym.kind)) continue;
    if (!nameToId.has(sym.name)) nameToId.set(sym.name, sym.id);
  }

  const references: Reference[] = [];
  for (const { symbolId: sourceId, body } of bodies) {
    walkCalls(body, callNodeType, skipTypes, (call) => {
      const fn = call.childForFieldName('function');
      if (!fn || fn.type !== 'identifier') return;
      const targetId = nameToId.get(fn.text);
      if (!targetId) return;
      references.push({
        sourceId,
        targetId,
        kind: 'calls',
        file: fileInfo.path,
        line: call.startPosition.row + 1,
      });
    });
  }
  return references;
}

function walkCalls(
  node: Node,
  callType: 'call_expression' | 'call',
  skipTypes: ReadonlySet<string>,
  onCall: (n: Node) => void,
): void {
  if (node.type === callType) onCall(node);
  for (const child of node.namedChildren) {
    if (skipTypes.has(child.type)) continue;
    walkCalls(child, callType, skipTypes, onCall);
  }
}
