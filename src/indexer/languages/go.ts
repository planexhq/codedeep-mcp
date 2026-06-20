import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportedName, ImportInfo, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
  collectAmbiguousTypeNames,
  commentDocLine,
  declSignature,
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
import {
  cFamilyBooleanOperatorKind,
  computeComplexity,
  isCFamilyBooleanOperator,
} from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Function-like nodes whose bodies contain calls that shouldn't attribute
// to an enclosing body. func_literal is deliberately absent (the Java
// lambda rule, not the TS arrow rule): an anonymous literal can never be a
// symbol, so calls inside `go func() { f() }()` attribute to the enclosing
// function. The one literal that IS a symbol — `var f = func() {...}` —
// still attributes correctly because its body is walked as f's own
// PendingBody first and the seen-set drops the moduleRoot duplicate.
const GO_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'method_declaration',
]);

// Same set: Go has no class-body analog to skip (type bodies carry no
// executable code), and function/method declarations can't even nest —
// the entries are parse-error tolerance, mirroring Java's structure.
const GO_SKIP_TYPES: ReadonlySet<string> = GO_FUNCTION_BODY_SKIP_TYPES;

// `composite_literal`'s callee is a type_identifier, never a plain
// identifier — without this, every `Server{}` ref would be dropped.
const GO_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier', 'type_identifier']);

// A bare `foo()` binds to top-level functions only (incl. `var f = func()`
// promotions). Type conversions parse as identical call_expressions
// (`MyInt(3)`), so type/class/variable kinds stay out — a conversion is
// emitted as an unresolved name-keyed ref, never a confidently-wrong edge.
const GO_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function']);

// Composite literals bind to structs and to named non-struct types
// (`type Pairs map[string]int; Pairs{...}`). 'type' matters: unresolved
// refs to 'type'-kind symbols are rejected at query time (NON_CALLABLE),
// so without it those literals would be invisible. Interfaces stay out —
// they cannot be composite-literal constructed.
const GO_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class', 'type']);

// Symbol kinds whose names share the simple-name FQN namespace — duplicates
// among these are excluded from extract-time call resolution. (struct→class,
// interface→interface, defined/alias→type.)
const GO_TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'type']);

// Predeclared builtins are package-less bare names; unresolved calls to
// them would flood the name-keyed reference store. The set also covers the
// predeclared TYPE names: a conversion `string(b)` / `int64(n)` parses as a
// call_expression with an identifier callee, identical to a builtin call,
// so without these every conversion site would persist a junk ref. Resolved
// calls escape the filter (see ignoredBareCallees), so a file-local
// `clear()` / pre-1.21 `max()` — or a user type shadowing a predeclared
// name — keeps its refs.
const GO_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  // builtin functions
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag',
  'len', 'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real',
  'recover',
  // predeclared types (conversion callees)
  'bool', 'byte', 'rune', 'string', 'error', 'any', 'uintptr',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64',
  'float32', 'float64', 'complex64', 'complex128',
]);

const GO_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call_expression', getCallee: (n) => n.childForFieldName('function') },
  { nodeType: 'composite_literal', getCallee: compositeLiteralCallee },
];

// `Server{}` → type_identifier (bare constructor-form, binds via
// constructorKinds); `Pair[K, V]{}` → generic_type wrapping the real type;
// `pkg.Config{}` → qualified_type (member path). Slice/map/array literal
// types (`[]Server{...}`) return null — the element type is buried and the
// inner typed literals fire their own selectors.
function compositeLiteralCallee(node: Node): Node | null {
  let type = node.childForFieldName('type');
  if (type?.type === 'generic_type') type = type.childForFieldName('type');
  if (!type) return null;
  if (type.type === 'type_identifier' || type.type === 'qualified_type') return type;
  return null;
}

