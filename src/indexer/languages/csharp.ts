import type { Node, Tree } from 'web-tree-sitter';

import { IMPORT_NAMESPACE, RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportInfo, ImportedName, Symbol, SymbolKind } from '../../types.js';
import {
  SIGNATURE_DISPLAY_CAP,
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

// Type-declaration node types → the SymbolKind they map to. Doubles as the
// "is this a type declaration" test during body iteration. struct/record →
// class (constructable, member-bearing); delegate → type (a named
// function-type); enum → enum (members NOT extracted, the universal rule).
const TYPE_KIND: Record<string, SymbolKind> = {
  class_declaration: 'class',
  struct_declaration: 'class',
  record_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  delegate_declaration: 'type',
};

// Nested `local_function_statement`s create their own scope — their calls must
// NOT attribute to an enclosing body. (Inert without a decorator selector, but
// documents intent; CSHARP_SKIP_TYPES is derived from it so the prune is real.)
const CSHARP_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['local_function_statement']);

// walkCalls skip set: nested funcs (own scope, from FUNCTION_BODY_SKIP) PLUS
// `attribute_list`. C# attribute arguments must be constant expressions, but
// `[Foo(Bar())]` still parses a REAL invocation_expression inside the leading
// `attribute_list` child, which the body/module-root walks would otherwise emit
// as a spurious `calls` ref. Skipping `attribute_list` drops those (the Dart
// `annotation` rule). Lambdas (`lambda_expression`) are DESCENDED (the
// Go/Kotlin/Dart rule). Type declarations are deliberately NOT skipped: every
// member initializer owns a per-binding PendingBody, so the module-root re-walk
// only re-touches already-seen call nodes (deduped by the engine's seen-set).
const CSHARP_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...CSHARP_FUNCTION_BODY_SKIP_TYPES,
  'attribute_list',
]);

// `new Foo()` resolves to a 'class'-kind symbol. C# construction `new Foo()`
// exposes a plain `identifier` type (NOT Java's distinct `type_identifier`), so
// it is recognized by CALL-NODE type (constructorSelectorTypes below) rather
// than callee type, and routed through constructorKinds. Bare invocation calls
// `Foo()` are then Java-precise: they resolve ONLY against the enclosing class's
// methods (bareCallsBindToEnclosingClass), never against a same-named class — so
// bareCallableKinds is EMPTY (a bare call colliding with a class name can't
// produce a wrong edge, and a `new Foo()` colliding with an enclosing method
// can't either).
const CSHARP_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set();
const CSHARP_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class']);
const CSHARP_CONSTRUCTOR_SELECTORS: ReadonlySet<string> = new Set(['object_creation_expression']);

// C# names that parse as bare calls but never resolve to a local symbol and
// would otherwise flood the name-keyed reference store. `nameof(x)` is an
// invocation_expression with an `identifier` callee. `typeof`/`sizeof`/`default`
// are their own expression nodes (not calls), so they need no entry. Suppressed
// ONLY when unresolved (a file-local function shadowing the name keeps its refs).
// Start tiny; extend after dogfood measurement.
const CSHARP_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set(['nameof']);

// ── call selectors ─────────────────────────────────────────────────────────

// Callee of an `invocation_expression` = its `function:` field: an `identifier`
// for bare calls, a `generic_name` for bare generic calls (unwrapped to the
// inner identifier), or a member/conditional access for member calls.
function csharpCallCallee(node: Node): Node | null {
  const fn = node.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'generic_name') return childOfType(fn, 'identifier');
  return fn;
}

// Callee of an `object_creation_expression` (`new Foo()`) = the simple-name
// identifier of its `type:` (identifier→itself, generic_name→inner id). A
// `qualified_name` type (`new A.B()`, cross-namespace) is dropped — its
// final segment routinely collides with a same-named in-repo type and same-file
// qualified construction is rare.
function csharpObjectCreationCallee(node: Node): Node | null {
  const t = node.childForFieldName('type');
  if (!t) return null;
  if (t.type === 'identifier') return t;
  if (t.type === 'generic_name') return childOfType(t, 'identifier');
  return null;
}

const CSHARP_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'invocation_expression', getCallee: csharpCallCallee },
  { nodeType: 'object_creation_expression', getCallee: csharpObjectCreationCallee },
];

// The called member name from a member_access/binding `name:` (identifier or a
// generic_name like `obj.Method<int>()` — unwrapped to its identifier).
function propertyName(nameNode: Node | null): string | null {
  if (!nameNode) return null;
  if (nameNode.type === 'identifier') return nameNode.text;
  if (nameNode.type === 'generic_name') return childOfType(nameNode, 'identifier')?.text ?? null;
  return null;
}

// Reduces a `member_access_expression` (`obj.M()`, `this.M()`, `C.Static()`) or
// a `conditional_access_expression` (`a?.M()`) callee to {receiver, property}.
// `this`/`base` are ANONYMOUS tokens (not *_expression nodes): `this` →
// self-call; `base` → null (super-like, skipped, the Java rule). A chained
// `a.b.c()` has a member_access receiver → RECEIVER_OPAQUE (findable by name,
// never resolved). A computed/non-name property emits nothing.
function csharpMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type === 'member_access_expression') {
    const expr = callee.childForFieldName('expression');
    const prop = propertyName(callee.childForFieldName('name'));
    if (!expr || !prop) return null;
    if (expr.type === 'this') return { receiver: 'this', property: prop, isSelf: true };
    if (expr.type === 'base') return null;
    if (expr.type === 'identifier') return { receiver: expr.text, property: prop, isSelf: false };
    return { receiver: RECEIVER_OPAQUE, property: prop, isSelf: false };
  }
  if (callee.type === 'conditional_access_expression') {
    const cond = callee.childForFieldName('condition');
    const binding = childOfType(callee, 'member_binding_expression');
    const prop = binding ? propertyName(binding.childForFieldName('name')) : null;
    if (!cond || !prop) return null;
    if (cond.type === 'this') return { receiver: 'this', property: prop, isSelf: true };
    if (cond.type === 'base') return null;
    if (cond.type === 'identifier') return { receiver: cond.text, property: prop, isSelf: false };
    return { receiver: RECEIVER_OPAQUE, property: prop, isSelf: false };
  }
  return null;
}

