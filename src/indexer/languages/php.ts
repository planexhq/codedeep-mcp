import type { Node, Tree } from 'web-tree-sitter';

import { collectAmbiguousTypeNames } from '../extractor.js';
import { RECEIVER_OPAQUE } from '../../types.js';
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
import { computeComplexity } from '../complexity.js';
import type { CognitiveOptions } from '../complexity.js';

// Type-declaration node types → SymbolKind. A `trait` maps to **class** (PHP
// traits are concrete, stateful, member-bearing mixins — unlike Rust's
// interface-like traits — so 'class' fits, and the sliced signature still
// carries the literal `trait` keyword for display, the Go struct → 'class'
// rule). enum → enum (cases NOT extracted, the universal rule). PHP has no
// nested type declarations, so there is no in-body type recursion.
const PHP_TYPE_KIND: Record<string, SymbolKind> = {
  class_declaration: 'class',
  trait_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};

// Nested named `function_definition`s create their own scope — their calls must
// NOT attribute to an enclosing body, and they are not extracted as symbols
// (the global no-nested-functions rule). Closures (`arrow_function`,
// `anonymous_function`) are deliberately ABSENT → DESCENDED so their calls
// attribute to the enclosing body (the Go/Kotlin/Dart lambda rule).
const PHP_FUNCTION_BODY_SKIP_TYPES: ReadonlySet<string> = new Set(['function_definition']);

// walkCalls skip set: nested funcs (own scope) + `attribute_list` (PHP-8
// `#[Attr(Bar())]` parses a real call inside the leading attribute node — the
// Dart/C# `annotation` rule) + the type declarations themselves. PHP class
// members each own a per-member PendingBody, so the module-root walk never
// needs to descend INTO a type to find their calls; pruning the type nodes also
// stops a rare function-nested `class {}`'s method calls from mis-attributing to
// the enclosing body. (Top-level script calls are direct program children, so
// they are unaffected.)
const PHP_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...PHP_FUNCTION_BODY_SKIP_TYPES,
  'attribute_list',
  'class_declaration',
  'interface_declaration',
  'trait_declaration',
  'enum_declaration',
  // An ANONYMOUS class (`new class {}`) is not a symbol and its methods own no
  // PendingBody, so without pruning its body the inner calls would attribute to
  // the ENCLOSING method — wrong edges, including wrong `$this->`/`self::`
  // self-edges (the anon `$this` is the anon instance, not the outer class).
  // The anon body is a `declaration_list`; pruning THAT (not the whole
  // anonymous_class) drops the body while keeping the OUTERMOST anon's ctor-arg
  // calls (`new class(make()){}`), which live in the sibling `arguments`. (A
  // `new class(call()){}` nested inside another anon's body loses its ctor-arg
  // edge too — vanishingly rare, a missed edge, never a wrong one.) A NAMED
  // type's declaration_list is never reached in a walk — its parent decl is
  // pruned above — so this targets only the anonymous case (Java's
  // anonymous-internals-not-descended rule).
  'declaration_list',
]);

// PHP's bare/construction callee is a `name` node (NOT the engine-default
// `identifier`, NOR Swift's `simple_identifier`) → reuse `plainCalleeType`.
const PHP_BARE_CALLEE_TYPES: ReadonlySet<string> = new Set(['name']);
const PHP_PLAIN_CALLEE_TYPE = 'name';

// A bare `foo()` is a FREE-FUNCTION call (PHP has top-level functions; an
// instance method always needs `$this->`/`self::`), so bare calls bind to
// functions ONLY — never a class (construction is routed separately) and never
// the enclosing class (no implicit-this). This is the TS/Py model, opposite of
// C#/Kotlin.
const PHP_BARE_CALLABLE_KINDS: ReadonlySet<string> = new Set(['function']);

// `new Foo()` resolves to a 'class'-kind symbol. Its callee is a plain `name`
// (indistinguishable from a bare call by callee type — the C# problem), so it is
// recognized by CALL-NODE type and routed through constructorKinds. Combined
// with the function-only bareCallableKinds above, BOTH wrong-edge directions are
// structurally impossible: a bare `foo()` can never reach a class, and a
// `new Foo()` can never reach a function or method.
const PHP_CONSTRUCTOR_KINDS: ReadonlySet<string> = new Set(['class']);
const PHP_CONSTRUCTOR_SELECTORS: ReadonlySet<string> = new Set(['object_creation_expression']);

// Self-construction keywords: `new self()`/`new static()`/`new parent()` parse
// with a `name` callee whose text is one of these. They are not type names, and
// the engine's constructor-form path has no enclosing-class context to resolve
// them, so the selector drops them (a documented minor recall gap) rather than
// emit junk `self`/`static`-targeted construction refs.
const PHP_SELF_CONSTRUCT = new Set(['self', 'static', 'parent']);

