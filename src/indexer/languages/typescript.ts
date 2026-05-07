import type { Node, Tree } from 'web-tree-sitter';

import type { FileInfo, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import { resolveCalls, symbolId } from '../extractor.js';
import type { ExtractResult, PendingBody } from '../extractor.js';

const WS_REGEX = /\s+/g;

const TS_SKIP_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'class_declaration',
  'class_expression',
  'abstract_class_declaration',
]);

export function extractTypeScript(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const bodies: PendingBody[] = [];

  for (const child of tree.rootNode.namedChildren) {
    let exported = false;
    let target: Node = child;

    if (child.type === 'export_statement') {
      const decl = child.childForFieldName('declaration');
      // Re-exports (`export { x }`, `export * from '...'`) have no
      // `declaration` field and contribute no new symbols here.
      if (!decl) continue;
      exported = true;
      target = decl;
    }

    extractTopLevel(target, child, content, fileInfo, exported, symbols, imports, bodies);
  }

  const references = resolveCalls(bodies, symbols, fileInfo, 'call_expression', TS_SKIP_TYPES);
  return { symbols, references, imports };
}

function extractTopLevel(
  target: Node,
  outer: Node,
  content: string,
  fileInfo: FileInfo,
  exported: boolean,
  outSymbols: Symbol[],
  outImports: ImportInfo[],
  outBodies: PendingBody[],
): void {
  switch (target.type) {
    case 'ambient_declaration': {
      const inner = target.firstNamedChild;
      if (inner) extractTopLevel(inner, outer, content, fileInfo, exported, outSymbols, outImports, outBodies);
      return;
    }
    case 'function_declaration':
    case 'function_signature': {
      const name = target.childForFieldName('name')?.text;
      if (!name) return;
      const sym = makeSymbol(target, outer, declSignature(target, content), fileInfo, 'function', name, `${fileInfo.path}:${name}`, exported);
      outSymbols.push(sym);
      const body = target.childForFieldName('body');
      if (body) outBodies.push({ symbolId: sym.id, body });
      return;
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const className = target.childForFieldName('name')?.text;
      if (!className) return;
      outSymbols.push(
        makeSymbol(target, outer, declSignature(target, content), fileInfo, 'class', className, `${fileInfo.path}:${className}`, exported),
      );
      const body = target.childForFieldName('body');
      if (!body) return;
      for (const member of body.namedChildren) {
        extractClassMember(member, content, fileInfo, className, exported, outSymbols, outBodies);
      }
      return;
    }
    case 'interface_declaration': {
      const name = target.childForFieldName('name')?.text;
      if (!name) return;
      outSymbols.push(
        makeSymbol(target, outer, declSignature(target, content), fileInfo, 'interface', name, `${fileInfo.path}:${name}`, exported),
      );
      return;
    }
    case 'type_alias_declaration': {
      const name = target.childForFieldName('name')?.text;
      if (!name) return;
      outSymbols.push(
        makeSymbol(target, outer, declSignature(target, content), fileInfo, 'type', name, `${fileInfo.path}:${name}`, exported),
      );
      return;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const declarator of target.namedChildren) {
        if (declarator.type !== 'variable_declarator') continue;
        const nameNode = declarator.childForFieldName('name');
        // Skip destructuring patterns (array_pattern, object_pattern).
        if (!nameNode || nameNode.type !== 'identifier') continue;
        const name = nameNode.text;
        const value = declarator.childForFieldName('value');
        const isFunction =
          !!value && (value.type === 'arrow_function' || value.type === 'function_expression');
        const kind: SymbolKind = isFunction ? 'function' : 'variable';
        const sym = makeSymbol(
          declarator,
          outer,
          variableSignature(declarator, value, content),
          fileInfo,
          kind,
          name,
          `${fileInfo.path}:${name}`,
          exported,
        );
        outSymbols.push(sym);
        if (isFunction && value) {
          const body = value.childForFieldName('body');
          if (body) outBodies.push({ symbolId: sym.id, body });
        }
      }
      return;
    }
    case 'import_statement': {
      extractImport(target, fileInfo, outImports);
      return;
    }
    default:
      return;
  }
}

