import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'dart', path = 'src/test.dart') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

const byName = (result: ReturnType<typeof extract>, name: string) =>
  result.symbols.filter((s) => s.name === name);

const resolvedTo = (
  result: ReturnType<typeof extract>,
  sourceName: string,
  targetName: string,
) => {
  const src = byName(result, sourceName)[0]!;
  const tgt = byName(result, targetName)[0]!;
  return result.references.some(
    (r) => r.sourceId === src.id && r.targetId === tgt.id && r.targetName === targetName,
  );
};

beforeAll(async () => {
  await initParser();
});

describe('dart extractor — functions and exportedness', () => {
  it('extracts a top-level function with kind/fqn/signature/exported/lines', () => {
    const result = extract(`int greet(String name) {\n  return 0;\n}\n`);
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('greet');
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.dart:greet');
    expect(sym.signature).toBe('int greet(String name)');
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(3);
    expect(sym.language).toBe('dart');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
    expect(sym.exported).toBe(true);
  });

  it('leading-underscore names are private; everything else exports', () => {
    const result = extract(`void pub() {}\nvoid _priv() {}\n`);
    expect(byName(result, 'pub')[0]!.exported).toBe(true);
    expect(byName(result, '_priv')[0]!.exported).toBe(false);
  });

  it('an expression body is excluded from the signature', () => {
    const sym = extract(`int double(int x) => x * 2;\n`).symbols[0]!;
    expect(sym.signature).toBe('int double(int x)');
  });

  it('async modifier and generics stay in the signature', () => {
    const sym = extract(`Future<int> fetch<T>() async {\n  return 0;\n}\n`).symbols[0]!;
    expect(sym.signature).toBe('Future<int> fetch<T>()');
  });

  it('caps the displayed signature at 120 chars', () => {
    const params = Array.from({ length: 40 }, (_, i) => `int a${i}`).join(', ');
    const sym = extract(`void wide(${params}) {}\n`).symbols[0]!;
    expect(sym.signature.length).toBe(120);
  });

  it('top-level getter and setter → function kind', () => {
    const result = extract(`String get name => 'x';\nset name(String v) {}\n`);
    const getter = byName(result, 'name').find((s) => s.signature.includes('get'))!;
    expect(getter.kind).toBe('function');
    const setter = byName(result, 'name').find((s) => s.signature.includes('set'))!;
    expect(setter.kind).toBe('function');
  });
});

describe('dart extractor — types', () => {
  it('class → class kind', () => {
    const sym = extract(`class Plain {}\n`).symbols[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.fqn).toBe('src/test.dart:Plain');
    expect(sym.signature).toBe('class Plain');
  });

  it('abstract class stays class kind; superclass/mixins kept in signature', () => {
    const sym = extract(`abstract class Shape extends Base with M implements I {\n  double area();\n}\n`).symbols.find(
      (s) => s.name === 'Shape',
    )!;
    expect(sym.kind).toBe('class');
    expect(sym.signature).toBe('abstract class Shape extends Base with M implements I');
  });

  it('mixin → class kind', () => {
    const sym = extract(`mixin Logger {\n  void log() {}\n}\n`).symbols.find((s) => s.name === 'Logger')!;
    expect(sym.kind).toBe('class');
    expect(sym.signature).toBe('mixin Logger');
  });

  it('enum → enum kind; constants NOT extracted', () => {
    const result = extract(`enum Color { red, green, blue }\n`);
    expect(byName(result, 'Color')[0]!.kind).toBe('enum');
    expect(byName(result, 'red')).toHaveLength(0);
    expect(byName(result, 'green')).toHaveLength(0);
  });

  it('enhanced enum members ARE extracted, keyed on the enum', () => {
    const result = extract(
      `enum Planet {\n  earth(5.9), mars(6.4);\n  final double mass;\n  const Planet(this.mass);\n  double gravity() => mass * 9.8;\n}\n`,
    );
    expect(byName(result, 'gravity')[0]!.fqn).toBe('src/test.dart:Planet.gravity');
    expect(byName(result, 'mass')[0]!.kind).toBe('variable');
    expect(byName(result, 'constructor')[0]!.fqn).toBe('src/test.dart:Planet.constructor');
  });

  it('typedef → type kind, name is the alias', () => {
    const sym = extract(`typedef IntList = List<int>;\n`).symbols[0]!;
    expect(sym.name).toBe('IntList');
    expect(sym.kind).toBe('type');
    expect(sym.signature).toBe('typedef IntList = List<int>');
  });

  it('top-level external function/getter/variable are extracted', () => {
    const result = extract(`external void doStuff();\nexternal int get prop;\nexternal int counter;\n`);
    expect(byName(result, 'doStuff')[0]!.kind).toBe('function');
    expect(byName(result, 'prop')[0]!.kind).toBe('function');
    expect(byName(result, 'counter')[0]!.kind).toBe('variable');
  });

  it('extension type → class kind with representation field + body members', () => {
    const result = extract(
      `extension type Meters(int value) implements int {\n  int get raw => value;\n  void show() => log();\n}\n`,
    );
    expect(byName(result, 'Meters')[0]!.kind).toBe('class');
    expect(byName(result, 'value')[0]!.fqn).toBe('src/test.dart:Meters.value');
    expect(byName(result, 'raw')[0]!.fqn).toBe('src/test.dart:Meters.raw');
    expect(byName(result, 'show')[0]!.fqn).toBe('src/test.dart:Meters.show');
  });
});