// Common PHP global built-ins: they parse as bare `name` calls but never resolve
// to a local symbol and would otherwise flood the name-keyed reference store.
// Suppressed ONLY when unresolved (a file-local function shadowing the name keeps
// its refs). PHP's stdlib is procedural, so this is larger than the C#/Go sets;
// tune further from dogfood measurement (the Kotlin/Dart empirical method).
// Several constructs that LOOK like calls parse as their own nodes (no entry
// needed): `unset`→unset_statement, `list`→list_assignment, `array`→
// array_creation, `include`/`require`→*_expression, `echo`→echo_statement,
// `print`→print_intrinsic, `exit`→exit_statement. But `isset`/`empty`/`eval`/
// `die` DO parse as function_call_expression with a `name` callee, so they ARE
// listed below — isset/empty especially are among the most frequent PHP tokens
// and would otherwise flood the store.
const PHP_IGNORED_BARE_CALLEES: ReadonlySet<string> = new Set([
  // call-shaped language constructs (function_call_expression, must be listed)
  'isset', 'empty', 'eval', 'die',
  // strings
  'strlen', 'strpos', 'stripos', 'strrpos', 'substr', 'substr_count', 'str_replace',
  'str_ireplace', 'str_repeat', 'str_split', 'str_pad', 'str_contains',
  'str_starts_with', 'str_ends_with', 'strtolower', 'strtoupper', 'ucfirst',
  'ucwords', 'lcfirst', 'trim', 'ltrim', 'rtrim', 'sprintf', 'printf', 'vsprintf',
  'vprintf', 'number_format', 'nl2br', 'wordwrap', 'htmlspecialchars',
  'htmlentities', 'html_entity_decode', 'strip_tags', 'addslashes', 'stripslashes',
  'strrev', 'strtr', 'chunk_split', 'mb_strlen', 'mb_substr', 'mb_strtolower',
  'mb_strtoupper', 'preg_match', 'preg_match_all', 'preg_replace',
  'preg_replace_callback', 'preg_split', 'preg_quote',
  // arrays
  'count', 'sizeof', 'array_map', 'array_filter', 'array_merge', 'array_merge_recursive',
  'array_keys', 'array_values', 'array_key_exists', 'array_key_first', 'array_key_last',
  'array_search', 'array_slice', 'array_splice', 'array_push', 'array_pop',
  'array_shift', 'array_unshift', 'array_reverse', 'array_unique', 'array_flip',
  'array_combine', 'array_fill', 'array_fill_keys', 'array_column', 'array_diff',
  'array_diff_key', 'array_intersect', 'array_intersect_key', 'array_reduce',
  'array_walk', 'array_sum', 'array_product', 'array_chunk', 'array_pad',
  'in_array', 'implode', 'explode', 'join', 'sort', 'rsort', 'usort', 'uasort',
  'uksort', 'ksort', 'krsort', 'asort', 'arsort', 'natsort', 'shuffle', 'range',
  'compact', 'extract', 'current', 'reset', 'end', 'key', 'next', 'prev',
  // type/var
  'is_array', 'is_string', 'is_int', 'is_integer', 'is_long', 'is_bool', 'is_float',
  'is_double', 'is_numeric', 'is_null', 'is_object', 'is_callable', 'is_scalar',
  'is_iterable', 'is_countable', 'is_a', 'is_subclass_of', 'gettype', 'settype',
  'intval', 'floatval', 'doubleval', 'strval', 'boolval', 'var_dump', 'var_export',
  'print_r', 'get_class', 'get_parent_class', 'get_object_vars', 'get_class_methods',
  'property_exists', 'method_exists', 'function_exists', 'class_exists',
  'interface_exists', 'trait_exists', 'enum_exists', 'defined', 'constant',
  'spl_object_id', 'spl_object_hash', 'spl_autoload_register',
  // math
  'abs', 'ceil', 'floor', 'round', 'min', 'max', 'pow', 'sqrt', 'rand', 'mt_rand',
  'random_int', 'random_bytes', 'intdiv', 'fmod', 'pi', 'log', 'exp',
  // json / serialize / encoding
  'json_encode', 'json_decode', 'serialize', 'unserialize', 'base64_encode',
  'base64_decode', 'http_build_query', 'urlencode', 'urldecode', 'rawurlencode',
  // callables / reflection
  'call_user_func', 'call_user_func_array', 'func_get_args', 'func_num_args',
  'func_get_arg', 'define',
  // misc / fs / time
  'dirname', 'basename', 'realpath', 'pathinfo', 'file_exists', 'file_get_contents',
  'file_put_contents', 'fopen', 'fclose', 'fwrite', 'fread', 'fgets', 'is_dir',
  'is_file', 'mkdir', 'unlink', 'getenv', 'putenv', 'error_reporting',
  'trigger_error', 'set_error_handler', 'date', 'time', 'mktime', 'strtotime',
  'microtime', 'sleep', 'usleep', 'header', 'http_response_code',
  'iterator_to_array', 'ctype_digit', 'ctype_alpha', 'dd', 'dump',
]);

// PHP instance methods are overwhelmingly domain/framework, so the member
// suppression set is deliberately small — only clearly-stdlib SPL-protocol /
// Throwable / magic methods whose chained captures would be pure noise (Iterator
// current/next/rewind/valid, ArrayAccess offset*, IteratorAggregate/ArrayObject
// getIterator/getArrayCopy, Throwable get*, jsonSerialize/__toString).
// DELIBERATELY EXCLUDED: `format` — the measure-don't-guess rule (dogfood on
// Carbon/php-parser/symfony-console) found 1166 `->format()` call-sites against 8
// real DOMAIN definitions (Carbon dates, translators, formatters) and zero stdlib
// protocol — i.e. a distinctive fluent domain method this feature exists to
// capture, not the DateTime::format stdlib noise its name suggests. (current/next
// /count are kept despite a few Carbon/collection domain defs: SPL-protocol-
// dominant, small flood, and find_references caps tier-5 rows anyway.)
// <=3-char names are gated downstream by SHORT_NAME_THRESHOLD.
const PHP_IGNORED_MEMBER_CALLEES: ReadonlySet<string> = new Set([
  'getMessage', 'getCode', 'getPrevious', 'getTrace', 'getTraceAsString',
  'getFile', 'getLine', 'current', 'next', 'rewind', 'valid', 'count',
  'offsetGet', 'offsetSet', 'offsetExists', 'offsetUnset', 'getIterator',
  'getArrayCopy', 'jsonSerialize', '__toString',
]);

