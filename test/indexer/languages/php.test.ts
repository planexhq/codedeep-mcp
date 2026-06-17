import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, path = 'src/test.php') {
  const tree = parseFile(src, 'php')!;
  return extractSymbols(tree, src, makeFileInfo('php', path));
}

type Result = ReturnType<typeof extract>;

const byName = (result: Result, name: string) =>
  result.symbols.filter((s) => s.name === name);

const resolvedTo = (result: Result, sourceName: string, targetName: string) => {
  const src = byName(result, sourceName)[0]!;
  const tgt = byName(result, targetName)[0]!;
  return result.references.some(
    (r) => r.sourceId === src.id && r.targetId === tgt.id && r.targetName === targetName,
  );
};

const moduleResolvedTo = (result: Result, targetName: string) => {
  const tgt = byName(result, targetName)[0]!;
  return result.references.some(
    (r) => r.sourceId === null && r.targetId === tgt.id && r.targetName === targetName,
  );
};

const hasRef = (result: Result, targetName: string) =>
  result.references.some((r) => r.targetName === targetName);

const selfRefFrom = (result: Result, sourceName: string, targetName: string) => {
  const src = byName(result, sourceName)[0]!;
  return result.references.some(
    (r) => r.sourceId === src.id && r.targetName === targetName && r.selfReceiver === true,
  );
};

beforeAll(async () => {
  await initParser();
});