// Go member suppression is EMPTY by design. The ignoredMemberCallees gate keys
// on the PROPERTY NAME alone (extractor.ts), never the receiver — so suppressing
// a stdlib-looking name (Println/String/Write) would ALSO drop the legitimate
// package-qualified call that shares it, and package-qualified calls
// (`fmt.Println`, `strings.Join`) are the dominant RESOLVABLE Go cross-file
// pattern. The two forms DO differ by receiver — `fmt.Println` keeps receiver
// `fmt`, only chained `x.fmt().Println()` goes opaque — but the property-keyed
// gate can't exploit that, so any non-empty set sacrifices the resolved
// package-qualified refs. Chained opaque refs to hot names (String/Close/Write,
// all >=4 chars) are therefore NOT suppressed: they stay tier-5 weak member
// rows, display-capped (WEAK_MEMBER_ROW_CAP) — recall over precision, the
// documented Go tradeoff. (Only <=3-char names are gated by SHORT_NAME_THRESHOLD.)
const GO_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set<string>();

// Cyclomatic decision nodes — Probe's convention, since Go is undocumented by
// SonarQube. `for_statement` is Go's ONLY loop node (covers 3-clause, range, and
// infinite forms). All THREE switch arms count — `expression_case`, `type_case`,
// AND `communication_case` (select) — while the switch CONTAINERS and
// `default_case` do NOT. Go has no ternary/`while`/`catch`. `&&`/`||` count via
// the shared isCFamilyBooleanOperator. Closures (`func_literal`) are descended
// (GO_SKIP_TYPES omits them), so a closure's branches count toward the enclosing
// func. VERIFIED divergences from the two reference tools (which disagree with
// each other): sonar-go DROPS select-`case`s (its Go→SLANG converter maps select
// CommClauses to nil, so they never count) — Probe counts them as genuine
// branches, matching gocyclo. gocyclo, conversely, counts `default` and every
// case incl. select — Probe excludes `default` (the SonarQube/McCabe convention),
// matching sonar-go on that point. So Probe = "count each non-default case of all
// three switch forms," a deliberate hybrid of the two.
const GO_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement',
  'expression_case',
  'type_case',
  'communication_case',
]);

