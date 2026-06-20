import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportedName, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  collectAmbiguousTypeNames,
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
import { cFamilyBooleanOperatorKind, computeComplexity, isCFamilyBooleanOperator } from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Function-like nodes whose bodies contain calls that shouldn't attribute
// to an enclosing body. lambda_expression is deliberately absent: Java
// lambdas can never be symbols of their own (unlike TS arrows assigned to
// consts), so pruning them would drop their calls entirely — calls inside
// `x -> f(x)` attribute to the enclosing method instead. A documented
// divergence from the TS arrow rule.
const JAVA_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);

const JAVA_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...JAVA_FUNCTION_BODY_SKIP_TYPES,
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
  // Anonymous classes: object_creation_expression carries a field-less
  // class_body child; pruning keeps anonymous internals (including field
  // initializers) out of every walk. Harmless as a PendingBody root —
  // walkCalls never checks the root's own type, only children.
  'class_body',
]);

// The four Java loop nodes — shared by the cyclomatic decision set and the
// cognitive surcharge set.
const JAVA_LOOP_NODE_TYPES: ReadonlySet<string> = new Set([
  'for_statement',
  'enhanced_for_statement',
  'while_statement',
  'do_statement',
]);

// CYCLOMATIC decision nodes (sonar-java ComplexityVisitor, clean-room verified +
// oracled). Each adds +1. `switch_expression` (container), `catch`/`throw`/
// `finally`/`default`/plain break-continue, AND `lambda_expression` are
// deliberately absent; non-default `switch_label` and `&&`/`||` come via the
// javaCyclomaticExtra predicate. LAMBDAS are excluded entirely from a METHOD's
// cyclomatic number: sonar-java's ComplexityVisitor, when its root is the method,
// counts neither the lambda arrow nor the lambda body (a lambda is a separate
// unit) — confirmed by the oracle diff (counting them over-reported every
// lambda-bearing method). See JAVA_CYCLOMATIC_SKIP_TYPES below; cognitive still
// DESCENDS lambdas (with a nesting bump), the metric asymmetry.
const JAVA_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  ...JAVA_LOOP_NODE_TYPES,
  'if_statement',
  'ternary_expression',
]);

// Cyclomatic-only skip set: JAVA_SKIP_TYPES plus `lambda_expression`, so a
// lambda's arrow + body are excluded from the enclosing method's cyclomatic
// number (sonar's per-method behavior). NOT added to JAVA_SKIP_TYPES itself —
// that set is shared with resolveCalls (which attributes lambda calls to the
// method) and with the cognitive walk (which descends lambdas).
const JAVA_CYCLOMATIC_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...JAVA_SKIP_TYPES,
  'lambda_expression',
]);

// The "+1 per node" cyclomatic cases a flat type set can't express, composed
// into the engine's `extraDecisionPredicate` slot:
// (1) a NON-DEFAULT `switch_label` — a `default` label has zero named children
// (just the keyword token), a `case X`/`case X,Y` label has ≥1; this counts each
// case label like sonar-java's CASE_LABEL, default excluded; (2) the C-family
// `&&`/`||` (one binary_expression node for all operators — read the op token).
function javaCyclomaticExtra(node: Node): boolean {
  if (node.type === 'switch_label') return node.namedChildCount > 0;
  return isCFamilyBooleanOperator(node);
}

