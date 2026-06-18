import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { RECEIVER_OPAQUE } from '../../../src/types.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'java', path = 'src/Test.java') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

describe('java extractor — classes and visibility', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a public class with kind/fqn/signature/exported', () => {
    const result = extract('public class Widget {\n}\n');
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('Widget');
    expect(sym.kind).toBe('class');
    expect(sym.fqn).toBe('src/Test.java:Widget');
    expect(sym.exported).toBe(true);
    expect(sym.signature).toBe('public class Widget');
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(2);
    expect(sym.file).toBe('src/Test.java');
    expect(sym.language).toBe('java');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
  });

  it('marks a package-private class as not exported', () => {
    const sym = extract('class Widget { }').symbols[0]!;
    expect(sym.exported).toBe(false);
    expect(sym.signature).toBe('class Widget');
  });

  it('extracts two top-level classes in one file', () => {
    const result = extract('public class A { }\nclass B { }');
    expect(result.symbols.map((s) => s.name)).toEqual(['A', 'B']);
    expect(result.symbols[0]!.exported).toBe(true);
    expect(result.symbols[1]!.exported).toBe(false);
  });

  it('keeps extends/implements/type parameters in the class signature', () => {
    const sym = extract('public class Box<T> extends Base implements Runnable { }').symbols[0]!;
    expect(sym.signature).toBe('public class Box<T> extends Base implements Runnable');
  });

  it('gates member exported on own visibility: public/protected yes, package-private/private no', () => {
    const src = [
      'public class Base {',
      '  public void pub() { }',
      '  protected void hook() { }',
      '  void pkg() { }',
      '  private void priv() { }',
      '}',
    ].join('\n');
    const result = extract(src);
    const by = (n: string) => result.symbols.find((s) => s.name === n)!;
    expect(by('pub').exported).toBe(true);
    expect(by('hook').exported).toBe(true);
    expect(by('pkg').exported).toBe(false);
    expect(by('priv').exported).toBe(false);
  });

  it('public members of a package-private class are not exported', () => {
    const src = 'class Hidden {\n  public void visible() { }\n}';
    const result = extract(src);
    expect(result.symbols.find((s) => s.name === 'visible')!.exported).toBe(false);
  });
});