// Cognitive-complexity config — gocognit-aligned (uudashr/gocognit, gocyclo's
// cognitive sibling), the same convention call the cyclomatic side made for
// gocyclo. ORACLE-VERIFIED EXACT against gocognit v1.2.1: 376/376 functions on
// spf13/cobra (157) + gin-gonic/gin (213) + a synthetic edge-case fixture (6).
// gocognit's nesting math is the shared whitepaper algorithm, but it DIVERGES
// from sonar-java (the engine default) in FOUR oracle-confirmed ways — each
// handled here without touching Java/TS:
//   1. nestElseBody:false — a plain `else { … }` body stays at the if's BASE
//      nesting (gocognit decNesting's after the then-body), vs sonar's nesting+1.
//   2. initField — the `if x := f(); cond {}` init is walked (gocognit), where
//      Go's `if err := recurse(); err != nil` idiom hides the recursive call.
//   3. parenthesizedType sentinel — gocognit does NOT unwrap parens in a boolean
//      chain, so `(a&&b)&&c` = 2 (the inner && is its own run), not sonar's 1.
//   4. recursion — +1 per bare self-call site (gocognit counts direct recursion;
//      sonar-java/SonarJS don't). function-only (methods self-call via selector).
// The 3 switch forms + select are each whole-switch +1 (cases add nothing — the
// cognitive/cyclomatic divergence, since GO_DECISION_NODE_TYPES counts each
// case). `for_statement` is Go's only loop; `func_literal` raises nesting (+0),
// matching the cyclomatic side which also descends closures (gocyclo-aligned).
// RESIDUAL DIVERGENCE (rare, deferred — the only place Probe ≠ gocognit on Go):
// the engine's loop/switch branch bumps nesting for ALL children incl. the
// HEADER, while gocognit walks a for-clause (init/cond/post) and a switch/select
// init/tag at BASE nesting (incNesting runs only before the body). `initField`
// fixes this for the `if` header but the for/switch/select header still
// overbumps a nested STRUCTURAL construct (a closure-with-control-flow in a
// loop/switch header) — `if`-init vs for/switch-init asymmetry. Booleans in a
// header are flat (unaffected). 0 cases in the 376-fn oracle; this is the Go
// aperture of the pre-existing, accepted loop-header overbump (complexity.ts
// "KNOWN DIVERGENCE" note), shared with Java/TS and deferred to a dedicated
// engine pass (per-construct body fields + re-oracling Java).
const GO_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  // `if x := f(); cond {}` — walked at base nesting (gocognit walks if.Init).
  initField: 'initializer',
  // Go holds `alternative` as the if/block directly (Java-style) — no wrapper.
  // Terminal `else` body stays at base nesting (gocognit ≠ sonar's nesting+1).
  nestElseBody: false,
  loopTypes: new Set(['for_statement']),
  switchTypes: new Set([
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
  ]),
  // Go has no ternary nor try/catch — sentinels that never match a real node.
  ternaryType: '__go_no_ternary__',
  catchType: '__go_no_catch__',
  // Closures raise nesting and roll their control flow into the enclosing func
  // (gocognit's FuncLit rule; the cyclomatic side descends them too).
  nestOnlyTypes: new Set(['func_literal']),
  // break/continue (optionally labeled) + goto (always labeled). Labels are a
  // positional `label_name` named child, NOT a field — so detect by child type
  // (robust to interleaved comments, unlike a positional namedChild check).
  labeledJumpTypes: new Set(['break_statement', 'continue_statement', 'goto_statement']),
  hasLabel: (n) => n.namedChildren.some((c) => c?.type === 'label_name'),
  // `&&`/`||` via the shared C-family reader (Go has no `??`). booleanRunStarts
  // unset → the default (+1 at every operator-kind change) matches gocognit's
  // `lastOp != op` exactly.
  booleanOperatorKind: cFamilyBooleanOperatorKind,
  // Sentinel: do NOT unwrap parens — gocognit's collectBinaryOps stops at a
  // parenthesized expression, so each parenthesized boolean is its own run.
  parenthesizedType: '__go_no_paren__',
  // Direct recursion (+1 per bare self-call site). Restricted to 'function'
  // (top-level funcs + `var f = func(){}`); a method self-call is `s.m()`, a
  // selector callee that bareCalleeName already returns null for.
  recursion: {
    callType: 'call_expression',
    bareCalleeName: (n) => {
      const callee = n.childForFieldName('function');
      return callee?.type === 'identifier' ? callee.text : null;
    },
    eligibleKinds: new Set(['function']),
  },
};

// `s.log()` and `pkg.Func()` carry their literal receiver token; chained and
// computed receivers (`s.conn.Close()`, `f().g()`, indexed) carry
// RECEIVER_OPAQUE so the called method stays findable by name (recall) but
// never resolves. A non-`field_identifier` field name emits nothing.
// Never returns isSelf — Go has no this/self token; selfness is decided
// in the engine by matching the receiver token against the enclosing
// method's PendingBody.selfReceiverName (opaque receivers never match it).
function goMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'selector_expression') {
    const field = callee.childForFieldName('field');
    if (field?.type !== 'field_identifier') return null;
    const operand = callee.childForFieldName('operand');
    if (operand?.type === 'identifier') {
      return { receiver: operand.text, property: field.text, isSelf: false };
    }
    // Chained/computed receiver (selector/call/index operand) → opaque. A
    // missing operand (only on a malformed/ERROR parse — valid Go selectors
    // always have one) emits nothing, preserving the pre-recall drop.
    if (!operand) return null;
    return { receiver: RECEIVER_OPAQUE, property: field.text, isSelf: false };
  }
  // Qualified composite literal `pkg.Config{}` — the constructor analog of
  // Java's `new pkg.Thing()` member path.
  if (callee.type === 'qualified_type') {
    const pkg = callee.childForFieldName('package');
    const name = callee.childForFieldName('name');
    if (!pkg || !name) return null;
    return { receiver: pkg.text, property: name.text, isSelf: false };
  }
  return null;
}

// Per-file duplicate-id disambiguation. Multiple `func init()` in one file
// are LEGAL Go and byte-identical in (name, kind, signature) — the only
// language where the full-signature hash (v7) still collides by
// construction. Repeats get an ordinal qualifier; ids shift only when an
// EARLIER duplicate is added/removed, which is the best line-free option.
type OccurrenceCounter = Map<string, number>;