// ── call selectors ─────────────────────────────────────────────────────────

// Bare `foo()` callee = the `function:` field, kept only when it is a plain
// `name` (drop `qualified_name` namespaced calls — cross-namespace, final
// segment collides — and `variable_name` dynamic `$fn()` calls). A first-class-
// callable `strlen(...)` (sole `variadic_placeholder` argument) is closure
// creation, not a call — suppressed.
function phpFunctionCallCallee(node: Node): Node | null {
  const fn = node.childForFieldName('function');
  if (!fn || fn.type !== 'name') return null;
  if (isFirstClassCallable(node)) return null;
  return fn;
}

// PHP 8.1 first-class-callable syntax (`strlen(...)`, `$obj->m(...)`,
// `C::m(...)`) is closure CREATION, not an invocation: the sole argument is a
// `variadic_placeholder`. Suppressed on every call form so it never emits a
// (wrong-kind) `calls` edge to the wrapped callable.
function isFirstClassCallable(callNode: Node): boolean {
  const args = childOfType(callNode, 'arguments');
  return (
    !!args &&
    args.namedChildren.length === 1 &&
    args.namedChildren[0]?.type === 'variadic_placeholder'
  );
}

// `new Foo()` callee = the first named child (the `new` keyword is anonymous):
// kept only when a plain `name`. `qualified_name` (`new \App\X()`),
// `variable_name` (`new $cls()`), and anonymous-class bodies are dropped, as are
// the self-construction keywords `self`/`static`/`parent`.
function phpObjectCreationCallee(node: Node): Node | null {
  const callee = node.namedChildren[0];
  if (!callee || callee.type !== 'name') return null;
  if (PHP_SELF_CONSTRUCT.has(callee.text)) return null;
  return callee;
}

// Member / nullsafe / scoped call nodes carry their receiver+property directly,
// so the selector returns the call NODE itself; phpMemberCallInfo reads it.
function selfNode(node: Node): Node {
  return node;
}

const PHP_SELECTORS: ReadonlyArray<CallSelector> = [
  { nodeType: 'function_call_expression', getCallee: phpFunctionCallCallee },
  { nodeType: 'object_creation_expression', getCallee: phpObjectCreationCallee },
  { nodeType: 'member_call_expression', getCallee: selfNode },
  { nodeType: 'nullsafe_member_call_expression', getCallee: selfNode },
  { nodeType: 'scoped_call_expression', getCallee: selfNode },
];

// Reduces a member/nullsafe/scoped call to {receiver, property, isSelf}.
//   `$this->m()`            → self-call (resolve against the enclosing class)
//   `$obj->m()` / `$o?->m()`→ unresolvable instance call (receiver keeps the `$`)
//   `Class::m()`            → receiver = `Class` (resolves via methodsByClass!)
//   `self::m()`/`static::m()` → self-call; `parent::m()` → null (super-like)
//   chained/computed `$a->b->c()`, `$cls::m()`, `Foo::bar()::baz()` → RECEIVER_OPAQUE
//   `qualified\Ns::m()`     → null (cross-namespace static path, identity-bearing)
function phpMemberCallInfo(callee: Node): MemberCallInfo | null {
  const t = callee.type;
  if (isFirstClassCallable(callee)) return null; // `C::m(...)` / `$o->m(...)` closure creation
  if (t === 'member_call_expression' || t === 'nullsafe_member_call_expression') {
    const obj = callee.childForFieldName('object');
    const nameNode = callee.childForFieldName('name');
    // A dynamic name (`$obj->$prop()`) has a `variable_name` here, not a `name`;
    // drop it (its `$`-text would be junk in the ref store), like the bare path.
    if (!obj || nameNode?.type !== 'name') return null;
    const prop = nameNode.text;
    // Any non-`variable_name` object is a runtime-computed receiver — chained
    // `$a->b->c()` (member_access) / `$a->b()->c()` (member_call), indexed
    // `$a[0]->m()` (subscript), parenthesized `(new X())->m()` — and is opaque:
    // findable by method name, never resolved. ($this / $obj are variable_name,
    // handled below; an instance receiver is always a value, so unlike the static
    // path there is no class-name/qualified scope to exclude first.)
    if (obj.type !== 'variable_name') {
      return { receiver: RECEIVER_OPAQUE, property: prop, isSelf: false };
    }
    const inner = innerVarName(obj);
    if (inner === 'this') return { receiver: 'this', property: prop, isSelf: true };
    // `->`/`?->` is an INSTANCE call: the receiver is a value, never a type. The
    // engine resolves a non-self receiver via methodsByClass[receiver], so a
    // variable named like a same-file class (`$Request->validate()`) would
    // mis-bind to that class's method — a WRONG edge. Keep the `$` sigil in the
    // recorded receiver so it can never match a (sigil-free) class name; the ref
    // stays unresolved and routes through the cross-file weak-include by name.
    return { receiver: obj.text, property: prop, isSelf: false };
  }
  if (t === 'scoped_call_expression') {
    const scope = callee.childForFieldName('scope');
    const nameNode = callee.childForFieldName('name');
    // `Other::$dynMethod()` has a `variable_name` name — drop the dynamic call.
    if (!scope || nameNode?.type !== 'name') return null;
    const prop = nameNode.text;
    if (scope.type === 'name') return { receiver: scope.text, property: prop, isSelf: false };
    if (scope.type === 'relative_scope') {
      const kw = scope.text;
      if (kw === 'self' || kw === 'static') return { receiver: kw, property: prop, isSelf: true };
      return null; // parent:: → super-like
    }
    // `\Ns\C::m()` (qualified_name) and `namespace\C::m()` (relative_name, the
    // namespace-relative operator) are identity-bearing — their final segment
    // routinely collides with a same-named in-repo class, so they stay null (the
    // deliberate cross-namespace drop, the Rust external-path rule).
    if (scope.type === 'qualified_name' || scope.type === 'relative_name') return null;
    // Every OTHER scope is a runtime-computed receiver — chained `Foo::bar()::baz()`
    // (scoped_call) / `$x->m()::n()` (member_call), dynamic `$cls::create()`
    // (variable_name, the Laravel/Eloquent idiom), indexed `$a[0]::m()` (subscript),
    // parenthesized `(new X())::m()`, `$a->b::c()` (member_access), `make()::m()`
    // (function_call). It is opaque: findable by method name, never resolved —
    // mirroring the instance catch-all above (zero wrong-edge: '()' matches no
    // class, so methodsByClass.get('()') is always undefined).
    return { receiver: RECEIVER_OPAQUE, property: prop, isSelf: false };
  }
  return null;
}