describe('java extractor — methods, constructors, fields', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts methods with full signatures including throws', () => {
    const src = [
      'public class Files {',
      '  public String read(String path) throws Exception { return path; }',
      '}',
    ].join('\n');
    const method = extract(src).symbols.find((s) => s.name === 'read')!;
    expect(method.kind).toBe('method');
    expect(method.fqn).toBe('src/Test.java:Files.read');
    expect(method.signature).toBe('public String read(String path) throws Exception');
  });

  it('extracts a constructor as method named `constructor`', () => {
    const src = [
      'public class Widget {',
      '  public Widget(String name) { }',
      '}',
    ].join('\n');
    const ctor = extract(src).symbols.find((s) => s.kind === 'method')!;
    expect(ctor.name).toBe('constructor');
    expect(ctor.fqn).toBe('src/Test.java:Widget.constructor');
    expect(ctor.signature).toBe('public Widget(String name)');
  });

  it('extracts an abstract (bodiless) method without the trailing semicolon', () => {
    const src = 'public abstract class Task {\n  public abstract void run();\n}';
    const run = extract(src).symbols.find((s) => s.name === 'run')!;
    expect(run.kind).toBe('method');
    expect(run.signature).toBe('public abstract void run()');
  });

  it('keeps type parameters of generic methods in the signature', () => {
    const src = 'public class Util {\n  public static <T> T id(T t) { return t; }\n}';
    const id = extract(src).symbols.find((s) => s.name === 'id')!;
    expect(id.signature).toBe('public static <T> T id(T t)');
  });

  it('extracts one variable symbol per declarator in a multi-declarator field', () => {
    const src = 'public class Pair {\n  private int a = 1, b;\n}';
    const result = extract(src);
    const fields = result.symbols.filter((s) => s.kind === 'variable');
    expect(fields.map((s) => s.name)).toEqual(['a', 'b']);
    expect(fields[0]!.fqn).toBe('src/Test.java:Pair.a');
    expect(fields[0]!.signature).toBe('private int a = 1, b');
    expect(fields[0]!.id).not.toBe(fields[1]!.id);
  });

  it('gives overloads distinct ids via distinct signatures', () => {
    const src = [
      'public class Calc {',
      '  public int add(int a) { return a; }',
      '  public int add(int a, int b) { return a + b; }',
      '}',
    ].join('\n');
    const adds = extract(src).symbols.filter((s) => s.name === 'add');
    expect(adds).toHaveLength(2);
    expect(adds[0]!.fqn).toBe(adds[1]!.fqn);
    expect(adds[0]!.id).not.toBe(adds[1]!.id);
  });

  it('truncates signatures at 120 chars', () => {
    const params = Array.from({ length: 20 }, (_, i) => `String veryLongParameterName${i}`).join(', ');
    const src = `public class Big {\n  public void huge(${params}) { }\n}`;
    const huge = extract(src).symbols.find((s) => s.name === 'huge')!;
    expect(huge.signature).toHaveLength(120);
  });

  it('keeps distinct ids for overloads that differ only past the display cap', () => {
    // JG1 regression: the id hashes the FULL signature, so overloads whose
    // visible 120-char signatures are identical must still get distinct ids
    // (under the old capped hash, rxjava's 10 `just` overloads got 5 ids,
    // merging their reference graphs).
    const longParams = Array.from({ length: 6 }, (_, i) => `String extremelyLongParameterName${i}`).join(', ');
    const src = [
      'public class Api {',
      `  public void send(${longParams}, int a) { }`,
      `  public void send(${longParams}, String b) { }`,
      '}',
    ].join('\n');
    const sends = extract(src).symbols.filter((s) => s.name === 'send');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.signature).toHaveLength(120);
    expect(sends[0]!.signature).toBe(sends[1]!.signature);
    expect(sends[0]!.id).not.toBe(sends[1]!.id);
  });
});

describe('java extractor — annotations', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('excludes annotations from the signature but includes them in the line range', () => {
    const src = [
      'public class Ann {',
      '  @Override',
      '  @Deprecated',
      '  public String toString() { return ""; }',
      '}',
    ].join('\n');
    const m = extract(src).symbols.find((s) => s.name === 'toString')!;
    expect(m.signature).toBe('public String toString()');
    expect(m.startLine).toBe(2);
    expect(m.endLine).toBe(4);
  });

  it('handles all-annotation modifiers (no keyword)', () => {
    const src = 'public class Ann {\n  @Override\n  void f() { }\n}';
    const f = extract(src).symbols.find((s) => s.name === 'f')!;
    expect(f.signature).toBe('void f()');
  });

  it('keeps overload ids distinct under a shared over-120-char annotation', () => {
    const longAnno = `@RequestMapping(value = "/an/extremely/long/url/path/segment/${'x'.repeat(80)}")`;
    const src = [
      'public class Web {',
      `  ${longAnno}`,
      '  public void handler(int a) { }',
      `  ${longAnno}`,
      '  public void handler(int a, int b) { }',
      '}',
    ].join('\n');
    const handlers = extract(src).symbols.filter((s) => s.name === 'handler');
    expect(handlers).toHaveLength(2);
    expect(handlers[0]!.signature).toBe('public void handler(int a)');
    expect(handlers[0]!.id).not.toBe(handlers[1]!.id);
  });
});