describe('dart extractor — members', () => {
  it('instance methods key on the class; private underscore methods do not export', () => {
    const result = extract(`class C {\n  void pub() {}\n  void _priv() {}\n}\n`);
    expect(byName(result, 'pub')[0]!.fqn).toBe('src/test.dart:C.pub');
    expect(byName(result, 'pub')[0]!.kind).toBe('method');
    expect(byName(result, 'pub')[0]!.exported).toBe(true);
    expect(byName(result, '_priv')[0]!.exported).toBe(false);
  });

  it('members of a private class are not exported', () => {
    const result = extract(`class _Hidden {\n  void m() {}\n}\n`);
    expect(byName(result, 'm')[0]!.exported).toBe(false);
  });

  it('getters/setters → method kind keyed on the class', () => {
    const result = extract(`class C {\n  int get v => 0;\n  set v(int x) {}\n}\n`);
    const members = byName(result, 'v');
    expect(members).toHaveLength(2);
    expect(members.every((s) => s.kind === 'method')).toBe(true);
    expect(members.every((s) => s.fqn === 'src/test.dart:C.v')).toBe(true);
  });

  it('operator methods → method named for the operator', () => {
    const result = extract(
      `class V {\n  int operator +(V o) => 0;\n  bool operator ==(Object o) => true;\n  int operator [](int i) => i;\n}\n`,
    );
    expect(byName(result, '+')[0]!.kind).toBe('method');
    expect(byName(result, '+')[0]!.fqn).toBe('src/test.dart:V.+');
    expect(byName(result, '==')[0]).toBeDefined();
    expect(byName(result, '[]')[0]).toBeDefined();
  });

  it('a return-type-less method (f() => g()) is a method, not a constructor', () => {
    const result = extract(`class A {\n  f() => g();\n  void g() {}\n}\n`);
    expect(byName(result, 'f')[0]!.kind).toBe('method');
    expect(byName(result, 'f')[0]!.fqn).toBe('src/test.dart:A.f');
    // The real constructor namespace is not polluted.
    expect(byName(result, 'constructor')).toHaveLength(0);
    // and its body call resolves.
    expect(resolvedTo(result, 'f', 'g')).toBe(true);
  });

  it('abstract methods are extracted (declaration-only, no body)', () => {
    const result = extract(`abstract class S {\n  double area();\n}\n`);
    expect(byName(result, 'area')[0]!.kind).toBe('method');
    expect(byName(result, 'area')[0]!.fqn).toBe('src/test.dart:S.area');
  });

  it('fields → variable members, one per name', () => {
    const result = extract(`class C {\n  int a, b;\n  final String name = 'x';\n  static int count = 0;\n}\n`);
    expect(byName(result, 'a')[0]!.kind).toBe('variable');
    expect(byName(result, 'a')[0]!.fqn).toBe('src/test.dart:C.a');
    expect(byName(result, 'b')[0]!.fqn).toBe('src/test.dart:C.b');
    expect(byName(result, 'name')[0]!.kind).toBe('variable');
    expect(byName(result, 'count')[0]!.kind).toBe('variable');
  });

  it('top-level variables → variable; const initializer kept in signature', () => {
    const result = extract(`const maxLen = 280;\nint counter = 0;\nfinal greeting = 'hi';\n`);
    expect(byName(result, 'maxLen')[0]!.kind).toBe('variable');
    expect(byName(result, 'maxLen')[0]!.signature).toBe('const maxLen = 280');
    expect(byName(result, 'counter')[0]!.kind).toBe('variable');
  });
});