// The inner identifier of a `variable_name` (`$this` → 'this', `$obj` → 'obj').
// The `$` is an anonymous token, so the name is the first NAMED child.
function innerVarName(vn: Node): string | null {
  return vn.namedChildren[0]?.text ?? null;
}

// ── complexity (cyclomatic + cognitive) — pinned EXACT to SonarPHP 3.38.0.12239 ──
// (php-frontend's ComplexityVisitor / CognitiveComplexityVisitor, run as a per-function
// oracle; see the project docs' "Cyclomatic/Cognitive Complexity Rules"). Both metrics MEASURED
// against the real analyzer. TWO master-vs-3.38 divergences are pinned to the RELEASED
// 3.38 (the runnable version users compare against): one-word `elseif` is NOT counted
// cyclomatically (3.38's ComplexityVisitor has no visitElseifClause; master added it),
// and the bitwise `|` (PIPE) is NOT counted cognitively (master added it). PHP also
// FORKS on `match`: it counts each arm like a switch case — a DELIBERATE divergence from
// SonarPHP (which counts `match` in NEITHER metric), user-chosen for McCabe-truth +
// consistency with switch.

// Cyclomatic decision nodes (+1 each). `else_if_clause` is DELIBERATELY ABSENT (3.38
// does not count one-word `elseif`; the inner `if` of a two-word `else if` still counts
// via `if_statement`). `default_statement` and the switch/match CONTAINERS are absent.
// `match_conditional_expression` (each non-default arm) is the match FORK
// (`match_default_expression` excluded). `conditional_expression` covers BOTH the full
// ternary and the elvis `?:` (same node).
const PHP_DECISION_NODE_TYPES: ReadonlySet<string> = new Set([
  'if_statement',
  'for_statement', 'foreach_statement', 'while_statement', 'do_statement',
  'conditional_expression', // ternary + elvis ?:
  'case_statement', // switch case (NOT default_statement)
  'match_conditional_expression', // match arm — the FORK (NOT match_default_expression)
]);

// Cyclomatic booleans: `&&`/`||` AND the word operators `and`/`or` (SonarPHP counts
// CONDITIONAL_AND/OR + ALTERNATIVE_CONDITIONAL_AND/OR), but NOT `xor`, `??`, or `|`.
// One `binary_expression` covers all binary ops, so read the `operator` field token.
const PHP_CYCLOMATIC_BOOLEAN_OPS: ReadonlySet<string> = new Set(['&&', '||', 'and', 'or']);
function phpCyclomaticExtra(node: Node): boolean {
  if (node.type !== 'binary_expression') return false;
  const op = node.childForFieldName('operator')?.type;
  return op !== undefined && PHP_CYCLOMATIC_BOOLEAN_OPS.has(op);
}

// Cognitive boolean-run kind: `&&`/`||` ONLY (3.38 cognitive tests only CONDITIONAL_AND/
// CONDITIONAL_OR — NOT the word `and`/`or`, NOT `xor`/`??`, NOT the PIPE `|` master
// added). Source-order + kind-change + paren-unwrap is the engine default.
const PHP_COGNITIVE_BOOLEAN_OPS: ReadonlySet<string> = new Set(['&&', '||']);
function phpCognitiveBooleanKind(node: Node): string | null {
  if (node.type !== 'binary_expression') return null;
  const op = node.childForFieldName('operator')?.type;
  return op !== undefined && PHP_COGNITIVE_BOOLEAN_OPS.has(op) ? op : null;
}

// Cognitive jump: PHP `break`/`continue` take an optional numeric LEVEL (`break 2;`) —
// SonarPHP charges +1 FLAT only when that argument is present (bare `break;` adds 0).
// The argument is the statement's lone non-comment named child.
function phpJumpHasArgument(node: Node): boolean {
  return node.namedChildren.some((c) => c.type !== 'comment');
}