describe('java extractor — interfaces, enums, records, annotation types', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts interface members as implicitly public', () => {
    const src = [
      'public interface Shape {',
      '  double EPS = 0.001;',
      '  double area();',
      '  default String label() { return name(); }',
      '  static Shape unit() { return null; }',
      '  String name();',
      '}',
    ].join('\n');
    const result = extract(src);
    const iface = result.symbols.find((s) => s.name === 'Shape')!;
    expect(iface.kind).toBe('interface');
    expect(iface.exported).toBe(true);

    const eps = result.symbols.find((s) => s.name === 'EPS')!;
    expect(eps.kind).toBe('variable');
    expect(eps.fqn).toBe('src/Test.java:Shape.EPS');
    expect(eps.exported).toBe(true);

    const area = result.symbols.find((s) => s.name === 'area')!;
    expect(area.kind).toBe('method');
    expect(area.exported).toBe(true);
    expect(area.signature).toBe('double area()');

    const label = result.symbols.find((s) => s.name === 'label')!;
    expect(label.signature).toBe('default String label()');

    // Implicit-this resolution works inside default methods too.
    const nameRef = result.references.find((r) => r.targetName === 'name')!;
    expect(nameRef.targetId).toBe(result.symbols.find((s) => s.name === 'name')!.id);
    expect(nameRef.sourceId).toBe(label.id);
  });

  it('members of a package-private interface are not exported', () => {
    const src = 'interface Hidden {\n  void x();\n}';
    expect(extract(src).symbols.find((s) => s.name === 'x')!.exported).toBe(false);
  });

  it('explicitly private interface methods (Java 9+) are not exported', () => {
    const src = [
      'public interface Helper {',
      '  default int total() { return base(); }',
      '  private int base() { return 1; }',
      '}',
    ].join('\n');
    const result = extract(src);
    expect(result.symbols.find((s) => s.name === 'base')!.exported).toBe(false);
    expect(result.symbols.find((s) => s.name === 'total')!.exported).toBe(true);
    // Private interface methods still resolve as implicit-this callees.
    const ref = result.references.find((r) => r.targetName === 'base')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'base')!.id);
  });

  it('extracts enum body members but never enum constants', () => {
    const src = [
      'public enum Color {',
      '  RED(lookup(1)), GREEN(2);',
      '  private final int code;',
      '  Color(int code) { this.code = code; }',
      '  public int code() { return code; }',
      '  private static int lookup(int i) { return i; }',
      '}',
    ].join('\n');
    const result = extract(src);
    const names = result.symbols.map((s) => s.name);
    expect(names).not.toContain('RED');
    expect(names).not.toContain('GREEN');

    const en = result.symbols.find((s) => s.name === 'Color' && s.kind === 'enum')!;
    expect(en.signature).toBe('public enum Color');
    expect(result.symbols.find((s) => s.fqn === 'src/Test.java:Color.constructor')).toBeDefined();
    expect(result.symbols.find((s) => s.fqn === 'src/Test.java:Color.code' && s.kind === 'method')).toBeDefined();

    // Constant-argument calls attribute to the enum symbol and resolve
    // against the enum's own methods.
    const lookupRef = result.references.find((r) => r.targetName === 'lookup')!;
    expect(lookupRef.sourceId).toBe(en.id);
    expect(lookupRef.targetId).toBe(result.symbols.find((s) => s.name === 'lookup')!.id);
  });

  it('skips methods inside enum constant bodies', () => {
    const src = [
      'public enum Op {',
      '  PLUS { public int apply(int a) { return helper(a); } };',
      '  static int helper(int a) { return a; }',
      '}',
    ].join('\n');
    const result = extract(src);
    expect(result.symbols.map((s) => s.name)).toEqual(['Op', 'helper']);
    // Constant-body internals are pruned like anonymous classes.
    expect(result.references.find((r) => r.targetName === 'helper')).toBeUndefined();
  });

  it('extracts records as class kind with components in the signature', () => {
    const src = [
      'public record Point(int x, int y) {',
      '  public Point { }',
      '  public static Point origin() { return new Point(0, 0); }',
      '}',
    ].join('\n');
    const result = extract(src);
    const rec = result.symbols.find((s) => s.name === 'Point' && s.kind === 'class')!;
    expect(rec.signature).toBe('public record Point(int x, int y)');

    const compact = result.symbols.find((s) => s.name === 'constructor')!;
    expect(compact.fqn).toBe('src/Test.java:Point.constructor');

    const origin = result.symbols.find((s) => s.name === 'origin')!;
    expect(origin.kind).toBe('method');

    // `new Point(0, 0)` binds to the record's class symbol.
    const newRef = result.references.find((r) => r.targetName === 'Point')!;
    expect(newRef.targetId).toBe(rec.id);
    expect(newRef.sourceId).toBe(origin.id);
  });

  it('extracts @interface as declaration-only interface kind', () => {
    const src = 'public @interface Marker {\n  String value() default "";\n}';
    const result = extract(src);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.kind).toBe('interface');
    expect(result.symbols[0]!.name).toBe('Marker');
  });
});

