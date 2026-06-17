import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'kotlin', path = 'src/test.kt') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

const byName = (result: ReturnType<typeof extract>, name: string) =>
  result.symbols.filter((s) => s.name === name);

beforeAll(async () => {
  await initParser();
});

describe('kotlin extractor — functions and exportedness', () => {
  it('extracts a fun with kind/fqn/signature/exported/lines', () => {
    const result = extract(`fun greet(name: String): String {\n    return name\n}\n`);
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('greet');
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.kt:greet');
    expect(sym.signature).toBe('fun greet(name: String): String');
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(3);
    expect(sym.language).toBe('kotlin');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
    expect(sym.exported).toBe(true); // no modifier = public
  });

  it('public/internal/protected export; private does not', () => {
    const result = extract(
      `public fun a() {}\ninternal fun b() {}\nprivate fun c() {}\n`,
    );
    expect(result.symbols.map((s) => s.exported)).toEqual([true, true, false]);
  });

  it('an expression body is excluded from the signature', () => {
    const sym = extract(`fun double(x: Int): Int = x * 2\n`).symbols[0]!;
    expect(sym.signature).toBe('fun double(x: Int): Int');
  });

  it('suspend/inline modifiers stay in the signature', () => {
    const sym = extract(`suspend inline fun fetch(): Int {\n    return 0\n}\n`).symbols[0]!;
    expect(sym.signature).toBe('suspend inline fun fetch(): Int');
  });

  it('caps the displayed signature at 120 chars', () => {
    const params = Array.from({ length: 40 }, (_, i) => `a${i}: Int`).join(', ');
    const sym = extract(`fun wide(${params}) {}\n`).symbols[0]!;
    expect(sym.signature.length).toBe(120);
  });
});

describe('kotlin extractor — types', () => {
  it('class/data/sealed/object → class kind; object members keyed on it', () => {
    const result = extract(`class Plain\ndata class D(val x: Int)\nsealed class S\nobject O {\n  fun m() {}\n}\n`);
    expect(byName(result, 'Plain')[0]!.kind).toBe('class');
    expect(byName(result, 'D')[0]!.kind).toBe('class');
    expect(byName(result, 'S')[0]!.kind).toBe('class');
    expect(byName(result, 'O')[0]!.kind).toBe('class');
    expect(byName(result, 'm')[0]!.fqn).toBe('src/test.kt:O.m');
  });

  it('interface and fun interface → interface kind', () => {
    const result = extract(`interface I {\n  fun a()\n}\nfun interface F {\n  fun g()\n}\n`);
    expect(byName(result, 'I')[0]!.kind).toBe('interface');
    expect(byName(result, 'F')[0]!.kind).toBe('interface');
  });

  it('interface members ARE extracted (declaration-only methods)', () => {
    const result = extract(`interface Shape {\n  fun area(): Double\n}\n`);
    const area = byName(result, 'area')[0]!;
    expect(area.kind).toBe('method');
    expect(area.fqn).toBe('src/test.kt:Shape.area');
  });

  it('enum class → enum kind; entries NOT extracted; body methods ARE', () => {
    const result = extract(`enum class Kind {\n  A, B;\n  fun label(): String = "x"\n}\n`);
    expect(byName(result, 'Kind')[0]!.kind).toBe('enum');
    expect(byName(result, 'A')).toHaveLength(0);
    expect(byName(result, 'B')).toHaveLength(0);
    expect(byName(result, 'label')[0]!.fqn).toBe('src/test.kt:Kind.label');
  });

  it('typealias → type kind (name is the alias, not the aliased type)', () => {
    const sym = extract(`typealias Handler = (Int) -> Unit\n`).symbols[0]!;
    expect(sym.kind).toBe('type');
    expect(sym.name).toBe('Handler');
    expect(sym.signature).toBe('typealias Handler = (Int) -> Unit');
  });

  it('nested types use simple-name FQNs with distinct ids', () => {
    const result = extract(`class Outer {\n  class Inner {\n    fun f() {}\n  }\n}\n`);
    expect(byName(result, 'Inner')[0]!.fqn).toBe('src/test.kt:Inner');
    expect(byName(result, 'f')[0]!.fqn).toBe('src/test.kt:Inner.f');
  });
});

