import type { Node, Tree } from 'web-tree-sitter';

import { collectAmbiguousTypeNames } from '../extractor.js';
import { computeComplexity } from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';
import { RECEIVER_OPAQUE } from '../../types.js';
import type { FileInfo, ImportInfo, Symbol, SymbolKind } from '../../types.js';
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

// ── skip sets ────────────────────────────────────────────────────────────────

// Nested `def`/`singleton_method` create their own scope — their calls must NOT
// attribute to an enclosing body, and they are not extracted (the global
// no-nested-functions rule). Blocks (`block`/`do_block`) are deliberately ABSENT
// → DESCENDED, so their calls attribute to the enclosing method (the Go/Kotlin/
// PHP lambda rule — a block closes over the method's `self`).
const RUBY_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'method',
  'singleton_method',
]);

// walkCalls skip set: nested defs (own scope) + the type/namespace nodes
// (`class`/`module`/`singleton_class`). Each Ruby member owns a per-member
// PendingBody, so the module-root walk never needs to descend INTO a type to find
// member calls; pruning the type nodes also stops a nested `class {}`'s method
// calls from mis-attributing to an enclosing body. Top-level script calls are
// direct program children, so they stay reachable.
const RUBY_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...RUBY_FUNCTION_BODY_SKIP_TYPES,
  'class',
  'module',
  'singleton_class',
]);

// ── call resolution ──────────────────────────────────────────────────────────

// Ruby's bare callee is the engine-default `identifier`; `constant` is ALSO a bare
// callee type ONLY so that `Foo.new` construction (a member call whose receiver is
// a constant) routes through the constructor-form path: getCallee returns the
// `constant`, and because `constant` !== `plainCalleeType` ('identifier') the
// engine treats it as constructor-form → typeNameToId (constructorKinds={class}).
// No `constructorSelectorTypes` is needed (construction has no distinct call NODE
// type — it is an ordinary `call`).
const RUBY_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['identifier', 'constant']);
const RUBY_PLAIN_CALLEE_TYPE = 'identifier';

// A bare `foo`/`foo(x)` is EITHER an implicit-self method call OR a top-level
// function call — Ruby has both (a top-level `def` is modelled as 'function').
// So bare calls bind to the enclosing class first (bareCallsBindToEnclosingClass)
// then the callable-name map over {function, method}. This is the C#-enclosing-
// class × PHP-top-level-function hybrid.
const RUBY_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

// `Foo.new` resolves to a 'class'-kind symbol (routed via the constant-callee
// constructor-form path above). A class can never be reached by a bare `foo()`
// (bareCallableKinds excludes 'class'), so a construction can never bind to a
// method/function and vice-versa.
const RUBY_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class']);

// Kernel / core built-ins that parse as bare `identifier`/`call` callees but never
// resolve to a local symbol — they would flood the name-keyed reference store.
// Suppressed ONLY when unresolved (a file-local method shadowing the name keeps
// its refs). START small + tune by dogfood (the Kotlin/PHP measure-don't-guess
// method). The visibility/`attr_*`/mixin keywords are handled structurally before
// resolve, but listing them is belt-and-suspenders for any that slip through as
// plain `call` nodes (`private :foo` etc.).
const RUBY_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  // IO / Kernel
  'puts', 'print', 'pp', 'warn', 'gets', 'sleep', 'exit', 'abort', 'raise', 'fail',
  'throw', 'catch', 'loop', 'lambda', 'proc', 'format', 'sprintf', 'printf', 'rand',
  'srand', 'require', 'require_relative', 'load', 'autoload', 'at_exit', 'binding',
  'caller', 'eval', 'freeze', 'frozen?', 'block_given?', 'gsub', 'sub',
  // metaprogramming / definition
  'attr_accessor', 'attr_reader', 'attr_writer', 'attr', 'include', 'extend',
  'prepend', 'private', 'protected', 'public', 'module_function', 'define_method',
  'alias_method', 'private_class_method', 'public_class_method', 'private_constant',
  'send', '__send__', 'public_send', 'respond_to?', 'instance_variable_get',
  'instance_variable_set', 'instance_of?', 'is_a?', 'kind_of?',
  // type coercion (Kernel conversion methods)
  'Integer', 'Float', 'String', 'Array', 'Hash',
]);

// Enumerable / core-protocol method names whose chained captures are pure noise
// (`.map`/`.each`/`.to_s`/…). Suppressed only when UNRESOLVED. Deliberately small —
// Ruby instance methods are overwhelmingly domain — and tuned by dogfood. <=3-char
// names (`map`, `to_a`) are gated downstream by SHORT_NAME_THRESHOLD regardless.
const RUBY_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'each', 'each_with_index', 'each_with_object', 'map', 'flat_map', 'collect',
  'select', 'reject', 'filter', 'find', 'detect', 'reduce', 'inject', 'group_by',
  'sort_by', 'min_by', 'max_by', 'partition', 'to_a', 'to_h', 'to_s', 'to_sym',
  'to_i', 'to_f', 'to_proc', 'include?', 'key?', 'empty?', 'any?', 'all?', 'none?',
  'push', 'pop', 'shift', 'unshift', 'freeze', 'frozen?', 'dup', 'clone', 'tap',
  'respond_to?', 'present?', 'blank?', 'nil?', 'call',
]);

