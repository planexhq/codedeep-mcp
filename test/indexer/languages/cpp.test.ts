import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { RECEIVER_OPAQUE } from '../../../src/types.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, path = 'src/test.cpp') {
  const tree = parseFile(src, 'cpp')!;
  return extractSymbols(tree, src, makeFileInfo('cpp', path));
}

type Result = ReturnType<typeof extract>;

const byName = (result: Result, name: string) => result.symbols.filter((s) => s.name === name);

const resolvedTo = (result: Result, sourceName: string, targetName: string) => {
  const src = byName(result, sourceName)[0]!;
  const tgt = byName(result, targetName)[0]!;
  return result.references.some(
    (r) => r.sourceId === src.id && r.targetId === tgt.id && r.targetName === targetName,
  );
};

const hasRef = (result: Result, targetName: string) =>
  result.references.some((r) => r.targetName === targetName);

const refTo = (result: Result, targetName: string) =>
  result.references.find((r) => r.targetName === targetName);

beforeAll(async () => {
  await initParser();
});

describe('cpp extractor — kinds, FQN, exportedness', () => {
  it('extracts a free function with kind/fqn/signature/exported/lines/id/doc', () => {
    const r = extract('// Adds two numbers.\nint add(int a, int b) {\n  return a + b;\n}\n');
    const add = byName(r, 'add');
    expect(add).toHaveLength(1);
    const s = add[0]!;
    expect(s.kind).toBe('function');
    expect(s.fqn).toBe('src/test.cpp:add');
    expect(s.signature).toBe('int add(int a, int b)');
    expect(s.exported).toBe(true);
    expect(s.startLine).toBe(2);
    expect(s.endLine).toBe(4);
    expect(s.file).toBe('src/test.cpp');
    expect(s.language).toBe('cpp');
    expect(s.id).toMatch(/^[0-9a-f]{16}$/);
    expect(s.doc).toBe('Adds two numbers.');
  });

  it('treats class/struct/union as class kind; enumerators are not extracted', () => {
    const r = extract('class A {};\nstruct B {};\nunion C { int i; float f; };\nenum class E { Red, Green };\n');
    expect(byName(r, 'A')[0]!.kind).toBe('class');
    expect(byName(r, 'B')[0]!.kind).toBe('class');
    expect(byName(r, 'C')[0]!.kind).toBe('class');
    expect(byName(r, 'E')[0]!.kind).toBe('enum');
    expect(byName(r, 'Red')).toHaveLength(0);
    expect(byName(r, 'Green')).toHaveLength(0);
  });

  it('typedef and using-alias are type kind', () => {
    const r = extract('typedef int MyInt;\nusing Str = const char*;\n');
    expect(byName(r, 'MyInt')[0]!.kind).toBe('type');
    expect(byName(r, 'Str')[0]!.kind).toBe('type');
  });

  it('extracts declarations inside extern "C" { } (and a single extern "C" decl)', () => {
    const r = extract('extern "C" {\nint c_api(int);\nvoid other();\n}\nextern "C" int single(void);\n');
    expect(byName(r, 'c_api')[0]!.kind).toBe('function');
    expect(byName(r, 'c_api')[0]!.exported).toBe(true);
    expect(byName(r, 'other')[0]!.kind).toBe('function');
    expect(byName(r, 'single')[0]!.kind).toBe('function');
  });

  it('does not create a phantom empty-named symbol for an unbraced extern "C" record', () => {
    const r = extract('extern "C" struct S { int x; };\nextern "C" struct Fwd;\n');
    expect(byName(r, 'S')[0]!.kind).toBe('class');
    expect(byName(r, 'x')[0]!.kind).toBe('variable');
    expect(r.symbols.every((s) => s.name !== '')).toBe(true); // no nameless garbage
    expect(r.symbols.every((s) => s.fqn !== 'src/test.cpp:')).toBe(true); // no degenerate FQN
  });

  it('uses the record name (not its body) in an inline-record variable signature', () => {
    const r = extract('struct Named { int x; int y; } g;\n');
    expect(byName(r, 'Named')[0]!.kind).toBe('class'); // the struct is still defined
    const g = byName(r, 'g')[0]!;
    expect(g.kind).toBe('variable');
    expect(g.signature).toBe('Named g'); // not "struct Named { int x; int y; } g"
  });

  it('class members: methods, fields (one per declarator), static', () => {
    const r = extract(
      'class W {\npublic:\n  int compute(int a) const;\n  static int count();\n  int a = 1, b, c = 3;\n  static constexpr int K = 5;\n};\n',
    );
    expect(byName(r, 'compute')[0]!.kind).toBe('method');
    expect(byName(r, 'count')[0]!.signature).toBe('static int count()');
    // `int a = 1, b, c = 3;` → three variable fields, initializers dropped.
    expect(byName(r, 'a')[0]!.signature).toBe('int a');
    expect(byName(r, 'b')[0]!.signature).toBe('int b');
    expect(byName(r, 'c')[0]!.signature).toBe('int c');
    expect(byName(r, 'K')[0]!.signature).toBe('static constexpr int K');
    for (const n of ['a', 'b', 'c', 'K']) expect(byName(r, n)[0]!.kind).toBe('variable');
  });
});

