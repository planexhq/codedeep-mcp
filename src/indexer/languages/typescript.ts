import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_DEFAULT, IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportedName, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  bareDecoratorIdentifier,
  commentDocLine,
  declSignature,
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
import {
  cFamilyBooleanOperatorKind,
  computeComplexity,
  isCFamilyBooleanOperator,
} from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Function-like nodes whose bodies contain calls that shouldn't attribute
// to an enclosing body. walkDecorators uses this subset (NOT the full
// SKIP_TYPES) so it still descends through class bodies — top-level
// decorators on inner classes attribute to the enclosing function — but
// stops at nested function bodies, where decorator firing is gated on the
// nested function being called.
const TS_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
]);

const TS_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...TS_FUNCTION_BODY_SKIP_TYPES,
  'class_declaration',
  'class_expression',
  'abstract_class_declaration',
]);

const TS_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call_expression', getCallee: (n) => n.childForFieldName('function') },
  { nodeType: 'new_expression', getCallee: (n) => n.childForFieldName('constructor') },
  { nodeType: 'jsx_opening_element', getCallee: jsxComponentName },
  { nodeType: 'jsx_self_closing_element', getCallee: jsxComponentName },
  { nodeType: 'decorator', getCallee: bareDecoratorIdentifier },
];

// JSX components are PascalCase by convention; lowercase first char is an
// HTML element (`<div>`, `<span>`) which we don't track as a symbol ref.
function jsxComponentName(node: Node): Node | null {
  const name = node.childForFieldName('name');
  if (!name || name.type !== 'identifier') return null;
  const ch = name.text.charAt(0);
  if (ch >= 'a' && ch <= 'z') return null;
  return name;
}

// Dominant JS/TS fluent/stdlib method names (>=4 chars) suppressed when a
// member call to them is unresolved — without this, capturing chained calls
// floods the name-keyed store with `.then()`/`.filter()`/`.map()`-style noise.
// Domain method names (zod's `.optional`/`.nullable`/`.refine`, etc.) are
// deliberately absent — those are the recall win. <=3-char names (`.map`,
// `.get`, `.set`) are gated downstream by SHORT_NAME_THRESHOLD, so they're
// omitted here.
const TS_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'then', 'catch', 'finally', 'filter', 'forEach', 'reduce', 'flatMap',
  'concat', 'slice', 'splice', 'indexOf', 'lastIndexOf', 'includes', 'join',
  'find', 'findIndex', 'some', 'every', 'sort', 'reverse', 'push',
  'replace', 'replaceAll', 'trim', 'split', 'startsWith', 'endsWith',
  'substring', 'toLowerCase', 'toUpperCase', 'toString', 'valueOf',
  'keys', 'values', 'entries', 'hasOwnProperty', 'charAt', 'padStart',
  'padEnd', 'repeat', 'delete',
]);

// The four TS loop nodes (`for_in_statement` covers both for-of and for-in) —
// shared by the cyclomatic decision set and the cognitive surcharge set.
const TS_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
]);

// Cyclomatic decision nodes — VERIFIED against SonarJS source (S1541 rule.ts):
// each adds +1. `for_in_statement` covers both `for…of` and `for…in`;
// `switch_case` counts per non-default case label (the extractor's `switch_case`
// node corresponds to a SwitchCase WITH a test) while `switch_default` and the
// `switch_statement` container do NOT. `&&`/`||`/`??` count via the shared
// isCFamilyBooleanOperator. NOTE the deliberate omissions that match SonarJS but
// differ from the textbook set: `throw` and `catch` do NOT count (ThrowStatement
// / CatchClause are absent from SonarJS's cyclomatic switch); `else`/`finally`/
// `default` never count; logical-assignment `&&=`/`||=`/`??=` do NOT count.
const TS_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  ...TS_LOOP_NODE_TYPES,
  'if_statement',
  'switch_case',
  'ternary_expression',
]);

