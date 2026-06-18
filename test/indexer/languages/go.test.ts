import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { RECEIVER_OPAQUE } from '../../../src/types.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'go', path = 'src/test.go') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

const PKG = 'package main\n\n';

describe('go extractor — functions and exportedness', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts an exported function with kind/fqn/signature/exported/lines', () => {
    const result = extract(`${PKG}func Handle(req string) error {\n\treturn nil\n}\n`);
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('Handle');
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.go:Handle');
    expect(sym.exported).toBe(true);
    expect(sym.signature).toBe('func Handle(req string) error');
    expect(sym.startLine).toBe(3);
    expect(sym.endLine).toBe(5);
    expect(sym.file).toBe('src/test.go');
    expect(sym.language).toBe('go');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
  });

  it('lowercase and underscore-leading names are not exported', () => {
    const result = extract(`${PKG}func helper() {}\nfunc _internal() {}\n`);
    expect(result.symbols.map((s) => s.exported)).toEqual([false, false]);
  });

  it('unicode uppercase first rune is exported', () => {
    const result = extract(`${PKG}func Ärger() {}\nfunc ärger() {}\n`);
    expect(result.symbols.find((s) => s.name === 'Ärger')!.exported).toBe(true);
    expect(result.symbols.find((s) => s.name === 'ärger')!.exported).toBe(false);
  });

  it('keeps type parameters in a generic function signature', () => {
    const sym = extract(
      `${PKG}func Map[T any, U any](in []T, f func(T) U) []U {\n\treturn nil\n}\n`,
    ).symbols[0]!;
    expect(sym.signature).toBe('func Map[T any, U any](in []T, f func(T) U) []U');
  });

  it('extracts a bodiless function (assembly stub) without crashing', () => {
    const result = extract(`${PKG}func Stub(x int) int\n`);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.signature).toBe('func Stub(x int) int');
    expect(result.references).toHaveLength(0);
  });

  it('variadic parameters survive in the signature', () => {
    const sym = extract(`${PKG}func V(xs ...int) {}\n`).symbols[0]!;
    expect(sym.signature).toBe('func V(xs ...int)');
  });

  it('two func init() in one file get distinct ids', () => {
    const result = extract(`${PKG}func init() {\n}\n\nfunc init() {\n}\n`);
    const inits = result.symbols.filter((s) => s.name === 'init');
    expect(inits).toHaveLength(2);
    expect(inits[0]!.signature).toBe(inits[1]!.signature);
    expect(inits[0]!.id).not.toBe(inits[1]!.id);
  });

  it('caps the displayed signature at 120 chars', () => {
    const longParams = Array.from({ length: 20 }, (_, i) => `argument${i} string`).join(', ');
    const sym = extract(`${PKG}func Long(${longParams}) {}\n`).symbols[0]!;
    expect(sym.signature.length).toBe(120);
  });

  it('skips blank-identifier functions (compile-time assertions)', () => {
    const result = extract(`${PKG}func _() {}\nfunc _() {}\nfunc Real() {}\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['Real']);
  });
});

describe('go extractor — methods and receivers', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a value-receiver method with class-member FQN', () => {
    const result = extract(`${PKG}type Server struct{}\n\nfunc (s Server) Handle(req string) error {\n\treturn nil\n}\n`);
    const sym = result.symbols.find((s) => s.name === 'Handle')!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.go:Server.Handle');
    expect(sym.signature).toBe('func (s Server) Handle(req string) error');
  });

  it('pointer receiver resolves to the base type', () => {
    const result = extract(`${PKG}type Server struct{}\n\nfunc (s *Server) Close() {}\n`);
    expect(result.symbols.find((s) => s.name === 'Close')!.fqn).toBe('src/test.go:Server.Close');
  });

  it('generic receiver resolves to the base type name', () => {
    const result = extract(
      `${PKG}type List[T any] struct{}\n\nfunc (l *List[T]) Push(v T) {}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'Push')!.fqn).toBe('src/test.go:List.Push');
  });

  it('nameless and blank receivers are extracted', () => {
    const result = extract(
      `${PKG}type S struct{}\n\nfunc (S) Static() {}\n\nfunc (_ *S) Blank() {}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'Static')!.fqn).toBe('src/test.go:S.Static');
    expect(result.symbols.find((s) => s.name === 'Blank')!.fqn).toBe('src/test.go:S.Blank');
  });

  it('method exportedness follows the method name case, not the receiver type', () => {
    const result = extract(`${PKG}type srv struct{}\n\nfunc (s srv) Public() {}\n\nfunc (s srv) hidden() {}\n`);
    expect(result.symbols.find((s) => s.name === 'Public')!.exported).toBe(true);
    expect(result.symbols.find((s) => s.name === 'hidden')!.exported).toBe(false);
  });

  it('same method name on two types yields distinct symbols', () => {
    const result = extract(
      `${PKG}type A struct{}\ntype B struct{}\n\nfunc (a A) Run() {}\n\nfunc (b B) Run() {}\n`,
    );
    const runs = result.symbols.filter((s) => s.name === 'Run');
    expect(runs.map((s) => s.fqn).sort()).toEqual(['src/test.go:A.Run', 'src/test.go:B.Run']);
    expect(runs[0]!.id).not.toBe(runs[1]!.id);
  });

  it('skips a method whose receiver is not a named type', () => {
    const result = extract(`${PKG}func (s map[string]int) Weird() {}\nfunc Good() {}\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['Good']);
  });

  it('unwraps parenthesized receiver types', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s (*Server)) Close() {}\n\nfunc (t (Server)) Open() {}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'Close')!.fqn).toBe('src/test.go:Server.Close');
    expect(result.symbols.find((s) => s.name === 'Open')!.fqn).toBe('src/test.go:Server.Open');
  });

  it('extracts a method despite a comment inside the receiver type', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s * /*ptr*/ Server) Handle() {\n\ts.log()\n}\n\nfunc (s *Server) log() {}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'Handle')!.fqn).toBe('src/test.go:Server.Handle');
    // and the body's calls survive (the method is registered as a PendingBody)
    expect(result.references.some((r) => r.targetName === 'log')).toBe(true);
  });

  it('skips a blank-identifier method', () => {
    const result = extract(`${PKG}type S struct{}\n\nfunc (s *S) _() {}\n\nfunc (s *S) Real() {}\n`);
    expect(result.symbols.filter((s) => s.kind === 'method').map((s) => s.name)).toEqual(['Real']);
  });
});