describe('java extractor — nested, local, and anonymous types', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('recurses into nested types with simple-name FQNs and member resolution', () => {
    const src = [
      'public class Outer {',
      '  private static class Inner {',
      '    void run() { help(); }',
      '    void help() { }',
      '  }',
      '  public static class Builder {',
      '    public Outer build() { return new Outer(); }',
      '  }',
      '}',
    ].join('\n');
    const result = extract(src);

    const inner = result.symbols.find((s) => s.name === 'Inner')!;
    expect(inner.fqn).toBe('src/Test.java:Inner');
    expect(inner.exported).toBe(false); // private static

    const builder = result.symbols.find((s) => s.name === 'Builder')!;
    expect(builder.exported).toBe(true);

    const run = result.symbols.find((s) => s.name === 'run')!;
    expect(run.fqn).toBe('src/Test.java:Inner.run');

    // Implicit-this inside the nested class resolves against the nested
    // class's own methods.
    const helpRef = result.references.find((r) => r.targetName === 'help')!;
    expect(helpRef.targetId).toBe(result.symbols.find((s) => s.name === 'help')!.id);
    expect(helpRef.sourceId).toBe(run.id);

    // `new Outer()` from the nested Builder binds to the outer class.
    const newOuter = result.references.find((r) => r.targetName === 'Outer')!;
    expect(newOuter.targetId).toBe(result.symbols.find((s) => s.name === 'Outer')!.id);
  });

  it('keeps distinct ids for same-named nested types under different outers', () => {
    const src = [
      'class A { static class Helper { } }',
      'class B { static class Helper { } }',
    ].join('\n');
    const helpers = extract(src).symbols.filter((s) => s.name === 'Helper');
    expect(helpers).toHaveLength(2);
    expect(helpers[0]!.fqn).toBe(helpers[1]!.fqn);
    expect(helpers[0]!.id).not.toBe(helpers[1]!.id);
  });

  it('never extracts local classes or anonymous class internals', () => {
    const src = [
      'public class Host {',
      '  public void work() {',
      '    class Local { void l() { } }',
      '    Runnable r = new Runnable() { public void run() { hidden(); } };',
      '  }',
      '  private void hidden() { }',
      '}',
    ].join('\n');
    const result = extract(src);
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['Host', 'hidden', 'work']);
    // Calls inside anonymous-class methods are pruned from every walk.
    expect(result.references.find((r) => r.targetName === 'hidden')).toBeUndefined();
    // The anonymous construction itself still emits a constructor ref.
    const newRunnable = result.references.find((r) => r.targetName === 'Runnable')!;
    expect(newRunnable.sourceId).toBe(result.symbols.find((s) => s.name === 'work')!.id);
  });
});

describe('java extractor — docs', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts the first non-empty Javadoc line', () => {
    const src = '/**\n * Greets users politely.\n * @since 1.0\n */\npublic class Greeter { }';
    expect(extract(src).symbols[0]!.doc).toBe('Greets users politely.');
  });

  it('finds Javadoc across annotations', () => {
    const src = '/** Marked for removal. */\n@Deprecated\npublic class Old { }';
    expect(extract(src).symbols[0]!.doc).toBe('Marked for removal.');
  });

  it('accepts line comments as docs on members', () => {
    const src = 'public class C {\n  // counts retries\n  private int retries;\n}';
    expect(extract(src).symbols.find((s) => s.name === 'retries')!.doc).toBe('counts retries');
  });

  it('accepts plain block comments', () => {
    const src = '/* plain block */\nclass C { }';
    expect(extract(src).symbols[0]!.doc).toBe('plain block');
  });

  it('returns null doc when no preceding comment', () => {
    expect(extract('public class C { }').symbols[0]!.doc).toBeNull();
  });

  it('does not treat a trailing comment on the previous member as doc', () => {
    const src = [
      'public class C {',
      '  int a = 1; // about a',
      '  void next() { }',
      '}',
    ].join('\n');
    expect(extract(src).symbols.find((s) => s.name === 'next')!.doc).toBeNull();
  });
});