// One selector: every Ruby call is a `call` node (bare calls WITH args/parens, and
// every receiver call); a bare no-arg no-paren call is a lone `identifier` —
// indistinguishable from a local read, so NOT captured (a documented recall gap).
// `super`/`yield` are their own nodes, not selected.
const RUBY_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'call', getCallee: rubyCallCallee },
];

// Discriminate the three call shapes by what getCallee returns:
//   bare `foo(x)`            → the `method` identifier (bare branch)
//   `Foo.new` / `A::B.new`   → the receiver `constant` (constructor-form: constant
//                              type !== plainCalleeType → typeNameToId)
//   `obj.m()` / `Foo.bar()`  → the call NODE itself (member branch via
//                              rubyMemberCallInfo)
// `super(x)` (method=super) → null (super-like, the Java `base`/PHP `parent::` rule).
function rubyCallCallee(node: Node): Node | null {
  const method = node.childForFieldName('method');
  if (!method || method.type === 'super') return null;
  const receiver = node.childForFieldName('receiver');
  if (!receiver) return method; // bare call → identifier
  if (method.text === 'new') {
    if (receiver.type === 'constant') return receiver;
    if (receiver.type === 'scope_resolution') {
      const name = receiver.childForFieldName('name');
      if (name && name.type === 'constant') return name; // A::B.new → B
    }
    // self.new / obj.new (non-constant) → fall through to the member path.
  }
  return node; // member call
}

// Reduces a member `call` node to {receiver, property, isSelf}.
//   `self.m()`              → self-call (resolve against the enclosing class)
//   `Foo.m()`              → receiver = `Foo` (resolves a class method via methodsByClass)
//   `obj.m()` / `obj&.m()` → receiver = `obj` (a lowercase local — never collides
//                            with a Capitalized class name, so it stays an
//                            unresolved name-keyed member ref; Ruby needs no PHP-
//                            style `$` sigil guard)
//   `A::B.m()`             → receiver = `B` (the scope's last constant)
//   chained `a.b.c()` / `f().g()` / `a[0].m()` → RECEIVER_OPAQUE (findable, never resolved)
function rubyMemberCallInfo(callee: Node): MemberCallInfo | null {
  if (callee.type !== 'call') return null;
  const method = callee.childForFieldName('method');
  if (!method || method.type !== 'identifier') return null; // operators parse as `binary`, not `call`
  const property = method.text;
  const receiver = callee.childForFieldName('receiver');
  if (!receiver) return null; // bare — handled in getCallee, never reaches here
  if (receiver.type === 'self') return { receiver: 'self', property, isSelf: true };
  if (receiver.type === 'identifier' || receiver.type === 'constant') {
    return { receiver: receiver.text, property, isSelf: false };
  }
  if (receiver.type === 'scope_resolution') {
    const name = receiver.childForFieldName('name');
    return { receiver: name?.text ?? RECEIVER_OPAQUE, property, isSelf: false };
  }
  // chained / indexed / parenthesized / computed receiver → opaque.
  return { receiver: RECEIVER_OPAQUE, property, isSelf: false };
}

// ── complexity (cyclomatic + cognitive) ──────────────────────────────────────
//
// BOTH metrics pinned EXACT to sonar-ruby — SonarSource's SLANG-based analyzer —
// via a RUNNABLE per-function oracle: the sonar-ruby-plugin's `RubyConverter`
// (JRuby + whitequark/parser) builds the SLANG tree, then the shared
// `org.sonarsource.slang` `CyclomaticComplexityVisitor` / `CognitiveComplexity`
// score each function. The increments below were MEASURED against that oracle on a
// per-construct battery + the sinatra/rack/liquid/devise corpus, never guessed —
// the campaign standard (oracle the PIN). See the project docs' "Cyclomatic /
// Cognitive Complexity Rules".