describe('go extractor — type declarations', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('struct → class kind with member-block-free signature', () => {
    const sym = extract(`${PKG}type Server struct {\n\tAddr string\n}\n`).symbols[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.signature).toBe('type Server struct');
    expect(sym.fqn).toBe('src/test.go:Server');
  });

  it('interface → interface kind', () => {
    const sym = extract(`${PKG}type Reader interface {\n\tRead(p []byte) (int, error)\n}\n`).symbols[0]!;
    expect(sym.kind).toBe('interface');
    expect(sym.signature).toBe('type Reader interface');
  });

  it('defined types and function types → type kind with full signature', () => {
    const result = extract(`${PKG}type MyInt int\ntype Handler func(int) error\n`);
    const myInt = result.symbols.find((s) => s.name === 'MyInt')!;
    expect(myInt.kind).toBe('type');
    expect(myInt.signature).toBe('type MyInt int');
    expect(result.symbols.find((s) => s.name === 'Handler')!.signature).toBe(
      'type Handler func(int) error',
    );
  });

  it('type alias → type kind', () => {
    const sym = extract(`${PKG}type Server struct{}\ntype Alias = Server\n`).symbols.find(
      (s) => s.name === 'Alias',
    )!;
    expect(sym.kind).toBe('type');
    expect(sym.signature).toBe('type Alias = Server');
  });

  it('grouped type declarations yield one symbol per spec', () => {
    const result = extract(`${PKG}type (\n\tA struct{}\n\tB int\n)\n`);
    expect(result.symbols.map((s) => [s.name, s.kind])).toEqual([
      ['A', 'class'],
      ['B', 'type'],
    ]);
  });

  it('generic type keeps its parameters in the signature', () => {
    const sym = extract(`${PKG}type Pair[K comparable, V any] struct {\n\tKey K\n}\n`).symbols[0]!;
    expect(sym.signature).toBe('type Pair[K comparable, V any] struct');
  });

  it('function-local type declarations produce no symbols', () => {
    const result = extract(`${PKG}func F() {\n\ttype local struct{}\n\t_ = local{}\n}\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['F']);
  });
});

describe('go extractor — struct fields and interface members', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts fields as variable members with capitalization-gated export', () => {
    const result = extract(`${PKG}type Server struct {\n\tAddr string\n\tport int\n}\n`);
    const addr = result.symbols.find((s) => s.name === 'Addr')!;
    expect(addr.kind).toBe('variable');
    expect(addr.fqn).toBe('src/test.go:Server.Addr');
    expect(addr.exported).toBe(true);
    expect(result.symbols.find((s) => s.name === 'port')!.exported).toBe(false);
  });

  it('multi-name fields yield one symbol per name with the shared signature', () => {
    const result = extract(`${PKG}type P struct {\n\ta, b int\n}\n`);
    const fields = result.symbols.filter((s) => s.kind === 'variable');
    expect(fields.map((s) => s.name)).toEqual(['a', 'b']);
    expect(fields[0]!.signature).toBe('a, b int');
    expect(fields[0]!.id).not.toBe(fields[1]!.id);
  });

  it('embedded fields are not extracted', () => {
    const result = extract(
      `${PKG}type S struct {\n\tio.Reader\n\t*Conn\n\tName string\n}\n`,
    );
    expect(result.symbols.filter((s) => s.kind === 'variable').map((s) => s.name)).toEqual([
      'Name',
    ]);
  });

  it('field tags stay in the signature', () => {
    const result = extract('package main\n\ntype S struct {\n\tName string `json:"name"`\n}\n');
    expect(result.symbols.find((s) => s.name === 'Name')!.signature).toBe(
      'Name string `json:"name"`',
    );
  });

  it('blank fields are skipped', () => {
    const result = extract(`${PKG}type S struct {\n\t_ int\n\tOk bool\n}\n`);
    expect(result.symbols.filter((s) => s.kind === 'variable').map((s) => s.name)).toEqual(['Ok']);
  });

  it('uppercase fields of an unexported struct are not exported', () => {
    const result = extract(`${PKG}type hidden struct {\n\tName string\n}\n`);
    expect(result.symbols.find((s) => s.name === 'Name')!.exported).toBe(false);
  });

  it('interface method specs become declaration-only method members', () => {
    const result = extract(
      `${PKG}type Shape interface {\n\tArea() float64\n\tfmt.Stringer\n}\n`,
    );
    const area = result.symbols.find((s) => s.name === 'Area')!;
    expect(area.kind).toBe('method');
    expect(area.fqn).toBe('src/test.go:Shape.Area');
    expect(area.signature).toBe('Area() float64');
    // Embedded fmt.Stringer adds no member.
    expect(result.symbols.filter((s) => s.kind === 'method')).toHaveLength(1);
  });

  it('type-set interfaces have no members', () => {
    const result = extract(`${PKG}type Num interface {\n\t~int | ~float64\n}\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['Num']);
  });

  it('does not recurse into anonymous nested struct types', () => {
    const result = extract(
      `${PKG}type S struct {\n\tMeta struct {\n\t\tInner string\n\t}\n}\n`,
    );
    expect(result.symbols.filter((s) => s.kind === 'variable').map((s) => s.name)).toEqual([
      'Meta',
    ]);
  });
});