describe('java extractor — references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('resolves implicit-this bare calls to same-class methods without a receiver key', () => {
    const src = [
      'public class Greeter {',
      '  public String greet(String name) { return format(name); }',
      '  private String format(String name) { return name; }',
      '}',
    ].join('\n');
    const result = extract(src);
    const ref = result.references.find((r) => r.targetName === 'format')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'format')!.id);
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'greet')!.id);
    expect('receiver' in ref).toBe(false);
    expect('selfReceiver' in ref).toBe(false);
    expect(ref.line).toBe(2);
  });

  it('leaves bare calls to unknown names unresolved', () => {
    const src = 'public class C {\n  void go() { mystery(); }\n}';
    const ref = extract(src).references.find((r) => r.targetName === 'mystery')!;
    expect(ref.targetId).toBeNull();
  });

  it('never binds bare calls to same-name fields or classes', () => {
    // Fields and classes are not bare-callable in Java: `log()` here is an
    // inherited/unknown method, NOT the field `log`; and a bare call can
    // never name a class.
    const src = [
      'public class Service {',
      '  private Object log;',
      '  void run() { log("hi"); Service(); }',
      '}',
    ].join('\n');
    const result = extract(src);
    const logRef = result.references.find((r) => r.targetName === 'log')!;
    expect(logRef.targetId).toBeNull();
    const clsRef = result.references.find((r) => r.targetName === 'Service')!;
    expect(clsRef.targetId).toBeNull();
  });

  it('binds new X() to the class even when a same-name field exists', () => {
    const src = [
      'class A {',
      '  static Object Widget = null;',
      '  Object make() { return new Widget(); }',
      '}',
      'class Widget { }',
    ].join('\n');
    const result = extract(src);
    const cls = result.symbols.find((s) => s.kind === 'class' && s.name === 'Widget')!;
    const ref = result.references.find((r) => r.targetName === 'Widget')!;
    expect(ref.targetId).toBe(cls.id);
  });

  it('resolves anonymous interface implementations to the interface symbol', () => {
    const src = [
      'public class App {',
      '  Runnable make() { return new Job() { public void run() { } }; }',
      '}',
      'interface Job extends Runnable { }',
    ].join('\n');
    const result = extract(src);
    const iface = result.symbols.find((s) => s.kind === 'interface')!;
    const ref = result.references.find((r) => r.targetName === 'Job')!;
    expect(ref.targetId).toBe(iface.id);
  });

  it('refuses to resolve through same-file ambiguous nested type names', () => {
    // Two nested `H` classes share the simple-name FQN; binding first-wins
    // would produce confidently wrong edges, so calls stay unresolved.
    const src = [
      'class A { static class H { void x() { y(); } void y() { } } }',
      'class B { static class H { void go() { new H(); } } }',
    ].join('\n');
    const result = extract(src);
    const yRef = result.references.find((r) => r.targetName === 'y')!;
    expect(yRef.targetId).toBeNull();
    const newH = result.references.find((r) => r.targetName === 'H')!;
    expect(newH.targetId).toBeNull();
  });

  it('resolves this.x() with receiver and selfReceiver', () => {
    const src = [
      'public class Greeter {',
      '  public String greet() { return this.format(); }',
      '  private String format() { return ""; }',
      '}',
    ].join('\n');
    const result = extract(src);
    const ref = result.references.find((r) => r.targetName === 'format')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'format')!.id);
    expect(ref.receiver).toBe('this');
    expect(ref.selfReceiver).toBe(true);
  });

  it('resolves same-file static calls through the class-name receiver', () => {
    const src = [
      'public class Service {',
      '  public static Service create() { return new Service(); }',
      '}',
      'class App {',
      '  void run() { Service s = Service.create(); }',
      '}',
    ].join('\n');
    const result = extract(src);
    const ref = result.references.find((r) => r.targetName === 'create')!;
    expect(ref.receiver).toBe('Service');
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'create')!.id);

    const newRef = result.references.find((r) => r.targetName === 'Service')!;
    expect(newRef.targetId).toBe(result.symbols.find((s) => s.kind === 'class' && s.name === 'Service')!.id);
  });

  it('stores unknown-receiver member calls unresolved with the receiver token', () => {
    const src = 'public class C {\n  void go(Runnable helper) { helper.run(); }\n}';
    const ref = extract(src).references.find((r) => r.targetName === 'run')!;
    expect(ref.receiver).toBe('helper');
    expect(ref.targetId).toBeNull();
  });

  it('unwraps generic constructor calls to a bare unresolved ref', () => {
    const src = 'public class C {\n  Object o = new java.util.ArrayList<String>();\n}';
    // Fully-qualified generic: the inner type is a scoped_type_identifier
    // nested deeper than one level — skipped. Use a plain generic instead.
    const src2 = 'public class C {\n  Object o = new ArrayList<String>();\n}';
    const ref = extract(src2).references.find((r) => r.targetName === 'ArrayList')!;
    expect(ref.targetId).toBeNull();
    expect('receiver' in ref).toBe(false);
    expect(extract(src).references).toHaveLength(0);
  });

  it('emits single-level scoped constructor calls as member refs', () => {
    const src = 'public class C {\n  Object o = new pkg.Thing();\n}';
    const ref = extract(src).references.find((r) => r.targetName === 'Thing')!;
    expect(ref.receiver).toBe('pkg');
    expect(ref.targetId).toBeNull();
  });

  it('captures chained calls opaquely; still drops super/method-ref/stdlib shapes', () => {
    const src = [
      'public class C extends Base {',
      '  C() { this(1); }',
      '  C(int x) { super.tearDown(); }',
      '  void go() {',
      '    a.b.deep();',
      '    maker().chain();',
      '    System.out.println("x");',
      '    Runnable r = C::helper;',
      '  }',
      '  static C maker() { return null; }',
      '  static void helper() { }',
      '}',
    ].join('\n');
    const result = extract(src);
    const targets = result.references.map((r) => r.targetName);
    // Chained calls are now CAPTURED under an opaque receiver (findable by name,
    // never resolved) — the recall win.
    const deep = result.references.find((r) => r.targetName === 'deep')!;
    expect(deep.receiver).toBe(RECEIVER_OPAQUE);
    expect(deep.targetId).toBeNull();
    const chain = result.references.find((r) => r.targetName === 'chain')!;
    expect(chain.receiver).toBe(RECEIVER_OPAQUE);
    expect(chain.targetId).toBeNull();
    // Still dropped: super.tearDown() (parent-class), C::helper (method ref),
    // and System.out.println() (`println` ∈ JAVA_IGNORED_MEMBER_CALLEES).
    expect(targets).not.toContain('tearDown');
    expect(targets).not.toContain('println');
    expect(targets).not.toContain('helper');
    // The inner call of `maker().chain()` still emits and resolves.
    const makerRef = result.references.find((r) => r.targetName === 'maker')!;
    expect(makerRef.targetId).toBe(result.symbols.find((s) => s.name === 'maker')!.id);
  });

  it('suppresses unresolved chained calls to common stdlib/stream names', () => {
    const src = [
      'public class C {',
      '  void go(java.util.List<String> xs) {',
      '    xs.stream().filter(x -> true).collect(null);',
      '  }',
      '}',
    ].join('\n');
    const result = extract(src);
    const targets = result.references.map((r) => r.targetName);
    // stream/filter/collect ∈ JAVA_IGNORED_MEMBER_CALLEES and all unresolved.
    expect(targets).not.toContain('stream');
    expect(targets).not.toContain('filter');
    expect(targets).not.toContain('collect');
  });

  it('unwraps cast ((T)a).m(), parenthesized (a).m(), and comment-in-paren receivers', () => {
    const src = [
      'class C {',
      '  void z(Object a) {',
      '    ((T) a).foo();',
      '    (a).bar();',
      '    ( /*c*/ a).baz();',
      '  }',
      '}',
    ].join('\n');
    const result = extract(src);
    const byName = new Map(result.references.map((r) => [r.targetName, r]));
    // ((T)a) (parenthesized cast_expression, value field = `a`) and (a) unwrap to
    // the single-identifier receiver `a` — Java's cast is its force-unwrap analog.
    expect(byName.get('foo')!.receiver).toBe('a');
    expect(byName.get('bar')!.receiver).toBe('a');
    // A leading comment inside the parens is skipped via isComment (the grammar
    // names it `block_comment`, not `comment`) — receiver still unwraps to `a`.
    expect(byName.get('baz')!.receiver).toBe('a');
  });

  it('attributes lambda-body calls to the enclosing method', () => {
    const src = [
      'public class Streams {',
      '  public void each(java.util.List<String> xs) { xs.forEach(x -> handle(x)); }',
      '  private void handle(String x) { }',
      '}',
    ].join('\n');
    const result = extract(src);
    const ref = result.references.find((r) => r.targetName === 'handle')!;
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'each')!.id);
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'handle')!.id);
  });

  it('attributes field-initializer and static-initializer calls to the type symbol', () => {
    const src = [
      'public class Init {',
      '  private int value = compute();',
      '  static { setup(); }',
      '  private int compute() { return 1; }',
      '  private static void setup() { }',
      '}',
    ].join('\n');
    const result = extract(src);
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    const computeRef = result.references.find((r) => r.targetName === 'compute')!;
    expect(computeRef.sourceId).toBe(cls.id);
    expect(computeRef.targetId).toBe(result.symbols.find((s) => s.name === 'compute')!.id);
    const setupRef = result.references.find((r) => r.targetName === 'setup')!;
    expect(setupRef.sourceId).toBe(cls.id);
    expect(setupRef.targetId).toBe(result.symbols.find((s) => s.name === 'setup')!.id);
  });

  it('attributes constructor-body calls to the constructor symbol', () => {
    const src = [
      'public class Widget {',
      '  public Widget(String name) { init(name); }',
      '  private void init(String n) { }',
      '}',
    ].join('\n');
    const result = extract(src);
    const ctor = result.symbols.find((s) => s.name === 'constructor')!;
    const ref = result.references.find((r) => r.targetName === 'init')!;
    expect(ref.sourceId).toBe(ctor.id);
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'init')!.id);
  });
});