// Dominant C# LINQ/collection/string method names (>=4 chars) suppressed when a
// member call to them is unresolved — capturing chained `.Where().Select()`
// calls otherwise floods the name-keyed store. Domain method names are
// deliberately absent. <=3-char names are gated downstream by
// SHORT_NAME_THRESHOLD.
const CSHARP_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'Where', 'Select', 'SelectMany', 'OrderBy', 'OrderByDescending', 'ThenBy',
  'GroupBy', 'Aggregate', 'First', 'FirstOrDefault', 'Last', 'LastOrDefault',
  'Single', 'SingleOrDefault', 'Count', 'Average', 'Distinct',
  'Take', 'Skip', 'Contains', 'ContainsKey', 'ContainsValue',
  'ToList', 'ToArray', 'ToDictionary', 'ToHashSet', 'AsEnumerable',
  'ForEach', 'Reverse', 'Concat', 'Union', 'Intersect', 'Except',
  'ToString', 'Equals', 'GetHashCode', 'GetType', 'Substring', 'IndexOf',
  'Replace', 'Trim', 'Split', 'StartsWith', 'EndsWith', 'ToLower', 'ToUpper',
  'Append', 'Remove', 'Clear', 'TryGetValue', 'ConfigureAwait', 'GetEnumerator',
]);

// ── complexity (cyclomatic + cognitive) — pinned EXACT to SonarC# ───────────
// (SonarAnalyzer.CSharp's CSharpCyclomaticComplexityMetric / CSharpCognitive-
// ComplexityMetric, run as a per-method oracle; see the project docs' "C# Complexity
// Rules"). Both metrics MEASURED against the real analyzer.

// Cyclomatic decision nodes (each +1). Booleans/`??`, `??=`, and the constant-
// `case` discriminator route through csharpCyclomaticExtra (shared node types).
// MEASURED: a `switch_expression_arm` counts for EVERY arm (incl `_`/pattern arms),
// `conditional_access_expression` (`?.` AND `?[`) ALWAYS counts (no Dart property-
// vs-call split), pattern combinators `and`/`or` count per-operator, `not` does not.
const CSHARP_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement', 'foreach_statement', 'while_statement', 'do_statement',
  'conditional_expression', // ternary
  'switch_expression_arm', // every arm (incl `_`/pattern arms)
  'and_pattern', 'or_pattern', // pattern combinators (NOT negated_pattern)
  'conditional_access_expression', // `?.` / `?[` — always +1
]);

// A switch-STATEMENT `switch_section` that SonarC# cyclomatic counts (Roslyn's
// CaseSwitchLabel): a plain constant `case <const>:` OR a bare discard `case _:`
// (both measured +1). The discriminant is a direct `constant_pattern` or `discard`
// child with NO `when_clause` (a `when` guard promotes the label to a
// CasePatternSwitchLabel → NOT counted). EXCLUDED: a `constant_pattern` that wraps a
// `tuple_expression` (`case (1,2):` is a positional pattern, NOT a compile-time
// constant — a tuple literal can never be const, so SonarC# does not count it);
// pattern cases (`declaration_pattern`/`relational_pattern`/`or_pattern`/…) and
// `default`. (`case 1 or 2:` is an or_pattern section → not a constant case here,
// but its `or` counts via CSHARP_DECISION_NODE_TYPES.) Switch EXPRESSIONS differ —
// every `switch_expression_arm` counts (in the node set above).
function csharpIsConstantCase(node: Node): boolean {
  let hasConstant = false;
  for (const c of node.namedChildren) {
    if (c.type === 'when_clause') return false; // a guard → CasePatternSwitchLabel
    if (c.type === 'discard') hasConstant = true; // bare `case _:`
    // a `constant_pattern` wrapping a tuple is a positional pattern, not a constant.
    if (c.type === 'constant_pattern' && c.namedChild(0)?.type !== 'tuple_expression') hasConstant = true;
  }
  return hasConstant;
}

// Extra cyclomatic +1s beyond the node set: `&&`/`||`/`??` (one binary_expression,
// read via the shared C-family token helper — SonarC# counts all three), the
// null-coalescing assignment `??=` (shares assignment_expression with `=`/`+=`),
// and a constant switch `case`.
function csharpCyclomaticExtra(node: Node): boolean {
  if (isCFamilyBooleanOperator(node)) return true; // && || ??
  if (node.type === 'assignment_expression')
    return node.childForFieldName('operator')?.type === '??='; // `.type` (= the token), like the other readers
  if (node.type === 'switch_section') return csharpIsConstantCase(node);
  return false;
}

// COGNITIVE boolean-run kind: `&&`/`||` (binary_expression, via the shared C-family
// reader — but NOT `??`, which is cyclomatic-only, the expected cyc/cog divergence)
// AND the pattern combinators `and`/`or` (and_pattern/or_pattern, their own nodes),
// so both fold into the SAME TREE-SCOPED run (booleanByTreeParent). `not`
// (negated_pattern) → null (uncounted).
function csharpCognitiveBooleanKind(node: Node): string | null {
  const op = cFamilyBooleanOperatorKind(node); // '&&' / '||' / '??' (binary_expression) or null
  if (op !== null) return op === '??' ? null : op; // `??` is cog-free
  if (node.type === 'and_pattern') return 'and';
  if (node.type === 'or_pattern') return 'or';
  return null;
}