// CYCLOMATIC (SLANG `CyclomaticComplexityVisitor`): base +1 per named function,
// then +1 per IfTree (if/unless/elsif/ternary/modifier-if/unless), +1 per LoopTree
// (while/until/for/modifier-while/until), +1 per MatchCaseTree-with-expression (a
// `when` arm — NOT the `case` container, NOT the `else` arm), and +1 per
// CONDITIONAL_AND/OR binary (the rubyCyclomaticExtra predicate). NOTABLY ABSENT
// (measured, matching the pin — sonar-ruby is the "compare to SonarQube" north
// star): `rescue`/`rescue_modifier` (SLANG registers no CatchTree cyclomatically —
// consistent with sonar-java/JS omitting catch; defensible, so NOT forked toward
// rubocop, which DOES count rescue), `case/in` pattern matching (`case_match`/
// `in_clause` map to an uncounted native tree — a converter limitation, rare in
// real Ruby), and `&.` safe-navigation. These are deliberate pin-faithful
// divergences from rubocop/McCabe, documented in the project docs.
const RUBY_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if', 'elsif', 'unless', 'if_modifier', 'unless_modifier', // IfTree (+1 each)
  'while', 'until', 'for', 'while_modifier', 'until_modifier', // LoopTree (+1 each)
  'when', // MatchCaseTree with expression (the case container + `else` arm add nothing)
  'conditional', // ternary `?:` → IfTree (+1)
]);

// Boolean operators counted by SLANG (BinaryExpressionTree CONDITIONAL_AND/OR):
// the symbolic `&&`/`||` AND the keyword `and`/`or` (both are `binary` nodes). The
// shared isCFamilyBooleanOperator only matches `&&`/`||`/`??`, so Ruby reads the
// `operator` field token itself. Returns the raw operator TEXT (not a normalized
// kind) because SLANG's cognitive run-collapse compares operator TEXT — so `&&`
// and `and` are DISTINCT runs (`a && b and c` = cog 2), oracle-verified.
const RUBY_BOOLEAN_OPS: ReadonlySet<string> = new Set(['&&', '||', 'and', 'or']);
function rubyBooleanKind(node: Node): string | null {
  if (node.type !== 'binary') return null;
  const op = node.childForFieldName('operator')?.type;
  return op !== undefined && RUBY_BOOLEAN_OPS.has(op) ? op : null;
}
function rubyCyclomaticExtra(node: Node): boolean {
  return rubyBooleanKind(node) !== null;
}

// Complexity body boundary — SEPARATE from RUBY_SKIP_TYPES (the resolveCalls
// boundary), which includes `method`/`singleton_method`. A method's PendingBody.body
// IS a `method`/`singleton_method` node, so reusing RUBY_SKIP_TYPES would root-skip
// the whole body (the engine's root guard + the cognitive walk both bail on a
// skip-typed root) → every method reads trivial. So the cognitive + root boundary
// lists ONLY the type/namespace nodes; blocks (`block`/`do_block`) DESCEND (roll
// into the enclosing method — they are SLANG NativeTrees, transparent, no nesting),
// and a NESTED `def` is descended pass-through cognitively (its control flow rolls
// into the encloser WITHOUT a nesting bump — a documented minor cognitive
// under-count vs the oracle's per-funcTree roll-in; nested defs are rare in Ruby,
// the Java-anon-class / PHP-nested-fn precedent).
const RUBY_COMPLEXITY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'class', 'module', 'singleton_class',
]);

// CYCLOMATIC-only child skip: additionally exclude nested `def`/`def self.x` so a
// nested method's decisions don't count toward the encloser (the per-symbol model —
// SLANG's per-funcTree oracle rolls them in, a rare documented divergence). The
// root method body is checked against RUBY_COMPLEXITY_SKIP_TYPES (which lacks
// `method`), so it survives; only nested-method CHILDREN are skipped here.
const RUBY_CYCLOMATIC_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...RUBY_COMPLEXITY_SKIP_TYPES,
  'method', 'singleton_method',
]);

// Never-matching paren sentinel: SLANG's `flattenOperators` does NOT skip
// parentheses (the `// TODO parentheses` in CognitiveComplexity.java), so a
// parenthesized boolean is its OWN run — `(a && b) && c` = cog 2, oracle-verified.
// The sentinel makes the engine's skipParens a no-op (the gocognit/sonar-python
// convention).
const RUBY_NO_PAREN = '__ruby_no_paren__';

// Statement-list container PARENT node types where a `?:`/`if`-else sits in STATEMENT
// position (→ if-else, +2). Maps to a SLANG BlockTree: an if/loop/case body (`then`/
// `else`/`ensure`/`do`), a `begin` body, the top level, AND a string `interpolation`
// (`"#{a ? x : y}"` is +2 — measured; the interpolation embeds a statement list). NOT
// included (→ EXPRESSION position, +1 ternary): `block_body` (a brace `{ }` block, a
// SLANG NativeTree) and a `body_statement` whose grandparent is a `do_block` (a
// `do…end` block, also a NativeTree) — both handled in rubyInStatementPosition.
const RUBY_STATEMENT_PARENTS: ReadonlySet<string> = new Set([
  'then', 'else', 'ensure', 'do', 'begin', 'program', 'interpolation',
]);

