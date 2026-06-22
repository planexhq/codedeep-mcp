import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportedName, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  bareDecoratorIdentifier,
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

// Peels `parenthesized_expression` (`(a)`, `(super())`) — transparent to receiver
// IDENTITY — so a parenthesized receiver resolves like its unwrapped form: `(a).x()`
// like `a.x()`, and `(super()).x()` reaches the super-call drop below. The wrapped
// expression is the first NON-COMMENT named child (a leading `# c` is a NAMED node;
// skip it, the Go/TS receiver-unwrap pattern). A genuine expression receiver
// (`(a + b).x()`) unwraps to a non-identifier/non-call node → stays opaque.
function unwrapPyReceiver(node: Node): Node {
  let n = node;
  while (n.type === 'parenthesized_expression') {
    let inner = n.firstNamedChild;
    while (inner && inner.type === 'comment') inner = inner.nextNamedSibling;
    if (!inner) break;
    n = inner;
  }
  return n;
}

// `self.x()` / `cls.x()` / `obj.x()` carry their literal receiver token; a
// parenthesized `(a).x()` / `(self).x()` receiver is unwrapped to that token too.
// Chained and computed receivers (`a.b.c()`, `foo().x()`) carry RECEIVER_OPAQUE so
// the called method stays findable by name (recall) but never resolves. `super().x()`
// — including the parenthesized `(super()).x()` form — is parent-class dispatch,
// dropped (the TS/Java/Dart rule), even though `super()` is syntactically a `call`
// node like a genuine chain. A computed/non-clean attribute (no `identifier`
// attribute) emits nothing.
function pyMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type !== 'attribute') return null;
  const obj0 = callee.childForFieldName('object');
  const prop = callee.childForFieldName('attribute');
  if (!obj0 || !prop || prop.type !== 'identifier') return null;
  const obj = unwrapPyReceiver(obj0);
  if (obj.type === 'identifier') {
    const isSelf = obj.text === 'self' || obj.text === 'cls';
    return { receiver: obj.text, property: prop.text, isSelf };
  }
  // `super().method()` — Python 3 super is always a `call`, so unlike the other
  // languages there is no `super` TOKEN to match; detect the call shape and drop
  // it (parent-class dispatch, deliberately untracked) before the opaque branch.
  if (obj.type === 'call') {
    const fn = obj.childForFieldName('function');
    if (fn?.type === 'identifier' && fn.text === 'super') return null;
  }
  return { receiver: RECEIVER_OPAQUE, property: prop.text, isSelf: false };
}

// Dominant Python stdlib/builtin method names (>=4 chars) suppressed when a
// member call to them is unresolved — capturing chained calls otherwise floods
// the name-keyed store with `.append()`/`.items()`/`.format()`-style noise.
// Domain method names are deliberately absent. <=3-char names (`.get`, `.pop`)
// are gated downstream by SHORT_NAME_THRESHOLD, so they're omitted here.
//
// Composition checked against a requests dogfood (per-name member-call flood vs
// in-repo `def` recall stake). The kept names are canonical-by-usage: even where
// requests also defines one (its `CaseInsensitiveDict`/`RequestsCookieJar`
// implement MutableMapping), ~0–12% of `.items()`/`.update()`/`.copy()`/`.values()`
// sites target it, so capturing would inject mostly-FALSE weak callers (e.g. the
// `copy.copy()` MODULE function would smear onto `def copy`). `close` was REMOVED
// (now captured): a distinctive resource-teardown method (Response/Session/
// HTTPAdapter), ~60% of `.close()` sites have in-repo receivers. NOTE: requests is
// one small HTTP library — it does NOT exercise the Django/SQLAlchemy/parser
// collision worry (update/match/search as ORM/parser methods); a confident trim of
// those needs a flask/django/sqlalchemy dogfood (tracked as a follow-up).
const PY_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'append', 'extend', 'insert', 'remove', 'index', 'count', 'sort',
  'reverse', 'copy', 'clear', 'items', 'keys', 'values', 'update',
  'setdefault', 'format', 'format_map', 'strip', 'lstrip', 'rstrip',
  'split', 'rsplit', 'splitlines', 'join', 'replace', 'encode', 'decode',
  'startswith', 'endswith', 'lower', 'upper', 'title', 'find', 'rfind',
  'isdigit', 'isalpha', 'isspace', 'read', 'readline', 'readlines',
  'write', 'flush', 'group', 'groups', 'match', 'search',
  'union', 'intersection', 'difference', 'discard',
]);