// Complexity body boundary — SEPARATE from PHP_SKIP_TYPES (the resolveCalls boundary).
// Closures (`anonymous_function`) and arrow fns (`arrow_function`) are DELIBERATELY
// ABSENT → DESCENDED, so they roll into the enclosing function cognitively (nestOnly,
// +1 nesting — SonarPHP's per-function model via visitWithNesting). The type
// declarations + their `declaration_list` body + `attribute_list` ARE skipped (an
// anon-class member's control flow then rolls into nobody — a rare documented
// per-symbol-model under-count, the Java anon-class precedent). `function_definition`
// is NOT listed: a top-level function's PendingBody IS a function_definition, so
// skipping it would root-skip the whole function; nested NAMED functions (vanishingly
// rare in PHP) are instead descended pass-through — a documented minor cognitive
// under-count (cyclomatic still excludes them via PHP_CYCLOMATIC_SKIP_TYPES).
const PHP_COMPLEXITY_SKIP_TYPES: ReadonlySet<string> = new Set([
  'attribute_list',
  'class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration',
  'declaration_list',
]);

// CYCLOMATIC-only child skip: additionally exclude ALL nested functions (closures,
// arrow fns, nested named fns). SonarPHP's per-function cyclomatic uses the
// ShallowComplexityVisitor, which does not descend nested functions (each gets its own
// number). Cognitive instead descends closures/arrow-fns (nestOnly) via the narrower
// PHP_COMPLEXITY_SKIP_TYPES — the Java lambda asymmetry.
const PHP_CYCLOMATIC_SKIP_TYPES: ReadonlySet<string> = new Set([
  ...PHP_COMPLEXITY_SKIP_TYPES,
  'function_definition', 'anonymous_function', 'arrow_function',
]);

// Cognitive config (SonarPHP 3.38 CognitiveComplexityVisitor). PHP's `if_statement`
// holds elseif/else under a REPEATED `alternative` field (the Python elifClauseType
// shape) PLUS the two-word `else if` = else-clause-contains-if hybrid (elseChainsIf, one
// of the two new engine knobs this slice — see complexity.ts; the other is
// ternaryBranchFields below). Loops nest body only (loopBodyField).
// switch + match (the FORK) are whole-+1. catch surcharges; try/finally pass through.
// break/continue WITH a level argument + goto are +1 flat. Booleans `&&`/`||`
// source-order. No recursion (SonarPHP doesn't count it).
const PHP_COGNITIVE_OPTIONS: CognitiveOptions = {
  ifType: 'if_statement',
  conditionField: 'condition',
  consequenceField: 'body',
  alternativeField: 'alternative',
  elifClauseType: 'else_if_clause',
  elseClauseType: 'else_clause',
  elseChainsIf: true, // two-word `else if` (else_clause→if_statement) flatten + extra nesting
  loopTypes: new Set(['for_statement', 'foreach_statement', 'while_statement', 'do_statement']),
  loopBodyField: 'body',
  switchTypes: new Set(['switch_statement', 'match_expression']), // match = the FORK (whole +1)
  ternaryType: 'conditional_expression',
  // Nest ONLY the true/false branches; the condition stays at ambient nesting so a
  // CHAINED elvis `a ?: b ?: c` (each link in the next's condition) doesn't compound —
  // SonarPHP-exact (verified on 5 Laravel chained-elvis cases). Elvis `?:` has only the
  // `alternative` branch; the full ternary adds `body`.
  ternaryBranchFields: ['body', 'alternative'],
  catchType: 'catch_clause',
  nestOnlyTypes: new Set(['anonymous_function', 'arrow_function']), // closures roll in, +0
  labeledJumpTypes: new Set(['break_statement', 'continue_statement']),
  hasLabel: phpJumpHasArgument, // `break 2;`/`continue 2;` → +1 flat (bare → 0)
  flatIncrement: (node) => node.type === 'goto_statement', // goto → +1 flat
  booleanOperatorKind: phpCognitiveBooleanKind,
  parenthesizedType: 'parenthesized_expression', // UNWRAP (SonarPHP removeParenthesis)
  // NO: recursion / booleanByTreeParent / booleanRunStarts / initField / nestElseBody /
  //     conditionFromNamedChildren / positional-if knobs — PHP is field-based.
};

// Per-file duplicate-id disambiguation (the Kotlin/Dart/C# OccurrenceCounter):
// two same-(name,kind,signature,qualifier) symbols get an ordinal qualifier.
type OccurrenceCounter = Map<string, number>;

interface PhpCtx {
  content: string;
  fileInfo: FileInfo;
  occurrences: OccurrenceCounter;
  symbols: Symbol[];
  imports: ImportInfo[];
  bodies: PendingBody[];
}