// True when an if-family node is in STATEMENT position (value discarded / a statement
// in a SLANG BlockTree), false when in EXPRESSION position (assignment RHS, arg,
// operator operand, OR the SOLE statement of a do/brace block — a NativeTree whose
// value is the block's result). The block-body distinction is the subtle bit, measured
// against the oracle: a method/class/module/begin body is ALWAYS a BlockTree (a
// single-statement method body is still +2), but a BLOCK body (brace `block_body` or a
// `do_block`'s `body_statement`) is a NativeTree → EXPRESSION only when it holds ONE
// statement (the if-else is the block's return value); a MULTI-statement block body is
// a BlockTree → STATEMENT. (A ternary nested in an arg/expression inside a multi-stmt
// block is still expression — its immediate parent is the arg, not the block body.)
function rubyInStatementPosition(node: Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  const t = parent.type;
  if (t === 'block_body') return parent.namedChildCount > 1; // brace block: sole stmt → expr, multi → stmt
  if (t === 'body_statement') {
    return parent.parent?.type === 'do_block' ? parent.namedChildCount > 1 : true; // do_block sole → expr
  }
  return RUBY_STATEMENT_PARENTS.has(t);
}

// SLANG BlockTree node types: a STATEMENT-LIST that, when it holds >1 statement, is a
// BlockTree (a single statement is unwrapped to the bare expression). A string
// `interpolation` (`#{…}`) is ALWAYS a BlockTree (it embeds a statement list).
const RUBY_BLOCK_LIST_NODES: ReadonlySet<string> = new Set([
  'then', 'else', 'ensure', 'do', 'block_body', 'body_statement', 'begin',
]);

// True if the subtree under `node` contains a SLANG BlockTree — an `interpolation`, or
// a multi-statement statement-list. This is `isTernaryOperator`'s final condition
// (`tree.descendants().noneMatch(BlockTree)`): an if-with-else whose branches embed a
// BlockTree (e.g. a string interpolation `["#{x}"] + super`, or a multi-statement
// then/else) is NOT a ternary even in expression position. The DFS INTENTIONALLY
// descends EVERYTHING — including a nested `def`/`class` in a branch — because SLANG's
// `tree.descendants()` does too; a nested scope's multi-statement body IS a BlockTree
// that disqualifies the ternary (oracle-confirmed: `v = if a; def g; x; y; end; else;
// z; end` is cog 2, not 1). This is DELIBERATELY a different boundary from the
// per-symbol cognitive walk (which skips nested scopes) — do NOT add a skip here, it
// would diverge from the pin. It early-returns on the first BlockTree (a nested scope
// is almost always multi-statement → detected immediately), so the bounded DFS stays
// cheap on the small if-else subtree.
function rubyHasBlockTree(node: Node): boolean {
  const stack: Node[] = [...node.namedChildren];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.type === 'interpolation') return true;
    if (RUBY_BLOCK_LIST_NODES.has(n.type) && n.namedChildCount > 1) return true;
    for (const c of n.namedChildren) stack.push(c);
  }
  return false;
}

// True when an if-family node is an EXPRESSION-TERNARY (sonar-ruby `isTernaryOperator`):
// an if-with-else used as an EXPRESSION (not statement position) with NO nested BlockTree
// (single-statement branches, no string interpolation) → its `else` +1 is SUPPRESSED
// (cog 1, not 2). Measured against the SLANG oracle:
//   v = cond ? a : b        → ternary (+1)       def f; cond ? a : b; end → NOT (+2)
//   v = if a; x; else; y end → ternary (+1)      if a; x; else; y; end    → NOT (+2)
//   arr.each { if a;x else y } → ternary (+1)    "#{cond ? a : b}"        → NOT (+2, interpolation)
//   v = if a; x; elsif…      → NOT (elsif-chain, +3)   v = if a; p; q; else… → NOT (multi-stmt, +2)
//   @x ||= if a; ["#{p}"]; else; q; end → NOT (+2, interpolation in a branch)
// A `?:` (`conditional`) and an `if`/`unless` with a PLAIN `else` (no elsif) both qualify
// when expression-position AND BlockTree-free; `elsif` is never a standalone ternary.
function rubyIsExpressionTernary(node: Node): boolean {
  if (rubyInStatementPosition(node)) return false; // statement position → if-else, charge else
  if (node.type === 'conditional') return !rubyHasBlockTree(node); // `?:`: ternary iff no nested BlockTree
  if (node.type !== 'if' && node.type !== 'unless') return false; // elsif / others: never standalone
  const alt = node.childForFieldName('alternative');
  if (!alt || alt.type !== 'else') return false; // no else, or an elsif-chain
  return !rubyHasBlockTree(node);
}