// Cyclomatic decision nodes — Probe's convention (radon/McCabe-aligned), since
// Python is undocumented by SonarQube. Verified against the sonar-python source
// (metrics/ComplexityVisitor): sonar-python counts only def/if/for/while/ternary/
// (and|or)/comprehension-if and notably OMITS `elif`, `except`, and `match`/`case`
// entirely (the visitor has no handler for them — the metric file predates 3.10).
// Probe DELIBERATELY DIVERGES from those omissions and counts every genuine
// branch (radon-style): `elif_clause` (+1 each), `except_clause` (+1 per clause),
// `case_clause` (each `match` arm incl. the wildcard `case _:`). `if_clause`
// covers BOTH comprehension filters (`[x for x in y if c]` — counted by radon AND
// sonar-python) and match-case guards (`case X if g:`). `else_clause`/
// `finally_clause`/comprehension-`for` never count. `boolean_operator` is a
// DISTINCT node (each `and`/`or` nests to its own node → per-operator total),
// folded straight in — no token-read predicate, unlike the C-family.
const PY_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'elif_clause',
  'for_statement',
  'while_statement',
  'except_clause',
  'conditional_expression',
  'case_clause',
  'if_clause',
  'boolean_operator',
]);

// Python's logical operator is a distinct `boolean_operator` node (NOT the C-family
// `binary_expression`), so the shared `cFamilyBooleanOperatorKind` reader won't match
// it. The `operator` field token is `and`/`or` — returned as the run-collapse KIND so
// `a and b or c` = 2 (per-operator-kind-change, the engine default + sonar-python).
function pyBooleanOperatorKind(node: Node): string | null {
  return node.type === 'boolean_operator'
    ? (node.childForFieldName('operator')?.type ?? null)
    : null;
}

// Never-matching sentinel: sonar-python's `flattenOperators` does NOT unwrap
// parentheses while linearizing a boolean run (it stops at a parenthesized
// expression), so `(a and b) and c` = 2 — the parenthesized `and` is its own run when
// the DFS later descends into it. The sentinel makes the engine's skipParens a no-op,
// the Go/gocognit treatment (NOT TS/Java/complexipy's unwrap). VERIFIED on the oracle.
const PY_NO_PAREN_SENTINEL = '__py_no_paren__';

// Cognitive-complexity config (SonarSource whitepaper §1.2), VERIFIED-EXACT against
// sonar-python's `CognitiveComplexityVisitor` (clean-room source read + an oracle diff
// on flask/django: 0 mismatches on all 5034 functions WITHOUT a nested scope). The pin
// is sonar-python — SonarQube's own number, and the clean engine fit (vs complexipy's
// quirks). Key choices, all oracle-confirmed: the `if`/`elif`/`else` chain is a flat
// sibling list (elifClauseType — the one genuinely-new engine path); `except` SURCHARGES
// (catchType, like Java); booleans count EVERYWHERE per-operator-kind run with NO paren
// unwrap; `for`/`while`/`try`-`else` is +1 flat with its body nested (the else_clause
// dispatch); `match` is 0 STRUCTURAL with case bodies nested (nestOnlyTypes); `with` and
// the `try` body are NOT nested (pass-through — the divergence from complexipy);
// loopBodyField nests only the loop body (resolving the loop-header overbump). Nested
// functions/lambdas/classes are EXCLUDED (PY_SKIP_TYPES is the cognitive boundary) — the
// per-symbol-model under-count, like the Java anon-class / TS-arrow callback divergence;
// see the project docs' "Cognitive Complexity Rules".
const PY_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  elifClauseType: 'elif_clause',
  elseClauseType: 'else_clause',
  loopTypes: new Set(['while_statement', 'for_statement']),
  loopBodyField: 'body',
  switchTypes: new Set(),
  ternaryType: 'conditional_expression',
  catchType: 'except_clause',
  nestOnlyTypes: new Set(['match_statement']),
  labeledJumpTypes: new Set(),
  hasLabel: () => false,
  booleanOperatorKind: pyBooleanOperatorKind,
  parenthesizedType: PY_NO_PAREN_SENTINEL,
};

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
    { ignoredMemberCallees: PY_IGNORED_MEMBER_CALLEES },
  );
  computeComplexity(bodies, symbols, {
    decisionNodeTypes: PY_DECISION_NODE_TYPES,
    skipTypes: PY_SKIP_TYPES,
    cognitive: PY_COGNITIVE_OPTIONS,
  });
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
    // Inline construction (no doc/range split needed) — but it must mirror
    // makePythonSymbol's contract: hash the FULL signature, store it capped.
    // A module-level `DATA = {...}` literal can run to kilobytes.
    id: symbolId(fileInfo.path, name, kind, signature),
    name,
    fqn: `${fileInfo.path}:${name}`,
    kind,
    file: fileInfo.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
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
    // The id hashes the FULL signature; only the stored copy is capped —
    // otherwise overloads differing past the cap share an id (JG1).
    id: symbolId(fileInfo.path, name, kind, signature, qualifier),
    name,
    fqn,
    kind,
    file: fileInfo.path,
    startLine: rangeNode.startPosition.row + 1,
    endLine: rangeNode.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
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