describe('dart extractor — constructors', () => {
  it('unnamed constructor → method named constructor', () => {
    const result = extract(`class Box {\n  final int v;\n  Box(this.v);\n}\n`);
    const ctor = byName(result, 'constructor')[0]!;
    expect(ctor.kind).toBe('method');
    expect(ctor.fqn).toBe('src/test.dart:Box.constructor');
    expect(ctor.signature).toBe('Box(this.v)');
  });

  it('named constructor → method named for the last segment', () => {
    const result = extract(`class Box {\n  final int v;\n  Box.unit() : v = 1;\n}\n`);
    const ctor = byName(result, 'unit')[0]!;
    expect(ctor.kind).toBe('method');
    expect(ctor.fqn).toBe('src/test.dart:Box.unit');
    expect(ctor.signature).toBe('Box.unit()'); // initializer list cut
  });

  it('factory constructor → method (named segment)', () => {
    const result = extract(`class Box {\n  Box();\n  factory Box.big() => Box();\n}\n`);
    expect(byName(result, 'big')[0]!.fqn).toBe('src/test.dart:Box.big');
    expect(byName(result, 'big')[0]!.signature).toBe('factory Box.big()');
  });

  it('private named constructor (leading underscore) is not exported', () => {
    const result = extract(`class Box {\n  Box._internal();\n}\n`);
    expect(byName(result, '_internal')[0]!.exported).toBe(false);
  });

  it('const constructor → method named constructor', () => {
    const result = extract(`class Box {\n  final int v;\n  const Box(this.v);\n}\n`);
    expect(byName(result, 'constructor')[0]!.fqn).toBe('src/test.dart:Box.constructor');
  });
});

describe('dart extractor — extensions (methods-apart)', () => {
  it('extension methods key on the extended on-type', () => {
    const result = extract(`extension StringX on String {\n  String shout() => '!';\n}\n`);
    const m = byName(result, 'shout')[0]!;
    expect(m.kind).toBe('method');
    expect(m.fqn).toBe('src/test.dart:String.shout');
    // The extension itself is not a symbol.
    expect(byName(result, 'StringX')).toHaveLength(0);
  });

  it('on-type generics are stripped to the simple name', () => {
    const result = extract(`extension on Map<String, int> {\n  int size() => 0;\n}\n`);
    expect(byName(result, 'size')[0]!.fqn).toBe('src/test.dart:Map.size');
  });

  it('anonymous extension still keys members on the on-type', () => {
    const result = extract(`extension on Circle {\n  String label() => 'c';\n}\n`);
    expect(byName(result, 'label')[0]!.fqn).toBe('src/test.dart:Circle.label');
  });

  it('member exportedness follows the EXTENSION name, not the on-type', () => {
    // Private extension on a public type → members NOT exported.
    expect(extract(`extension _Priv on String {\n  String a() => '';\n}\n`).symbols
      .find((s) => s.name === 'a')!.exported).toBe(false);
    // Public extension on a private type → members ARE exported.
    expect(extract(`extension Pub on _Secret {\n  String b() => '';\n}\n`).symbols
      .find((s) => s.name === 'b')!.exported).toBe(true);
    // Anonymous extension → public.
    expect(extract(`extension on String {\n  String c() => '';\n}\n`).symbols
      .find((s) => s.name === 'c')!.exported).toBe(true);
  });
});