export function extractGo(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const symbols: Symbol[] = [];
  const imports: ImportInfo[] = [];
  const bodies: PendingBody[] = [];
  const occurrences: OccurrenceCounter = new Map();

  for (const child of tree.rootNode.namedChildren) {
    switch (child.type) {
      case 'import_declaration':
        extractImport(child, fileInfo, imports);
        break;
      case 'function_declaration':
        extractFunction(child, content, fileInfo, occurrences, symbols, bodies);
        break;
      case 'method_declaration':
        extractMethod(child, content, fileInfo, occurrences, symbols, bodies);
        break;
      case 'type_declaration':
        extractTypeDeclaration(child, content, fileInfo, occurrences, symbols);
        break;
      case 'const_declaration':
        extractConstVar(child, 'const', content, fileInfo, occurrences, symbols, bodies);
        break;
      case 'var_declaration':
        extractConstVar(child, 'var', content, fileInfo, occurrences, symbols, bodies);
        break;
      // package_clause, comments — no symbols.
      default:
        break;
    }
  }

  // Same-file duplicate type names are invalid Go, so this only fires on
  // broken parses — where refusing resolution beats binding through a
  // half-parsed type (Java's nested-Builder rationale, kept as tolerance).
  const ambiguousTypeNames = collectAmbiguousTypeNames(symbols, GO_TYPE_KINDS);

  const references = resolveCalls(
    bodies,
    tree.rootNode,
    symbols,
    fileInfo,
    GO_SELECTORS,
    GO_SKIP_TYPES,
    GO_FUNCTION_BODY_SKIP_TYPES,
    goMemberCallInfo,
    {
      bareCalleeTypes: GO_BARE_CALLEE_TYPES,
      // A bare `foo()` in a method body is a package-level call — Go has
      // no implicit method receiver (the opposite of Java).
      bareCallsBindToEnclosingClass: false,
      bareCallableKinds: GO_BARE_CALLABLE_KINDS,
      constructorKinds: GO_CONSTRUCTOR_KINDS,
      ambiguousClassNames: ambiguousTypeNames,
      ignoredBareCallees: GO_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: GO_IGNORED_MEMBER_CALLEES,
    },
  );
  computeComplexity(bodies, symbols, {
    decisionNodeTypes: GO_DECISION_NODE_TYPES,
    extraDecisionPredicate: isCFamilyBooleanOperator,
    skipTypes: GO_SKIP_TYPES,
    cognitive: GO_COGNITIVE_OPTIONS,
  });
  return { symbols, references, imports };
}

function extractFunction(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const name = decl.childForFieldName('name')?.text;
  // `func _() { ... }` is legal Go — stringer/enumer emit one such
  // compile-time assertion per enum. The blank identifier is never a real
  // symbol; skip it as every other extraction path does.
  if (!name || name === '_') return;
  const sym = makeGoSymbol(
    decl,
    declSignature(decl, content),
    fileInfo,
    'function',
    name,
    `${fileInfo.path}:${name}`,
    isExportedName(name),
    goDoc(decl),
    occurrences,
  );
  outSymbols.push(sym);
  // Assembly stubs (`func Stub(x int) int` with the body in a .s file)
  // have no body field — the symbol is still extracted.
  const body = decl.childForFieldName('body');
  if (body) outBodies.push({ symbolId: sym.id, body });
}

function extractMethod(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  const name = decl.childForFieldName('name')?.text;
  // `func (s *T) _() {}` is legal (blank method); never a real symbol.
  if (!name || name === '_') return;
  const recv = receiverInfo(decl);
  if (!recv) return;
  // Exported by METHOD-name case only — an exported method on an
  // unexported type is reachable through interfaces and embedding
  // promotion, so the receiver type's case doesn't gate it.
  const sym = makeGoSymbol(
    decl,
    declSignature(decl, content),
    fileInfo,
    'method',
    name,
    // FQN uses the receiver base type as the "class" — slots straight
    // into classNameFromFqn/methodsByClass. The receiver type also goes
    // into the hashed qualifier: same-name same-signature methods on
    // different receivers already differ via the signature, but the
    // qualifier keeps the id stable if signatures ever normalize closer.
    `${fileInfo.path}:${recv.typeName}.${name}`,
    isExportedName(name),
    goDoc(decl),
    occurrences,
    recv.typeName,
  );
  outSymbols.push(sym);
  const body = decl.childForFieldName('body');
  if (body) {
    outBodies.push({
      symbolId: sym.id,
      body,
      className: recv.typeName,
      selfReceiverName: recv.varName,
    });
  }
}