export function extractPHP(tree: Tree, content: string, fileInfo: FileInfo): ExtractResult {
  const ctx: PhpCtx = {
    content,
    fileInfo,
    occurrences: new Map(),
    symbols: [],
    imports: [],
    bodies: [],
  };

  extractMembers(ctx, tree.rootNode.namedChildren, '');

  // Same-name types share the simple-name FQN (e.g. two classes of the same name
  // in different namespaces in one file); resolving through them first-wins would
  // bind to the WRONG type, so exclude them from extract-time resolution.
  const ambiguousClassNames = collectAmbiguousTypeNames(
    ctx.symbols,
    new Set(['class', 'interface', 'enum']),
  );
  // Same-name top-level functions across namespaces in ONE file share the
  // simple-name FQN too; a bare call to that name would first-wins bind to the
  // wrong namespace's function — keep it unresolved (the bare-path analogue).
  const ambiguousBareCallees = collectAmbiguousTypeNames(ctx.symbols, new Set(['function']));

  const references = resolveCalls(
    ctx.bodies,
    tree.rootNode,
    ctx.symbols,
    fileInfo,
    PHP_SELECTORS,
    PHP_SKIP_TYPES,
    PHP_FUNCTION_BODY_SKIP_TYPES,
    phpMemberCallInfo,
    {
      bareCalleeTypes: PHP_BARE_CALLEE_TYPES,
      plainCalleeType: PHP_PLAIN_CALLEE_TYPE,
      bareCallableKinds: PHP_BARE_CALLABLE_KINDS,
      // PHP has no implicit-this: a bare call is never a sibling-method call.
      bareCallsBindToEnclosingClass: false,
      constructorKinds: PHP_CONSTRUCTOR_KINDS,
      constructorSelectorTypes: PHP_CONSTRUCTOR_SELECTORS,
      ambiguousClassNames,
      ambiguousBareCallees,
      ignoredBareCallees: PHP_IGNORED_BARE_CALLEES,
      ignoredMemberCallees: PHP_IGNORED_MEMBER_CALLEES,
    },
  );
  // Cyclomatic + cognitive complexity (SonarPHP-3.38-pinned), computed while the tree
  // is alive (the Dart/Kotlin/C# call-site pattern). Cyclomatic uses its OWN skip set
  // (nested functions excluded — the Shallow per-function model); cognitive descends
  // closures/arrow-fns (nestOnly) via PHP_COMPLEXITY_SKIP_TYPES.
  computeComplexity(ctx.bodies, ctx.symbols, {
    decisionNodeTypes: PHP_DECISION_NODE_TYPES,
    extraDecisionPredicate: phpCyclomaticExtra,
    skipTypes: PHP_COMPLEXITY_SKIP_TYPES,
    cyclomaticSkipTypes: PHP_CYCLOMATIC_SKIP_TYPES,
    cognitive: PHP_COGNITIVE_OPTIONS,
  });
  return { symbols: ctx.symbols, references, imports: ctx.imports };
}

// Processes a list of program / namespace-body children, threading the current
// namespace qualifier. A file-level `namespace X;` (no body) updates the
// qualifier for all FOLLOWING siblings; a block `namespace X { }` recurses into
// its body with the joined qualifier. Namespaces are NOT symbols — PHP FQNs are
// file-path based, so the namespace path only disambiguates hashed ids.
function extractMembers(ctx: PhpCtx, children: readonly Node[], nsQualifier: string): void {
  let ns = nsQualifier;
  for (const child of children) {
    switch (child.type) {
      case 'namespace_use_declaration':
        extractImport(ctx, child);
        break;
      case 'namespace_definition': {
        const name = child.childForFieldName('name')?.text ?? '';
        const body = child.childForFieldName('body');
        if (body) extractMembers(ctx, body.namedChildren, joinQualifier(ns, name));
        else ns = joinQualifier(nsQualifier, name);
        break;
      }
      case 'function_definition':
        extractFunction(ctx, child, ns);
        break;
      case 'const_declaration':
        // Top-level / namespace-level `const FOO = 1;` → 'variable' symbols (the
        // TS/Go top-level-const convention); always exported (no private here).
        extractConsts(ctx, child, null, ns, true);
        break;
      // Recall gap (Python parity): functions/classes defined inside a top-level
      // `if (!function_exists(..)) { .. }` / version guard (the polyfill idiom)
      // are NOT descended into — accepted, never a wrong edge.
      default:
        if (PHP_TYPE_KIND[child.type] !== undefined) extractType(ctx, child, ns);
        break;
    }
  }
}

// A top-level function → 'function' kind (always exported — PHP has no private
// top-level functions).
function extractFunction(ctx: PhpCtx, decl: Node, ns: string): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const sym = makePhpSymbol(ctx, decl, phpSig(ctx, decl), 'function', name, topFqn(ctx, name), true, phpDoc(decl), ns);
  ctx.symbols.push(sym);
  // The WHOLE decl is the PendingBody so calls in parameter defaults
  // (`function f($x = make())`) attribute here alongside the body.
  ctx.bodies.push({ symbolId: sym.id, body: decl });
}

// A class / interface / trait / enum declaration. Top-level types are always
// exported (PHP types carry no private visibility). Iterates the body for
// members; enum cases are skipped (the universal rule). No nested-type recursion
// — PHP has none.
function extractType(ctx: PhpCtx, decl: Node, ns: string): void {
  const name = decl.childForFieldName('name')?.text;
  if (!name) return;
  const kind = PHP_TYPE_KIND[decl.type]!;
  ctx.symbols.push(
    makePhpSymbol(ctx, decl, phpSig(ctx, decl), kind, name, topFqn(ctx, name), true, phpDoc(decl), ns),
  );

  const body = decl.childForFieldName('body'); // declaration_list / enum_declaration_list
  if (!body) return;
  // Members fold the class name into the hashed qualifier (the C#/Kotlin rule)
  // so two classes' same-(name,kind,signature) members get distinct ids — the
  // class name only otherwise lives in the FQN, which is NOT hashed.
  const memberQualifier = joinQualifier(ns, name);
  for (const member of body.namedChildren) {
    extractMember(ctx, member, name, memberQualifier, true);
  }
}

// A class/interface/trait/enum body member. Methods, properties, and constants
// become symbols; enum cases, trait `use`, and stray tokens are skipped.
function extractMember(
  ctx: PhpCtx,
  member: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  switch (member.type) {
    case 'method_declaration': {
      const name = member.childForFieldName('name')?.text;
      if (!name) return;
      const exported = phpExported(member, containerExported);
      // The WHOLE decl is the PendingBody so parameter-default calls (and, for
      // the constructor, promoted-param defaults + `: parent::__construct(...)`
      // delegation) attribute to the method alongside its body.
      extractCallable(ctx, member, name, className, qualifier, exported);
      if (name === '__construct') {
        extractPromotedProperties(ctx, member, className, qualifier, containerExported);
      }
      return;
    }
    case 'property_declaration':
      extractProperties(ctx, member, className, qualifier, containerExported);
      return;
    case 'const_declaration':
      extractConsts(ctx, member, className, qualifier, containerExported);
      return;
    // enum_case (universal rule), use_declaration (trait use — v1 recall gap),
    // comments, tokens → no symbol.
    default:
      return;
  }
}