describe('kotlin extractor — members', () => {
  it('class properties → variable members; primary-ctor val/var too', () => {
    const result = extract(`class C(val p: Int, q: String) {\n  val derived: Int = 0\n  private var hidden = 1\n}\n`);
    expect(byName(result, 'p')[0]!.fqn).toBe('src/test.kt:C.p');
    expect(byName(result, 'p')[0]!.kind).toBe('variable');
    // a plain (no val/var) ctor parameter is NOT a property
    expect(byName(result, 'q')).toHaveLength(0);
    expect(byName(result, 'derived')[0]!.fqn).toBe('src/test.kt:C.derived');
    expect(byName(result, 'hidden')[0]!.exported).toBe(false);
  });

  it('secondary constructor → method named constructor', () => {
    const result = extract(`class K(val n: Int) {\n  constructor() : this(0) {\n    setup()\n  }\n  fun setup() {}\n}\n`);
    const ctors = byName(result, 'constructor');
    expect(ctors.some((c) => c.fqn === 'src/test.kt:K.constructor')).toBe(true);
    // primary (synthesized) + secondary both present with distinct ids
    expect(new Set(ctors.map((c) => c.id)).size).toBe(ctors.length);
    expect(ctors.length).toBeGreaterThanOrEqual(2);
  });

  it('companion object members merge into the enclosing class', () => {
    const result = extract(`class Repo {\n  companion object {\n    const val MAX = 10\n    fun create(): Repo = Repo()\n  }\n}\n`);
    expect(byName(result, 'MAX')[0]!.fqn).toBe('src/test.kt:Repo.MAX');
    expect(byName(result, 'create')[0]!.fqn).toBe('src/test.kt:Repo.create');
  });

  it('property getter omits the body from the signature', () => {
    const result = extract(`class C {\n  val computed: Int\n    get() = 42\n}\n`);
    expect(byName(result, 'computed')[0]!.signature).toBe('val computed: Int');
  });

  it('destructuring val extracts each binding, no phantom owner', () => {
    const result = extract(`val (a, b) = pair()\n`);
    expect(byName(result, 'a')).toHaveLength(1);
    expect(byName(result, 'b')).toHaveLength(1);
  });

  it('an object with an init block has no phantom constructor; the object owns the init call', () => {
    const result = extract(`object Config {\n  init {\n    load()\n  }\n  fun load() {}\n}\n`);
    expect(byName(result, 'constructor')).toHaveLength(0);
    const config = byName(result, 'Config')[0]!;
    const load = byName(result, 'load')[0]!;
    expect(result.references.some((r) => r.sourceId === config.id && r.targetId === load.id)).toBe(true);
  });

  it('a companion init block does not create a duplicate enclosing constructor', () => {
    const result = extract(
      `class Outer(val a: Int) {\n  init { ownSetup() }\n  fun ownSetup() {}\n  companion object {\n    init { compSetup() }\n    fun compSetup() {}\n  }\n}\n`,
    );
    // exactly one Outer.constructor (the class's own) — the companion's init does
    // not synthesize a second.
    expect(byName(result, 'constructor').filter((s) => s.fqn === 'src/test.kt:Outer.constructor')).toHaveLength(1);
    const outer = byName(result, 'Outer')[0]!;
    const compSetup = byName(result, 'compSetup')[0]!;
    expect(result.references.some((r) => r.sourceId === outer.id && r.targetId === compSetup.id)).toBe(true);
  });
});

describe('kotlin extractor — extensions', () => {
  it('extension fun keys on the receiver type; exported by own visibility', () => {
    const result = extract(`fun String.shout(): String = this\nprivate fun Int.neg(): Int = this\n`);
    const shout = byName(result, 'shout')[0]!;
    expect(shout.kind).toBe('method');
    expect(shout.fqn).toBe('src/test.kt:String.shout');
    expect(shout.exported).toBe(true);
    expect(byName(result, 'neg')[0]!.exported).toBe(false);
  });

  it('generic/scoped/nullable receivers unwrap to the simple type name', () => {
    const result = extract(`fun List<Int>.a() {}\nfun com.pkg.Type.b() {}\nfun String?.c() {}\n`);
    expect(byName(result, 'a')[0]!.fqn).toBe('src/test.kt:List.a');
    expect(byName(result, 'b')[0]!.fqn).toBe('src/test.kt:Type.b');
    expect(byName(result, 'c')[0]!.fqn).toBe('src/test.kt:String.c');
  });

  it('a member extension in a non-exported container is not exported', () => {
    // top-level extension follows its own visibility; a MEMBER extension is also
    // gated on the enclosing class.
    const result = extract(`private class Helpers {\n  fun String.shout(): String = this\n}\n`);
    expect(byName(result, 'shout')[0]!.exported).toBe(false);
  });
});