// Direct-recursion self-call (SonarC# counts it +1 cognitive, like gocognit) —
// but ONLY when the bare-IDENTIFIER callee name AND the ARGUMENT COUNT both match
// the enclosing method. SonarC#'s CSharpCognitiveComplexityMetric checks
// IdentifierName + arg-count == the method's parameter count; a `Foo(2 args)` call
// inside `Foo(3 params)` is OVERLOAD FORWARDING (ubiquitous in C#), NOT recursion —
// a name-only check over-counts it heavily (measured: ~150 false +1s on Polly). So
// match the call's `argument` count against the enclosing declaration's `parameter`
// count. `this.Foo()` (member_access) and `Foo<T>()` (generic_name) are not bare
// identifiers → not self-calls. The declaration is the body's owner: for a method
// the body (block / arrow_expression_clause) is a child of method_declaration; a
// constructor's body IS the declaration (it carries `parameters` itself), so check
// the body first, then its parent.
function csharpCountChildren(node: Node | null, type: string): number {
  if (!node) return 0;
  let n = 0;
  for (const c of node.namedChildren) if (c.type === type) n++;
  return n;
}
function csharpIsSelfCall(callNode: Node, body: Node, sym: Symbol): boolean {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'identifier' || fn.text !== sym.name) return false;
  // Recursion only applies to a REAL method body — a `block` or an arrow
  // `arrow_expression_clause`. A constructor's synthesized body is the whole
  // `constructor_declaration`, or (primary ctor) a `parameter_list` / `base_list`;
  // those have no resolvable owning-method parameter list (the type decl's params
  // are a POSITIONAL child, not a `parameters` field → paramCount would mis-resolve
  // to 0 and match any 0-arg call), and a constructor can't bare-self-recurse anyway.
  if (body.type !== 'block' && body.type !== 'arrow_expression_clause') return false;
  const decl = body.childForFieldName('parameters') ? body : body.parent;
  const params = decl?.childForFieldName('parameters') ?? null;
  // A `params T[] x` parameter is NOT wrapped in a `parameter` node (a grammar
  // quirk) — it flattens to a trailing `array_type` + `identifier` directly under
  // the parameter_list, so add the bare `identifier` (only a params param leaks one).
  const paramCount =
    csharpCountChildren(params, 'parameter') + csharpCountChildren(params, 'identifier');
  const argCount = csharpCountChildren(callNode.childForFieldName('arguments'), 'argument');
  return paramCount === argCount;
}

// Complexity body boundary: skip ONLY `attribute_list`. Probe measures each member's
// BODY (its PendingBody), not the declaration's attribute_lists (which sit OUTSIDE
// the body for top-level members anyway); SonarC# walks the whole declaration and
// DOES count control flow in attribute arguments — but that is a degenerate case
// (valid C# attribute args are compile-time constants, so a ternary/`&&`/switch
// there is near-zero in real code: 0 cases across Newtonsoft.Json+Polly), a SAFE
// documented under-count from the body boundary. The skip keeps a body-INTERNAL
// attribute (on a local fn / lambda) consistent with that boundary. (A SEPARATE set
// from CSHARP_SKIP_TYPES, the resolveCalls boundary, which DOES prune local functions
// from call attribution.) local_function_statement and lambda_expression are
// DELIBERATELY ABSENT (descended) so they ROLL INTO the enclosing member with a
// nesting bump — SonarC#'s per-member model for a NON-static local fn / lambda. A
// STATIC local function is scored separately by SonarC# but rolled in here (no Probe
// symbol exists for it) — the documented per-symbol-model divergence.
const CSHARP_COMPLEXITY_SKIP_TYPES: ReadonlySet<string> = new Set(['attribute_list']);

// Cognitive config (SonarC# S3776 — sonar-java-shaped: field-based `if`, contained
// `catch`). MEASURED EXACT. Two non-default shapes the oracle forced: booleans are
// TREE-SCOPED (booleanByTreeParent, like the SonarQube Dart model — NOT sonar-java's source-order),
// and `goto`/`goto case` is a SURCHARGE (+1+nesting) → surchargeTypes.
const CSHARP_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative', // Java-style: else/else-if held directly (no else_clause wrapper)
  loopTypes: new Set(['for_statement', 'foreach_statement', 'while_statement', 'do_statement']),
  switchTypes: new Set(['switch_statement', 'switch_expression']), // whole-switch +1 (stmt + expr)
  ternaryType: 'conditional_expression',
  catchType: 'catch_clause', // contains its `body:` block → the generic catch branch
  surchargeTypes: new Set(['goto_statement']), // `goto`/`goto case`: +1+nesting
  nestOnlyTypes: new Set(['lambda_expression', 'local_function_statement']), // roll in, nest +0
  labeledJumpTypes: new Set(), // C# break/continue are unlabeled; goto is a surcharge (above)
  hasLabel: () => false,
  booleanOperatorKind: csharpCognitiveBooleanKind,
  // TREE-SCOPED boolean runs (like the SonarQube Dart model, NOT sonar-java's source-order) — a
  // `&&`/`||` (or pattern `and`/`or`) counts iff its operator kind differs from its
  // nearest logical ancestor (skipping parens). MEASURED EXACT: `a && b && (c||d) &&
  // (e||f)` = cog 3 (one &&-spine + two ||s), NOT source-order's 4 — the slice's
  // surprise. The `parenthesizedType` SET below skips BOTH a parenthesized EXPRESSION
  // (`(c||d)`) and a parenthesized PATTERN (`(int and >0)`) so a same-kind combinator
  // grouped by parens stays ONE run (`is (A and B) and C` = cog 2). See the project docs' "C# Complexity Rules".
  booleanByTreeParent: true,
  // A SET (not a single string) so the tree-scoped ancestor walk treats BOTH a
  // parenthesized EXPRESSION (`(c||d)`) and a parenthesized PATTERN (`(int and >0)`)
  // as transparent — a same-kind combinator grouped by parens stays one run.
  parenthesizedType: new Set(['parenthesized_expression', 'parenthesized_pattern']),
  recursion: {
    callType: 'invocation_expression',
    isSelfCall: csharpIsSelfCall,
    eligibleKinds: new Set(['method']),
    oncePerSymbol: true, // SonarC# adds +1 once per recursive method, not per call-site
  },
  // NO: elseClauseType / conditionFromNamedChildren / collectionIfType / tryType /
  //     initField / nestElseBody / loopBodyField / flatIncrement / positional-if knobs —
  //     C# is field-based and sonar-java-shaped.
};