describe('php extractor — type declarations', () => {
  it('extracts a class with kind/fqn/signature/exported/lines/id', () => {
    const result = extract(`<?php\nclass Widget {\n}\n`);
    const sym = byName(result, 'Widget')[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.fqn).toBe('src/test.php:Widget');
    expect(sym.signature).toBe('class Widget');
    expect(sym.exported).toBe(true);
    expect(sym.startLine).toBe(2);
    expect(sym.language).toBe('php');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('interface maps to interface kind and its members are extracted', () => {
    const result = extract(
      `<?php\ninterface Shape {\n  public function area(): float;\n  const PI = 3.14;\n}\n`,
    );
    expect(byName(result, 'Shape')[0]!.kind).toBe('interface');
    expect(byName(result, 'area')[0]!.kind).toBe('method');
    expect(byName(result, 'PI')[0]!.kind).toBe('variable');
  });

  it('trait maps to class kind and keeps the trait keyword in the signature', () => {
    const result = extract(`<?php\ntrait Greets {\n  public function hi(): string { return 'x'; }\n}\n`);
    const sym = byName(result, 'Greets')[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.signature).toBe('trait Greets');
    expect(byName(result, 'hi')[0]!.kind).toBe('method');
  });

  it('enum maps to enum kind; cases are NOT extracted but body methods/consts ARE', () => {
    const result = extract(
      `<?php\nenum Suit: string {\n  case Hearts = 'H';\n  case Spades = 'S';\n  const Wild = 'W';\n  public function color(): string { return 'r'; }\n}\n`,
    );
    expect(byName(result, 'Suit')[0]!.kind).toBe('enum');
    expect(byName(result, 'Hearts')).toHaveLength(0);
    expect(byName(result, 'Spades')).toHaveLength(0);
    expect(byName(result, 'Wild')[0]!.kind).toBe('variable');
    expect(byName(result, 'color')[0]!.kind).toBe('method');
  });

  it('abstract/final modifiers are kept in the class signature', () => {
    const result = extract(`<?php\nabstract class Base {}\nfinal class Leaf {}\n`);
    expect(byName(result, 'Base')[0]!.signature).toBe('abstract class Base');
    expect(byName(result, 'Leaf')[0]!.signature).toBe('final class Leaf');
  });

  it('readonly class (PHP 8.2) keeps the readonly keyword in the signature', () => {
    const result = extract(`<?php\nreadonly class Pt { public function __construct(public int $x) {} }\n`);
    expect(byName(result, 'Pt')[0]!.signature).toBe('readonly class Pt');
  });

  it('class with extends/implements captures the full header signature', () => {
    const result = extract(`<?php\nclass C extends Base implements A, B {}\n`);
    expect(byName(result, 'C')[0]!.signature).toBe('class C extends Base implements A, B');
  });

  it('top-level function maps to function kind', () => {
    const result = extract(`<?php\nfunction topLevel(int $n): int { return $n; }\n`);
    const sym = byName(result, 'topLevel')[0]!;
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.php:topLevel');
    expect(sym.signature).toBe('function topLevel(int $n): int');
    expect(sym.exported).toBe(true);
  });
});

describe('php extractor — members', () => {
  it('methods carry Class.method FQN and method kind', () => {
    const result = extract(`<?php\nclass C {\n  public function go(): void {}\n}\n`);
    const sym = byName(result, 'go')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.php:C.go');
  });

  it('constructor keeps the real name __construct', () => {
    const result = extract(`<?php\nclass C {\n  public function __construct(int $x) {}\n}\n`);
    const sym = byName(result, '__construct')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.php:C.__construct');
  });

  it('abstract method has no body and a clean signature', () => {
    const result = extract(`<?php\nabstract class C {\n  abstract public function must(): void;\n}\n`);
    const sym = byName(result, 'must')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.signature).toBe('abstract public function must(): void');
  });

  it('one variable per property_element, name without the $', () => {
    const result = extract(`<?php\nclass C {\n  public static int $count = 0, $other = 1;\n}\n`);
    expect(byName(result, 'count')[0]!.kind).toBe('variable');
    expect(byName(result, 'count')[0]!.fqn).toBe('src/test.php:C.count');
    expect(byName(result, 'other')[0]!.kind).toBe('variable');
    // signature drops the `= initializer`.
    expect(byName(result, 'count')[0]!.signature).toBe('public static int $count');
  });

  it('one variable per const_element', () => {
    const result = extract(`<?php\nclass C {\n  public const A = 1, B = 2;\n}\n`);
    expect(byName(result, 'A')[0]!.kind).toBe('variable');
    expect(byName(result, 'B')[0]!.kind).toBe('variable');
    expect(byName(result, 'A')[0]!.fqn).toBe('src/test.php:C.A');
  });

  it('constructor property promotion emits a property per promoted param', () => {
    const result = extract(
      `<?php\nclass Pt {\n  public function __construct(private int $x, protected readonly string $name = "a") {}\n}\n`,
    );
    expect(byName(result, '__construct')[0]!.kind).toBe('method');
    const x = byName(result, 'x')[0]!;
    expect(x.kind).toBe('variable');
    expect(x.fqn).toBe('src/test.php:Pt.x');
    expect(x.exported).toBe(false); // private
    const name = byName(result, 'name')[0]!;
    expect(name.kind).toBe('variable');
    expect(name.exported).toBe(true); // protected exports
  });

  it('plain (non-promoted) constructor params are NOT properties', () => {
    const result = extract(`<?php\nclass C {\n  public function __construct(int $plain) {}\n}\n`);
    expect(byName(result, 'plain')).toHaveLength(0);
  });
});

describe('php extractor — exportedness (default public, private vetoes)', () => {
  it('absent / public / protected export; private does not', () => {
    const result = extract(
      `<?php\nclass C {\n  function noMod(): void {}\n  public function pub(): void {}\n  protected function prot(): void {}\n  private function priv(): void {}\n}\n`,
    );
    expect(byName(result, 'noMod')[0]!.exported).toBe(true);
    expect(byName(result, 'pub')[0]!.exported).toBe(true);
    expect(byName(result, 'prot')[0]!.exported).toBe(true);
    expect(byName(result, 'priv')[0]!.exported).toBe(false);
  });

  it('interface members are exported (implicitly public)', () => {
    const result = extract(`<?php\ninterface I {\n  public function m(): void;\n}\n`);
    expect(byName(result, 'm')[0]!.exported).toBe(true);
  });

  it('top-level functions and types are always exported', () => {
    const result = extract(`<?php\nfunction f(): void {}\nclass C {}\ntrait T {}\nenum E {}\n`);
    expect(byName(result, 'f')[0]!.exported).toBe(true);
    expect(byName(result, 'C')[0]!.exported).toBe(true);
    expect(byName(result, 'T')[0]!.exported).toBe(true);
    expect(byName(result, 'E')[0]!.exported).toBe(true);
  });

  it('private property is not exported', () => {
    const result = extract(`<?php\nclass C {\n  private string $secret = 'x';\n  public int $open = 0;\n}\n`);
    expect(byName(result, 'secret')[0]!.exported).toBe(false);
    expect(byName(result, 'open')[0]!.exported).toBe(true);
  });
});

describe('php extractor — namespaces fold into the qualifier', () => {
  it('file-level namespace keeps a simple-name FQN and disambiguates ids', () => {
    const result = extract(`<?php\nnamespace App\\Service;\nclass Widget {}\nfunction make(): void {}\n`);
    const widget = byName(result, 'Widget')[0]!;
    expect(widget.fqn).toBe('src/test.php:Widget'); // simple name, no namespace
    expect(widget.kind).toBe('class');
    expect(byName(result, 'make')[0]!.fqn).toBe('src/test.php:make');
  });

  it('block namespace recurses into its body', () => {
    const result = extract(`<?php\nnamespace A { class X {} }\nnamespace B { class Y {} }\n`);
    expect(byName(result, 'X')[0]!.kind).toBe('class');
    expect(byName(result, 'Y')[0]!.kind).toBe('class');
  });

  it('same-name classes in different namespaces in one file get distinct ids', () => {
    const result = extract(`<?php\nnamespace A { class Dup {} }\nnamespace B { class Dup {} }\n`);
    const dups = byName(result, 'Dup');
    expect(dups).toHaveLength(2);
    expect(dups[0]!.id).not.toBe(dups[1]!.id);
  });
});

describe('php extractor — docs', () => {
  it('extracts a /** */ PHPDoc block first line', () => {
    const result = extract(`<?php\n/** Greets people. */\nclass Greeter {}\n`);
    expect(byName(result, 'Greeter')[0]!.doc).toBe('Greets people.');
  });

  it('multi-line PHPDoc takes the first content line', () => {
    const result = extract(`<?php\n/**\n * Does a thing.\n * @param int $x\n */\nfunction doc(int $x): int { return $x; }\n`);
    expect(byName(result, 'doc')[0]!.doc).toBe('Does a thing.');
  });

  it('plain // and # comments are NOT docs', () => {
    const result = extract(`<?php\n// not a doc\nfunction a(): void {}\n# also not\nfunction b(): void {}\n`);
    expect(byName(result, 'a')[0]!.doc).toBeNull();
    expect(byName(result, 'b')[0]!.doc).toBeNull();
  });

  it('a non-adjacent PHPDoc is not attached', () => {
    const result = extract(`<?php\n/** Far away. */\n\n\nclass C {}\n`);
    expect(byName(result, 'C')[0]!.doc).toBeNull();
  });
});

describe('php extractor — call resolution', () => {
  it('bare call resolves to a free function (never a class)', () => {
    const result = extract(
      `<?php\nfunction helper(): int { return 1; }\nfunction caller(): int { return helper(); }\n`,
    );
    expect(resolvedTo(result, 'caller', 'helper')).toBe(true);
  });

  it('a bare call colliding with a class name does NOT resolve to the class', () => {
    const result = extract(
      `<?php\nclass Widget {}\nfunction caller(): void { Widget(); }\n`,
    );
    // bare Widget() can only bind to a function named Widget — none exists.
    const widget = byName(result, 'Widget')[0]!;
    expect(result.references.some((r) => r.targetId === widget.id)).toBe(false);
  });

  it('new X() resolves to the class via construction routing', () => {
    const result = extract(
      `<?php\nclass Widget {}\nfunction make(): Widget { return new Widget(); }\n`,
    );
    expect(resolvedTo(result, 'make', 'Widget')).toBe(true);
  });

  it('new Foo() does NOT mis-bind to an enclosing method named Foo', () => {
    const result = extract(
      `<?php\nclass Box {}\nclass C {\n  public function Box(): void {}\n  public function make(): Box { return new Box(); }\n}\n`,
    );
    // the construction must hit the class Box, never the method Box.
    const cls = byName(result, 'Box').find((s) => s.kind === 'class')!;
    const make = byName(result, 'make')[0]!;
    expect(result.references.some((r) => r.sourceId === make.id && r.targetId === cls.id)).toBe(true);
    const method = byName(result, 'Box').find((s) => s.kind === 'method')!;
    expect(result.references.some((r) => r.sourceId === make.id && r.targetId === method.id)).toBe(false);
  });

  it('$this->m() resolves to the enclosing class method as a self-call', () => {
    const result = extract(
      `<?php\nclass C {\n  public function a(): void { $this->b(); }\n  public function b(): void {}\n}\n`,
    );
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
    expect(selfRefFrom(result, 'a', 'b')).toBe(true);
  });

  it('self:: and static:: resolve as self-calls; parent:: is dropped', () => {
    const result = extract(
      `<?php\nclass C {\n  public function a(): void { self::b(); static::d(); parent::p(); }\n  public static function b(): void {}\n  public function d(): void {}\n}\n`,
    );
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
    expect(resolvedTo(result, 'a', 'd')).toBe(true);
    // parent::p() is super-like — never emitted.
    expect(hasRef(result, 'p')).toBe(false);
  });

  it('Class::method() static call resolves via methodsByClass', () => {
    const result = extract(
      `<?php\nclass Helper {\n  public static function compute(): int { return 1; }\n}\nclass C {\n  public function run(): int { return Helper::compute(); }\n}\n`,
    );
    expect(resolvedTo(result, 'run', 'compute')).toBe(true);
  });

  it('member call on a variable is unresolved but records the receiver', () => {
    const result = extract(`<?php\nclass C {\n  public function run($obj): void { $obj->save(); }\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'save');
    expect(ref).toBeDefined();
    expect(ref!.targetId).toBeNull();
    // receiver keeps the `$` sigil so it can never collide with a class name.
    expect(ref!.receiver).toBe('$obj');
  });

  it('nullsafe member call is handled like a normal member call', () => {
    const result = extract(`<?php\nclass C {\n  public function run($obj): void { $obj?->maybe(); }\n}\n`);
    expect(hasRef(result, 'maybe')).toBe(true);
  });

  it('namespaced bare call and qualified construction are dropped', () => {
    const result = extract(
      `<?php\nfunction caller(): void {\n  \\App\\format();\n  $x = new \\App\\Model\\Thing();\n}\n`,
    );
    expect(hasRef(result, 'format')).toBe(false);
    expect(hasRef(result, 'Thing')).toBe(false);
  });

  it('new self()/new static()/new parent() emit no junk construction ref', () => {
    const result = extract(
      `<?php\nclass C {\n  public function a(): self { return new self(); }\n  public function b(): static { return new static(); }\n}\n`,
    );
    expect(hasRef(result, 'self')).toBe(false);
    expect(hasRef(result, 'static')).toBe(false);
  });

  it('calls inside closures attribute to the enclosing method', () => {
    const result = extract(
      `<?php\nfunction helper(): int { return 1; }\nclass C {\n  public function run(): void {\n    $cb = fn() => helper();\n    $fn = function() { helper(); };\n  }\n}\n`,
    );
    expect(resolvedTo(result, 'run', 'helper')).toBe(true);
  });

  it('first-class-callable syntax is suppressed (closure creation, not a call)', () => {
    const result = extract(`<?php\nfunction caller(): void { $x = strlen(...); }\n`);
    expect(hasRef(result, 'strlen')).toBe(false);
  });

  it('common built-ins are suppressed when unresolved', () => {
    const result = extract(
      `<?php\nfunction caller(array $a): void { count($a); array_map('x', $a); trim('y'); }\n`,
    );
    expect(hasRef(result, 'count')).toBe(false);
    expect(hasRef(result, 'array_map')).toBe(false);
    expect(hasRef(result, 'trim')).toBe(false);
  });

  it('a user-defined function shadowing a built-in keeps its refs', () => {
    const result = extract(
      `<?php\nfunction count(): int { return 0; }\nfunction caller(): int { return count(); }\n`,
    );
    expect(resolvedTo(result, 'caller', 'count')).toBe(true);
  });

  it('top-level construction attributes to module scope', () => {
    const result = extract(`<?php\nclass Widget {}\n$w = new Widget();\n`);
    expect(moduleResolvedTo(result, 'Widget')).toBe(true);
  });

  it('property initializer calls attribute to the property (not the constructor)', () => {
    // `new` in a property initializer is valid PHP 8.1; the construction must
    // attribute to the PROPERTY symbol via its per-element PendingBody — not to
    // any constructor (this exercises the property-element body, not the ctor body).
    const result = extract(
      `<?php\nclass NullLogger {}\nclass C {\n  public NullLogger $log = new NullLogger();\n}\n`,
    );
    expect(resolvedTo(result, 'log', 'NullLogger')).toBe(true);
  });
});

describe('php extractor — imports', () => {
  it('extracts a simple use with source module and name', () => {
    const result = extract(`<?php\nuse App\\Model\\User;\n`);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.sourceModule).toBe('App\\Model');
    expect(result.imports[0]!.importedNames[0]!.name).toBe('User');
  });

  it('extracts an aliased use', () => {
    const result = extract(`<?php\nuse App\\Logger as Log;\n`);
    expect(result.imports[0]!.importedNames[0]).toEqual({ name: 'Logger', alias: 'Log' });
  });

  it('extracts a group use into multiple imports', () => {
    const result = extract(`<?php\nuse App\\Util\\{Helper, Logger as Log};\n`);
    expect(result.imports).toHaveLength(2);
    expect(result.imports[0]!.importedNames[0]!.name).toBe('Helper');
    expect(result.imports[0]!.sourceModule).toBe('App\\Util');
    expect(result.imports[1]!.importedNames[0]).toEqual({ name: 'Logger', alias: 'Log' });
  });
});

describe('php extractor — id stability', () => {
  it('same-name same-signature members in different classes get distinct ids', () => {
    // C.dup and D.dup share (name,kind,signature); the symbol id ALSO hashes the
    // member qualifier (the class name), so C vs D yields distinct ids. (The
    // OccurrenceCounter #n is a further fallback for a TRUE same-qualifier clash.)
    const result = extract(
      `<?php\nclass C {\n  public function dup(): void {}\n}\nclass D {\n  public function dup(): void {}\n}\n`,
    );
    const dups = byName(result, 'dup');
    expect(dups).toHaveLength(2);
    expect(dups[0]!.id).not.toBe(dups[1]!.id); // distinct via the class qualifier
  });

  it('no duplicate ids across a representative file', () => {
    const result = extract(
      `<?php\nnamespace App;\nclass C {\n  public function __construct(private int $x) {}\n  public function a(): void {}\n  public function b(): void {}\n}\ntrait T { public function a(): void {} }\nfunction f(): void {}\n`,
    );
    const ids = result.symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('php extractor — review-fix regressions', () => {
  it('top-level and namespace-level const are extracted as variables', () => {
    const result = extract(
      `<?php\nnamespace App\\Config;\nconst DEFAULT_TIMEOUT = 30;\nconst A = 1, B = 2;\n`,
    );
    const t = byName(result, 'DEFAULT_TIMEOUT')[0]!;
    expect(t.kind).toBe('variable');
    expect(t.fqn).toBe('src/test.php:DEFAULT_TIMEOUT');
    expect(t.exported).toBe(true);
    expect(byName(result, 'A')[0]!.kind).toBe('variable');
    expect(byName(result, 'B')[0]!.kind).toBe('variable');
  });

  it('parameter-default calls attribute to the callable (method, function)', () => {
    const result = extract(
      `<?php\nfunction topDefault(): int { return 1; }\nfunction topf($p = topDefault()): int { return 2; }\nclass Svc {\n  public function handle($c = Svc::mk()): void {}\n  public static function mk(): int { return 1; }\n}\n`,
    );
    // top-level function param default → free function.
    expect(resolvedTo(result, 'topf', 'topDefault')).toBe(true);
    // method param default → static self call resolves via methodsByClass.
    expect(resolvedTo(result, 'handle', 'mk')).toBe(true);
  });

  it('a variable receiver named like a same-file class does NOT mis-bind (no wrong edge)', () => {
    const result = extract(
      `<?php\nclass Request {\n  public function validate(): void {}\n}\nclass Controller {\n  public function handle($Request): void { $Request->validate(); }\n}\n`,
    );
    const validate = byName(result, 'validate')[0]!;
    // the member call must NOT resolve to Request.validate (untyped variable).
    expect(result.references.some((r) => r.targetId === validate.id)).toBe(false);
    // it is still recorded as an unresolved member ref (for the weak-include).
    const ref = result.references.find((r) => r.targetName === 'validate');
    expect(ref!.targetId).toBeNull();
  });

  it('first-class-callable on member/scoped calls emits no edge', () => {
    const result = extract(
      `<?php\nclass C {\n  public static function helper(): void {}\n  public function build(): void {\n    $fn = C::helper(...);\n    $g = $obj->method(...);\n  }\n}\n`,
    );
    // C::helper(...) is closure creation, not a call — no ref to helper.
    expect(hasRef(result, 'helper')).toBe(false);
    expect(hasRef(result, 'method')).toBe(false);
  });

  it('property/const/promoted signatures strip a leading #[Attr] block', () => {
    const result = extract(
      `<?php\nclass C {\n  #[ORM\\Column]\n  private int $id = 0;\n  #[Attr]\n  public const FOO = 1;\n  public function __construct(#[Inject] private Logger $log) {}\n}\n`,
    );
    expect(byName(result, 'id')[0]!.signature).toBe('private int $id');
    expect(byName(result, 'FOO')[0]!.signature).toBe('public const FOO');
    expect(byName(result, 'log')[0]!.signature).toBe('private Logger $log');
  });
});

describe('php extractor — 9-angle review regressions', () => {
  it('anonymous-class method bodies do NOT leak calls to the enclosing method', () => {
    const result = extract(
      `<?php\nfunction target(): void {}\nclass Outer {\n  public function build(): object {\n    return new class {\n      public function run(): void { target(); $this->helper(); self::other(); }\n    };\n  }\n  public function helper(): void {}\n  public function other(): void {}\n}\n`,
    );
    // none of the anon-class body calls attribute to Outer.build (or anywhere).
    expect(hasRef(result, 'target')).toBe(false);
    expect(hasRef(result, 'helper')).toBe(false);
    expect(hasRef(result, 'other')).toBe(false);
  });

  it('anonymous-class $this->m() does NOT mis-bind to a same-named outer method', () => {
    const result = extract(
      `<?php\nclass Outer {\n  public function compute(): int { return 1; }\n  public function build(): object {\n    return new class {\n      public function inside(): int { return $this->compute(); }\n      public function compute(): int { return 2; }\n    };\n  }\n}\n`,
    );
    const outerCompute = byName(result, 'compute').find((s) => s.fqn === 'src/test.php:Outer.compute')!;
    // the wrong self-edge Outer.build -> Outer.compute must NOT exist.
    expect(result.references.some((r) => r.targetId === outerCompute.id)).toBe(false);
  });

  it('anonymous-class constructor-arg calls STILL attribute to the enclosing method', () => {
    const result = extract(
      `<?php\nfunction makeArg(): int { return 1; }\nclass Outer {\n  public function build(): object {\n    return new class(makeArg()) {\n      public function __construct(int $x) {}\n    };\n  }\n}\n`,
    );
    // the ctor arg runs in the enclosing scope at construction → edge preserved.
    expect(resolvedTo(result, 'build', 'makeArg')).toBe(true);
  });

  it('a comment between #[Attr] and a decl neither leaks into the signature nor drops the doc', () => {
    const result = extract(
      `<?php\nclass C {\n  #[Route("/x")]\n  /** Handles the request. */\n  public function handle(): void {}\n}\n`,
    );
    const handle = byName(result, 'handle')[0]!;
    expect(handle.signature).toBe('public function handle(): void');
    expect(handle.doc).toBe('Handles the request.');
  });

  it('PHP 8.4 asymmetric visibility reads the GET modifier for exportedness', () => {
    const result = extract(
      `<?php\nclass C {\n  private(set) private int $w = 0;\n  public private(set) int $ok = 0;\n  private(set) int $defGet = 0;\n}\n`,
    );
    expect(byName(result, 'w')[0]!.exported).toBe(false); // GET = private
    expect(byName(result, 'ok')[0]!.exported).toBe(true); // GET = public
    expect(byName(result, 'defGet')[0]!.exported).toBe(true); // GET defaults public
  });

  it('a comment after the keyword (no attribute) does NOT drop the keyword from the signature', () => {
    const result = extract(
      `<?php\nfunction /*c*/ topfn(): int { return 1; }\nclass C {\n  const /*c*/ FOO = 1;\n}\n`,
    );
    // The regression was the `function`/`const` keyword being skipped; assert it
    // survives (a mid-header comment with no attribute stays in the slice, which
    // is the pre-existing, acceptable behavior).
    const topfn = byName(result, 'topfn')[0]!.signature;
    expect(topfn.startsWith('function')).toBe(true);
    expect(topfn).toContain('topfn');
    const foo = byName(result, 'FOO')[0]!.signature;
    expect(foo.startsWith('const')).toBe(true);
    expect(foo).toContain('FOO');
  });

  it('phpDoc finds a /** block past a non-doc comment between #[Attr] and the decl', () => {
    const result = extract(
      `<?php\nclass C {\n  #[Route("/x")]\n  // junk\n  /** Real doc. */\n  public function foo(): void {}\n}\n`,
    );
    const foo = byName(result, 'foo')[0]!;
    expect(foo.doc).toBe('Real doc.');
    expect(foo.signature).toBe('public function foo(): void');
  });
});

describe('php extractor — code-review (xhigh) regressions', () => {
  it('call-shaped language constructs (isset/empty/eval/die) emit no ref', () => {
    const result = extract(
      `<?php\nfunction caller(): void { isset($x); empty($y); eval("z"); die("bye"); realCall(); }\n`,
    );
    expect(hasRef(result, 'isset')).toBe(false);
    expect(hasRef(result, 'empty')).toBe(false);
    expect(hasRef(result, 'eval')).toBe(false);
    expect(hasRef(result, 'die')).toBe(false);
    // a real bare call still records a ref (sanity that suppression is targeted).
    expect(hasRef(result, 'realCall')).toBe(true);
  });

  it('dynamic method/static names emit no junk $-prefixed ref', () => {
    const result = extract(
      `<?php\nclass D {\n  public function handle($obj, $prop): void {\n    $obj->$prop();\n    $obj?->$prop();\n    $this->$prop();\n    Other::$dynMethod();\n    $obj->realMethod();\n  }\n}\n`,
    );
    expect(result.references.some((r) => r.targetName.startsWith('$'))).toBe(false);
    // the static dynamic name does not leak either.
    expect(hasRef(result, 'dynMethod')).toBe(false);
    // a real member call still records its ref.
    expect(hasRef(result, 'realMethod')).toBe(true);
  });

  it('same-name functions across namespaces in one file do NOT mis-resolve (no wrong edge)', () => {
    const result = extract(
      `<?php\nnamespace A { function helper(): void {} function callerA(): void { helper(); } }\nnamespace B { function helper(): void {} function callerB(): void { helper(); } }\n`,
    );
    // `helper` is ambiguous (two same-name top-level functions) → both calls stay
    // UNRESOLVED rather than first-wins binding callerB to A's helper.
    const resolvedHelper = result.references.filter(
      (r) => r.targetName === 'helper' && r.targetId !== null,
    );
    expect(resolvedHelper).toHaveLength(0);
  });

  it('a UNIQUE top-level function still resolves (ambiguity guard is targeted)', () => {
    const result = extract(
      `<?php\nfunction only(): void {}\nfunction caller(): void { only(); }\n`,
    );
    expect(resolvedTo(result, 'caller', 'only')).toBe(true);
  });

  it('a mid-header /** comment with no preceding attribute is NOT taken as the doc', () => {
    const result = extract(`<?php\nfunction /** D */ bar(): void {}\nconst /** CD */ FOO = 1;\n`);
    expect(byName(result, 'bar')[0]!.doc).toBeNull();
    expect(byName(result, 'FOO')[0]!.doc).toBeNull();
  });

  it('an empty group-use emits no phantom import', () => {
    const result = extract(`<?php\nuse App\\{};\n`);
    expect(result.imports).toHaveLength(0);
  });
});