// First named child that isn't a comment. pointer_type / parenthesized_type
// hold their wrapped type positionally, and tree-sitter-go attaches comments
// as named extras, so a naive firstNamedChild can return the comment.
function firstTypeChild(node: Node): Node | null {
  for (const child of node.namedChildren) {
    if (child && child.type !== 'comment') return child;
  }
  return null;
}

// Receiver base type and variable name. `func (s *Server)` → {Server, s};
// `func (S) f()` / `func (_ *S) f()` → varName undefined (no token can
// reference the receiver, so no self-call resolution either).
function receiverInfo(decl: Node): { typeName: string; varName?: string } | null {
  const receiver = decl.childForFieldName('receiver');
  const param = receiver?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  if (!param) return null;
  let type = param.childForFieldName('type');
  // `*Server` → pointer_type wrapping the real type (no field name);
  // `(T)` / `(*T)` → parenthesized_type (legal, if unusual, Go);
  // `List[T]` → generic_type with the base name in its `type` field.
  // Unwrap in any nesting order. pointer_type/parenthesized_type expose the
  // wrapped type positionally — comments are NAMED extras in tree-sitter-go,
  // so firstNamedChild can land on a comment (`* /*x*/ Server`) and silently
  // drop the whole method; skip them.
  for (;;) {
    if (type?.type === 'pointer_type' || type?.type === 'parenthesized_type') {
      type = firstTypeChild(type);
    } else if (type?.type === 'generic_type') {
      type = type.childForFieldName('type');
    } else {
      break;
    }
  }
  if (type?.type !== 'type_identifier') return null;
  const nameNode = param.childForFieldName('name');
  const varName = nameNode && nameNode.text !== '_' ? nameNode.text : undefined;
  return { typeName: type.text, varName };
}

// Symbol kinds for type_spec by the shape of its `type` field; anything
// that isn't a struct or interface (defined types, function types, map
// types...) is a plain 'type'.
function typeSpecKind(typeNode: Node | null): SymbolKind {
  if (typeNode?.type === 'struct_type') return 'class';
  if (typeNode?.type === 'interface_type') return 'interface';
  return 'type';
}

function extractTypeDeclaration(
  decl: Node,
  content: string,
  fileInfo: FileInfo,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  // Grouped `type ( A struct{...} ; B int )` puts the specs as direct
  // children; `type A = B` is a distinct type_alias node, same fields.
  const specs = decl.namedChildren.filter(
    (c): c is Node => c?.type === 'type_spec' || c?.type === 'type_alias',
  );
  for (const spec of specs) {
    const name = spec.childForFieldName('name')?.text;
    if (!name) continue;
    const typeNode = spec.childForFieldName('type');
    const kind = spec.type === 'type_alias' ? 'type' : typeSpecKind(typeNode);
    const exported = isExportedName(name);
    outSymbols.push(
      makeGoSymbol(
        spec,
        typeSpecSignature(spec, typeNode, content),
        fileInfo,
        kind,
        name,
        `${fileInfo.path}:${name}`,
        exported,
        // Ungrouped specs carry no preceding sibling inside the decl, so
        // the doc sits on the declaration; grouped specs document
        // individually (no group-comment fan-out — const/var rule).
        goDoc(spec) ?? (specs.length === 1 ? goDoc(decl) : null),
        occurrences,
      ),
    );
    // Type bodies carry no executable code (no field initializers in Go),
    // so unlike Java there is no type-body PendingBody.
    if (typeNode?.type === 'struct_type') {
      extractStructFields(typeNode, content, fileInfo, name, exported, occurrences, outSymbols);
    } else if (typeNode?.type === 'interface_type') {
      extractInterfaceMembers(typeNode, content, fileInfo, name, exported, occurrences, outSymbols);
    }
  }
}