// Per-file duplicate-id disambiguation (the Kotlin/Dart OccurrenceCounter): two
// same-(name,kind,signature,qualifier) symbols — e.g. same-file partial-class
// decls, or an overload byte-identical past nothing — get an ordinal qualifier.
type OccurrenceCounter = Map<string, number>;

interface CSharpCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
  // Per type-name aggregate for partial-aware ambiguity: total decls, whether
  // EVERY decl of that name is `partial`, and the distinct "groups" seen — a
  // group is the qualifying context (namespace + enclosing-type chain) plus
  // generic arity. Same-name decls merge (not collide) only when all-partial AND
  // a SINGLE group: `partial class Foo<T>` vs `partial class Foo` (arity) and
  // `N1.Foo` vs `N2.Foo` (namespace) are DISTINCT types that must NOT merge
  // despite both being partial — they share the simple-name FQN, and the engine
  // keys methodsByClass/typeNameToId by simple name, so merging them first-wins
  // produces a confidently WRONG cross-type edge.
  typeStats: Map<string, { total: number; allPartial: boolean; groups: Set<string> }>;
}

export function extractCSharp(
  tree: Tree,
  content: string,
  fileInfo: FileInfo,
): ExtractResult {
  const ctx: CSharpCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
    typeStats: new Map(),
  };

  extractMembers(ctx, tree.rootNode.namedChildren, '');

  // Same-named types collide on the simple-name FQN, so resolving through them
  // first-wins would bind to the WRONG type — EXCEPT an all-`partial`,
  // single-group set is the same logical type and SHOULD merge (methodsByClass
  // first-wins is then correct). Flag a name when it has >1 decl and they are
  // NOT all partial, OR they span more than one group (different namespace /
  // enclosing type / generic arity → distinct types sharing the simple name).
  const ambiguousTypeNames = new Set<string>();
  for (const [name, st] of ctx.typeStats) {
    if (st.total > 1 && (!st.allPartial || st.groups.size > 1)) ambiguousTypeNames.add(name);
  }

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    CSHARP_SELECTORS,
    CSHARP_SKIP_TYPES,
    CSHARP_FUNCTION_BODY_SKIP_TYPES,
    csharpMemberCallInfo,
    {
      // Bare `Foo()` is an implicit-`this` method call → resolves ONLY against
      // the enclosing class (bareCallableKinds empty, Java-precise). `new Foo()`
      // (object_creation_expression — a constructorSelector) routes through
      // constructorKinds to the 'class'-kind symbol, never the enclosing class,
      // so a `new Foo()` can't mis-bind to a same-named enclosing method.
      bareCallsBindToEnclosingClass: true,
      bareCallableKinds: CSHARP_BARE_CALLABLE_KINDS,
      constructorKinds: CSHARP_CONSTRUCTOR_KINDS,
      constructorSelectorTypes: CSHARP_CONSTRUCTOR_SELECTORS,
      ambiguousClassNames: ambiguousTypeNames,
      ignoredBareCallees: CSHARP_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: CSHARP_IGNORED_MEMBER_CALLEES,
    },
  );
  // Cyclomatic + cognitive complexity (SonarC#-pinned), computed while the tree
  // is alive (the Dart/Kotlin call-site pattern). Uses its OWN skip set (local fns
  // + lambdas roll into the enclosing member — SonarC#'s per-member model), not
  // CSHARP_SKIP_TYPES.
  computeComplexity(ctx.bodies, ctx.symbols, {
    decisionNodeTypes: CSHARP_DECISION_NODE_TYPES,
    extraDecisionPredicate: csharpCyclomaticExtra,
    skipTypes: CSHARP_COMPLEXITY_SKIP_TYPES,
    cognitive: CSHARP_COGNITIVE_OPTIONS,
  });

  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Processes a list of compilation_unit / namespace-body children, threading the
// current namespace qualifier. A `file_scoped_namespace_declaration` updates the
// qualifier for all FOLLOWING siblings; a block `namespace_declaration` recurses
// into its own body with the joined qualifier. Namespaces are NOT symbols — C#
// FQNs are file-path based, so a per-file module symbol would be pure noise; the
// namespace path only disambiguates hashed ids (via the qualifier).
function extractMembers(ctx: CSharpCtx, children: readonly Node[], nsQualifier: string): void {
  let ns = nsQualifier;
  for (const child of children) {
    switch (child.type) {
      case 'using_directive':
        extractImport(ctx, child);
        break;
      case 'file_scoped_namespace_declaration': {
        const name = child.childForFieldName('name')?.text;
        if (name) ns = joinQualifier(nsQualifier, name);
        break;
      }
      case 'namespace_declaration': {
        const name = child.childForFieldName('name')?.text ?? '';
        const body = child.childForFieldName('body');
        if (body) extractMembers(ctx, body.namedChildren, joinQualifier(ns, name));
        break;
      }
      // global_statement (top-level statements / Program.cs), extern_alias,
      // comments — no symbols. Calls inside top-level statements still attribute
      // to module scope via the module-root walk.
      default:
        if (TYPE_KIND[child.type] !== undefined) {
          extractType(ctx, child, ns, true, true, false);
        }
        break;
    }
  }
}