describe('cpp extractor — function pointers are variables, not functions', () => {
  it('classifies a function-pointer field/variable as variable (not method/function)', () => {
    const r = extract(
      'int (*gfp)(int) = nullptr;\nstruct S {\n  int (*cb)(int);\n  void (*table[4])(int);\n};\n',
    );
    expect(byName(r, 'gfp')[0]!.kind).toBe('variable');
    expect(byName(r, 'cb')[0]!.kind).toBe('variable');
    expect(byName(r, 'cb')[0]!.fqn).toBe('src/test.cpp:S.cb');
    expect(byName(r, 'table')[0]!.kind).toBe('variable');
  });

  it('keeps a real function returning a pointer as a function/method', () => {
    const r = extract('int* getPtr(int);\nstruct S { char* name() const; };\n');
    expect(byName(r, 'getPtr')[0]!.kind).toBe('function');
    expect(byName(r, 'name')[0]!.kind).toBe('method');
  });

  it('does not create a wrong-kind edge from a call to a function-pointer member', () => {
    // `this->cb(3)` must NOT resolve to the data member `cb` (a variable): a
    // variable can never be in methodsByClass, so the edge stays unresolved.
    const r = extract('struct S {\n  int (*cb)(int);\n  void run() { this->cb(3); }\n};\n');
    const ref = refTo(r, 'cb');
    expect(ref).toBeDefined();
    expect(ref!.targetId).toBeNull(); // unresolved, not a wrong-kind resolved edge
  });
});

describe('cpp extractor — constructors, destructors, operators', () => {
  it('names constructors after the class and the destructor ~Class', () => {
    const r = extract('class Foo {\npublic:\n  Foo();\n  Foo(int x);\n  ~Foo();\n};\n');
    const ctors = byName(r, 'Foo').filter((s) => s.kind === 'method');
    expect(ctors).toHaveLength(2); // two overloaded constructors
    expect(ctors[0]!.fqn).toBe('src/test.cpp:Foo.Foo');
    const dtor = byName(r, '~Foo')[0]!;
    expect(dtor.kind).toBe('method');
    expect(dtor.fqn).toBe('src/test.cpp:Foo.~Foo');
  });

  it('names overloaded and conversion operators', () => {
    const r = extract(
      'struct V {\n  bool operator==(const V&) const;\n  V& operator=(V&&) noexcept;\n  operator bool() const;\n};\n',
    );
    expect(byName(r, 'operator==')[0]!.kind).toBe('method');
    expect(byName(r, 'operator=')[0]!.kind).toBe('method');
    expect(byName(r, 'operator bool')[0]!.kind).toBe('method');
  });

  it('extracts = default / = delete / pure-virtual declarations', () => {
    const r = extract('class W {\npublic:\n  W() = default;\n  W(const W&) = delete;\n  virtual int area() = 0;\n};\n');
    expect(byName(r, 'W').some((s) => s.signature === 'W() = default')).toBe(true);
    expect(byName(r, 'W').some((s) => s.signature === 'W(const W&) = delete')).toBe(true);
    expect(byName(r, 'area')[0]!.signature).toBe('virtual int area() = 0');
  });
});