// A method / constructor → 'method' symbol keyed `file:Class.name`. The
// constructor keeps its real name `__construct` (the Swift `init` precedent —
// findable, and `self::__construct()` self-delegation resolves); `new C()` binds
// to the CLASS via constructorKinds regardless.
function extractCallable(
  ctx: PhpCtx,
  decl: Node,
  name: string,
  className: string,
  qualifier: string,
  exported: boolean,
): void {
  const sym = makePhpSymbol(ctx, decl, phpSig(ctx, decl), 'method', name, memberFqn(ctx, className, name), exported, phpDoc(decl), qualifier);
  ctx.symbols.push(sym);
  // The whole decl is always the PendingBody (param-default + body calls).
  ctx.bodies.push({ symbolId: sym.id, body: decl, className });
}

// Constructor property promotion (`function __construct(private int $x)`): each
// `property_promotion_parameter` is also a class property. Exported by its OWN
// visibility (the constructor owns its initializer/default calls).
function extractPromotedProperties(
  ctx: PhpCtx,
  ctorDecl: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const plist = ctorDecl.childForFieldName('parameters');
  if (!plist) return;
  for (const param of plist.namedChildren) {
    if (param.type !== 'property_promotion_parameter') continue;
    const vn = param.childForFieldName('name') ?? childOfType(param, 'variable_name');
    const pname = vn ? innerVarName(vn) : null;
    if (!pname || !vn) continue;
    const exported = phpExported(param, containerExported);
    const sig = normalizeSignature(ctx.content.slice(signatureStart(param), vn.endIndex));
    ctx.symbols.push(
      makePhpSymbol(ctx, param, sig, 'variable', pname, memberFqn(ctx, className, pname), exported, null, qualifier),
    );
  }
}

// `[mods] [type] $a = .., $b;` → one 'variable' per `property_element` (name
// without the `$`). Each element owns a per-binding PendingBody (its default
// initializer's calls); the signature drops the `= default`.
function extractProperties(
  ctx: PhpCtx,
  member: Node,
  className: string,
  qualifier: string,
  containerExported: boolean,
): void {
  const exported = phpExported(member, containerExported);
  const doc = phpDoc(member);
  const firstEl = childOfType(member, 'property_element');
  if (!firstEl) return;
  // signatureStart skips a leading PHP-8 `#[Attr]` block, matching phpSig.
  const head = ctx.content.slice(signatureStart(member), firstEl.startIndex);
  for (const el of member.namedChildren) {
    if (el.type !== 'property_element') continue;
    const vn = childOfType(el, 'variable_name');
    const pname = vn ? innerVarName(vn) : null;
    if (!pname) continue;
    const sig = normalizeSignature(`${head}$${pname}`);
    const sym = makePhpSymbol(ctx, member, sig, 'variable', pname, memberFqn(ctx, className, pname), exported, doc, qualifier);
    ctx.symbols.push(sym);
    ctx.bodies.push({ symbolId: sym.id, body: el, className });
  }
}

// `[visibility] const A = .., B = ..;` → one 'variable' per `const_element`
// (its name is the element's first named child — no `name:` field). Each owns a
// per-binding PendingBody (the value expression's calls). `className === null`
// is a top-level / namespace-level const (FQN `file:NAME`, always exported, no
// enclosing class for self-resolution).
function extractConsts(
  ctx: PhpCtx,
  member: Node,
  className: string | null,
  qualifier: string,
  containerExported: boolean,
): void {
  const topLevel = className === null;
  const exported = topLevel ? true : phpExported(member, containerExported);
  const doc = phpDoc(member);
  const firstEl = childOfType(member, 'const_element');
  if (!firstEl) return;
  // signatureStart skips a leading PHP-8 `#[Attr]` block, matching phpSig.
  const head = ctx.content.slice(signatureStart(member), firstEl.startIndex);
  for (const el of member.namedChildren) {
    if (el.type !== 'const_element') continue;
    const cname = el.namedChildren[0]?.text;
    if (!cname) continue;
    const sig = normalizeSignature(`${head}${cname}`);
    const fqn = topLevel ? topFqn(ctx, cname) : memberFqn(ctx, className, cname);
    const sym = makePhpSymbol(ctx, member, sig, 'variable', cname, fqn, exported, doc, qualifier);
    ctx.symbols.push(sym);
    ctx.bodies.push({ symbolId: sym.id, body: el, className: className ?? undefined });
  }
}

// `use App\Model\User;` / `use App\{A, B as C};` / `use Foo as Bar;` →
// ImportInfo per clause. Low cross-file value (PHP namespaces don't map to
// indexed file paths — the Rust/Kotlin framing); the `use function`/`use const`
// distinction is not tracked.
function extractImport(ctx: PhpCtx, node: Node): void {
  const line = node.startPosition.row + 1;
  const group = childOfType(node, 'namespace_use_group');
  if (group) {
    const prefix = childOfType(node, 'namespace_name')?.text ?? '';
    for (const clause of group.namedChildren) {
      if (clause.type === 'namespace_use_clause') addUseClause(ctx, clause, prefix, line);
    }
    return;
  }
  for (const clause of node.namedChildren) {
    if (clause.type === 'namespace_use_clause') addUseClause(ctx, clause, '', line);
  }
}