// A type declaration (class/struct/record/interface/enum/delegate). Recurses
// through the body for nested types (simple-name FQN; the namespace+enclosing
// chain folds into the hashed qualifier only — the Java/Kotlin rule) and members.
function extractType(
  ctx: CSharpCtx,
  decl: Node,
  parentQualifier: string,
  containerExported: boolean,
  isTopLevelType: boolean,
  containerIsInterface: boolean,
): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const kind = TYPE_KIND[decl.type]!;
  const mods = findModifierTexts(decl);
  // A type nested directly in an interface is implicitly public (like interface
  // members), so containerIsInterface gates exportedness the same way.
  const exported = csharpExported(mods, containerExported, containerIsInterface, isTopLevelType);

  // Record partial-aware type stats (all type-kinds share the simple-name FQN
  // namespace). The "group" key (qualifying context + generic arity) lets only
  // genuine same-namespace/same-arity partials merge: `Foo` vs `Foo<T>` (arity)
  // and `N1.Foo` vs `N2.Foo` (namespace) get distinct groups → flagged ambiguous.
  const isPartial = mods.has('partial');
  const group = `${parentQualifier}\0${genericArity(decl)}`;
  const st = ctx.typeStats.get(name) ?? { total: 0, allPartial: true, groups: new Set<string>() };
  st.total += 1;
  st.allPartial = st.allPartial && isPartial;
  st.groups.add(group);
  ctx.typeStats.set(name, st);

  ctx.symbols.push(
    makeCSharpSymbol(ctx, decl, csharpSig(ctx, decl), kind, name, topFqn(ctx, name), exported, csharpDoc(decl), parentQualifier),
  );

  // delegate: a single-line named function-type, no body. enum: members are
  // enum constants (NOT extracted, the universal rule).
  if (decl.type === 'delegate_declaration' || decl.type === 'enum_declaration') return;

  const memberQualifier = joinQualifier(parentQualifier, name);
  const isInterface = decl.type === 'interface_declaration';

  // Primary constructor (`class D(int x)` / `record R(int X)` / struct). Records
  // turn positional params into public init-only PROPERTIES; class/struct
  // primary-ctor params are NOT members (implicit captures), but both
  // synthesize a 'constructor' owning the param defaults + base-initializer
  // args (`: Base(Make(x))`).
  if (
    decl.type === 'record_declaration' ||
    decl.type === 'class_declaration' ||
    decl.type === 'struct_declaration'
  ) {
    extractPrimaryConstructor(ctx, decl, name, memberQualifier, exported, decl.type === 'record_declaration');
  }

  const body = decl.childForFieldName('body'); // declaration_list
  if (!body) return;
  for (const member of body.namedChildren) {
    if (TYPE_KIND[member.type] !== undefined) {
      extractType(ctx, member, memberQualifier, exported, false, isInterface);
    } else {
      extractMember(ctx, member, name, memberQualifier, exported, isInterface);
    }
  }
}

// A class/struct/record/interface body member. Routes to callable, property,
// field, or event handling. Nested type decls are handled by the caller.
function extractMember(
  ctx: CSharpCtx,
  member: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
  inInterface: boolean,
): void {
  const doc = csharpDoc(member);
  const mods = findModifierTexts(member);
  const exported = csharpExported(mods, containerExported, inInterface, false);

  switch (member.type) {
    case 'method_declaration': {
      const name = member.childForFieldName('name')?.text;
      if (!name) return;
      // An extension method (`static T M(this string s)`) is methods-apart: its
      // FQN keys on the receiver-param type so `s.M()` resolves (Kotlin/Swift/
      // Dart rule), BUT it is a STATIC method with no implicit `this`, so a bare
      // call inside its body binds to the CONTAINER class's static methods — the
      // PendingBody className stays `className`, not the receiver type.
      const fqnClass = extensionReceiverName(member) ?? className;
      extractCallable(ctx, member, name, fqnClass, className, qualifier, exported, doc, member.childForFieldName('body'));
      return;
    }
    case 'constructor_declaration': {
      // Named 'constructor' (TS convention); the WHOLE decl is the body so the
      // `: base(...)`/`: this(...)` initializer args and param defaults attribute
      // here. `new C()` refs bind to the CLASS symbol via constructorKinds.
      extractCallable(ctx, member, 'constructor', className, className, qualifier, exported, doc, member);
      return;
    }
    case 'operator_declaration': {
      const op = member.childForFieldName('operator')?.text;
      if (!op) return;
      extractCallable(ctx, member, op, className, className, qualifier, exported, doc, member.childForFieldName('body'));
      return;
    }
    case 'conversion_operator_declaration': {
      // `public static implicit operator int(C c) => ...` — no `name:` field;
      // name it `operator <target type>` (the `type:` field). The whole decl is
      // the body so the conversion expression's calls attribute here.
      const target = simpleTypeName(member.childForFieldName('type'));
      extractCallable(ctx, member, `operator ${target ?? '?'}`, className, className, qualifier, exported, doc, member);
      return;
    }
    case 'destructor_declaration': {
      // `~C() { ... }` finalizer → method 'finalize' (its `name:` field repeats
      // the class name, the constructor problem). Owns its body's calls.
      extractCallable(ctx, member, 'finalize', className, className, qualifier, exported, doc, member.childForFieldName('body'));
      return;
    }
    case 'indexer_declaration': {
      // `this[int i]` → a 'method' named 'this[]'; the WHOLE decl is the body so
      // the get/set accessor (or arrow value) calls attribute here.
      extractCallable(ctx, member, 'this[]', className, className, qualifier, exported, doc, member);
      return;
    }
    case 'property_declaration': {
      const name = member.childForFieldName('name')?.text;
      if (!name) return;
      const sym = makeCSharpSymbol(ctx, member, csharpSig(ctx, member), 'variable', name, memberFqn(ctx, className, name), exported, doc, qualifier);
      ctx.symbols.push(sym);
      // The whole property owns its accessor bodies, arrow `value:`, and `= init`.
      ctx.bodies.push({ symbolId: sym.id, body: member, className });
      return;
    }
    case 'event_declaration': {
      // Explicit event with add/remove accessors → a 'variable'; the whole decl
      // owns the accessor calls.
      const name = member.childForFieldName('name')?.text;
      if (!name) return;
      const sym = makeCSharpSymbol(ctx, member, csharpSig(ctx, member), 'variable', name, memberFqn(ctx, className, name), exported, doc, qualifier);
      ctx.symbols.push(sym);
      ctx.bodies.push({ symbolId: sym.id, body: member, className });
      return;
    }
    case 'field_declaration':
    case 'event_field_declaration':
      extractFieldLike(ctx, member, className, qualifier, exported, doc);
      return;
    // destructor/conversion-operator/static-constructor-without-name and stray
    // tokens — no symbol (static ctors arrive as constructor_declaration above).
    default:
      return;
  }
}