// COGNITIVE config — VERIFIED-EXACT against SonarJS S3776 (eslint-plugin-sonarjs
// `cjs/S3776/rule.js`, clean-room read + threshold-0 oracle), which differs
// MATERIALLY from sonar-java (do not assume the Java config transfers): see the
// boolean + JSX notes below. All node names AST-dumped against the bundled
// grammars. See complexity.ts + the project docs' "Cognitive Complexity Rules".
const TS_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  // tree-sitter-typescript wraps else/else-if in an `else_clause` node (UNLIKE
  // Java's direct `alternative`); the engine unwraps it. else-if = +1 flat.
  elseClauseType: 'else_clause',
  loopTypes: TS_LOOP_NODE_TYPES,
  // TS uses `switch_statement` (not Java's `switch_expression`); the WHOLE switch
  // is +1 regardless of case count (the cognitive/cyclomatic divergence).
  switchTypes: new Set(['switch_statement']),
  ternaryType: 'ternary_expression',
  catchType: 'catch_clause',
  // EMPTY by design: nested functions/arrows are already in TS_SKIP_TYPES (the
  // cognitive walk's boundary prunes them), so each top-level fn / method /
  // arrow-const gets its OWN standalone cognitive number and nested-fn control
  // flow counts toward nobody — matching SonarJS's per-function report (an
  // extracted symbol's number == SonarJS's) and the TS cyclomatic arrow-callback
  // gap. Adding arrows here would double-count them into the encloser.
  nestOnlyTypes: new Set(),
  labeledJumpTypes: new Set(['break_statement', 'continue_statement']),
  // Read the `label` FIELD, not namedChildCount: an unlabeled `break /*c*/;`
  // carries a comment as a named child, so counting children would misread it as
  // labeled and add a spurious +1.
  hasLabel: (node) => node.childForFieldName('label') != null,
  // SonarJS counts ONLY maximal `&&` runs; `cFamilyBooleanOperatorKind` returns
  // the kind for `&&`/`||`/`??` so `||`/`??` stay in the source-order run as
  // breakers, and booleanRunStarts filters to `&&`-run-starts (`||`/`??` never
  // count). NB cyclomatic DOES count `||`/`??` — the expected cyc/cog divergence.
  booleanOperatorKind: cFamilyBooleanOperatorKind,
  booleanRunStarts: (kind, prev) => kind === '&&' && prev !== '&&',
  excludeBooleanRun: tsBooleanRunExcluded,
  parenthesizedType: 'parenthesized_expression',
};

// SonarJS S3776 excludes a UNIFORM-operator logical expression whose immediate
// parent is a JSX `{...}` container (`jsx_expression` — covers both JSX children
// and attribute values) from the cognitive count: `{cond && <X/>}` / `{a && b}` /
// `{foo() && bar()}` / `<div x={a && a}/>` all score 0 (oracle-confirmed). A
// MIXED-operator tree is NOT excluded (`{(a || b) && <X/>}` = 1). Mirrors the
// plugin's `flattenJsxShortCircuitNodes`: bail on a ternary or a different-operator
// logical node; recurse same-operator operands; any other leaf is fine.
function tsBooleanRunExcluded(root: Node): boolean {
  // Walk up through parenthesized_expression wrappers before the container test:
  // SonarJS runs on ESTree, which has no paren nodes, so a WHOLE-expression-
  // parenthesized short-circuit (`{(cond && <X/>)}`, a common conditional-render
  // idiom) sits DIRECTLY under the JSX container there and IS excluded. tree-sitter
  // keeps the paren node between them, so without this walk codedeep-mcp would over-count.
  let container = root.parent;
  while (container?.type === 'parenthesized_expression') container = container.parent;
  if (container?.type !== 'jsx_expression') return false;
  const rootOp = cFamilyBooleanOperatorKind(root);
  if (rootOp === null) return false;
  const uniform = (node: Node | null): boolean => {
    // Unwrap parens like the engine's skipParens (sonar's ESTree has no paren
    // nodes, so operands are the raw children).
    let n = node;
    while (n && n.type === 'parenthesized_expression') n = n.namedChild(0);
    if (!n) return true;
    if (n.type === 'ternary_expression') return false;
    const k = cFamilyBooleanOperatorKind(n);
    if (k === null) return true; // non-logical leaf
    if (k !== rootOp) return false; // different operator → not a JSX short-circuit
    return uniform(n.childForFieldName('left')) && uniform(n.childForFieldName('right'));
  };
  return uniform(root);
}