describe('cpp extractor — positional access visibility', () => {
  it('class defaults to private; access labels flip exportedness for following members', () => {
    const r = extract('class C {\n  int a_;\npublic:\n  int b_;\nprivate:\n  int c_;\nprotected:\n  int d_;\n};\n');
    expect(byName(r, 'a_')[0]!.exported).toBe(false); // class default private
    expect(byName(r, 'b_')[0]!.exported).toBe(true); // public
    expect(byName(r, 'c_')[0]!.exported).toBe(false); // private
    expect(byName(r, 'd_')[0]!.exported).toBe(false); // protected NOT exported
  });

  it('struct defaults to public', () => {
    const r = extract('struct S {\n  int x;\n  void f();\nprivate:\n  int y;\n};\n');
    expect(byName(r, 'x')[0]!.exported).toBe(true);
    expect(byName(r, 'f')[0]!.exported).toBe(true);
    expect(byName(r, 'y')[0]!.exported).toBe(false);
  });

  it('a #ifdef-guarded access label does not bleed past #endif', () => {
    const r = extract(
      'class C {\npublic:\n  void a();\n#ifdef X\nprivate:\n  void b();\n#endif\n  void c();\n};\n',
    );
    expect(byName(r, 'a')[0]!.exported).toBe(true);
    expect(byName(r, 'b')[0]!.exported).toBe(false); // sees the guarded private:
    expect(byName(r, 'c')[0]!.exported).toBe(true); // reverts after #endif
  });

  it('a #else / #elif branch label does not inherit the #if branch visibility', () => {
    const r = extract(
      'class C {\npublic:\n#if X\nprivate:\n  void a();\n#else\n  void b();\n#endif\n  void c();\n};\n',
    );
    expect(byName(r, 'a')[0]!.exported).toBe(false); // #if branch private:
    expect(byName(r, 'b')[0]!.exported).toBe(true); // #else reverts to enclosing public:
    expect(byName(r, 'c')[0]!.exported).toBe(true); // after #endif
  });

  it('a private nested class does not export its public members', () => {
    const r = extract('class Outer {\n  class Inner {\n  public:\n    void m();\n  };\n};\n');
    expect(byName(r, 'Inner')[0]!.exported).toBe(false);
    expect(byName(r, 'm')[0]!.exported).toBe(false);
  });
});

describe('cpp extractor — namespaces & nested types', () => {
  it('namespaces fold into the qualifier; the FQN stays simple-name', () => {
    const r = extract('namespace app {\nclass S {\npublic:\n  void run();\n};\n}\n');
    expect(byName(r, 'S')[0]!.fqn).toBe('src/test.cpp:S');
    expect(byName(r, 'run')[0]!.fqn).toBe('src/test.cpp:S.run');
  });

  it('same-name types in different namespaces get distinct ids', () => {
    const r = extract('namespace a { struct X { int p; }; }\nnamespace b { struct X { int q; }; }\n');
    const xs = byName(r, 'X');
    expect(xs).toHaveLength(2);
    expect(xs[0]!.id).not.toBe(xs[1]!.id);
  });

  it('a nested type keeps a simple-name FQN', () => {
    const r = extract('class Outer {\npublic:\n  struct Inner { int z; };\n};\n');
    expect(byName(r, 'Inner')[0]!.fqn).toBe('src/test.cpp:Inner');
    expect(byName(r, 'z')[0]!.fqn).toBe('src/test.cpp:Inner.z');
  });
});

describe('cpp extractor — templates & preprocessor', () => {
  it('unwraps a template class and keeps the template preamble in the signature', () => {
    const r = extract('template<typename T>\nclass Box {\npublic:\n  T get() const;\n};\n');
    const box = byName(r, 'Box')[0]!;
    expect(box.kind).toBe('class');
    expect(box.signature).toBe('template<typename T> class Box');
    expect(byName(r, 'get')[0]!.kind).toBe('method');
  });

  it('extracts members guarded by an #ifndef include guard', () => {
    const r = extract('#ifndef G_H\n#define G_H\nclass Guarded {\npublic:\n  void m();\n};\n#endif\n');
    expect(byName(r, 'Guarded')[0]!.kind).toBe('class');
    expect(byName(r, 'm')[0]!.kind).toBe('method');
  });

  it('#include directives become imports', () => {
    const r = extract('#include <vector>\n#include "shape.h"\nint x;\n');
    expect(r.imports.map((i) => i.sourceModule).sort()).toEqual(['shape.h', 'vector']);
  });
});