// COGNITIVE (SLANG `CognitiveComplexity`). SLANG's nesting is ANCESTOR-based — every
// IfTree(non-elseif)/LoopTree/MatchTree/CatchTree ancestor adds a level (reset at a
// class), so a construct's CONDITION nests too (unlike sonar-java, where the engine
// visits if-conditions at base). Consequences of that, all oracle-measured:
//  - `unless`/`elsif` are if-like (the collectionIfType SET — the engine widening
//    this slice): `unless` surcharges + handles its `else`; `elsif` is the chain
//    link recursed by handleAlternative. (`if a; x; elsif b; y; else z` = cog 3.)
//  - Modifier `if`/`unless` go in loopTypes (surcharge + bump ALL children — the engine's
//    loop branch nests every child at nesting+1 because Ruby leaves `loopBodyField` unset,
//    unlike Python which nests only the body), NOT collectionIfType: SLANG's ancestor-nesting
//    bumps a modifier's CONDITION too (`x if (a?b:c)` = cog 3), and their then-branch lives
//    under `body`, not `consequence`. Modifier loops bump-all likewise. So loopTypes carries
//    the 3 real loops + the 4 modifier forms.
//  - `conditional` (ternary) is +1 (ternaryType) — the dominant EXPRESSION-ternary
//    form (`x = a?1:2` = cog 1); a rare BARE-statement ternary is +2 in SLANG (it
//    becomes an if-else) → a documented near-zero under-count.
//  - whole `case` is +1 (switchTypes/MatchTree); `case/in` is uncounted (not MatchTree).
//  - block `rescue` is +1+nesting (catchType/CatchTree); modifier `x rescue y` is
//    UNCOUNTED cognitively (not a CatchTree).
//  - Ruby BLOCKS (`{}`/`do..end`) are SLANG NativeTrees → TRANSPARENT (no nesting):
//    a 3-deep block keeps an inner `if` at base nesting → nestOnlyTypes is EMPTY.
//  - booleans: source-order, +1 per operator-TEXT change, NO paren skip (above).
//  - no recursion (SLANG doesn't count it), no labeled jumps (Ruby has none).
const RUBY_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if',
  collectionIfType: new Set(['unless', 'elsif']),
  conditionField: 'condition',
  consequenceField: 'consequence',
  alternativeField: 'alternative',
  loopTypes: new Set([
    'while', 'until', 'for',
    'while_modifier', 'until_modifier', 'if_modifier', 'unless_modifier',
  ]),
  switchTypes: new Set(['case']),
  ternaryType: 'conditional',
  // sonar-ruby's isTernaryOperator: a simple if-with-else used as an EXPRESSION
  // suppresses its `else` +1 (applies to `?:` AND `if`/`unless`). See the helper.
  isExpressionTernary: rubyIsExpressionTernary,
  catchType: 'rescue',
  // Only an explicit `begin … rescue` (parent `begin`) is a SLANG CatchTree (+1); a
  // METHOD-level rescue (`def f; …; rescue E; …`, parent `body_statement`) is
  // uncounted — measured on the corpus (rescue parents: begin / body_statement only).
  catchPredicate: (node) => node.parent?.type === 'begin',
  nestOnlyTypes: new Set(),
  labeledJumpTypes: new Set(),
  hasLabel: () => false,
  booleanOperatorKind: rubyBooleanKind,
  parenthesizedType: RUBY_NO_PAREN,
};

// ── symbol extraction ─────────────────────────────────────────────────────────

type Visibility = 'public' | 'protected' | 'private';

// Per-file duplicate-id disambiguation (the Kotlin/Dart/C#/PHP OccurrenceCounter):
// two same-(name,kind,signature,qualifier) symbols get an ordinal qualifier.
type OccurrenceCounter = Map<string, number>;

interface RubyCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
}