describe('go extractor — const and var', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('ungrouped const → variable with keyword-prefixed signature', () => {
    const sym = extract(`${PKG}const Greeting = "hello"\n`).symbols[0]!;
    expect(sym.kind).toBe('variable');
    expect(sym.signature).toBe('const Greeting = "hello"');
    expect(sym.exported).toBe(true);
  });

  it('grouped const block yields one symbol per spec, iota continuation included', () => {
    const result = extract(`${PKG}const (\n\tA = iota\n\tB\n)\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['A', 'B']);
    expect(result.symbols[0]!.signature).toBe('const A = iota');
    expect(result.symbols[1]!.signature).toBe('const B');
  });

  it('multi-name const specs yield one symbol per identifier (no phantom comma)', () => {
    // const_spec puts the whole name list under the `name:` field, so the
    // `,` tokens carry it too — unlike var_spec, which is per-identifier.
    const result = extract(`${PKG}const MinPort, MaxPort = 1, 65535\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['MinPort', 'MaxPort']);
    const grouped = extract(`${PKG}const (\n\tlo, hi = iota, iota\n)\n`);
    expect(grouped.symbols.map((s) => s.name)).toEqual(['lo', 'hi']);
  });

  it('multi-name var spec yields one symbol per name', () => {
    const result = extract(`${PKG}var x, y = 1, 2\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['x', 'y']);
    expect(result.symbols[0]!.signature).toBe('var x, y = 1, 2');
    expect(result.symbols[0]!.id).not.toBe(result.symbols[1]!.id);
  });

  it('grouped var block (var_spec_list wrapper) is handled', () => {
    const result = extract(`${PKG}var (\n\tx, y = 1, 2\n\tName string\n)\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['x', 'y', 'Name']);
    expect(result.symbols.find((s) => s.name === 'Name')!.exported).toBe(true);
  });

  it('var assigned a func literal becomes a function symbol', () => {
    const result = extract(`${PKG}var f = func(a int) int {\n\treturn a\n}\n`);
    const sym = result.symbols[0]!;
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('var f = func(a int) int');
  });

  it('multi-name func-literal var stays variable kind', () => {
    const result = extract(`${PKG}var f, g = func() {}, func() {}\n`);
    expect(result.symbols.map((s) => s.kind)).toEqual(['variable', 'variable']);
  });

  it('blank var produces no symbol but keeps its initializer call', () => {
    const result = extract(`${PKG}func sideEffect() bool { return true }\n\nvar _ = sideEffect()\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['sideEffect']);
    const ref = result.references.find((r) => r.targetName === 'sideEffect')!;
    expect(ref.sourceId).toBeNull();
    expect(ref.targetId).toBe(result.symbols[0]!.id);
  });
});

describe('go extractor — docs', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('takes a single // line directly above the declaration', () => {
    const sym = extract(`${PKG}// Greet says hello.\nfunc Greet() {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Greet says hello.');
  });

  it('takes the FIRST line of a multi-line godoc block', () => {
    const sym = extract(
      `${PKG}// Server doc line one.\n// Second line.\ntype Server struct{}\n`,
    ).symbols[0]!;
    expect(sym.doc).toBe('Server doc line one.');
  });

  it('skips //go: directives inside the doc block', () => {
    const above = extract(`${PKG}//go:noinline\n// RealDoc here.\nfunc F() {}\n`).symbols[0]!;
    expect(above.doc).toBe('RealDoc here.');
    const below = extract(`${PKG}// RealDoc here.\n//go:noinline\nfunc F() {}\n`).symbols[0]!;
    expect(below.doc).toBe('RealDoc here.');
    const only = extract(`${PKG}//go:generate stringer\nfunc F() {}\n`).symbols[0]!;
    expect(only.doc).toBeNull();
  });

  it('skips non-go: directives (//nolint, //line) like go/doc does', () => {
    const sym = extract(
      `${PKG}//nolint:gocyclo\n// Complex does things.\nfunc Complex() {}\n`,
    ).symbols[0]!;
    expect(sym.doc).toBe('Complex does things.');
    // `// note: x` has a space after the slashes — prose, not a directive.
    const prose = extract(`${PKG}// note: subtle.\nfunc F() {}\n`).symbols[0]!;
    expect(prose.doc).toBe('note: subtle.');
  });

  it('keeps prose that looks directive-ish but lacks a char after the colon', () => {
    // go/ast requires `word:[a-z0-9]` — a slash or space after the colon
    // means prose, which go/doc keeps as the summary line.
    expect(extract(`${PKG}//https://example.com/spec\nfunc F() {}\n`).symbols[0]!.doc).toBe(
      'https://example.com/spec',
    );
    expect(extract(`${PKG}//nolint: gocyclo\nfunc G() {}\n`).symbols[0]!.doc).toBe(
      'nolint: gocyclo',
    );
  });

  it('skips empty // lines when picking the doc summary line', () => {
    const sym = extract(`${PKG}//\n// Doc here.\nfunc F() {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Doc here.');
  });

  it('a blank line detaches the comment block', () => {
    const sym = extract(`${PKG}// Detached.\n\nfunc F() {}\n`).symbols[0]!;
    expect(sym.doc).toBeNull();
  });

  it('a trailing comment on the previous statement is not doc', () => {
    const result = extract(`${PKG}var z = 1 // about z\nfunc F() {}\n`);
    expect(result.symbols.find((s) => s.name === 'F')!.doc).toBeNull();
  });

  it('block comments work through commentDocLine', () => {
    const sym = extract(`${PKG}/* Block doc. */\nfunc F() {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Block doc.');
  });

  it('grouped const specs document individually, without group fan-out', () => {
    const result = extract(`${PKG}// Group doc.\nconst (\n\t// A doc.\n\tA = 1\n\tB = 2\n)\n`);
    expect(result.symbols.find((s) => s.name === 'A')!.doc).toBe('A doc.');
    expect(result.symbols.find((s) => s.name === 'B')!.doc).toBeNull();
  });

  it('single-spec declarations fall back to the declaration doc', () => {
    const result = extract(`${PKG}// Count of things.\nvar count int\n`);
    expect(result.symbols[0]!.doc).toBe('Count of things.');
  });

  it('struct fields and interface methods carry their own docs', () => {
    const result = extract(
      `${PKG}type S struct {\n\t// Addr is the listen address.\n\tAddr string\n}\n\ntype I interface {\n\t// Run runs.\n\tRun()\n}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'Addr')!.doc).toBe('Addr is the listen address.');
    expect(result.symbols.find((s) => s.name === 'Run')!.doc).toBe('Run runs.');
  });
});

describe('go extractor — references: bare calls and builtins', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('resolves a bare call to a same-file function', () => {
    const result = extract(`${PKG}func helper() {}\n\nfunc F() {\n\thelper()\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'helper')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'helper')!.id);
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'F')!.id);
    expect(ref.receiver).toBeUndefined();
  });

  it('emits unknown bare calls unresolved (cross-file lookup by name)', () => {
    const result = extract(`${PKG}func F() {\n\tnewClient()\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'newClient')!;
    expect(ref.targetId).toBeNull();
  });

  it('bare calls never bind to variables or types', () => {
    const result = extract(
      `${PKG}var handler = 1\n\ntype MyInt int\n\nfunc F() {\n\thandler()\n\t_ = MyInt(3)\n}\n`,
    );
    expect(result.references.find((r) => r.targetName === 'handler')!.targetId).toBeNull();
    expect(result.references.find((r) => r.targetName === 'MyInt')!.targetId).toBeNull();
  });

  it('builtins emit no references', () => {
    const result = extract(
      `${PKG}func F() {\n\tx := make([]int, 0)\n\tx = append(x, len(x))\n\tp := new(int)\n\t_ = p\n\tpanic("x")\n}\n`,
    );
    expect(result.references).toHaveLength(0);
  });

  it('a file-local function shadowing a builtin name keeps its refs', () => {
    const result = extract(`${PKG}func clear() {}\n\nfunc F() {\n\tclear()\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'clear')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'clear')!.id);
  });

  it('conversions to predeclared types emit no references', () => {
    // string(b)/int64(n)/byte(c) parse as bare calls — pure noise, filtered
    // like the builtin functions. User-type conversions (MyInt) still emit.
    const result = extract(
      `${PKG}func F(b []byte, n int) {\n\t_ = string(b)\n\t_ = int64(n)\n\t_ = float64(n)\n\t_ = error(nil)\n\t_ = rune(n)\n}\n`,
    );
    expect(result.references).toHaveLength(0);
  });

  it('top-level var initializer calls are module-level (null source)', () => {
    const result = extract(`${PKG}func newClient() int { return 1 }\n\nvar c = newClient()\n`);
    const ref = result.references.find((r) => r.targetName === 'newClient')!;
    expect(ref.sourceId).toBeNull();
    expect(ref.targetId).not.toBeNull();
  });

  it('go and defer statements attribute to the enclosing function', () => {
    const result = extract(
      `${PKG}func run() {}\nfunc cleanup() {}\n\nfunc F() {\n\tgo run()\n\tdefer cleanup()\n}\n`,
    );
    const fId = result.symbols.find((s) => s.name === 'F')!.id;
    expect(result.references.find((r) => r.targetName === 'run')!.sourceId).toBe(fId);
    expect(result.references.find((r) => r.targetName === 'cleanup')!.sourceId).toBe(fId);
  });

  it('calls inside closures attribute to the enclosing function', () => {
    const result = extract(
      `${PKG}func inner() {}\n\nfunc F() {\n\tgo func() {\n\t\tinner()\n\t}()\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'inner')!;
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'F')!.id);
  });

  it('calls inside a var-assigned func literal attribute to that function symbol', () => {
    const result = extract(`${PKG}func helper() {}\n\nvar f = func() {\n\thelper()\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'helper')!;
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'f')!.id);
  });
});