function extractStructFields(
  structType: Node,
  content: string,
  fileInfo: FileInfo,
  typeName: string,
  typeExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  const list = structType.namedChildren.find((c) => c?.type === 'field_declaration_list');
  if (!list) return;
  for (const field of list.namedChildren) {
    if (field?.type !== 'field_declaration') continue;
    // Embedded fields (`io.Reader`, `*Conn`) have no name children — the
    // promoted members belong to the embedded type, not this struct.
    // Anonymous nested struct types are not recursed either (no FQN scheme
    // below one member level).
    const signature = normalizeSignature(field.text);
    const doc = goDoc(field);
    for (const nameNode of field.childrenForFieldName('name')) {
      const fieldName = nameNode?.text;
      if (!fieldName || fieldName === '_') continue;
      outSymbols.push(
        makeGoSymbol(
          field,
          signature,
          fileInfo,
          'variable',
          fieldName,
          `${fileInfo.path}:${typeName}.${fieldName}`,
          typeExported && isExportedName(fieldName),
          doc,
          occurrences,
          typeName,
        ),
      );
    }
  }
}

// Interface method specs are declaration-only members (Java-interface
// precedent): they populate methodsByClass under the interface name, so
// method expressions (`Shape.Area`) and same-named lookups resolve.
// Embedded interfaces and type-set elements (type_elem) carry no name of
// their own and are skipped.
function extractInterfaceMembers(
  ifaceType: Node,
  content: string,
  fileInfo: FileInfo,
  ifaceName: string,
  ifaceExported: boolean,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
): void {
  for (const member of ifaceType.namedChildren) {
    if (member?.type !== 'method_elem') continue;
    const name = member.childForFieldName('name')?.text;
    if (!name) continue;
    outSymbols.push(
      makeGoSymbol(
        member,
        normalizeSignature(member.text),
        fileInfo,
        'method',
        name,
        `${fileInfo.path}:${ifaceName}.${name}`,
        ifaceExported && isExportedName(name),
        goDoc(member),
        occurrences,
        ifaceName,
      ),
    );
  }
}

function extractConstVar(
  decl: Node,
  kindWord: 'const' | 'var',
  content: string,
  fileInfo: FileInfo,
  occurrences: OccurrenceCounter,
  outSymbols: Symbol[],
  outBodies: PendingBody[],
): void {
  // Spec collection handles the grammar's asymmetry: const_declaration
  // holds const_spec children DIRECTLY even when grouped, var_declaration
  // wraps grouped specs in a var_spec_list.
  const specs: Node[] = [];
  for (const child of decl.namedChildren) {
    if (!child) continue;
    if (child.type === 'const_spec' || child.type === 'var_spec') specs.push(child);
    else if (child.type === 'var_spec_list') {
      for (const inner of child.namedChildren) {
        if (inner?.type === 'var_spec') specs.push(inner);
      }
    }
  }

  for (const spec of specs) {
    // const_spec (unlike var_spec/field_declaration) puts the WHOLE name
    // list under the `name:` field, so the anonymous `,` tokens carry it
    // too — filter to identifiers or `const A, B = 1, 2` grows a phantom
    // symbol named ','.
    const nameNodes = spec
      .childrenForFieldName('name')
      .filter((n): n is Node => n?.type === 'identifier');
    const doc = goDoc(spec) ?? (specs.length === 1 ? goDoc(decl) : null);

    // `var f = func(...) ... { ... }` is a function symbol, mirroring the
    // TS arrow-const rule; its literal body becomes f's own PendingBody.
    // const can't hold a func value, and multi-name specs stay variables.
    if (kindWord === 'var' && nameNodes.length === 1) {
      const literal = singleFuncLiteralValue(spec);
      const name = nameNodes[0]?.text;
      if (literal && name && name !== '_') {
        const literalBody = literal.childForFieldName('body');
        const raw = literalBody
          ? content.slice(spec.startIndex, literalBody.startIndex)
          : spec.text;
        const sym = makeGoSymbol(
          spec,
          normalizeSignature(`${kindWord} ${raw}`),
          fileInfo,
          'function',
          name,
          `${fileInfo.path}:${name}`,
          isExportedName(name),
          doc,
          occurrences,
        );
        outSymbols.push(sym);
        if (literalBody) outBodies.push({ symbolId: sym.id, body: literalBody });
        continue;
      }
    }

    // One symbol per name (`var x, y = 1, 2` → two); the shared spec
    // signature is fine — ids differ by name (Java declarator precedent).
    const signature = normalizeSignature(`${kindWord} ${spec.text}`);
    for (const nameNode of nameNodes) {
      const name = nameNode.text;
      if (!name || name === '_') continue;
      outSymbols.push(
        makeGoSymbol(
          spec,
          signature,
          fileInfo,
          'variable',
          name,
          `${fileInfo.path}:${name}`,
          isExportedName(name),
          doc,
          occurrences,
        ),
      );
    }
  }
}