describe('cpp extractor — the declaration/definition split', () => {
  it('extracts an in-class declaration and its out-of-line definition as separate symbols', () => {
    const r = extract('struct P {\n  void f();\n};\nvoid P::f() {\n}\n');
    const fs = byName(r, 'f');
    expect(fs).toHaveLength(2);
    expect(fs.every((s) => s.kind === 'method')).toBe(true);
    expect(fs.every((s) => s.fqn === 'src/test.cpp:P.f')).toBe(true);
    expect(fs[0]!.id).not.toBe(fs[1]!.id); // distinct ids (decl vs def)
  });

  it('an out-of-line definition keys its body on the class for same-file self-calls', () => {
    const r = extract(
      'struct S {\n  void a();\n  void b();\n};\nvoid S::a() { b(); }\nvoid S::b() {}\n',
    );
    // The out-of-line a() (the definition with a body) resolves its b() call
    // against S's other same-file method symbols. With both the in-class decl and
    // the out-of-line def present, methodsByClass is first-wins (the decl), so the
    // edge targets a `b` METHOD of S — the point is that it resolves, not which
    // copy. (Cross-file, the .cpp has only the def, so it resolves to the def.)
    const aDef = byName(r, 'a').find((s) => s.signature.includes('S::'))!;
    const ref = r.references.find((rf) => rf.sourceId === aDef.id && rf.targetName === 'b');
    expect(ref).toBeDefined();
    expect(ref!.targetId).not.toBeNull();
    const tgt = r.symbols.find((s) => s.id === ref!.targetId)!;
    expect(tgt.kind).toBe('method');
    expect(tgt.fqn).toBe('src/test.cpp:S.b');
  });
});

describe('cpp extractor — call resolution', () => {
  it('resolves a bare call to a free function', () => {
    const r = extract('int helper();\nvoid caller() { helper(); }\n');
    expect(resolvedTo(r, 'caller', 'helper')).toBe(true);
  });

  it('resolves an implicit-this and an explicit this-> call to a sibling method', () => {
    const r = extract('struct S {\n  void a() { b(); this->c(); }\n  void b() {}\n  void c() {}\n};\n');
    expect(resolvedTo(r, 'a', 'b')).toBe(true);
    expect(resolvedTo(r, 'a', 'c')).toBe(true);
  });

  it('captures an object member call as an unresolved name-keyed ref with a receiver', () => {
    const r = extract('struct Other { void run(); };\nvoid use(Other* o) { o->run(); }\n');
    const ref = refTo(r, 'run');
    expect(ref).toBeDefined();
    expect(ref!.receiver).toBe('o');
    // `run` resolves cross-receiver only when the receiver type matches; here it
    // stays unresolved (no edge to a wrong target).
  });

  it('captures a scope-resolution call with the scope as receiver', () => {
    const r = extract('void f() { ns::g(); }\n');
    const ref = refTo(r, 'g');
    expect(ref).toBeDefined();
    expect(ref!.receiver).toBe('ns');
  });

  it('resolves new Foo() to the class, never to a like-named function', () => {
    const r = extract('class Widget {};\nWidget* make() { return new Widget(); }\n');
    expect(resolvedTo(r, 'make', 'Widget')).toBe(true);
    expect(byName(r, 'Widget')[0]!.kind).toBe('class');
  });

  it('does not emit a call edge for a function-like macro in a preprocessor condition', () => {
    // `#if FOO(3)` is a preprocessor condition, not a C++ runtime call — capturing
    // it would inject a spurious resolved edge to a same-named real function.
    const r = extract('int FOO(int);\n#if FOO(3)\nint g();\n#endif\n');
    expect(r.references.filter((ref) => ref.targetName === 'FOO')).toHaveLength(0);
  });

  it('marks a chained-receiver call opaque (findable, never resolved)', () => {
    const r = extract('struct S { void a(S* s) { s->next()->run(); } };\n');
    const ref = refTo(r, 'run');
    expect(ref).toBeDefined();
    expect(ref!.receiver).toBe(RECEIVER_OPAQUE);
    expect(ref!.targetId).toBeNull();
  });
});

describe('cpp extractor — id hygiene', () => {
  it('produces unique ids across overloads, the decl/def split, and members', () => {
    const r = extract(
      'int f(int);\nint f(double);\nint f(int x) { return x; }\nstruct S {\n  void g();\n  int g(int);\n};\nvoid S::g() {}\n',
    );
    const ids = r.symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });
});