// COGNITIVE config (sonar-java CognitiveComplexityVisitor, clean-room verified;
// all node names AST-dumped against the bundled grammar). See complexity.ts.
const JAVA_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  loopTypes: JAVA_LOOP_NODE_TYPES,
  // Colon AND Java-14 arrow switch are BOTH `switch_expression` (no
  // `switch_statement` node); the whole switch is +1 regardless of case count.
  switchTypes: new Set(['switch_expression']),
  ternaryType: 'ternary_expression',
  // Catch is recognized by its own node type, so this covers BOTH plain
  // `try_statement` and `try_with_resources_statement` for free.
  catchType: 'catch_clause',
  // Lambdas raise nesting but add nothing (NOT "+1 hybrid").
  nestOnlyTypes: new Set(['lambda_expression']),
  labeledJumpTypes: new Set(['break_statement', 'continue_statement']),
  // A break/continue's only named child is its optional label identifier.
  hasLabel: (node) => node.namedChildCount > 0,
  // Java has `&&`/`||` (no `??`); reuse the shared C-family token reader.
  booleanOperatorKind: (node) => {
    const op = cFamilyBooleanOperatorKind(node);
    return op === '&&' || op === '||' ? op : null;
  },
  parenthesizedType: 'parenthesized_expression',
};

// `object_creation_expression`'s callee is a type_identifier, never a plain
// identifier — without this, every `new X()` ref would be dropped.
const JAVA_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier', 'type_identifier']);

// A bare `foo()` in Java is ALWAYS a method call — fields and classes are
// never bare-callable — so identifier callees bind only through the
// enclosing-class fallback, never the callable-name map.
const JAVA_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set();

// `new X()` binds to classes (records included) and interfaces — anonymous
// implementations (`new Iface() { ... }`) are real instantiation sites.
// Enums can't be instantiated, so they stay out.
const JAVA_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class', 'interface']);

// Type kinds sharing the simple-name FQN namespace — duplicates among these
// are excluded from extract-time resolution (collectAmbiguousTypeNames).
const JAVA_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'enum']);

const JAVA_SELECTORS: ReadonlyArray<CallSelector> = [
  // method_invocation has no single callee field: bare calls expose only
  // `name:`, member calls `object:` + `name:`. Return the node itself for
  // the member form so javaMemberCallInfo can read both fields.
  {
    nodeType: 'method_invocation',
    getCallee: (n) => (n.childForFieldName('object') ? n : n.childForFieldName('name')),
  },
  { nodeType: 'object_creation_expression', getCallee: objectCreationCallee },
];

// Symbol kinds for the five type-declaration node types; doubles as the
// "is this a type declaration" test during body iteration.
const TYPE_KIND: Record<string, SymbolKind> = {
  class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  record_declaration: 'class',
  annotation_type_declaration: 'interface',
};

// `new Widget()` → type_identifier (bare path, binds to the class symbol);
// `new ArrayList<String>()` → generic_type wrapping the real type;
// `new pkg.Thing()` / `new Outer.Inner()` → scoped_type_identifier
// (member path, single level only).
function objectCreationCallee(node: Node): Node | null {
  let type = node.childForFieldName('type');
  if (type?.type === 'generic_type') type = type.firstNamedChild;
  if (!type) return null;
  if (type.type === 'type_identifier' || type.type === 'scoped_type_identifier') return type;
  return null;
}

function isComment(node: Node): boolean {
  return node.type === 'line_comment' || node.type === 'block_comment';
}

// Dominant Java stdlib/collection/stream/string method names (>=4 chars)
// suppressed when a member call to them is unresolved — capturing chained
// calls otherwise floods the name-keyed store with `.stream().filter()`-style
// noise. Domain method names are deliberately absent. <=3-char names (`.add`,
// `.get`, `.put`) are gated downstream by SHORT_NAME_THRESHOLD.
const JAVA_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'stream', 'filter', 'collect', 'forEach', 'flatMap', 'reduce', 'sorted',
  'distinct', 'limit', 'count', 'anyMatch', 'allMatch', 'noneMatch',
  'findFirst', 'findAny', 'toList', 'toArray', 'contains', 'containsKey',
  'containsValue', 'isEmpty', 'remove', 'clear', 'size', 'keySet', 'values',
  'entrySet', 'iterator', 'hasNext', 'append', 'toString', 'equals',
  'hashCode', 'length', 'substring', 'indexOf', 'replace', 'trim', 'split',
  'startsWith', 'endsWith', 'charAt', 'matches', 'format', 'valueOf',
  'getOrDefault', 'putIfAbsent', 'orElse', 'orElseGet', 'orElseThrow',
  'isPresent', 'ifPresent', 'getClass', 'println', 'print', 'printf',
]);