export function extractRuby(tree: Tree, content: string, fileInfo: FileInfo): ExtractResult {
  const ctx: RubyCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  // Top level: no enclosing class, no visibility state (top-level defs are public).
  extractBody(ctx, tree.rootNode.namedChildren, null, '', true);

  // Same-name types/modules share the simple-name FQN; resolving through them
  // first-wins would bind to the WRONG one, so exclude them from extract-time
  // resolution. Same for same-name top-level functions (the bare-path analogue).
  const ambiguousClassNames = collectAmbiguousTypeNames(ctx.symbols, new Set(['class', 'module']));
  const ambiguousBareCallees = collectAmbiguousTypeNames(ctx.symbols, new Set(['function']));

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    RUBY_SELECTORS,
    RUBY_SKIP_TYPES,
    RUBY_FUNCTION_BODY_SKIP_TYPES,
    rubyMemberCallInfo,
    {
      bareCalleeTypes: RUBY_BARE_CALLEE_TYPES,
      plainCalleeType: RUBY_PLAIN_CALLEE_TYPE,
      bareCallableKinds: RUBY_BARE_CALLABLE_KINDS,
      bareCallsBindToEnclosingClass: true, // implicit self
      constructorKinds: RUBY_CONSTRUCTOR_KINDS,
      ambiguousClassNames,
      ambiguousBareCallees,
      ignoredBareCallees: RUBY_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: RUBY_IGNORED_MEMBER_CALLEES,
    },
  );

  // Cyclomatic + cognitive complexity (sonar-ruby SLANG-pinned), computed while the
  // tree is alive (the php/csharp call-site pattern). The complexity boundary is
  // SEPARATE from the resolveCalls RUBY_SKIP_TYPES (which includes the method node
  // types a method's own PendingBody.body IS — see RUBY_COMPLEXITY_SKIP_TYPES).
  // Cyclomatic additionally excludes nested defs (the Shallow per-function model).
  computeComplexity(ctx.bodies, ctx.symbols, {
    decisionNodeTypes: RUBY_DECISION_NODE_TYPES,
    extraDecisionPredicate: rubyCyclomaticExtra,
    skipTypes: RUBY_COMPLEXITY_SKIP_TYPES,
    cyclomaticSkipTypes: RUBY_CYCLOMATIC_SKIP_TYPES,
    cognitive: RUBY_COGNITIVE_OPTIONS,
  });
  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Walks a class/module/top-level body in DOCUMENT ORDER, tracking the current
// visibility (Ruby's `private`/`protected`/`public` are stateful positional
// modifiers). `className === null` is the top level (no class, defs are functions,
// always exported — no visibility state). A class/module body resets visibility to
// public at entry; a per-body name→symbol map supports the retroactive
// `private :foo` form.
function extractBody(
  ctx: RubyCtx,
  children: readonly Node[],
  className: string | null,
  qualifier: string,
  containerExported: boolean,
): void {
  let visibility: Visibility = 'public';
  // name → the symbols emitted under that name in THIS body (for `private :foo`).
  const byName = new Map<string, Symbol[]>();
  const record = (sym: Symbol): void => pushByName(byName, sym);
  const exportedNow = (): boolean =>
    className === null ? true : containerExported && visibility !== 'private';

  for (const child of children) {
    switch (child.type) {
      case 'method': {
        const sym = extractMethod(ctx, child, className, qualifier, exportedNow());
        if (sym) record(sym);
        break;
      }
      case 'singleton_method': {
        // `def self.x` — a class method of the enclosing class. `def obj.x` on an
        // arbitrary object is skipped (no static owner).
        const obj = child.childForFieldName('object');
        if (className !== null && obj?.type === 'self') {
          const sym = extractMethod(ctx, child, className, qualifier, exportedNow());
          if (sym) record(sym);
        }
        break;
      }
      case 'class':
      case 'module':
        extractClassOrModule(ctx, child, qualifier, containerExported);
        break;
      case 'singleton_class':
        // `class << self` — its methods are class methods of the enclosing class.
        if (className !== null) {
          const body = child.childForFieldName('body');
          if (body) extractBody(ctx, body.namedChildren, className, qualifier, containerExported);
        }
        break;
      case 'assignment':
        extractConstant(ctx, child, className, qualifier, exportedNow());
        break;
      case 'identifier':
        // A bare no-arg `private`/`protected`/`public` flips visibility for the
        // following sibling defs (only inside a class/module body).
        if (className !== null) {
          const v = visibilityKeyword(child.text);
          if (v) visibility = v;
        }
        break;
      case 'call':
        visibility = handleBodyCall(ctx, child, className, qualifier, containerExported, visibility, byName);
        break;
      default:
        break;
    }
  }
}

// A `call` in a class/module/top-level body. Handles the call-FORM visibility
// modifiers (`private :foo`, `private def foo`, a bare-call `private`), `attr_*`
// accessor synthesis, and `require`-family imports. Returns the (possibly updated)
// visibility. Other calls (mixins `include M`, executable class-level code) are
// not symbols.
function handleBodyCall(
  ctx: RubyCtx,
  call: Node,
  className: string | null,
  qualifier: string,
  containerExported: boolean,
  visibility: Visibility,
  byName: Map<string, Symbol[]>,
): Visibility {
  const method = call.childForFieldName('method');
  if (!method || method.type !== 'identifier' || call.childForFieldName('receiver')) {
    return visibility; // only bare `name(...)` forms matter here
  }
  const name = method.text;
  const args = call.childForFieldName('arguments');

  if (className !== null) {
    const v = visibilityKeyword(name);
    if (v) {
      // `private`/`protected`/`public` WITH arguments: a symbol-list form
      // (`private :a, :b` → retroactively set those already-emitted members) or a
      // def-arg form (`private def foo`). Neither flips the running visibility.
      let touched = false;
      for (const arg of args?.namedChildren ?? []) {
        if (arg.type === 'simple_symbol') {
          touched = true;
          const sym = byName.get(symbolName(arg.text));
          if (sym) for (const s of sym) s.exported = containerExported && v !== 'private';
        } else if (arg.type === 'method' || arg.type === 'singleton_method') {
          touched = true;
          const exported = containerExported && v !== 'private';
          const obj = arg.childForFieldName('object');
          if (arg.type === 'method' || obj?.type === 'self') {
            const s = extractMethod(ctx, arg, className, qualifier, exported);
            if (s) pushByName(byName, s);
          }
        }
      }
      // A bare-call `private` (no args, parsed as a `call` not an `identifier` in
      // some contexts) flips the running visibility.
      if (!touched) return v;
      return visibility;
    }

    if (name === 'attr_accessor' || name === 'attr_reader' || name === 'attr_writer' || name === 'attr') {
      extractAttrAccessors(ctx, call, name, args, className, qualifier, containerExported && visibility !== 'private', byName);
      return visibility;
    }
  }

  if (name === 'require' || name === 'require_relative' || name === 'load' || name === 'autoload') {
    extractRequire(ctx, call, name, args);
  }
  return visibility;
}