function addUseClause(ctx: PhpCtx, clause: Node, prefix: string, line: number): void {
  const aliasNode = clause.childForFieldName('alias');
  const pathNode = clause.namedChildren.find(
    (c) => c.id !== aliasNode?.id && (c.type === 'qualified_name' || c.type === 'name'),
  );
  // An empty group-use clause (`use App\{};`) parses to a MISSING name (text "")
  // — skip it rather than emit a phantom import named for the bare prefix.
  if (!pathNode || !pathNode.text) return;
  const full = prefix ? `${prefix}\\${pathNode.text}` : pathNode.text;
  const segs = full.split('\\').filter(Boolean);
  const name = segs[segs.length - 1] ?? full;
  const sourceModule = segs.slice(0, -1).join('\\');
  const imported: ImportedName = aliasNode ? { name, alias: aliasNode.text } : { name };
  ctx.imports.push({ file: ctx.fileInfo.path, sourceModule, importedNames: [imported], line });
}

// ── helpers ──────────────────────────────────────────────────────────────

// PHP's member default is PUBLIC, so a declaration exports unless it carries a
// `private` visibility_modifier (absent / public / protected all export —
// protected is inheritance API; no namespace carve-out). Members AND-in their
// container's exportedness via the caller.
function phpExported(decl: Node, containerExported: boolean): boolean {
  if (!containerExported) return false;
  // PHP 8.4 asymmetric visibility emits TWO visibility_modifiers; the READ
  // (exportedness) visibility is the one WITHOUT a `(set)` suffix (a `(set)`
  // modifier governs writes only). When only `(set)` modifiers exist, GET
  // defaults to public.
  const vis = decl.namedChildren.filter((c) => c.type === 'visibility_modifier');
  const get = vis.find((c) => !c.text.endsWith('(set)'));
  return get ? get.text !== 'private' : true;
}

// Signature = source from the first non-attribute token (modifiers/keyword
// included; leading PHP-8 `#[Attr]` blocks excluded — they blow the 120-char cap
// and collide overload ids, the Java rationale) to the `body:` (compound_statement
// / declaration_list / enum_declaration_list), or the decl end when bodiless
// (abstract/interface methods), with a trailing `;` stripped.
function phpSig(ctx: PhpCtx, node: Node): string {
  const start = signatureStart(node);
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : node.endIndex;
  let sig = normalizeSignature(ctx.content.slice(start, end));
  if (sig.endsWith(';')) sig = sig.slice(0, -1).trimEnd();
  return sig;
}

// Past the leading `attribute_list` children (PHP-8 `#[Attr]` sits before the
// modifiers/keyword; the keyword is anonymous, so start right after them). A
// `comment` that FOLLOWS an attribute is relocated INSIDE the declaration by
// tree-sitter (see phpDoc), so skip it too — but ONLY after an attribute: a
// comment with no preceding attribute (`function /*c*/ name()`) sits AFTER the
// anonymous `function`/`const` keyword, so skipping it would drop the keyword.
function signatureStart(decl: Node): number {
  let start = decl.startIndex;
  let sawAttr = false;
  for (const c of decl.namedChildren) {
    if (c.type === 'attribute_list') {
      start = c.endIndex;
      sawAttr = true;
    } else if (c.type === 'comment' && sawAttr) {
      start = c.endIndex;
    } else break;
  }
  return start;
}

// Doc = a `/** */` PHPDoc block (a single `comment` node). Plain `//` and `#`
// comments are NOT docs (the PHPDoc convention; the Java/Kotlin `/** */`-only
// rule). Normally the block is the declaration's previousNamedSibling — but when
// a leading `#[Attr]` precedes it, tree-sitter relocates the comment INTO the
// declaration (an inner child after the attribute_list(s)), so check there too.
function phpDoc(decl: Node): string | null {
  const nearest = decl.previousNamedSibling;
  if (
    nearest &&
    nearest.type === 'comment' &&
    nearest.endPosition.row === decl.startPosition.row - 1 && // adjacency
    !isTrailingComment(nearest) &&
    nearest.text.startsWith('/**')
  ) {
    return commentDocLine(nearest.text);
  }
  // Attribute-then-doc ordering: the doc is a leading inner child AFTER an
  // attribute_list. Keep scanning past non-doc `//`/`#` comments to a later
  // `/**` block; stop at the first real token. Gate on having seen an attribute
  // (like signatureStart) — a leading inner comment with NO preceding attribute
  // (`function /** x */ f()`) is a mid-header comment, not a relocated doc.
  let sawAttr = false;
  for (const c of decl.namedChildren) {
    if (c.type === 'attribute_list') {
      sawAttr = true;
      continue;
    }
    if (c.type !== 'comment' || !sawAttr) break;
    if (c.text.startsWith('/**')) return commentDocLine(c.text);
  }
  return null;
}

function topFqn(ctx: PhpCtx, name: string): string {
  return `${ctx.fileInfo.path}:${name}`;
}

function memberFqn(ctx: PhpCtx, className: string, name: string): string {
  return `${ctx.fileInfo.path}:${className}.${name}`;
}

function childOfType(node: Node, ...types: string[]): Node | null {
  return node.namedChildren.find((c) => types.includes(c.type)) ?? null;
}

// Namespace path only disambiguates hashed ids — it never reaches FQN parsing —
// so any unique join works.
function joinQualifier(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\\${b}`;
}

function makePhpSymbol(
  ctx: PhpCtx,
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