// The spec's value expression list when it is exactly one func_literal.
function singleFuncLiteralValue(spec: Node): Node | null {
  const value = spec.childForFieldName('value');
  if (!value) return null;
  const exprs = value.namedChildren;
  if (exprs.length !== 1) return null;
  return exprs[0]?.type === 'func_literal' ? exprs[0] : null;
}

function extractImport(decl: Node, fileInfo: FileInfo, out: ImportInfo[]): void {
  // Single import → import_spec direct child; grouped → import_spec_list.
  // One ImportInfo per spec keeps per-spec line attribution.
  const specs: Node[] = [];
  for (const child of decl.namedChildren) {
    if (child?.type === 'import_spec') specs.push(child);
    else if (child?.type === 'import_spec_list') {
      for (const inner of child.namedChildren) {
        if (inner?.type === 'import_spec') specs.push(inner);
      }
    }
  }
  for (const spec of specs) {
    const pathNode = spec.childForFieldName('path');
    if (!pathNode) continue;
    // interpreted_string_literal or raw_string_literal — strip the quotes.
    const sourceModule = pathNode.text.replace(/^["`]|["`]$/g, '');
    if (!sourceModule) continue;

    // Whole-package imports map to Python's `'module'` shape: the local
    // binding is the package name (or alias), members reach top-level
    // exports only. Dot imports ARE wildcard imports (`from x import *`),
    // and blank imports get an inert '_' binding (it can never be a
    // receiver or bare callee, so it matches nothing downstream).
    const nameNode = spec.childForFieldName('name');
    let imported: ImportedName;
    if (!nameNode) {
      imported = { name: defaultPackageName(sourceModule), kind: 'module' };
    } else if (nameNode.type === 'dot') {
      imported = { name: IMPORT_NAMESPACE };
    } else if (nameNode.text === '_') {
      imported = { name: '_', kind: 'module' };
    } else {
      imported = { name: defaultPackageName(sourceModule), alias: nameNode.text, kind: 'module' };
    }
    out.push({
      file: fileInfo.path,
      sourceModule,
      importedNames: [imported],
      line: spec.startPosition.row + 1,
    });
  }
}

// Best-effort package name from an import path. Wrong guesses fail open:
// a receiver that matches no import falls to the weak-include branch
// instead of being dropped.
function defaultPackageName(importPath: string): string {
  const segments = importPath.split('/');
  let last = segments[segments.length - 1] ?? importPath;
  // Module major-version suffix: `github.com/x/y/v2` → package y.
  if (/^v\d+$/.test(last) && segments.length > 1) {
    last = segments[segments.length - 2] ?? last;
  }
  // gopkg.in style: `gopkg.in/yaml.v2` → package yaml.
  return last.replace(/\.v\d+$/, '');
}

// Exported in Go = first rune is an UPPERCASE LETTER — exact, no heuristic
// caveat (\p{Lu} covers the unicode classes the spec names).
function isExportedName(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

function makeGoSymbol(
  node: Node,
  signature: string,
  fileInfo: FileInfo,
  kind: SymbolKind,
  name: string,
  fqn: string,
  exported: boolean,
  doc: string | null,
  occurrences: OccurrenceCounter,
  qualifier = '',
): Symbol {
  // Repeated identical (name, kind, signature, qualifier) tuples — legal
  // only for `func init()` — get an ordinal so ids stay unique per file.
  const key = `${name}\0${kind}\0${signature}\0${qualifier}`;
  const n = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, n);
  const effectiveQualifier = n === 1 ? qualifier : `${qualifier}#${n}`;
  return {
    // The id hashes the FULL signature; only the stored copy is capped.
    id: symbolId(fileInfo.path, name, kind, signature, effectiveQualifier),
    name,
    fqn,
    kind,
    file: fileInfo.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
    doc,
    exported,
    language: fileInfo.language,
  };
}

// `type Server struct` / `type Handler interface` (keeps `[T any]` type
// params, drops the member block); other specs keep their full text
// (`type MyInt int`, `type A = B`). The uniform 'type ' prefix is added
// here because grouped specs don't contain the keyword.
function typeSpecSignature(spec: Node, typeNode: Node | null, content: string): string {
  const bodyStart = typeBodyStart(typeNode);
  const raw =
    bodyStart !== null ? content.slice(spec.startIndex, bodyStart) : spec.text;
  return normalizeSignature(`type ${raw}`);
}

// Where a struct/interface member block opens. struct_type wraps members
// in a field_declaration_list; interface_type holds them directly, so the
// anonymous '{' token is the marker (scanning children rather than text
// keeps generic constraints containing braces out of the signature).
function typeBodyStart(typeNode: Node | null): number | null {
  if (typeNode?.type === 'struct_type') {
    const list = typeNode.namedChildren.find((c) => c?.type === 'field_declaration_list');
    return list ? list.startIndex : null;
  }
  if (typeNode?.type === 'interface_type') {
    for (const child of typeNode.children) {
      if (child?.type === '{') return child.startIndex;
    }
    return null;
  }
  return null;
}

// Godoc extraction — two deliberate divergences from extractJavaDoc:
// the block must be ADJACENT (a blank line detaches it, per godoc), and
// the FIRST line of the comment block wins, not the last comment node
// (consecutive `//` lines are separate AST siblings; godoc's summary is
// the block's opening sentence). `//go:` directives inside the block
// (build tags, noinline, generate) are skipped wherever they sit.
function goDoc(decl: Node): string | null {
  const nearest = decl.previousNamedSibling;
  if (!nearest || nearest.type !== 'comment') return null;
  if (nearest.endPosition.row !== decl.startPosition.row - 1) return null;
  if (isTrailingComment(nearest)) return null;
  if (!nearest.text.startsWith('//')) return commentDocLine(nearest.text);

  // Walk up the contiguous `//` chain (each comment exactly one line above
  // the next, none of them trailing an earlier statement).
  const chain: Node[] = [nearest];
  for (;;) {
    const bottom = chain[chain.length - 1];
    if (!bottom) break;
    const prev = bottom.previousNamedSibling;
    if (
      !prev ||
      prev.type !== 'comment' ||
      !prev.text.startsWith('//') ||
      prev.endPosition.row !== bottom.startPosition.row - 1 ||
      isTrailingComment(prev)
    ) {
      break;
    }
    chain.push(prev);
  }
  chain.reverse(); // document order
  for (const comment of chain) {
    if (isDirectiveComment(comment.text)) continue;
    // Empty `//` separator lines yield null — keep scanning the block
    // (godoc's summary is the first line with content).
    const line = commentDocLine(comment.text);
    if (line) return line;
  }
  return null;
}

// go/ast's directive rule (what go/doc strips from doc text): `//`
// immediately followed by `word:x` — a [a-z0-9]+ tag, a colon, then a
// [a-z0-9] char (//go:embed, //nolint:gocyclo) — or by `line `, with no
// space after the slashes. The trailing-char requirement matters: `//see:
// RFC` (space after colon) and `//https://x` (slash after colon) are prose
// go/doc keeps, not directives.
function isDirectiveComment(text: string): boolean {
  return /^\/\/(line |[a-z0-9]+:[a-z0-9])/.test(text);
}
