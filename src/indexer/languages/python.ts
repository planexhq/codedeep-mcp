import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE } from '../../types.js';
import type { FileInfo, ImportedName, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import { bareDecoratorIdentifier, resolveCalls, symbolId } from '../extractor.js';
import type {
  CallSelector,
  ExtractResult,
  MemberCallInfo,
  PendingBody,
} from '../extractor.js';

const WS_REGEX = /\s+/g;

// Function-like nodes whose bodies contain calls that shouldn't attribute
// to an enclosing body. walkDecorators uses this subset so it still
// descends through class bodies but stops at nested function bodies and
// lambdas — see the matching TS_FUNCTION_BODY_SKIP_TYPES in typescript.ts.
const PY_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'function_definition',
  'lambda',
]);

const PY_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...PY_FUNCTION_BODY_SKIP_TYPES,
  'class_definition',
]);

const PY_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call', getCallee: (n) => n.childForFieldName('function') },
  { nodeType: 'decorator', getCallee: bareDecoratorIdentifier },
];

// Single-level attribute callees only: `self.x()`, `cls.x()`, `obj.x()`.
// Chained (`a.b.c()`) and computed (`super().x()` — object is a `call`
// node) receivers return null and emit nothing.
function pyMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type !== 'attribute') return null;
  const obj = callee.childForFieldName('object');
  const prop = callee.childForFieldName('attribute');
  if (!obj || !prop || prop.type !== 'identifier' || obj.type !== 'identifier') {
    return null;
  }
  const isSelf = obj.text === 'self' || obj.text === 'cls';
  return { receiver: obj.text, property: prop.text, isSelf };
}

export function extractPython(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const bodies: PendingBody[] = [];

  const allNames = findAllNames(tree.rootNode);

  for (const child of tree.rootNode.namedChildren) {
    extractTopLevel(child, content, fileInfo, allNames, symbols, imports, bodies);
  }

  const references = resolveCalls(
    bodies,
    tree.rootNode,
    symbols,
    fileInfo,
    PY_SELECTORS,
    PY_SKIP_TYPES,
    PY_FUNCTION_BODY_SKIP_TYPES,
    pyMemberCallInfo,
  );
  return { symbols, references, imports };
}

function extractTopLevel(
  node: Node,
  content: string,
  fileInfo: FileInfo,
  allNames: Set<string> | null,
  outSymbols: Symbol[],
  outImports: ImportInfo[],
  outBodies: PendingBody[],
): void {
  switch (node.type) {
    case 'function_definition':
      extractFunction(node, node, content, fileInfo, allNames, outSymbols, outBodies);
      return;
    case 'class_definition':
      extractClass(node, node, content, fileInfo, allNames, outSymbols, outBodies);
      return;
    case 'decorated_definition': {
      const inner = node.childForFieldName('definition');
      if (!inner) return;
      if (inner.type === 'function_definition') {
        extractFunction(inner, node, content, fileInfo, allNames, outSymbols, outBodies);
      } else if (inner.type === 'class_definition') {
        extractClass(inner, node, content, fileInfo, allNames, outSymbols, outBodies);
      }
      return;
    }
    case 'assignment':
      extractAssignment(node, content, fileInfo, allNames, outSymbols);
      return;
    case 'expression_statement': {
      const inner = node.firstNamedChild;
      if (inner?.type === 'assignment') {
        extractAssignment(inner, content, fileInfo, allNames, outSymbols);
      }
      return;
    }
    case 'import_statement':
      extractImport(node, fileInfo, outImports);
      return;
    case 'import_from_statement':
      extractImportFrom(node, fileInfo, outImports);
      return;
    default:
      return;
  }
}

function extractFunction(
  inner: Node,
  rangeNode: Node,
  content: string,
  fileInfo: FileInfo,
  allNames: Set<string> | null,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const name = inner.childForFieldName('name')?.text;
  if (!name) return;
  const signature = pythonSignature(inner, rangeNode, content);
  const sym = makePythonSymbol(
    rangeNode,
    inner,
    signature,
    fileInfo,
    'function',
    name,
    `${fileInfo.path}:${name}`,
    isExported(name, allNames),
  );
  outSymbols.push(sym);
  const body = inner.childForFieldName('body');
  if (body) outBodies.push({ symbolId: sym.id, body });
}