describe('java extractor — imports', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts simple, wildcard, static, and static-wildcard imports', () => {
    const src = [
      'import java.util.List;',
      'import java.util.*;',
      'import static org.junit.Assert.assertEquals;',
      'import static java.util.Collections.*;',
      '',
      'public class C { }',
    ].join('\n');
    const { imports } = extract(src);
    expect(imports).toHaveLength(4);

    expect(imports[0]).toEqual({
      file: 'src/Test.java',
      sourceModule: 'java.util',
      importedNames: [{ name: 'List' }],
      line: 1,
    });
    expect(imports[1]!.sourceModule).toBe('java.util');
    expect(imports[1]!.importedNames).toEqual([{ name: '*' }]);
    expect(imports[2]!.sourceModule).toBe('org.junit.Assert');
    expect(imports[2]!.importedNames).toEqual([{ name: 'assertEquals' }]);
    expect(imports[3]!.sourceModule).toBe('java.util.Collections');
    expect(imports[3]!.importedNames).toEqual([{ name: '*' }]);
    expect(imports[3]!.line).toBe(4);
  });
});

describe('java extractor — error tolerance', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('does not throw and keeps declarations preceding a syntax error', () => {
    const src = [
      'public class Bad {',
      '  public void good() { }',
      '  void broken( {',
      '}',
    ].join('\n');
    const result = extract(src);
    expect(result.symbols.find((s) => s.name === 'good')).toBeDefined();
    // Declarations AFTER the error may be swallowed by the ERROR node —
    // only preceding siblings are guaranteed (empirical grammar behavior).
  });
});