// Peels transparent receiver wrappers off a member-call receiver so a wrapped
// receiver resolves like the bare form: parenthesized `(a).m()` and the classic
// downcast `((T)a).m()` (a `cast_expression` whose operand is its `value` field
// — Java has no force-unwrap operator, so the cast is its analog). Leading
// comment nodes inside the parens are skipped via isComment (tree-sitter-java
// names them `line_comment`/`block_comment`, never `comment`). Each step
// strictly descends a finite tree, so the loop always terminates.
function unwrapJavaReceiver(node: Node): Node {
  let n = node;
  for (;;) {
    if (n.type === 'parenthesized_expression') {
      let inner = n.firstNamedChild;
      while (inner && isComment(inner)) inner = inner.nextNamedSibling;
      if (!inner) break;
      n = inner;
    } else if (n.type === 'cast_expression') {
      const inner = n.childForFieldName('value');
      if (!inner) break;
      n = inner;
    } else break;
  }
  return n;
}

// `this.x()` and `obj.x()` carry their literal receiver token; chained and
// computed receivers (`a.b.c()`, `System.out.println()`, `foo().bar()`) carry
// RECEIVER_OPAQUE so the called method stays findable by name (recall) but
// never resolves. `super.x()` (object is a `super` node — the grammar has no
// super_method_invocation) and computed (non-`identifier` name) emit nothing.
function javaMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'method_invocation') {
    const rawObj = callee.childForFieldName('object');
    const prop = callee.childForFieldName('name');
    if (!rawObj || !prop || prop.type !== 'identifier') return null;
    // Unwrap parens/cast first so `(a).m()` and `((T)a).m()` resolve like
    // `a.m()`. The super-drop is checked AFTER the unwrap so a super receiver
    // is dropped regardless of wrapping — a bare `super` is the only real case
    // (`(super)` / `((T)super)` are illegal Java and error-parse to a method
    // call whose object is already a bare `super`).
    const obj = unwrapJavaReceiver(rawObj);
    if (obj.type === 'this') return { receiver: 'this', property: prop.text, isSelf: true };
    if (obj.type === 'identifier') {
      return { receiver: obj.text, property: prop.text, isSelf: false };
    }
    if (obj.type === 'super') return null;
    return { receiver: RECEIVER_OPAQUE, property: prop.text, isSelf: false };
  }
  if (callee.type === 'scoped_type_identifier') {
    // Positional children, no fields — and comments are NAMED extras that
    // can sit between the two type_identifiers, so filter them out before
    // indexing. Deeper qualification nests another scoped_type_identifier
    // in slot 0 and is skipped (chained analog).
    const parts = callee.namedChildren.filter((c) => !isComment(c));
    const scope = parts[0];
    const name = parts[1];
    if (scope?.type !== 'type_identifier' || name?.type !== 'type_identifier') return null;
    return { receiver: scope.text, property: name.text, isSelf: false };
  }
  return null;
}