// A method / constructor / operator / indexer → a 'method' symbol. `fqnClass`
// keys the FQN/methods-apart lookup (the receiver type for an extension method,
// else the enclosing class); `bodyClass` is the PendingBody className for
// bare/self-call resolution inside the body (always the enclosing class — the
// two differ only for extension methods). `bodyNode` is the `body:` field for
// methods/operators, or the WHOLE declaration for constructors/indexers (so
// initializer/accessor calls attribute here); abstract/interface members pass
// null and own no PendingBody.
function extractCallable(
  ctx: CSharpCtx,
  decl: Node,
  name: string,
  fqnClass: string,
  bodyClass: string,
  qualifier: string,
  exported: boolean,
  doc: string | null,
  bodyNode: Node | null,
): void {
  const sym = makeCSharpSymbol(ctx, decl, csharpSig(ctx, decl), 'method', name, memberFqn(ctx, fqnClass, name), exported, doc, qualifier);
  ctx.symbols.push(sym);
  if (bodyNode) ctx.bodies.push({ symbolId: sym.id, body: bodyNode, className: bodyClass });
}

// field_declaration / event_field_declaration → one 'variable' per
// variable_declarator (`int a = 1, b;` carries several). Each declarator with an
// initializer owns a PendingBody on itself (the Java/Dart per-binding rule).
function extractFieldLike(
  ctx: CSharpCtx,
  member: Node,
  className: string,
  qualifier: string,
  exported: boolean,
  doc: string | null,
): void {
  const varDecl = childOfType(member, 'variable_declaration');
  if (!varDecl) return;
  // The `value:` initializer lives on each variable_declarator, not on the
  // field node, so csharpSig can't cut it — build "<modifiers> <type>
  // <name>[, <name>]" explicitly to keep initializers out of the signature
  // (matching the property path; the id still hashes this normalized form).
  const signature = fieldSignature(ctx, member, varDecl);
  for (const declarator of varDecl.namedChildren) {
    if (declarator.type !== 'variable_declarator') continue;
    const name = declarator.childForFieldName('name')?.text;
    if (!name) continue;
    const sym = makeCSharpSymbol(ctx, member, signature, 'variable', name, memberFqn(ctx, className, name), exported, doc, qualifier);
    ctx.symbols.push(sym);
    // The declarator carries any `= initializer` — own its calls per-binding.
    ctx.bodies.push({ symbolId: sym.id, body: declarator, className });
  }
}

// The "<modifiers> <type> <name>[, <name>]" signature of a field /
// event_field_declaration, with all `= initializer` text dropped.
function fieldSignature(ctx: CSharpCtx, member: Node, varDecl: Node): string {
  const type = varDecl.childForFieldName('type');
  const head = type
    ? ctx.content.slice(signatureStart(member), type.endIndex)
    : ctx.content.slice(signatureStart(member), varDecl.startIndex);
  const names = varDecl.namedChildren
    .filter((c) => c.type === 'variable_declarator')
    .map((d) => d.childForFieldName('name')?.text)
    .filter((n): n is string => Boolean(n));
  return normalizeSignature(`${head} ${names.join(', ')}`);
}