describe('dart extractor — references', () => {
  it('resolves a bare function call', () => {
    const result = extract(`void a() {\n  b();\n}\nvoid b() {}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves an implicit-this method call', () => {
    const result = extract(`class C {\n  void a() {\n    b();\n  }\n  void b() {}\n}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves an explicit this.method() call', () => {
    const result = extract(`class C {\n  void a() {\n    this.b();\n  }\n  void b() {}\n}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves construction Type(...) to the class', () => {
    const result = extract(`class P {\n  P();\n}\nP make() => P();\n`);
    expect(resolvedTo(result, 'make', 'P')).toBe(true);
  });

  it('resolves a named-constructor call Class.named()', () => {
    const result = extract(`class P {\n  P.zero() {}\n}\nP make() => P.zero();\n`);
    expect(resolvedTo(result, 'make', 'zero')).toBe(true);
  });

  it('resolves a static-style member call Class.method()', () => {
    const result = extract(`class P {\n  static P make() => P.build();\n  static P build() => P.make();\n}\n`);
    expect(resolvedTo(result, 'make', 'build')).toBe(true);
  });

  it('captures cascade method-calls on this (self)', () => {
    const result = extract(`class C {\n  void run() {\n    this..a()..b();\n  }\n  void a() {}\n  void b() {}\n}\n`);
    expect(resolvedTo(result, 'run', 'a')).toBe(true);
    expect(resolvedTo(result, 'run', 'b')).toBe(true);
  });

  it('captures cascade method-calls on a named receiver as member refs', () => {
    const result = extract(`class C {\n  void run(C other) {\n    other..a()..b();\n  }\n  void a() {}\n}\n`);
    const run = byName(result, 'run')[0]!;
    const refs = result.references.filter((r) => r.sourceId === run.id && r.receiver === 'other');
    expect(refs.map((r) => r.targetName).sort()).toEqual(['a', 'b']);
  });

  it('keys each cascade chain to its own receiver when two share a host', () => {
    const result = extract(`class C {\n  void run() {\n    f(aa..x(), bb..y());\n  }\n}\n`);
    const run = byName(result, 'run')[0]!;
    const x = result.references.find((r) => r.sourceId === run.id && r.targetName === 'x');
    const y = result.references.find((r) => r.sourceId === run.id && r.targetName === 'y');
    expect(x?.receiver).toBe('aa');
    expect(y?.receiver).toBe('bb'); // not 'aa' — the bug was using the host's first target
  });

  it('recovers a self-call from a this-bodied arrow closure', () => {
    const result = extract(`class C {\n  void run() {\n    xs.forEach((e) => this.g());\n  }\n  void g() {}\n}\n`);
    expect(resolvedTo(result, 'run', 'g')).toBe(true);
  });

  it('recovers a member ref from an obj-bodied arrow closure', () => {
    const result = extract(`class C {\n  void run(C obj) {\n    xs.map((e) => obj.handle());\n  }\n  void handle() {}\n}\n`);
    const run = byName(result, 'run')[0]!;
    expect(result.references.some((r) => r.sourceId === run.id && r.receiver === 'obj' && r.targetName === 'handle')).toBe(true);
  });

  it('resolves a self-call inside a field initializer', () => {
    const result = extract(`class C {\n  final v = build();\n}\nint build() => 0;\n`);
    expect(resolvedTo(result, 'v', 'build')).toBe(true);
  });

  it('resolves a call inside a constructor initializer list', () => {
    const result = extract(`class C {\n  int v;\n  C() : v = compute();\n  int compute() => 0;\n}\n`);
    expect(resolvedTo(result, 'constructor', 'compute')).toBe(true);
  });

  it('descends into lambdas (closure calls attribute to the enclosing body)', () => {
    const result = extract(`void a(List items) {\n  items.forEach((e) => b(e));\n}\nvoid b(e) {}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('recovers a member call from an arrow-closure body (grammar quirk)', () => {
    const result = extract(`class C {\n  void run() {\n    items.map((x) => helper());\n  }\n  void helper() {}\n}\n`);
    // `(x) => helper()` mis-parses, but the recovery resolves helper() as a self-call.
    expect(resolvedTo(result, 'run', 'helper')).toBe(true);
  });

  it('does not emit a false edge for a non-call arrow-closure body', () => {
    const result = extract(`void run() {\n  final f = ((x) => x + 1)(5);\n}\nint x() => 0;\n`);
    const run = byName(result, 'run')[0]!;
    expect(result.references.some((r) => r.sourceId === run.id)).toBe(false);
  });

  it('prunes nested local functions (their calls do not attribute to the enclosing body)', () => {
    const result = extract(`void a() {\n  void local() => b();\n  local();\n}\nvoid b() {}\n`);
    const a = byName(result, 'a')[0]!;
    expect(result.references.some((r) => r.sourceId === a.id && r.targetName === 'b')).toBe(false);
  });

  it('suppresses unresolved stdlib bare calls (print)', () => {
    const result = extract(`void a() {\n  print('x');\n}\n`);
    expect(result.references.some((r) => r.targetName === 'print')).toBe(false);
  });

  it('keeps a file-local definition that shadows an ignored name', () => {
    const result = extract(`void a() {\n  print();\n}\nvoid print() {}\n`);
    expect(resolvedTo(result, 'a', 'print')).toBe(true);
  });

  it('drops annotation-argument calls', () => {
    const result = extract(`class C {\n  @Meta(build())\n  void a() {}\n}\nvoid build() {}\n`);
    expect(result.references.some((r) => r.targetName === 'build')).toBe(false);
  });

  it('does not emit a ref for a chained receiver call', () => {
    const result = extract(`void a() {\n  x().y();\n}\n`);
    expect(result.references.some((r) => r.targetName === 'y')).toBe(false);
  });

  it('resolves a self-call inside an extension method body', () => {
    const result = extract(
      `class Circle {\n  String describe() => 'c';\n}\nextension X on Circle {\n  String label() => describe();\n}\n`,
    );
    // label's body call describe() resolves against Circle (extension methods-apart merge).
    const label = byName(result, 'label')[0]!;
    const describe = byName(result, 'describe').find((s) => s.fqn === 'src/test.dart:Circle.describe')!;
    expect(result.references.some((r) => r.sourceId === label.id && r.targetId === describe.id)).toBe(true);
  });
});

describe('dart extractor — docs', () => {
  it('extracts a /// doc block, first content line', () => {
    const sym = extract(`/// Greets people.\n/// Second line.\nclass G {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Greets people.');
  });

  it('extracts a /** */ doc', () => {
    const sym = extract(`/** A box. */\nclass Box {}\n`).symbols[0]!;
    expect(sym.doc).toBe('A box.');
  });

  it('plain // and /* */ comments are NOT docs', () => {
    expect(extract(`// not a doc\nclass A {}\n`).symbols[0]!.doc).toBeNull();
    expect(extract(`/* not a doc */\nclass B {}\n`).symbols[0]!.doc).toBeNull();
  });

  it('attaches a member doc anchored on the class_member wrapper', () => {
    const result = extract(`class C {\n  /// The greeting.\n  void greet() {}\n}\n`);
    expect(byName(result, 'greet')[0]!.doc).toBe('The greeting.');
  });
});

describe('dart extractor — imports', () => {
  it('records a plain import as a namespace import', () => {
    const result = extract(`import 'package:flutter/material.dart';\n`);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.sourceModule).toBe('package:flutter/material.dart');
    expect(result.imports[0]!.importedNames[0]!.name).toBe('*');
  });

  it('records a show combinator as named imports', () => {
    const result = extract(`import 'a.dart' show Foo, Bar;\n`);
    expect(result.imports[0]!.importedNames.map((n) => n.name).sort()).toEqual(['Bar', 'Foo']);
  });

  it('records an as-alias on the namespace binding', () => {
    const result = extract(`import 'a.dart' as a;\n`);
    expect(result.imports[0]!.importedNames[0]!.alias).toBe('a');
  });

  it('carries the as-alias onto show-combinator names', () => {
    const result = extract(`import 'a.dart' as p show Foo, Bar;\n`);
    expect(result.imports[0]!.importedNames.every((n) => n.alias === 'p')).toBe(true);
    expect(result.imports[0]!.importedNames.map((n) => n.name).sort()).toEqual(['Bar', 'Foo']);
  });

  it('skips export and part directives', () => {
    const result = extract(`export 'b.dart';\npart 'c.dart';\nlibrary my.lib;\n`);
    expect(result.imports).toHaveLength(0);
  });
});

describe('dart extractor — robustness', () => {
  it('handles an empty file', () => {
    const result = extract(``);
    expect(result.symbols).toHaveLength(0);
    expect(result.references).toHaveLength(0);
  });

  it('a destructuring pattern owns no initializer body but does not crash', () => {
    const result = extract(`void a() {\n  var (x, y) = pair();\n}\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['a']);
  });

  it('gives same-name same-signature members distinct ids via the occurrence counter', () => {
    const result = extract(`class C {\n  void m() {}\n}\nextension X on C {\n  void m() {}\n}\n`);
    const ms = byName(result, 'm');
    expect(ms).toHaveLength(2);
    expect(new Set(ms.map((s) => s.id)).size).toBe(2);
  });
});