describe('kotlin extractor — references', () => {
  const resolvedTo = (result: ReturnType<typeof extract>, sourceName: string, targetName: string) => {
    const src = byName(result, sourceName)[0]!;
    const tgt = byName(result, targetName)[0]!;
    return result.references.some(
      (r) => r.sourceId === src.id && r.targetId === tgt.id && r.targetName === targetName,
    );
  };

  it('resolves a bare function call', () => {
    const result = extract(`fun a() {\n  b()\n}\nfun b() {}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves an implicit-this method call', () => {
    const result = extract(`class C {\n  fun a() {\n    b()\n  }\n  fun b() {}\n}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves an explicit this.method() call', () => {
    const result = extract(`class C {\n  fun a() {\n    this.b()\n  }\n  fun b() {}\n}\n`);
    const a = byName(result, 'a')[0]!;
    const b = byName(result, 'b')[0]!;
    const ref = result.references.find((r) => r.sourceId === a.id && r.targetName === 'b')!;
    expect(ref.targetId).toBe(b.id);
    expect(ref.selfReceiver).toBe(true);
  });

  it('resolves construction Foo() to the class', () => {
    const result = extract(`class P\nfun make(): P {\n  return P()\n}\n`);
    expect(resolvedTo(result, 'make', 'P')).toBe(true);
  });

  it('resolves a static-style Object.method() call', () => {
    const result = extract(`object Reg {\n  fun add() {}\n}\nfun use() {\n  Reg.add()\n}\n`);
    expect(resolvedTo(result, 'use', 'add')).toBe(true);
  });

  it('attributes init-block calls to the synthesized constructor', () => {
    const result = extract(`class C(val x: Int) {\n  init {\n    setup()\n  }\n  fun setup() {}\n}\n`);
    const ctor = byName(result, 'constructor')[0]!;
    const setup = byName(result, 'setup')[0]!;
    expect(result.references.some((r) => r.sourceId === ctor.id && r.targetId === setup.id)).toBe(true);
  });

  it('attributes property-initializer calls to the property', () => {
    const result = extract(`class C {\n  val v: Int = compute()\n  fun compute(): Int = 0\n}\n`);
    const v = byName(result, 'v')[0]!;
    const compute = byName(result, 'compute')[0]!;
    expect(result.references.some((r) => r.sourceId === v.id && r.targetId === compute.id)).toBe(true);
  });

  it('descends lambdas but prunes nested functions', () => {
    const result = extract(
      `fun outer() {\n  listOf(1).forEach { inLambda() }\n  fun nested() { inNested() }\n}\n`,
    );
    const outer = byName(result, 'outer')[0]!;
    const callees = result.references.filter((r) => r.sourceId === outer.id).map((r) => r.targetName);
    expect(callees).toContain('inLambda');
    expect(callees).not.toContain('inNested');
  });

  it('suppresses unresolved stdlib/scope callees', () => {
    const result = extract(`fun a() {\n  println("x")\n  require(true)\n}\n`);
    expect(result.references.some((r) => r.targetName === 'println')).toBe(false);
    expect(result.references.some((r) => r.targetName === 'require')).toBe(false);
  });

  it('keeps a file-local definition shadowing an ignored name', () => {
    const result = extract(`fun check() {}\nfun a() {\n  check()\n}\n`);
    expect(resolvedTo(result, 'a', 'check')).toBe(true);
  });

  it('extracts annotated declarations without leaking annotation names as refs', () => {
    // Annotations live in `modifiers` (skipped by the call walk); their
    // constant args are never calls in valid Kotlin.
    const result = extract(`@Deprecated("old")\nfun a() {}\nclass C {\n  @JvmStatic\n  fun b() {}\n}\n`);
    expect(byName(result, 'a')).toHaveLength(1);
    expect(byName(result, 'b')[0]!.fqn).toBe('src/test.kt:C.b');
    expect(result.references.some((r) => r.targetName === 'Deprecated')).toBe(false);
    expect(result.references.some((r) => r.targetName === 'JvmStatic')).toBe(false);
  });

  it('skips :: callable references (not calls)', () => {
    const result = extract(`fun a() {\n  val f = String::length\n}\n`);
    expect(result.references.some((r) => r.targetName === 'length')).toBe(false);
  });

  it('labeled this@Outer.m() resolves against the labeled class, not the inner one', () => {
    const result = extract(
      `class Outer {\n  fun shared() {}\n  inner class Inner {\n    fun shared() {}\n    fun go() {\n      this@Outer.shared()\n    }\n  }\n}\n`,
    );
    const go = byName(result, 'go')[0]!;
    const outerShared = byName(result, 'shared').find((s) => s.fqn === 'src/test.kt:Outer.shared')!;
    const ref = result.references.find((r) => r.sourceId === go.id && r.targetName === 'shared')!;
    expect(ref.receiver).toBe('Outer');
    expect(ref.targetId).toBe(outerShared.id);
  });

  it('attributes enum-entry constructor-arg calls to the synthesized constructor', () => {
    const result = extract(
      `enum class Color(val rgb: Int) {\n  RED(make()),\n  GREEN(other());\n}\nfun make(): Int = 0\nfun other(): Int = 1\n`,
    );
    const ctor = byName(result, 'constructor').find((s) => s.fqn === 'src/test.kt:Color.constructor')!;
    const make = byName(result, 'make')[0]!;
    expect(result.references.some((r) => r.sourceId === ctor.id && r.targetId === make.id)).toBe(true);
    // not attributed to module scope
    expect(result.references.some((r) => r.sourceId === null && r.targetName === 'make')).toBe(false);
  });

  it('attributes secondary-constructor delegation-arg calls to the constructor', () => {
    const result = extract(
      `class K {\n  constructor() : this(parse()) {}\n  constructor(n: Int)\n  fun parse(): Int = 0\n}\n`,
    );
    const ctors = byName(result, 'constructor');
    const parse = byName(result, 'parse')[0]!;
    expect(
      result.references.some((r) => ctors.some((c) => c.id === r.sourceId) && r.targetId === parse.id),
    ).toBe(true);
    // not leaked to module scope
    expect(result.references.some((r) => r.sourceId === null && r.targetName === 'parse')).toBe(false);
  });

  it('attributes enum-entry args even when the enum has only a secondary constructor', () => {
    const result = extract(`enum class E {\n  A(make());\n  constructor(n: Int) {}\n}\nfun make(): Int = 0\n`);
    expect(result.references.some((r) => r.sourceId !== null && r.targetName === 'make')).toBe(true);
    expect(result.references.some((r) => r.sourceId === null && r.targetName === 'make')).toBe(false);
  });

  it('attributes enum-entry anonymous-class-body initializer calls to the constructor (not module scope)', () => {
    const result = extract(
      `enum class Op {\n  ADD {\n    val seed = compute()\n    override fun apply() {}\n  };\n  abstract fun apply()\n}\nfun compute(): Int = 0\n`,
    );
    const ctor = byName(result, 'constructor').find((s) => s.fqn === 'src/test.kt:Op.constructor')!;
    const compute = byName(result, 'compute')[0]!;
    expect(result.references.some((r) => r.sourceId === ctor.id && r.targetId === compute.id)).toBe(true);
    expect(result.references.some((r) => r.sourceId === null && r.targetName === 'compute')).toBe(false);
  });
});

describe('kotlin extractor — docs', () => {
  it('extracts a KDoc /** */ block', () => {
    const result = extract(`/** Greets someone. */\nfun greet() {}\n`);
    expect(result.symbols[0]!.doc).toBe('Greets someone.');
  });

  it('takes the first content line of a multi-line KDoc', () => {
    const result = extract(`/**\n * Summary line.\n * @param x stuff\n */\nfun f(x: Int) {}\n`);
    expect(result.symbols[0]!.doc).toBe('Summary line.');
  });

  it('plain // and /* */ comments are NOT docs', () => {
    const line = extract(`// not a doc\nfun a() {}\n`);
    expect(line.symbols[0]!.doc).toBeNull();
    const block = extract(`/* not a doc */\nfun b() {}\n`);
    expect(block.symbols[0]!.doc).toBeNull();
  });

  it('a trailing comment is not a doc for the next declaration', () => {
    const result = extract(`val z = 1 /** trailing */\nfun a() {}\n`);
    expect(byName(result, 'a')[0]!.doc).toBeNull();
  });
});

describe('kotlin extractor — imports', () => {
  it('plain import → single-symbol binding (name = last segment)', () => {
    const result = extract(`import a.b.C\n`);
    expect(result.imports).toEqual([
      { file: 'src/test.kt', sourceModule: 'a.b', importedNames: [{ name: 'C' }], line: 1 },
    ]);
  });

  it('wildcard import → namespace', () => {
    const result = extract(`import a.b.*\n`);
    expect(result.imports[0]!.importedNames).toEqual([{ name: '*', kind: 'namespace' }]);
    expect(result.imports[0]!.sourceModule).toBe('a.b');
  });

  it('aliased import keeps the alias', () => {
    const result = extract(`import a.b.D as Alias\n`);
    expect(result.imports[0]!.importedNames).toEqual([{ name: 'D', alias: 'Alias' }]);
    expect(result.imports[0]!.sourceModule).toBe('a.b');
  });
});

describe('kotlin extractor — robustness', () => {
  it('an empty file yields no symbols', () => {
    expect(extract(``).symbols).toHaveLength(0);
  });

  it('a package header produces no symbols', () => {
    const result = extract(`package com.example.app\n\nfun a() {}\n`);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('a');
  });

  it('an extension method duplicating a type method gets a distinct id', () => {
    const result = extract(`class C {\n  fun m() {}\n}\nfun C.m() {}\n`);
    const ms = byName(result, 'm').filter((s) => s.fqn === 'src/test.kt:C.m');
    expect(ms).toHaveLength(2);
    expect(new Set(ms.map((s) => s.id)).size).toBe(2);
  });
});