export function extractJava(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const bodies: PendingBody[] = [];

  for (const child of tree.rootNode.namedChildren) {
    if (child.type === 'import_declaration') {
      extractImport(child, fileInfo, imports);
    } else if (TYPE_KIND[child.type] !== undefined) {
      extractType(child, content, fileInfo, '', true, false, symbols, bodies);
    }
    // package_declaration, comments, module_declaration — no symbols.
  }

  // Two same-named types in one file (e.g. a `Builder` under two different
  // outers) share the simple-name FQN; resolving through them first-wins
  // would bind calls to the WRONG class, so their names are excluded from
  // extract-time resolution entirely (calls stay unresolved instead).
  const ambiguousTypeNames = collectAmbiguousTypeNames(symbols, JAVA_TYPE_KINDS);

  const references = resolveCalls(
    bodies,
    tree.rootNode,
    symbols,
    fileInfo,
    JAVA_SELECTORS,
    JAVA_SKIP_TYPES,
    JAVA_FUNCTION_BODY_SKIP_TYPES,
    javaMemberCallInfo,
    // Implicit this: a bare `foo()` inside a class body is a method call on
    // the enclosing class (Java has no top-level functions), so bare calls
    // resolve against the enclosing class's methods and nothing else.
    {
      bareCalleeTypes: JAVA_BARE_CALLEE_TYPES,
      bareCallsBindToEnclosingClass: true,
      bareCallableKinds: JAVA_BARE_CALLABLE_KINDS,
      constructorKinds: JAVA_CONSTRUCTOR_KINDS,
      ambiguousClassNames: ambiguousTypeNames,
      ignoredMemberCallees: JAVA_IGNORED_MEMBER_CALLEES,
    },
  );
  computeComplexity(bodies, symbols, {
    decisionNodeTypes: JAVA_DECISION_NODE_TYPES,
    extraDecisionPredicate: javaCyclomaticExtra,
    skipTypes: JAVA_SKIP_TYPES,
    cyclomaticSkipTypes: JAVA_CYCLOMATIC_SKIP_TYPES,
    cognitive: JAVA_COGNITIVE_OPTIONS,
  });
  return { symbols, references, imports };
}

// Extracts a type declaration and recurses through its body. Recursion only
// ever enters type bodies (class/interface/enum) — local classes inside
// method blocks and anonymous classes are never reached, which implements
// the "top-level and class-level only" scope rule structurally.
function extractType(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  qualifier: string,
  containerExported: boolean,
  inInterface: boolean,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const kind = TYPE_KIND[decl.type];
  const mods = findModifiers(decl);
  // Member types of interfaces are implicitly public (JLS 9.5 — and unlike
  // methods, they can't be declared private).
  const exported = containerExported && (inInterface || hasModifier(mods, 'public', 'protected'));
  // Nested types keep a simple-name FQN (`file:Inner` — a deeper dotted FQN
  // would trip classNameFromFqn's member parsing); the enclosing chain goes
  // into the hashed qualifier instead, so same-named nested types in one
  // file keep distinct ids.
  const sym = makeJavaSymbol(
    decl,
    javaSignature(decl, content, mods),
    fileInfo,
    kind,
    name,
    `${fileInfo.path}:${name}`,
    exported,
    qualifier,
  );
  outSymbols.push(sym);

  // @interface is declaration-only: elements mirror the enum-constant
  // exclusion, and annotation bodies carry no executable code.
  if (decl.type === 'annotation_type_declaration') return;
  const body = decl.childForFieldName('body');
  if (!body) return;

  // Walk the type body as the type's own PendingBody: field initializers,
  // static/instance initializer blocks, and enum constant arguments
  // (`RED(2)`) attribute to the type symbol. JAVA_SKIP_TYPES keeps
  // method-body calls attributed to the methods.
  outBodies.push({ symbolId: sym.id, body, className: name });

  const memberQualifier = qualifier ? `${qualifier}.${name}` : name;
  const isInterfaceBody = decl.type === 'interface_declaration';
  // Enum members hide one level deeper: enum_body holds enum_constants plus
  // an enum_body_declarations section after the `;`. Constants are never
  // symbols (the enum-member rule); constant bodies (`BLUE { ... }`) are
  // class_body nodes pruned like anonymous classes.
  const members = decl.type === 'enum_declaration' ? enumMemberNodes(body) : body.namedChildren;
  for (const member of members) {
    if (TYPE_KIND[member.type] !== undefined) {
      extractType(member, content, fileInfo, memberQualifier, exported, isInterfaceBody, outSymbols, outBodies);
    } else {
      extractMember(member, content, fileInfo, name, memberQualifier, exported, isInterfaceBody, outSymbols, outBodies);
    }
  }
}