describe('go extractor — references: members and self-receiver', () => {
  beforeAll(async () => {
    await initParser();
  });

  const SERVER = `${PKG}type Server struct{}\n\nfunc (s *Server) Handle(req string) {\n\ts.log(req)\n}\n\nfunc (s *Server) log(msg string) {}\n`;

  it('resolves a receiver-variable member call to the same-file method', () => {
    const result = extract(SERVER);
    const ref = result.references.find((r) => r.targetName === 'log')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'log')!.id);
    expect(ref.receiver).toBe('s');
    expect(ref.selfReceiver).toBe(true);
  });

  it('keeps selfReceiver on unresolved self-calls', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s *Server) Handle() {\n\ts.missing()\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'missing')!;
    expect(ref.targetId).toBeNull();
    expect(ref.selfReceiver).toBe(true);
  });

  it('non-receiver tokens are plain member refs, not self', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s *Server) Handle(other *Server) {\n\tother.log()\n}\n\nfunc (s *Server) log() {}\n`,
    );
    const ref = result.references.find((r) => r.receiver === 'other')!;
    expect(ref.selfReceiver).toBeUndefined();
    expect(ref.targetId).toBeNull();
  });

  it('self-calls inside closures still resolve through the receiver', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s *Server) Handle() {\n\tgo func() {\n\t\ts.log()\n\t}()\n}\n\nfunc (s *Server) log() {}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'log')!;
    expect(ref.targetId).not.toBeNull();
    expect(ref.selfReceiver).toBe(true);
  });

  it('blank-receiver methods produce no self resolution', () => {
    const result = extract(
      `${PKG}type S struct{}\n\nfunc (_ *S) Handle(x *S) {\n\tx.log()\n}\n\nfunc (s *S) log() {}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'log')!;
    expect(ref.selfReceiver).toBeUndefined();
  });

  it('captures chained and computed receivers under an opaque receiver', () => {
    const result = extract(
      `${PKG}func F(s *Wrapper) {\n\ts.conn.Close()\n\tget().Run()\n}\n`,
    );
    // Chained `s.conn.Close()` (operand is a selector_expression) and computed
    // `get().Run()` (operand is a call) are now captured under RECEIVER_OPAQUE:
    // findable by method name (recall) but never resolved.
    const close = result.references.find((r) => r.targetName === 'Close')!;
    expect(close.receiver).toBe(RECEIVER_OPAQUE);
    expect(close.targetId).toBeNull();
    const run = result.references.find((r) => r.targetName === 'Run')!;
    expect(run.receiver).toBe(RECEIVER_OPAQUE);
    expect(run.targetId).toBeNull();
  });

  it('package-qualified calls are unresolved member refs', () => {
    const result = extract(`${PKG}import "fmt"\n\nfunc F() {\n\tfmt.Println("x")\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'Println')!;
    expect(ref.receiver).toBe('fmt');
    expect(ref.targetId).toBeNull();
  });

  it('method expressions resolve through the type-name receiver', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s Server) Handle() {}\n\nfunc F(s Server) {\n\tServer.Handle(s)\n}\n`,
    );
    const ref = result.references.find((r) => r.receiver === 'Server')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'Handle')!.id);
  });

  it('method values emit no reference', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc (s *Server) Handle() {}\n\nfunc F(s *Server) {\n\th := s.Handle\n\th()\n}\n`,
    );
    expect(result.references.find((r) => r.targetName === 'Handle')).toBeUndefined();
  });
});

describe('go extractor — references: composite literals', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('resolves Server{} and &Server{} to the struct symbol', () => {
    const result = extract(
      `${PKG}type Server struct{}\n\nfunc F() {\n\ta := Server{}\n\tb := &Server{}\n\t_, _ = a, b\n}\n`,
    );
    const refs = result.references.filter((r) => r.targetName === 'Server');
    expect(refs).toHaveLength(2);
    const classId = result.symbols.find((s) => s.name === 'Server')!.id;
    expect(refs.every((r) => r.targetId === classId)).toBe(true);
  });

  it('qualified composite literals are member refs', () => {
    const result = extract(`${PKG}func F() {\n\tc := pkg.Config{}\n\t_ = c\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'Config')!;
    expect(ref.receiver).toBe('pkg');
    expect(ref.targetId).toBeNull();
  });

  it('generic composite literals unwrap to the base type', () => {
    const result = extract(
      `${PKG}type Pair[K comparable, V any] struct{}\n\nfunc F() {\n\tp := Pair[string, int]{}\n\t_ = p\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'Pair')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'Pair')!.id);
  });

  it('slice and map literal types emit nothing', () => {
    const result = extract(
      `${PKG}type S struct{}\n\nfunc F() {\n\ta := []S{{}}\n\tb := map[string]int{"x": 1}\n\t_, _ = a, b\n}\n`,
    );
    expect(result.references).toHaveLength(0);
  });

  it('named non-struct types resolve via the type kind', () => {
    const result = extract(
      `${PKG}type Pairs map[string]int\n\nfunc F() {\n\tp := Pairs{"a": 1}\n\t_ = p\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'Pairs')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'Pairs')!.id);
  });

  it('duplicate same-file type names refuse resolution', () => {
    const result = extract(
      `${PKG}type Dup struct{}\ntype Dup struct{}\n\nfunc F() {\n\td := Dup{}\n\t_ = d\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'Dup')!;
    expect(ref.targetId).toBeNull();
  });
});

describe('go extractor — imports', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('plain import binds the package basename as a module', () => {
    const result = extract(`${PKG}import "encoding/json"\n`);
    expect(result.imports).toHaveLength(1);
    const imp = result.imports[0]!;
    expect(imp.sourceModule).toBe('encoding/json');
    expect(imp.importedNames).toEqual([{ name: 'json', kind: 'module' }]);
    expect(imp.line).toBe(3);
  });

  it('aliased, dot, and blank imports map to alias / wildcard / inert forms', () => {
    const result = extract(
      `${PKG}import j "encoding/json"\nimport . "fmt"\nimport _ "net/http/pprof"\n`,
    );
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'json', alias: 'j', kind: 'module' },
    ]);
    expect(result.imports[1]!.importedNames).toEqual([{ name: '*' }]);
    expect(result.imports[2]!.importedNames).toEqual([{ name: '_', kind: 'module' }]);
  });

  it('grouped imports yield one ImportInfo per spec with per-spec lines', () => {
    const result = extract(`${PKG}import (\n\t"fmt"\n\tstr "strings"\n)\n`);
    expect(result.imports).toHaveLength(2);
    expect(result.imports[0]!.sourceModule).toBe('fmt');
    expect(result.imports[0]!.line).toBe(4);
    expect(result.imports[1]!.importedNames[0]!.alias).toBe('str');
    expect(result.imports[1]!.line).toBe(5);
  });

  it('package-name heuristics: /vN suffix and gopkg.in versions', () => {
    const result = extract(
      `${PKG}import (\n\t"github.com/x/structured/v2"\n\t"gopkg.in/yaml.v2"\n)\n`,
    );
    expect(result.imports[0]!.importedNames[0]!.name).toBe('structured');
    expect(result.imports[1]!.importedNames[0]!.name).toBe('yaml');
  });

  it('raw-string import paths are stripped of backticks', () => {
    const result = extract('package main\n\nimport `fmt`\n');
    expect(result.imports[0]!.sourceModule).toBe('fmt');
  });
});

describe('go extractor — error tolerance', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('keeps declarations preceding a syntax error', () => {
    const result = extract(`${PKG}func Good() {}\n\nfunc Bad( {\n`);
    expect(result.symbols.some((s) => s.name === 'Good')).toBe(true);
  });

  it('never throws on an empty or comment-only file', () => {
    expect(extract('').symbols).toHaveLength(0);
    expect(extract('// just a comment\n').symbols).toHaveLength(0);
  });
});