// A primary constructor on a record / class / struct (`record R(int X)`,
// `class D(int x) : Base(Make(x))`). For RECORDS the positional params are
// public init-only PROPERTIES (`emitProperties`); for class/struct they are
// implicit captures, not members. Either way a SINGLE 'constructor' is
// synthesized when there are params, owning the parameter_list (default-arg
// calls) AND the base_list (`: Base(Make(x))` initializer-arg calls). No phantom
// for a parameterless type.
function extractPrimaryConstructor(
  ctx: CSharpCtx,
  decl: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
  emitProperties: boolean,
): void {
  const plist = childOfType(decl, 'parameter_list');
  if (!plist) return;
  const params = plist.namedChildren.filter((c) => c.type === 'parameter');
  let hasParam = false;
  for (const param of params) {
    const name = param.childForFieldName('name')?.text;
    if (!name) continue;
    hasParam = true;
    if (!emitProperties) continue;
    ctx.symbols.push(
      makeCSharpSymbol(
        ctx,
        param,
        normalizeSignature(ctx.content.slice(param.startIndex, param.endIndex)),
        'variable',
        name,
        memberFqn(ctx, className, name),
        containerExported,
        null,
        qualifier,
      ),
    );
  }
  if (!hasParam) return;
  const sym = makeCSharpSymbol(
    ctx,
    plist,
    normalizeSignature(`constructor${ctx.content.slice(plist.startIndex, plist.endIndex)}`),
    'method',
    'constructor',
    memberFqn(ctx, className, 'constructor'),
    containerExported,
    null,
    qualifier,
  );
  ctx.symbols.push(sym);
  ctx.bodies.push({ symbolId: sym.id, body: plist, className });
  // `: Base(Make(x))` base-initializer args run at construction — own their calls.
  const baseList = childOfType(decl, 'base_list');
  if (baseList) ctx.bodies.push({ symbolId: sym.id, body: baseList, className });
}

// `using X.Y;` / `using static X.Y;` / `global using X.Y;` → namespace import
// (IMPORT_NAMESPACE — these widen scope over a whole namespace). `using A = X.Y;`
// → an alias import binding A to the last segment. Low cross-file value (C#
// namespaces don't map to indexed files, no directory carve-out — the Rust/
// Kotlin framing).
function extractImport(ctx: CSharpCtx, node: Node): void {
  const aliasNode = node.childForFieldName('name'); // present only for `A = X.Y`
  let pathNode = childOfType(node, 'qualified_name');
  if (!pathNode) {
    // The path is a bare `identifier` (`using System;`) or, for an unqualified
    // generic alias (`using F = List<int>;`), a `generic_name` — both distinct
    // from the alias `name:` identifier.
    pathNode =
      node.namedChildren.find(
        (c) => (c.type === 'identifier' || c.type === 'generic_name') && c.id !== aliasNode?.id,
      ) ?? null;
  }
  if (!pathNode) return;
  const line = node.startPosition.row + 1;

  if (aliasNode) {
    // `using F = N.C<int>;` — the bound name is the base type (`C`), not the
    // generic instantiation text; simpleTypeName strips type arguments.
    const last = simpleTypeName(pathNode);
    const source = pathNode.type === 'qualified_name' ? pathNode.childForFieldName('qualifier')?.text ?? '' : '';
    if (!last) return;
    const imported: ImportedName = { name: last, alias: aliasNode.text };
    ctx.imports.push({ file: ctx.fileInfo.path, sourceModule: source, importedNames: [imported], line });
    return;
  }
  ctx.imports.push({
    file: ctx.fileInfo.path,
    sourceModule: pathNode.text,
    importedNames: [{ name: IMPORT_NAMESPACE, kind: 'namespace' }],
    line,
  });
}

// ── helpers ──────────────────────────────────────────────────────────────

// Each `modifier` is a separate named child whose `.text` is the keyword
// ('public'/'static'/'partial'/'this'/…). Absent entirely on modifier-less
// declarations.
function findModifierTexts(decl: Node): Set<string> {
  const out = new Set<string>();
  for (const c of decl.namedChildren) {
    if (c.type === 'modifier') out.add(c.text);
  }
  return out;
}

// C#'s member default is PRIVATE (absent modifier ≠ public, unlike Kotlin/
// Swift), so the "no private keyword" heuristic fails. Rule:
//   • a `private` modifier (incl. `private protected`) is never exported;
//   • interface members default public (the Java rule);
//   • a top-level type defaults to internal → exported (internal-as-exported
//     preserves cross-file member-call recall; no dir→package carve-out);
//   • everything else (member / nested type) needs an explicit
//     public/protected/internal modifier (default private → not exported).
// Members AND-in their container's exportedness via the caller.
function csharpExported(
  mods: ReadonlySet<string>,
  containerExported: boolean,
  inInterface: boolean,
  isTopLevelType: boolean,
): boolean {
  if (!containerExported) return false;
  if (mods.has('private')) return false;
  if (inInterface) return true;
  if (isTopLevelType) return true;
  return mods.has('public') || mods.has('protected') || mods.has('internal');
}

// An extension method's receiver type: its FIRST parameter carries a `this`
// modifier; the receiver's simple type name keys the method apart. Returns null
// for a non-extension method.
function extensionReceiverName(method: Node): string | null {
  const plist = method.childForFieldName('parameters');
  if (!plist) return null;
  const first = plist.namedChildren.find((c) => c.type === 'parameter');
  if (!first) return null;
  const isExtension = first.namedChildren.some((c) => c.type === 'modifier' && c.text === 'this');
  if (!isExtension) return null;
  return simpleTypeName(first.childForFieldName('type'));
}

// Simple name of a type node (predefined `int`/`string`, `identifier`,
// `generic_name`→base, `qualified_name`→last segment, `nullable_type`→inner).
// Returns null for non-nominal types (array/tuple/pointer/function) — the caller
// then keeps an extension method on its container class. The qualified_name case
// RECURSES into its `name:` segment, which is itself a `generic_name` for a
// fully-qualified generic (`System...List<int>` → `List`, not `List<int>`).
function simpleTypeName(t: Node | null): string | null {
  if (!t) return null;
  if (t.type === 'nullable_type') return simpleTypeName(t.namedChildren[0] ?? null);
  if (t.type === 'identifier' || t.type === 'predefined_type') return t.text;
  if (t.type === 'generic_name') return childOfType(t, 'identifier')?.text ?? null;
  if (t.type === 'qualified_name') return simpleTypeName(t.childForFieldName('name'));
  return null;
}