// A `def`/`def self.x` → 'method' (in a class/module) or 'function' (top level).
function extractMethod(
  ctx: RubyCtx,
  decl: Node,
  className: string | null,
  qualifier: string,
  exported: boolean,
): Symbol | null {
  const name = methodName(decl);
  if (!name) return null;
  const kind: SymbolKind = className === null ? 'function' : 'method';
  const fqn = className === null ? topFqn(ctx, name) : memberFqn(ctx, className, name);
  const sym = makeRubySymbol(ctx, decl, rubySig(ctx, decl), kind, name, fqn, exported, rubyDoc(decl), qualifier);
  ctx.symbols.push(sym);
  // The whole decl is the PendingBody so calls in parameter defaults attribute
  // here alongside the body. className threads self-call resolution.
  ctx.bodies.push({ symbolId: sym.id, body: decl, className: className ?? undefined });
  return sym;
}

// A `class C < S` / `module M` → 'class'/'module' symbol; recurse the body. Top-
// level types are always exported (Ruby has no type-level privacy short of
// `private_constant`, a documented v1 gap). The class/module name folds into the
// member qualifier (the C#/Kotlin/PHP rule) so members of same-name types get
// distinct hashed ids.
function extractClassOrModule(
  ctx: RubyCtx,
  decl: Node,
  qualifier: string,
  containerExported: boolean,
): void {
  const nameNode = decl.childForFieldName('name');
  // `class A::B` (scope_resolution name) → use the last constant as the simple name.
  const name =
    nameNode?.type === 'constant'
      ? nameNode.text
      : nameNode?.type === 'scope_resolution'
        ? nameNode.childForFieldName('name')?.text ?? null
        : null;
  if (!name) return;
  const kind: SymbolKind = decl.type === 'module' ? 'module' : 'class';
  const exported = containerExported; // type-level privacy not modelled
  ctx.symbols.push(
    makeRubySymbol(ctx, decl, rubySig(ctx, decl), kind, name, topFqn(ctx, name), exported, rubyDoc(decl), qualifier),
  );
  const body = decl.childForFieldName('body');
  if (!body) return;
  extractBody(ctx, body.namedChildren, name, joinQualifier(qualifier, name), exported);
}

// `NAME = ...` (a `constant` LHS) → 'variable'. Lowercase locals, `@ivar`s, and
// `@@cvar`s are NOT symbols (Ruby has no field declarations). The whole assignment
// is the PendingBody so the RHS's calls attribute to the constant.
function extractConstant(
  ctx: RubyCtx,
  assign: Node,
  className: string | null,
  qualifier: string,
  exported: boolean,
): void {
  const left = assign.childForFieldName('left');
  if (!left || left.type !== 'constant') return;
  const name = left.text;
  const sym = makeRubySymbol(
    ctx,
    assign,
    rubyConstSig(ctx, assign),
    'variable',
    name,
    className === null ? topFqn(ctx, name) : memberFqn(ctx, className, name),
    exported,
    rubyDoc(assign),
    qualifier,
  );
  ctx.symbols.push(sym);
  ctx.bodies.push({ symbolId: sym.id, body: assign, className: className ?? undefined });
}

// `attr_accessor :a, :b` / `attr_reader` / `attr_writer` → one 'method' symbol per
// symbol argument (Ruby's "field" pattern, but the accessors are CALL targets
// `obj.a`, so method-kind not variable). No PendingBody (no body to attribute).
function extractAttrAccessors(
  ctx: RubyCtx,
  call: Node,
  kind: string,
  args: Node | null,
  className: string,
  qualifier: string,
  exported: boolean,
  byName: Map<string, Symbol[]>,
): void {
  for (const arg of args?.namedChildren ?? []) {
    if (arg.type !== 'simple_symbol') continue;
    const name = symbolName(arg.text);
    if (!name) continue;
    const sig = normalizeSignature(`${kind} :${name}`);
    const sym = makeRubySymbol(ctx, call, sig, 'method', name, memberFqn(ctx, className, name), exported, null, qualifier);
    ctx.symbols.push(sym);
    pushByName(byName, sym);
  }
}