function enumMemberNodes(enumBody: Node): readonly Node[] {
  for (const child of enumBody.namedChildren) {
    if (child.type === 'enum_body_declarations') return child.namedChildren;
  }
  return [];
}

function extractMember(
  member: Node,
  content: string,
  fileInfo: FileInfo,
  className: string,
  qualifier: string,
  containerExported: boolean,
  inInterface: boolean,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  // Interface members are implicitly public — except explicitly `private`
  // ones (legal on interface methods since Java 9). Elsewhere a member is
  // exported only when it carries its own public/protected modifier AND
  // every enclosing type is exported.
  const mods = findModifiers(member);
  const exported =
    containerExported &&
    (inInterface ? !hasModifier(mods, 'private') : hasModifier(mods, 'public', 'protected'));

  switch (member.type) {
    case 'method_declaration': {
      const methodName = member.childForFieldName('name')?.text;
      if (!methodName) return;
      extractCallable(member, methodName, content, fileInfo, className, qualifier, exported, mods, outSymbols, outBodies);
      return;
    }
    case 'constructor_declaration':
    case 'compact_constructor_declaration': {
      // Named `constructor` per the established convention (FQN
      // `file:Class.constructor`) — the AST name field repeats the class
      // name, which would pair a same-named method with the class symbol in
      // every lookup. `new C()` refs bind to the CLASS symbol instead.
      extractCallable(member, 'constructor', content, fileInfo, className, qualifier, exported, mods, outSymbols, outBodies);
      return;
    }
    case 'field_declaration':
    case 'constant_declaration': {
      // constant_declaration is the interface-constant variant — a distinct
      // node type with the same internal shape. One field_declaration can
      // carry multiple declarator: fields (`int a = 1, b;`) — one symbol per
      // variable_declarator; the shared signature is fine, ids differ by name.
      const signature = normalizeSignature(
        content.slice(signatureStart(member, mods), member.endIndex).replace(/;\s*$/, ''),
      );
      for (const declarator of member.childrenForFieldName('declarator')) {
        if (declarator?.type !== 'variable_declarator') continue;
        const fieldName = declarator.childForFieldName('name')?.text;
        if (!fieldName) continue;
        outSymbols.push(
          makeJavaSymbol(
            member,
            signature,
            fileInfo,
            'variable',
            fieldName,
            `${fileInfo.path}:${className}.${fieldName}`,
            exported,
            qualifier,
          ),
        );
      }
      return;
    }
    // static_initializer, enum constants, annotation elements, stray `;` —
    // no symbol; initializer-block calls attribute via the type-body walk.
    default:
      return;
  }
}

function extractCallable(
  member: Node,
  symName: string,
  content: string,
  fileInfo: FileInfo,
  className: string,
  qualifier: string,
  exported: boolean,
  mods: Node | null,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const sym = makeJavaSymbol(
    member,
    javaSignature(member, content, mods),
    fileInfo,
    'method',
    symName,
    `${fileInfo.path}:${className}.${symName}`,
    exported,
    qualifier,
  );
  outSymbols.push(sym);
  // The body field is `block` for methods and compact record constructors
  // but `constructor_body` for constructors; abstract/interface methods
  // have none (the symbol is still extracted, mirroring TS signatures).
  const body = member.childForFieldName('body');
  if (body) outBodies.push({ symbolId: sym.id, body, className });
}