// Generic arity = the number of type parameters in a type declaration's
// `type_parameter_list` (0 when non-generic). `Foo` and `Foo<T>` share the
// simple name `Foo` but are DISTINCT types, so arity disambiguates them.
function genericArity(decl: Node): number {
  const tpl = childOfType(decl, 'type_parameter_list');
  if (!tpl) return 0;
  return tpl.namedChildren.filter((c) => c.type === 'type_parameter').length;
}

// Signature = source from the first non-attribute token (attributes excluded —
// the Java annotation rationale: `[Attr(...)]` blocks blow the 120-char cap and
// collide overload ids) to the body / accessors / property-value / ctor
// initializer, with a trailing `;` stripped (bodiless interface/abstract
// members, delegates, bodiless records). Feeds symbolId hashing; the stored copy
// is capped by makeCSharpSymbol.
function csharpSig(ctx: CSharpCtx, node: Node): string {
  const start = signatureStart(node);
  let end = node.endIndex;
  for (const field of ['body', 'accessors', 'value'] as const) {
    const c = node.childForFieldName(field);
    if (c) end = Math.min(end, c.startIndex);
  }
  const init = node.namedChildren.find((c) => c.type === 'constructor_initializer');
  if (init) end = Math.min(end, init.startIndex);
  let sig = normalizeSignature(ctx.content.slice(start, end));
  if (sig.endsWith(';')) sig = sig.slice(0, -1).trimEnd();
  return sig;
}

// Past the leading `attribute_list` children (they sit before the modifiers/
// keyword); the keyword itself is anonymous, so we can't address it by named
// child — instead start right after the last leading attribute_list.
function signatureStart(decl: Node): number {
  let start = decl.startIndex;
  for (const c of decl.namedChildren) {
    if (c.type === 'attribute_list') start = c.endIndex;
    else break;
  }
  return start;
}

// Doc = the immediately-preceding `///` XML-doc block (consecutive `///` are
// SEPARATE `comment` nodes → contiguous-block walk, first content line) or a
// single `/** */`. Plain `//` and `/* */` are NOT docs. Attributes live INSIDE
// the declaration (a leading child), so they don't break adjacency — no
// Rust-style sibling skip.
function csharpDoc(decl: Node): string | null {
  const nearest = decl.previousNamedSibling;
  if (!nearest || nearest.type !== 'comment') return null;
  if (nearest.endPosition.row !== decl.startPosition.row - 1) return null; // adjacency
  if (isTrailingComment(nearest)) return null;
  const text = nearest.text;
  if (text.startsWith('/**')) return commentDocLine(text);
  if (!text.startsWith('///')) return null;

  const chain: Node[] = [nearest];
  for (;;) {
    const bottom = chain[chain.length - 1]!;
    const prev = bottom.previousNamedSibling;
    if (
      !prev ||
      prev.type !== 'comment' ||
      !prev.text.startsWith('///') ||
      prev.endPosition.row !== bottom.startPosition.row - 1 ||
      isTrailingComment(prev)
    ) {
      break;
    }
    chain.push(prev);
  }
  chain.reverse();
  for (const comment of chain) {
    const line = csharpDocLine(comment.text);
    if (line) return line;
  }
  return null;
}

// First content line of a `///`/`/**` comment, with a leading XML doc tag
// (`<summary>` etc.) and its closing tag stripped for a cleaner one-liner. A
// tag-only line (`/// <summary>`) strips to empty → null, so the block walk
// skips it and continues to the first line carrying real content.
function csharpDocLine(text: string): string | null {
  const line = commentDocLine(text);
  if (!line) return null;
  const stripped = line
    .replace(/^<\s*[A-Za-z]+[^>]*>\s*/, '')
    .replace(/\s*<\/\s*[A-Za-z]+\s*>\s*$/, '')
    .trim();
  return stripped || null;
}

function topFqn(ctx: CSharpCtx, name: string): string {
  return `${ctx.fileInfo.path}:${name}`;
}

function memberFqn(ctx: CSharpCtx, className: string | undefined, name: string): string {
  return className ? `${ctx.fileInfo.path}:${className}.${name}` : `${ctx.fileInfo.path}:${name}`;
}

// First direct named child of one of the given types (or null).
function childOfType(node: Node, ...types: string[]): Node | null {
  return node.namedChildren.find((c) => types.includes(c.type)) ?? null;
}

// Namespace path / enclosing-type chain only disambiguate hashed ids — they
// never reach FQN parsing — so any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}.${b}`;
}

function makeCSharpSymbol(
  ctx: CSharpCtx,
  node: Node,
  signature: string,
  kind: SymbolKind,
  name: string,
  fqn: string,
  exported: boolean,
  doc: string | null,
  qualifier = '',
): Symbol {
  const key = `${name}\0${kind}\0${signature}\0${qualifier}`;
  const n = (ctx.occurrences.get(key) ?? 0) + 1;
  ctx.occurrences.set(key, n);
  const effectiveQualifier = n === 1 ? qualifier : `${qualifier}#${n}`;
  return {
    // The id hashes the FULL signature; only the stored copy is capped.
    id: symbolId(ctx.fileInfo.path, name, kind, signature, effectiveQualifier),
    name,
    fqn,
    kind,
    file: ctx.fileInfo.path,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    signature: signature.slice(0, SIGNATURE_DISPLAY_CAP),
    doc,
    exported,
    language: ctx.fileInfo.language,
  };
}