function extractClass(
  inner: Node,
  rangeNode: Node,
  content: string,
  fileInfo: FileInfo,
  allNames: Set<string> | null,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const className = inner.childForFieldName('name')?.text;
  if (!className) return;
  const exported = isExported(className, allNames);
  const classSym = makePythonSymbol(
    rangeNode,
    inner,
    pythonSignature(inner, rangeNode, content),
    fileInfo,
    'class',
    className,
    `${fileInfo.path}:${className}`,
    exported,
  );
  outSymbols.push(classSym);

  const body = inner.childForFieldName('body');
  if (!body) return;

  // Walk the class body so class-level calls (`class C: x = helper()`,
  // `class C: helper()`) attribute to the class. PY_SKIP_TYPES contains
  // function_definition / lambda / class_definition, so methods,
  // lambdas, and nested classes stay attributed to themselves.
  outBodies.push({ symbolId: classSym.id, body, className });

  for (const member of body.namedChildren) {
    if (member.type === 'function_definition') {
      const methodName = member.childForFieldName('name')?.text;
      if (!methodName) continue;
      const methodSym = makePythonSymbol(
        member,
        member,
        pythonSignature(member, member, content),
        fileInfo,
        'method',
        methodName,
        `${fileInfo.path}:${className}.${methodName}`,
        exported,
        className,
      );
      outSymbols.push(methodSym);
      const methodBody = member.childForFieldName('body');
      if (methodBody) {
        outBodies.push({ symbolId: methodSym.id, body: methodBody, className });
      }
    } else if (member.type === 'decorated_definition') {
      const innerDef = member.childForFieldName('definition');
      if (!innerDef || innerDef.type !== 'function_definition') continue;
      const methodName = innerDef.childForFieldName('name')?.text;
      if (!methodName) continue;
      const methodSym = makePythonSymbol(
        member,
        innerDef,
        pythonSignature(innerDef, member, content),
        fileInfo,
        'method',
        methodName,
        `${fileInfo.path}:${className}.${methodName}`,
        exported,
        className,
      );
      outSymbols.push(methodSym);
      const methodBody = innerDef.childForFieldName('body');
      if (methodBody) {
        outBodies.push({ symbolId: methodSym.id, body: methodBody, className });
      }
    }
  }
}

function extractAssignment(
  node: Node,
  content: string,
  fileInfo: FileInfo,
  allNames: Set<string> | null,
  outSymbols: Symbol[],
): void {
  const left = node.childForFieldName('left');
  if (!left || left.type !== 'identifier') return;
  const name = left.text;
  if (name === '__all__') return;
  const kind: SymbolKind = 'variable';
  const signature = normalizeSignature(content.slice(node.startIndex, node.endIndex));
  outSymbols.push({
    id: symbolId(fileInfo.path, name, kind, signature),
    name,
    fqn: `${fileInfo.path}:${name}`,
    kind,
    file: fileInfo.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature,
    doc: null,
    exported: isExported(name, allNames),
    language: fileInfo.language,
  });
}

function extractImport(stmt: Node, fileInfo: FileInfo, out: ImportInfo[]): void {
  // `import x` / `import x as y` — both bind a module object, not a
  // callable value. kind='module' tells primaryRefMatchesTarget to
  // not admit bare `x()` / `y()` as bound through the import.
  for (const nameNode of stmt.childrenForFieldName('name')) {
    if (nameNode.type === 'aliased_import') {
      const named = readAliased(nameNode);
      if (!named) continue;
      named.kind = 'module';
      out.push({
        file: fileInfo.path,
        sourceModule: named.name,
        importedNames: [named],
        line: stmt.startPosition.row + 1,
      });
    } else if (nameNode.type === 'dotted_name') {
      out.push({
        file: fileInfo.path,
        sourceModule: nameNode.text,
        importedNames: [{ name: nameNode.text, kind: 'module' }],
        line: stmt.startPosition.row + 1,
      });
    }
  }
}