// `require 'set'` / `require_relative '../lib/foo'` / `autoload :Bar, 'bar'` →
// ImportInfo. Low cross-file value (Ruby load paths are load-path-relative, rarely
// map to indexed files — the Rust/PHP framing). sourceModule = the string literal.
function extractRequire(ctx: RubyCtx, call: Node, _kind: string, args: Node | null): void {
  const strArg = args?.namedChildren.find((a) => a.type === 'string');
  if (!strArg) return;
  const content = stringContent(strArg);
  if (!content) return;
  ctx.imports.push({
    file: ctx.fileInfo.path,
    sourceModule: content,
    importedNames: [{ name: '*' }], // IMPORT_NAMESPACE-style — require has no named binding
    line: call.startPosition.row + 1,
  });
}

// ── helpers ────────────────────────────────────────────────────────────────

function visibilityKeyword(text: string): Visibility | null {
  return text === 'private' || text === 'protected' || text === 'public' ? text : null;
}

// Append a symbol to the per-body name→symbols map (get-or-create). Used by the
// three recording sites (the extractBody `record` closure, the `private def`
// arm, attr_* synthesis) — they live in separate functions sharing only `byName`.
function pushByName(byName: Map<string, Symbol[]>, sym: Symbol): void {
  const list = byName.get(sym.name);
  if (list) list.push(sym);
  else byName.set(sym.name, [sym]);
}

// The method name from a `method`/`singleton_method` `name:` field: an
// `identifier` (incl. predicate `valid?` / bang `save!`), a `setter` (`name=`), or
// an `operator` (`+`, `[]`). Each node's text already carries the full name.
function methodName(decl: Node): string | null {
  return decl.childForFieldName('name')?.text ?? null;
}

// `:name` → `name` (a `simple_symbol` node's text includes the leading colon).
function symbolName(text: string): string {
  return text.startsWith(':') ? text.slice(1) : text;
}

// The body of a string literal (between the quotes), skipping interpolations.
function stringContent(str: Node): string | null {
  const c = str.namedChildren.find((n) => n.type === 'string_content');
  return c?.text ?? null;
}

// Signature = source from the decl start to the `body:` field. When the body is
// EMPTY there is no body field (`class Widget\nend`), so cut before the trailing
// `end` keyword token instead — a string-strip of "end" would corrupt a name that
// ends in "end" (`class Friend`). Ruby has no leading attributes.
function rubySig(ctx: RubyCtx, decl: Node): string {
  const body = decl.childForFieldName('body');
  let end: number;
  if (body) end = body.startIndex;
  else {
    const endTok = decl.children.find((c) => c?.type === 'end');
    end = endTok ? endTok.startIndex : decl.endIndex;
  }
  return normalizeSignature(ctx.content.slice(decl.startIndex, end));
}

// Constant signature = just the `NAME` head — the `= <rhs>` is dropped (it can be
// large, and the RHS in the id hash would bloat it), matching the PHP/C# const-
// signature convention. Cut at the `right:` value; an OccurrenceCounter `#n`
// disambiguates a same-name redefinition.
function rubyConstSig(ctx: RubyCtx, assign: Node): string {
  const right = assign.childForFieldName('right');
  const end = right ? right.startIndex : assign.endIndex;
  let sig = normalizeSignature(ctx.content.slice(assign.startIndex, end));
  if (sig.endsWith('=')) sig = sig.slice(0, -1).trimEnd();
  return sig;
}

// Doc = the contiguous `#` comment block immediately above the decl (the RDoc
// convention; `=begin/=end` blocks are not handled in v1). Consecutive `#` lines
// are SEPARATE comment nodes — take the nearest one's first content line.
function rubyDoc(decl: Node): string | null {
  const prev = decl.previousNamedSibling;
  if (
    prev &&
    prev.type === 'comment' &&
    prev.text.startsWith('#') &&
    prev.endPosition.row === decl.startPosition.row - 1 &&
    !isTrailingComment(prev)
  ) {
    return commentDocLine(prev.text);
  }
  return null;
}

function topFqn(ctx: RubyCtx, name: string): string {
  return `${ctx.fileInfo.path}:${name}`;
}

function memberFqn(ctx: RubyCtx, className: string, name: string): string {
  return `${ctx.fileInfo.path}:${className}.${name}`;
}

// The qualifier only disambiguates hashed ids — any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}::${b}`;
}

function makeRubySymbol(
  ctx: RubyCtx,
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