function extractClassMember(
  member: Node,
  content: string,
  fileInfo: FileInfo,
  className: string,
  exported: boolean,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  switch (member.type) {
    case 'method_definition':
    case 'method_signature':
    case 'abstract_method_signature': {
      const methodName = member.childForFieldName('name')?.text;
      if (!methodName) return;
      const methodSym = makeSymbol(
        member,
        member,
        declSignature(member, content),
        fileInfo,
        'method',
        methodName,
        `${fileInfo.path}:${className}.${methodName}`,
        exported,
        className,
      );
      outSymbols.push(methodSym);
      const methodBody = member.childForFieldName('body');
      if (methodBody) outBodies.push({ symbolId: methodSym.id, body: methodBody });
      return;
    }
    case 'public_field_definition': {
      const propName = member.childForFieldName('name')?.text;
      if (!propName) return;
      const value = member.childForFieldName('value');
      const isCallable =
        !!value && (value.type === 'arrow_function' || value.type === 'function_expression');
      const kind: SymbolKind = isCallable ? 'method' : 'variable';
      const fieldSym = makeSymbol(
        member,
        member,
        variableSignature(member, value, content),
        fileInfo,
        kind,
        propName,
        `${fileInfo.path}:${className}.${propName}`,
        exported,
        className,
      );
      outSymbols.push(fieldSym);
      if (isCallable && value) {
        const fnBody = value.childForFieldName('body');
        if (fnBody) outBodies.push({ symbolId: fieldSym.id, body: fnBody });
      }
      return;
    }
    default:
      return;
  }
}

function extractImport(stmt: Node, fileInfo: FileInfo, out: ImportInfo[]): void {
  const sourceNode = stmt.childForFieldName('source');
  if (!sourceNode) return;
  const sourceModule = sourceNode.text.replace(/^['"`]|['"`]$/g, '');
  const importedNames: Array<{ name: string; alias?: string }> = [];

  for (const child of stmt.namedChildren) {
    if (child.type !== 'import_clause') continue;
    for (const item of child.namedChildren) {
      if (item.type === 'identifier') {
        importedNames.push({ name: 'default', alias: item.text });
      } else if (item.type === 'namespace_import') {
        for (const nsChild of item.namedChildren) {
          if (nsChild.type === 'identifier') {
            importedNames.push({ name: '*', alias: nsChild.text });
          }
        }
      } else if (item.type === 'named_imports') {
        for (const spec of item.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
          const specName = spec.childForFieldName('name')?.text;
          if (!specName) continue;
          const specAlias = spec.childForFieldName('alias')?.text;
          importedNames.push(specAlias ? { name: specName, alias: specAlias } : { name: specName });
        }
      }
    }
  }

  out.push({
    file: fileInfo.path,
    sourceModule,
    importedNames,
    line: stmt.startPosition.row + 1,
  });
}

function makeSymbol(
  decl: Node,
  docNode: Node,
  signature: string,
  fileInfo: FileInfo,
  kind: SymbolKind,
  name: string,
  fqn: string,
  exported: boolean,
  qualifier = '',
): Symbol {
  return {
    id: symbolId(fileInfo.path, name, kind, signature, qualifier),
    name,
    fqn,
    kind,
    file: fileInfo.path,
    startLine: decl.startPosition.row + 1,
    endLine: decl.endPosition.row + 1,
    signature,
    doc: extractDoc(docNode),
    exported,
    language: fileInfo.language,
  };
}

function declSignature(decl: Node, content: string): string {
  const body = decl.childForFieldName('body');
  const sigEnd = body ? body.startIndex : decl.endIndex;
  return normalizeSignature(content.slice(decl.startIndex, sigEnd));
}

function variableSignature(declarator: Node, value: Node | null, content: string): string {
  if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
    const body = value.childForFieldName('body');
    const sigEnd = body ? body.startIndex : declarator.endIndex;
    let sig = content.slice(declarator.startIndex, sigEnd).trim().replace(WS_REGEX, ' ');
    if (value.type === 'arrow_function') sig = sig.replace(/=>\s*$/, '').trimEnd();
    return sig.slice(0, 120);
  }
  return normalizeSignature(content.slice(declarator.startIndex, declarator.endIndex));
}

function normalizeSignature(raw: string): string {
  return raw.trim().replace(WS_REGEX, ' ').slice(0, 120);
}

function extractDoc(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (!prev || prev.type !== 'comment') return null;
  const text = prev.text;

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
