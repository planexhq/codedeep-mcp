import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { RECEIVER_OPAQUE } from '../../../src/types.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'csharp', path = 'src/test.cs') {
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

const hasRef = (result: ReturnType<typeof extract>, targetName: string) =>
  result.references.some((r) => r.targetName === targetName);

beforeAll(async () => {
  await initParser();
});

describe('csharp extractor — type declarations', () => {
  it('extracts a class with kind/fqn/signature/exported/lines/id', () => {
    const result = extract(`namespace N {\n  public class Widget {\n  }\n}\n`);
    const sym = byName(result, 'Widget')[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.fqn).toBe('src/test.cs:Widget');
    expect(sym.signature).toBe('public class Widget');
    expect(sym.exported).toBe(true);
    expect(sym.startLine).toBe(2);
    expect(sym.language).toBe('csharp');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('struct and record map to class kind', () => {
    const result = extract(`public struct P { }\npublic record R(int X);\npublic record struct Q(int Y);\n`);
    expect(byName(result, 'P')[0]!.kind).toBe('class');
    expect(byName(result, 'R')[0]!.kind).toBe('class');
    expect(byName(result, 'Q')[0]!.kind).toBe('class');
  });

  it('interface maps to interface kind and its members are extracted', () => {
    const result = extract(`public interface IFoo {\n  void Draw();\n  int Area() => 0;\n}\n`);
    expect(byName(result, 'IFoo')[0]!.kind).toBe('interface');
    expect(byName(result, 'Draw')[0]!.kind).toBe('method');
    expect(byName(result, 'Area')[0]!.kind).toBe('method');
  });

  it('enum maps to enum kind and members are NOT extracted', () => {
    const result = extract(`public enum Color { Red, Green, Blue }\n`);
    expect(byName(result, 'Color')[0]!.kind).toBe('enum');
    expect(byName(result, 'Red')).toHaveLength(0);
    expect(byName(result, 'Green')).toHaveLength(0);
  });

  it('delegate maps to type kind', () => {
    const result = extract(`public delegate int BinOp(int a, int b);\n`);
    const sym = byName(result, 'BinOp')[0]!;
    expect(sym.kind).toBe('type');
    expect(sym.signature).toBe('public delegate int BinOp(int a, int b)');
  });

  it('namespaces are not symbols (pure qualifier)', () => {
    const result = extract(`namespace A.B { class C {} }\n`);
    expect(byName(result, 'A.B')).toHaveLength(0);
    expect(byName(result, 'A')).toHaveLength(0);
    expect(byName(result, 'C')).toHaveLength(1);
  });

  it('file-scoped namespace types are top-level and exported', () => {
    const result = extract(`namespace App;\nclass FileScoped { }\n`);
    expect(byName(result, 'FileScoped')[0]!.exported).toBe(true);
  });
});

describe('csharp extractor — nested types', () => {
  it('nested types keep simple-name FQN with distinct ids', () => {
    const result = extract(`class Outer {\n  class Inner { }\n}\nclass Inner { }\n`);
    const inners = byName(result, 'Inner');
    expect(inners).toHaveLength(2);
    expect(inners[0]!.fqn).toBe('src/test.cs:Inner');
    expect(inners[1]!.fqn).toBe('src/test.cs:Inner');
    expect(inners[0]!.id).not.toBe(inners[1]!.id);
  });

  it('a nested type with no modifier is private (not exported)', () => {
    const result = extract(`public class Outer {\n  class Inner { }\n}\n`);
    expect(byName(result, 'Inner')[0]!.exported).toBe(false);
  });
});

describe('csharp extractor — members', () => {
  it('methods carry kind/fqn and exclude the body from the signature', () => {
    const result = extract(`class C {\n  public int Add(int a, int b) { return a + b; }\n}\n`);
    const sym = byName(result, 'Add')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.cs:C.Add');
    expect(sym.signature).toBe('public int Add(int a, int b)');
  });

  it('arrow-bodied methods exclude the expression body', () => {
    const sym = extract(`class C {\n  public int Two() => 2;\n}\n`).symbols.find((s) => s.name === 'Two')!;
    expect(sym.signature).toBe('public int Two()');
  });

  it('constructors are named "constructor"', () => {
    const result = extract(`class C {\n  public C(int x) { }\n}\n`);
    const sym = byName(result, 'constructor')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.cs:C.constructor');
  });

  it('overloaded constructors get distinct ids', () => {
    const result = extract(`class C {\n  public C(int x) { }\n  public C(string y) { }\n}\n`);
    const ctors = byName(result, 'constructor');
    expect(ctors).toHaveLength(2);
    expect(ctors[0]!.id).not.toBe(ctors[1]!.id);
  });

  it('properties are variable kind; signature stops before accessors/value', () => {
    const result = extract(`class C {\n  public int Name { get; set; }\n  public int Area => 1;\n}\n`);
    expect(byName(result, 'Name')[0]!.kind).toBe('variable');
    expect(byName(result, 'Name')[0]!.signature).toBe('public int Name');
    expect(byName(result, 'Area')[0]!.signature).toBe('public int Area');
  });

  it('fields emit one variable per declarator', () => {
    const result = extract(`class C {\n  public int X, Y;\n}\n`);
    expect(byName(result, 'X')[0]!.kind).toBe('variable');
    expect(byName(result, 'Y')[0]!.kind).toBe('variable');
  });

  it('events emit one variable per declarator', () => {
    const result = extract(`class C {\n  public event System.EventHandler A, B;\n}\n`);
    expect(byName(result, 'A')[0]!.kind).toBe('variable');
    expect(byName(result, 'B')[0]!.kind).toBe('variable');
  });

  it('operators are methods named for the operator token', () => {
    const result = extract(`class C {\n  public static C operator +(C a, C b) => a;\n}\n`);
    const sym = byName(result, '+')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.cs:C.+');
  });

  it('indexers are methods named this[]', () => {
    const result = extract(`class C {\n  public int this[int i] => i;\n}\n`);
    expect(byName(result, 'this[]')[0]!.kind).toBe('method');
  });

  it('signatures exclude leading attributes', () => {
    const result = extract(`class C {\n  [Obsolete]\n  public void M() { }\n}\n`);
    expect(byName(result, 'M')[0]!.signature).toBe('public void M()');
  });
});

describe('csharp extractor — records', () => {
  it('positional parameters become variable properties plus a synthesized constructor', () => {
    const result = extract(`public record Person(string First, string Last);\n`);
    expect(byName(result, 'First')[0]!.kind).toBe('variable');
    expect(byName(result, 'Last')[0]!.kind).toBe('variable');
    const ctor = byName(result, 'constructor')[0]!;
    expect(ctor.fqn).toBe('src/test.cs:Person.constructor');
    expect(ctor.signature).toBe('constructor(string First, string Last)');
  });

  it('a body member coexists with positional params', () => {
    const result = extract(`public record Person(string First) {\n  public string Full => First;\n}\n`);
    expect(byName(result, 'First')[0]!.kind).toBe('variable');
    expect(byName(result, 'Full')[0]!.kind).toBe('variable');
  });
});

describe('csharp extractor — exportedness', () => {
  it('member default is private (not exported); explicit access modifiers export', () => {
    const result = extract(
      `class C {\n  void Implicit() {}\n  private void Priv() {}\n  public void Pub() {}\n  internal void Int() {}\n  protected void Prot() {}\n}\n`,
    );
    expect(byName(result, 'Implicit')[0]!.exported).toBe(false);
    expect(byName(result, 'Priv')[0]!.exported).toBe(false);
    expect(byName(result, 'Pub')[0]!.exported).toBe(true);
    expect(byName(result, 'Int')[0]!.exported).toBe(true);
    expect(byName(result, 'Prot')[0]!.exported).toBe(true);
  });

  it('top-level types default to internal → exported', () => {
    const result = extract(`class TopLevel { }\n`);
    expect(byName(result, 'TopLevel')[0]!.exported).toBe(true);
  });

  it('interface members default to public → exported', () => {
    const result = extract(`interface I {\n  void A();\n  private void B() {}\n}\n`);
    expect(byName(result, 'A')[0]!.exported).toBe(true);
    expect(byName(result, 'B')[0]!.exported).toBe(false);
  });

  it('members of a private container are not exported', () => {
    const result = extract(`public class Outer {\n  private class Inner {\n    public void M() {}\n  }\n}\n`);
    expect(byName(result, 'M')[0]!.exported).toBe(false);
  });

  it('protected internal exports; private protected does not', () => {
    const result = extract(`class C {\n  protected internal void A() {}\n  private protected void B() {}\n}\n`);
    expect(byName(result, 'A')[0]!.exported).toBe(true);
    expect(byName(result, 'B')[0]!.exported).toBe(false);
  });
});

describe('csharp extractor — calls and resolution', () => {
  it('resolves an implicit-this bare call to an enclosing method', () => {
    const result = extract(`class C {\n  void A() { B(); }\n  void B() {}\n}\n`);
    expect(resolvedTo(result, 'A', 'B')).toBe(true);
  });

  it('resolves a this.M() self-call', () => {
    const result = extract(`class C {\n  void A() { this.B(); }\n  void B() {}\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'B')!;
    expect(ref.selfReceiver).toBe(true);
    expect(resolvedTo(result, 'A', 'B')).toBe(true);
  });

  it('resolves construction new Foo() to the class', () => {
    const result = extract(`class C {\n  void A() { var x = new Widget(); }\n}\nclass Widget {}\n`);
    expect(resolvedTo(result, 'A', 'Widget')).toBe(true);
  });

  it('resolves a same-file static member call C.M()', () => {
    const result = extract(`class A {\n  void Use() { Helper.Do(); }\n}\nclass Helper {\n  public void Do() {}\n}\n`);
    expect(resolvedTo(result, 'Use', 'Do')).toBe(true);
  });

  it('base.M() is not recorded as a reference', () => {
    const result = extract(`class C : Base {\n  void A() { base.Init(); }\n}\n`);
    expect(hasRef(result, 'Init')).toBe(false);
  });

  it('unwraps a generic-name callee (Generic<int>())', () => {
    const result = extract(`class C {\n  void A() { Generic<int>(); }\n  void Generic<T>() {}\n}\n`);
    expect(hasRef(result, 'Generic')).toBe(true);
  });

  it('resolves a conditional-access self-call this?.M()', () => {
    const result = extract(`class C {\n  void A() { this?.B(); }\n  void B() {}\n}\n`);
    expect(resolvedTo(result, 'A', 'B')).toBe(true);
  });

  it('records a member call a?.B() with its receiver', () => {
    const result = extract(`class C {\n  void A() { obj?.Render(); }\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'Render')!;
    expect(ref.receiver).toBe('obj');
  });

  it('chained calls a.b.c() are captured under an opaque receiver', () => {
    const result = extract(`class C {\n  void A() { x.y.z(); }\n}\n`);
    // The chained `.z()` (expression is a member_access) is now captured under
    // RECEIVER_OPAQUE — findable by method name (recall) but never resolved.
    const z = result.references.find((r) => r.targetName === 'z')!;
    expect(z.receiver).toBe(RECEIVER_OPAQUE);
    expect(z.targetId).toBeNull();
  });

  it('suppresses unresolved chained calls to common LINQ/stdlib names', () => {
    const result = extract(`class C {\n  void A() { items.Where(x => true).Select(x => x); }\n}\n`);
    expect(hasRef(result, 'Where')).toBe(false);
    expect(hasRef(result, 'Select')).toBe(false);
  });

  it('conditional-access chains key on the CALLED method, not the intermediate binding', () => {
    const result = extract(`class C {\n  void A(D a) { a?.b?.Build(); a?.c.Run(); }\n}\n`);
    // Each `?.` nests its left into the condition, so the outer conditional-access
    // (or member_access) callee yields the CALLED method — Build/Run — chained →
    // opaque, never resolved. The intermediate `b`/`c` are bindings, not calls.
    const build = result.references.find((r) => r.targetName === 'Build')!;
    expect(build.receiver).toBe(RECEIVER_OPAQUE);
    expect(build.targetId).toBeNull();
    const run = result.references.find((r) => r.targetName === 'Run')!;
    expect(run.receiver).toBe(RECEIVER_OPAQUE);
    // the intermediate `b` must NOT be mis-captured as a called method.
    expect(result.references.some((r) => r.targetName === 'b')).toBe(false);
  });

  it('field initializers attribute their calls to the field', () => {
    const result = extract(`class C {\n  int X = Compute();\n  int Compute() => 0;\n}\n`);
    expect(resolvedTo(result, 'X', 'Compute')).toBe(true);
  });

  it('property initializers attribute their calls to the property', () => {
    const result = extract(`class C {\n  int X { get; } = Compute();\n  int Compute() => 0;\n}\n`);
    expect(resolvedTo(result, 'X', 'Compute')).toBe(true);
  });

  it('constructor initializer calls attribute to the constructor', () => {
    const result = extract(`class C {\n  C() : this(Make()) {}\n  C(int x) {}\n  static int Make() => 0;\n}\n`);
    expect(resolvedTo(result, 'constructor', 'Make')).toBe(true);
  });

  it('calls inside lambdas attribute to the enclosing method', () => {
    const result = extract(`class C {\n  void A() { items.ForEach(x => Process(x)); }\n  void Process(int x) {}\n}\n`);
    expect(resolvedTo(result, 'A', 'Process')).toBe(true);
  });

  it('calls inside local functions are pruned (not attributed)', () => {
    const result = extract(`class C {\n  void A() {\n    Local();\n    void Local() { Hidden(); }\n  }\n}\n`);
    expect(hasRef(result, 'Hidden')).toBe(false);
  });

  it('nameof is suppressed when unresolved', () => {
    const result = extract(`class C {\n  void A() { var n = nameof(A); }\n}\n`);
    expect(hasRef(result, 'nameof')).toBe(false);
  });

  it('new Foo() resolves to the class, never an enclosing method named Foo', () => {
    // Builder has a METHOD named Item; `new Item()` must bind to the class Item.
    const result = extract(`class Builder {\n  Item Item() => null;\n  void Run() { var x = new Item(); }\n}\nclass Item {}\n`);
    const cls = byName(result, 'Item').find((s) => s.kind === 'class')!;
    const method = byName(result, 'Item').find((s) => s.kind === 'method')!;
    const ref = result.references.find((r) => r.targetName === 'Item' && r.targetId)!;
    expect(ref.targetId).toBe(cls.id);
    expect(ref.targetId).not.toBe(method.id);
  });

  it('a bare call never binds to a same-named class (construction needs new)', () => {
    // `Make()` (no new) must NOT resolve to class Make; it is a method call.
    const result = extract(`class C {\n  void A() { Make(); }\n}\nclass Make {}\n`);
    const ref = result.references.find((r) => r.targetName === 'Make')!;
    expect(ref.targetId).toBeNull();
  });
});

describe('csharp extractor — primary constructors (C# 12)', () => {
  it('a class primary constructor synthesizes a constructor and owns base-init calls', () => {
    const result = extract(`class D(int x) : Base(Make(x)) {\n  static int Make(int v) => v;\n}\n`);
    expect(byName(result, 'constructor')[0]!.fqn).toBe('src/test.cs:D.constructor');
    expect(resolvedTo(result, 'constructor', 'Make')).toBe(true);
    // class primary-ctor params are NOT properties (unlike records).
    expect(byName(result, 'x')).toHaveLength(0);
  });

  it('a record base-initializer call attributes to the synthesized constructor', () => {
    const result = extract(`record R(int X) : B(Mk()) {\n  static int Mk() => 0;\n}\n`);
    expect(byName(result, 'X')[0]!.kind).toBe('variable');
    expect(resolvedTo(result, 'constructor', 'Mk')).toBe(true);
  });
});

describe('csharp extractor — conversion operators, destructors, generics', () => {
  it('extracts a conversion operator and owns its body', () => {
    const result = extract(`class C {\n  public static implicit operator int(C c) => Helper(c);\n  static int Helper(C c) => 0;\n}\n`);
    const op = byName(result, 'operator int')[0]!;
    expect(op.kind).toBe('method');
    expect(resolvedTo(result, 'operator int', 'Helper')).toBe(true);
  });

  it('extracts a destructor as finalize and owns its body', () => {
    const result = extract(`class C {\n  ~C() { Cleanup(); }\n  void Cleanup() {}\n}\n`);
    expect(byName(result, 'finalize')[0]!.kind).toBe('method');
    expect(resolvedTo(result, 'finalize', 'Cleanup')).toBe(true);
  });

  it('a fully-qualified generic extension receiver keys on the base type name', () => {
    const result = extract(`static class X {\n  public static int B(this System.Collections.Generic.List<int> ls) => 0;\n}\n`);
    expect(byName(result, 'B')[0]!.fqn).toBe('src/test.cs:List.B');
  });
});

describe('csharp extractor — review-round fixes', () => {
  it('a bare call inside an extension method binds to the container, not the receiver type', () => {
    const result = extract(`static class X {\n  public static int A(this int[] xs) => Count();\n  static int Count() => 0;\n}\n`);
    expect(resolvedTo(result, 'A', 'Count')).toBe(true);
  });

  it('a type nested in an interface is exported (interface-default public)', () => {
    const result = extract(`interface I {\n  class Nested { public void M() {} }\n}\n`);
    expect(byName(result, 'Nested')[0]!.exported).toBe(true);
    expect(byName(result, 'M')[0]!.exported).toBe(true);
  });

  it('arity-distinct same-name partials do not merge (no cross-type edge)', () => {
    const result = extract(`partial class Foo { void S(){ R(); } }\npartial class Foo<T> { void R(){} }\n`);
    // Foo and Foo<T> are distinct types → ambiguous → S does not resolve to R.
    expect(resolvedTo(result, 'S', 'R')).toBe(false);
  });

  it('field signatures exclude the initializer but still own its calls', () => {
    const result = extract(`class C {\n  public int Z = Compute();\n  int Compute() => 0;\n}\n`);
    expect(byName(result, 'Z')[0]!.signature).toBe('public int Z');
    expect(resolvedTo(result, 'Z', 'Compute')).toBe(true);
  });

  it('a generic-type using alias binds the base name', () => {
    const result = extract(`using F = N.C<int>;\nclass X {}\n`);
    expect(result.imports[0]!.importedNames[0]!.name).toBe('C');
    expect(result.imports[0]!.importedNames[0]!.alias).toBe('F');
  });

  it('an unqualified generic using alias is not dropped', () => {
    const result = extract(`using F = List<int>;\nclass X {}\n`);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.importedNames[0]!.name).toBe('List');
    expect(result.imports[0]!.importedNames[0]!.alias).toBe('F');
  });

  it('same-name partials in DIFFERENT namespaces do not merge (no cross-type edge)', () => {
    // N1.Foo and N2.Foo are distinct types sharing the simple name `Foo`; the
    // partial-merge carve-out must NOT merge them (a wrong cross-namespace edge).
    const result = extract(
      `namespace N1 { partial class Foo { void S() { R(); } } }\n` +
        `namespace N2 { partial class Foo { void R() {} } }\n`,
    );
    expect(resolvedTo(result, 'S', 'R')).toBe(false);
  });

  it('same-name partials in the SAME namespace still merge', () => {
    const result = extract(
      `namespace N { partial class Foo { void S() { R(); } }\n  partial class Foo { void R() {} } }\n`,
    );
    expect(resolvedTo(result, 'S', 'R')).toBe(true);
  });
});

describe('csharp extractor — partial classes', () => {
  it('same-file partials merge for resolution and keep distinct ids', () => {
    const result = extract(
      `partial class S {\n  void Start() { Run(); }\n}\npartial class S {\n  void Run() {}\n}\n`,
    );
    const decls = byName(result, 'S');
    expect(decls).toHaveLength(2);
    expect(decls[0]!.id).not.toBe(decls[1]!.id);
    expect(resolvedTo(result, 'Start', 'Run')).toBe(true);
  });

  it('genuinely ambiguous same-name non-partial types stay unresolved', () => {
    const result = extract(
      `class S {\n  void A() { Helper(); }\n  void Helper() {}\n}\nclass S {\n  void Helper() {}\n}\n`,
    );
    expect(resolvedTo(result, 'A', 'Helper')).toBe(false);
  });
});

describe('csharp extractor — extension methods', () => {
  it('an extension method keys on the receiver type (methods-apart)', () => {
    const result = extract(`public static class Ext {\n  public static int Twice(this int n) => n * 2;\n}\n`);
    const sym = byName(result, 'Twice')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.cs:int.Twice');
    expect(sym.exported).toBe(true);
  });
});

describe('csharp extractor — docs', () => {
  it('extracts a /// XML doc summary, stripping the tag', () => {
    const result = extract(`/// <summary>A widget.</summary>\npublic class Widget { }\n`);
    expect(byName(result, 'Widget')[0]!.doc).toBe('A widget.');
  });

  it('walks a multi-line /// block to the first content line', () => {
    const result = extract(`/// <summary>\n/// First sentence.\n/// </summary>\npublic class W { }\n`);
    expect(byName(result, 'W')[0]!.doc).toBe('First sentence.');
  });

  it('plain // comments are not docs', () => {
    const result = extract(`// not a doc\npublic class W { }\n`);
    expect(byName(result, 'W')[0]!.doc).toBeNull();
  });

  it('a trailing comment on the previous line is not doc', () => {
    const result = extract(`public class A { } /// trailing\npublic class B { }\n`);
    expect(byName(result, 'B')[0]!.doc).toBeNull();
  });
});

describe('csharp extractor — imports', () => {
  it('a plain using is a namespace import', () => {
    const result = extract(`using System.Collections.Generic;\nclass C {}\n`);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.sourceModule).toBe('System.Collections.Generic');
    expect(result.imports[0]!.importedNames[0]!.name).toBe('*');
  });

  it('using static is a namespace import', () => {
    const result = extract(`using static System.Math;\nclass C {}\n`);
    expect(result.imports[0]!.sourceModule).toBe('System.Math');
  });

  it('a using alias binds the last segment', () => {
    const result = extract(`using Json = Newtonsoft.Json.JsonConvert;\nclass C {}\n`);
    expect(result.imports[0]!.importedNames[0]!.name).toBe('JsonConvert');
    expect(result.imports[0]!.importedNames[0]!.alias).toBe('Json');
  });

  it('a global using is recorded', () => {
    const result = extract(`global using System.Linq;\nclass C {}\n`);
    expect(result.imports[0]!.sourceModule).toBe('System.Linq');
  });
});

describe('csharp extractor — robustness', () => {
  it('returns arrays for an empty file', () => {
    const result = extract(`\n`);
    expect(result.symbols).toEqual([]);
    expect(result.references).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it('top-level statements (Program.cs) yield no symbols', () => {
    const result = extract(`System.Console.WriteLine("hi");\nint Compute() => 42;\n`);
    expect(result.symbols).toHaveLength(0);
  });
});