function extractImportFrom(stmt: Node, fileInfo: FileInfo, out: ImportInfo[]): void {
  const moduleNode = stmt.childForFieldName('module_name');
  if (!moduleNode) return;
  const sourceModule = moduleNode.text;
  // `from . import x` / `from .. import y` — the bare-dot form binds
  // `x`/`y` as submodule objects of the package, not as callable
  // values. tree-sitter-python distinguishes by structure: a bare-dot
  // `relative_import` carries only `import_prefix`, while a named one
  // (`from .pkg import x`) also has a `dotted_name` child.
  const bindsModuleObjects =
    moduleNode.type === 'relative_import' &&
    !moduleNode.namedChildren.some((c) => c.type === 'dotted_name');
  const importedNames: ImportedName[] = [];

  const hasWildcard = stmt.namedChildren.some((c) => c.type === 'wildcard_import');
  if (hasWildcard) {
    importedNames.push({ name: IMPORT_NAMESPACE });
  } else {
    for (const nameNode of stmt.childrenForFieldName('name')) {
      const named =
        nameNode.type === 'aliased_import'
          ? readAliased(nameNode)
          : { name: nameNode.text };
      if (!named) continue;
      if (bindsModuleObjects) named.kind = 'module';
      importedNames.push(named);
    }
  }

  out.push({
    file: fileInfo.path,
    sourceModule,
    importedNames,
    line: stmt.startPosition.row + 1,
  });
}

function readAliased(nameNode: Node): ImportedName | null {
  const inner = nameNode.childForFieldName('name');
  const alias = nameNode.childForFieldName('alias');
  if (!inner || !alias) return null;
  return { name: inner.text, alias: alias.text };
}

function pythonSignature(inner: Node, rangeNode: Node, content: string): string {
  const body = inner.childForFieldName('body');
  const sigEnd = body ? body.startIndex : inner.endIndex;
  return normalizeSignature(content.slice(rangeNode.startIndex, sigEnd));
}

function makePythonSymbol(
  rangeNode: Node,
  innerNode: Node,
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
    startLine: rangeNode.startPosition.row + 1,
    endLine: rangeNode.endPosition.row + 1,
    signature,
    doc: extractPythonDoc(innerNode),
    exported,
    language: fileInfo.language,
  };
}

function isExported(name: string, allNames: Set<string> | null): boolean {
  if (allNames) return allNames.has(name);
  return !name.startsWith('_');
}

function findAllNames(rootNode: Node): Set<string> | null {
  for (const child of rootNode.namedChildren) {
    let assignment: Node | null = null;
    if (child.type === 'assignment') {
      assignment = child;
    } else if (child.type === 'expression_statement') {
      const inner = child.firstNamedChild;
      if (inner?.type === 'assignment') assignment = inner;
    }
    if (!assignment) continue;

    const left = assignment.childForFieldName('left');
    if (!left || left.text !== '__all__') continue;
    const right = assignment.childForFieldName('right');
    if (!right || (right.type !== 'list' && right.type !== 'tuple')) continue;
    const set = new Set<string>();
    for (const item of right.namedChildren) {
      if (item.type === 'string') set.add(stripPyStringQuotes(item.text));
    }
    return set;
  }
  return null;
}

function extractPythonDoc(definitionNode: Node): string | null {
  const body = definitionNode.childForFieldName('body');
  if (!body) return null;
  const first = body.firstNamedChild;
  if (!first || first.type !== 'expression_statement') return null;
  const stringNode = first.firstNamedChild;
  if (!stringNode || stringNode.type !== 'string') return null;
  const inner = stripPyStringQuotes(stringNode.text);
  for (const line of inner.split('\n')) {
    const cleaned = line.trim();
    if (cleaned) return cleaned;
  }
  return null;
}

function stripPyStringQuotes(text: string): string {
  let s = text.replace(/^[fFrRbBuU]+/, '');
  if (s.startsWith('"""') && s.endsWith('"""') && s.length >= 6) return s.slice(3, -3);
  if (s.startsWith("'''") && s.endsWith("'''") && s.length >= 6) return s.slice(3, -3);
  if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'")) && s[0] === s[s.length - 1]) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeSignature(raw: string): string {
  return raw.trim().replace(WS_REGEX, ' ').slice(0, 120);
}