// Peels receiver wrappers that are transparent to receiver IDENTITY:
// `non_null_expression` (`a!`) and `parenthesized_expression` (`(a)`). The
// wrapped expression is the first NON-COMMENT named child (the `!` and parens are
// anonymous tokens; a leading inline comment — `(/*c*/ a)` — is a NAMED node, so
// skip it, the same comment-skip the Go receiver unwrap does), so `a!.x()` /
// `(a).x()` recover the inner `a`/`this` and resolve like `a.x()`. A genuinely
// chained receiver (`a.b().c()` → call_expression) is NOT a wrapper and is left
// intact → stays opaque.
function unwrapReceiver(node: Node): Node {
  let n = node;
  while (n.type === 'non_null_expression' || n.type === 'parenthesized_expression') {
    let inner = n.firstNamedChild;
    while (inner && inner.type === 'comment') inner = inner.nextNamedSibling;
    if (!inner) break;
    n = inner;
  }
  return n;
}

// `this.x()` / `obj.x()` carry their literal receiver token; a non-null `a!.x()`
// or parenthesized `(a).x()` receiver is unwrapped to that token too (so it
// resolves like `a.x()`). Genuinely chained or indexed receivers (`a.b().c()`,
// `arr[0].run()`) carry RECEIVER_OPAQUE so the called method stays findable by
// name (recall) but never resolves. `super.x()` (parent-class call) and
// computed-property calls (no clean property name, e.g. `foo()[k]()`) emit nothing.
function tsMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type !== 'member_expression') return null;
  const obj = callee.childForFieldName('object');
  const prop = callee.childForFieldName('property');
  if (!obj || !prop) return null;
  if (prop.type !== 'property_identifier' && prop.type !== 'private_property_identifier') {
    return null;
  }
  const recv = unwrapReceiver(obj);
  if (recv.type === 'this') return { receiver: 'this', property: prop.text, isSelf: true };
  if (recv.type === 'identifier') {
    return { receiver: recv.text, property: prop.text, isSelf: false };
  }
  if (recv.type === 'super') return null;
  return { receiver: RECEIVER_OPAQUE, property: prop.text, isSelf: false };
}

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

  const references = resolveCalls(
    bodies,
    tree.rootNode,
    symbols,
    fileInfo,
    TS_SELECTORS,
    TS_SKIP_TYPES,
    TS_FUNCTION_BODY_SKIP_TYPES,
    tsMemberCallInfo,
    { ignoredMemberCallees: TS_IGNORED_MEMBER_CALLEES },
  );
  computeComplexity(bodies, symbols, {
    decisionNodeTypes: TS_DECISION_NODE_TYPES,
    extraDecisionPredicate: isCFamilyBooleanOperator,
    skipTypes: TS_SKIP_TYPES,
    cognitive: TS_COGNITIVE_OPTIONS,
  });
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
      const classSym = makeSymbol(target, outer, declSignature(target, content), fileInfo, 'class', className, `${fileInfo.path}:${className}`, exported);
      outSymbols.push(classSym);
      const body = target.childForFieldName('body');
      if (!body) return;
      for (const member of body.namedChildren) {
        extractClassMember(member, content, fileInfo, className, exported, outSymbols, outBodies);
      }
      // Walk the class body itself so calls in static blocks and
      // non-callable field initializers (`static x = helper()`,
      // `field = helper()`) attribute to the class. TS_SKIP_TYPES
      // contains method_definition + function/arrow forms, so calls
      // inside member function bodies stay attributed to the member.
      outBodies.push({ symbolId: classSym.id, body, className });
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
    case 'enum_declaration': {
      // Covers `enum`, `const enum` (const modifier inside the node), and —
      // via the ambient_declaration recursion above — `declare enum`. Enum
      // MEMBERS are not extracted (extraction scope: top-level and
      // class-level declarations only).
      const name = target.childForFieldName('name')?.text;
      if (!name) return;
      outSymbols.push(
        makeSymbol(target, outer, declSignature(target, content), fileInfo, 'enum', name, `${fileInfo.path}:${name}`, exported),
      );
      return;
    }
    // Bare `namespace X {}` parses as expression_statement > internal_module
    // (grammar quirk); `export namespace` and `declare namespace` surface
    // internal_module directly via the declaration field / ambient recursion.
    case 'expression_statement': {
      const inner = target.firstNamedChild;
      if (inner && (inner.type === 'internal_module' || inner.type === 'module')) {
        extractTopLevel(inner, outer, content, fileInfo, exported, outSymbols, outImports, outBodies);
      }
      return;
    }
    case 'internal_module': // namespace X { … }
    case 'module': {        // module X { … } (legacy keyword)
      const nameNode = target.childForFieldName('name');
      // Simple identifiers only. A dotted `namespace A.B` (nested_identifier)
      // would put a '.' in the FQN and trip classNameFromFqn's member
      // parsing (isClassMember → true → dropped from file outlines), and a
      // string name (`declare module "pkg"`) names a package, not a symbol.
      // Declaration-only: namespace MEMBERS are not extracted this round —
      // a member FQN `file:Ns.fn` would collide with class-member semantics.
      if (nameNode?.type !== 'identifier') return;
      outSymbols.push(
        makeSymbol(target, outer, declSignature(target, content), fileInfo, 'module', nameNode.text, `${fileInfo.path}:${nameNode.text}`, exported),
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
      if (methodBody) {
        outBodies.push({ symbolId: methodSym.id, body: methodBody, className });
      }
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
        if (fnBody) {
          outBodies.push({ symbolId: fieldSym.id, body: fnBody, className });
        }
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
  const importedNames: ImportedName[] = [];
  // `import type { ... }` — the `type` token is an unnamed child of
  // import_statement, so it isn't surfaced via namedChildren.
  const wholeIsTypeOnly = hasTypeKeyword(stmt);

  for (const child of stmt.namedChildren) {
    if (child.type !== 'import_clause') continue;
    for (const item of child.namedChildren) {
      if (item.type === 'identifier') {
        const named: ImportedName = { name: IMPORT_DEFAULT, alias: item.text };
        if (wholeIsTypeOnly) named.kind = 'type';
        importedNames.push(named);
      } else if (item.type === 'namespace_import') {
        for (const nsChild of item.namedChildren) {
          if (nsChild.type !== 'identifier') continue;
          const named: ImportedName = { name: IMPORT_NAMESPACE, alias: nsChild.text };
          named.kind = wholeIsTypeOnly ? 'type' : 'namespace';
          importedNames.push(named);
        }
      } else if (item.type === 'named_imports') {
        for (const spec of item.namedChildren) {
          if (spec.type !== 'import_specifier') continue;
          const specName = spec.childForFieldName('name')?.text;
          if (!specName) continue;
          const specAlias = spec.childForFieldName('alias')?.text;
          const named: ImportedName = { name: specName };
          if (specAlias) named.alias = specAlias;
          // `import { type X, Y }` — per-specifier `type` keyword sits
          // as an unnamed child before the name identifier.
          if (wholeIsTypeOnly || hasTypeKeyword(spec)) named.kind = 'type';
          importedNames.push(named);
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

function hasTypeKeyword(node: Node): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'type') return true;
  }
  return false;
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
    // The id hashes the FULL signature; only the stored copy is capped —
    // otherwise overloads differing past the cap share an id (JG1).
    id: symbolId(fileInfo.path, name, kind, signature, qualifier),
    name,
    fqn,
    kind,
    file: fileInfo.path,
    startLine: decl.startPosition.row + 1,
    endLine: decl.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
    doc: extractDoc(docNode),
    exported,
    language: fileInfo.language,
  };
}


function variableSignature(declarator: Node, value: Node | null, content: string): string {
  if (value && (value.type === 'arrow_function' || value.type === 'function_expression')) {
    const body = value.childForFieldName('body');
    const sigEnd = body ? body.startIndex : declarator.endIndex;
    let sig = normalizeSignature(content.slice(declarator.startIndex, sigEnd));
    if (value.type === 'arrow_function') sig = sig.replace(/=>\s*$/, '').trimEnd();
    return sig;
  }
  return normalizeSignature(content.slice(declarator.startIndex, declarator.endIndex));
}

function extractDoc(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (!prev || prev.type !== 'comment') return null;
  return commentDocLine(prev.text);
}