function extractImport(stmt: Node, fileInfo: FileInfo, out: ImportInfo[]): void {
  // Payload is a scoped_identifier (fields scope:/name:) or a bare
  // identifier; wildcard imports add a named `asterisk` child. The `static`
  // keyword is an anonymous token and needs no special handling — the
  // scope/name split already yields `a.b.C` + `m` for static imports.
  let payload: Node | null = null;
  let wildcard = false;
  for (const child of stmt.namedChildren) {
    if (child.type === 'scoped_identifier' || child.type === 'identifier') payload = child;
    else if (child.type === 'asterisk') wildcard = true;
  }
  if (!payload) return;

  let sourceModule: string;
  const importedNames: ImportedName[] = [];
  if (wildcard) {
    sourceModule = payload.text;
    importedNames.push({ name: IMPORT_NAMESPACE });
  } else if (payload.type === 'scoped_identifier') {
    const nameNode = payload.childForFieldName('name');
    if (!nameNode) return;
    sourceModule = payload.childForFieldName('scope')?.text ?? '';
    importedNames.push({ name: nameNode.text });
  } else {
    // Bare `import Foo;` — default-package import, rare/legacy.
    sourceModule = payload.text;
    importedNames.push({ name: payload.text });
  }

  out.push({
    file: fileInfo.path,
    sourceModule,
    importedNames,
    line: stmt.startPosition.row + 1,
  });
}

function makeJavaSymbol(
  decl: Node,
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
    // otherwise overloads differing past the cap share an id (JG1: rxjava's
    // 10 `just` overloads collapsed to 5 ids).
    id: symbolId(fileInfo.path, name, kind, signature, qualifier),
    name,
    fqn,
    kind,
    file: fileInfo.path,
    // Annotations live inside the declaration node (its modifiers child),
    // so startLine is the first annotation's line — same as Python's
    // decorated_definition range.
    startLine: decl.startPosition.row + 1,
    endLine: decl.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
    doc: extractJavaDoc(decl),
    exported,
    language: fileInfo.language,
  };
}

// `modifiers` is a named CHILD, not a field — childForFieldName('modifiers')
// returns null despite "modifiers" appearing in the grammar's field table.
// Absent entirely on modifier-less declarations, so never address children
// by index. Each declaration finds its modifiers ONCE and threads the node
// through the exported/signature helpers.
function findModifiers(decl: Node): Node | null {
  for (const child of decl.namedChildren) {
    if (child.type === 'modifiers') return child;
  }
  return null;
}

// Keyword tokens inside `modifiers` are anonymous children whose type IS the
// literal text; annotations are named marker_annotation/annotation children.
function hasModifier(mods: Node | null, ...wanted: string[]): boolean {
  if (!mods) return false;
  for (const child of mods.children) {
    if (child && wanted.includes(child.type)) return true;
  }
  return false;
}

// Signature runs from the first non-annotation modifier token (or the
// declaration start) to the body start. Annotations are excluded — unlike
// Python's decorators-in-signature — because Spring/JUnit annotation blocks
// routinely exceed the 120-char cap, which would truncate the declaration
// proper out of the display and let same-name overloads collide on
// identical truncated signatures (= identical symbol ids). Body-less
// callables (abstract/interface methods) run to the declaration end with
// the trailing `;` stripped, matching the field path.
function javaSignature(decl: Node, content: string, mods: Node | null): string {
  const body = decl.childForFieldName('body');
  const raw = body
    ? content.slice(signatureStart(decl, mods), body.startIndex)
    : content.slice(signatureStart(decl, mods), decl.endIndex).replace(/;\s*$/, '');
  return normalizeSignature(raw);
}

function signatureStart(decl: Node, mods: Node | null): number {
  if (!mods) return decl.startIndex;
  for (const child of mods.children) {
    if (!child || child.type === 'marker_annotation' || child.type === 'annotation' || isComment(child)) {
      continue;
    }
    return child.startIndex;
  }
  // All-annotation modifiers (`@Override void f()`): start past them.
  return mods.endIndex;
}

// Javadoc (and plain comments) precede the declaration as named
// block_comment/line_comment siblings — annotations don't break adjacency
// because they live inside the declaration's modifiers child.
function extractJavaDoc(decl: Node): string | null {
  const prev = decl.previousNamedSibling;
  if (!prev || !isComment(prev)) return null;
  // A comment trailing an earlier statement on its own line is not doc for
  // the next declaration.
  if (isTrailingComment(prev)) return null;
  return commentDocLine(prev.text);
}
