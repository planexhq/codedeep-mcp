import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { classNameFromFqn } from '../../../src/types.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'swift', path = 'src/test.swift') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

const byName = (result: ReturnType<typeof extract>, name: string) =>
  result.symbols.filter((s) => s.name === name);

beforeAll(async () => {
  await initParser();
});

describe('swift extractor — functions and exportedness', () => {
  it('extracts a func with kind/fqn/signature/exported/lines', () => {
    const result = extract(`func greet(name: String) -> String {\n    return name\n}\n`);
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('greet');
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.swift:greet');
    expect(sym.signature).toBe('func greet(name: String) -> String');
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(3);
    expect(sym.language).toBe('swift');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
    // internal (no modifier) counts as exported.
    expect(sym.exported).toBe(true);
  });

  it('public/open/internal export; private/fileprivate do not', () => {
    const result = extract(
      `public func a() {}\nopen func b() {}\ninternal func c() {}\nfileprivate func d() {}\nprivate func e() {}\n`,
    );
    expect(result.symbols.map((s) => s.exported)).toEqual([true, true, true, false, false]);
  });

  it('async/throws stay in the signature', () => {
    const sym = extract(`public func fetch() async throws -> Int {\n    return 0\n}\n`).symbols[0]!;
    expect(sym.signature).toBe('public func fetch() async throws -> Int');
  });

  it('an operator func names to the operator token', () => {
    const sym = extract(`func + (l: Int, r: Int) -> Int {\n    return l\n}\n`).symbols[0]!;
    expect(sym.name).toBe('+');
    expect(sym.kind).toBe('function');
  });

  it('caps the displayed signature at 120 chars', () => {
    const params = Array.from({ length: 40 }, (_, i) => `a${i}: Int`).join(', ');
    const sym = extract(`func wide(${params}) {}\n`).symbols[0]!;
    expect(sym.signature.length).toBe(120);
  });
});

describe('swift extractor — types', () => {
  it('class/struct/actor → class kind', () => {
    const result = extract(`public class C {}\nstruct P {}\nactor A {}\n`);
    expect(byName(result, 'C')[0]!.kind).toBe('class');
    expect(byName(result, 'P')[0]!.kind).toBe('class');
    expect(byName(result, 'A')[0]!.kind).toBe('class');
    expect(byName(result, 'C')[0]!.signature).toBe('public class C');
  });

  it('struct fields → variable members with container-gated export', () => {
    const result = extract(`public struct P {\n    public var x: Int\n    private var y: Int\n}\n`);
    const x = byName(result, 'x')[0]!;
    expect(x.kind).toBe('variable');
    expect(x.fqn).toBe('src/test.swift:P.x');
    expect(x.exported).toBe(true);
    expect(byName(result, 'y')[0]!.exported).toBe(false);
  });

  it('enum → enum kind; cases are NOT extracted', () => {
    const result = extract(`enum E {\n    case round\n    case pointy(Int)\n    func f() {}\n}\n`);
    expect(byName(result, 'E')[0]!.kind).toBe('enum');
    expect(byName(result, 'round')).toHaveLength(0);
    expect(byName(result, 'pointy')).toHaveLength(0);
    expect(byName(result, 'f')[0]!.kind).toBe('method');
  });

  it('protocol → interface with declaration-only members', () => {
    const result = extract(`public protocol Pr {\n    func m()\n    var v: Int { get }\n}\n`);
    expect(byName(result, 'Pr')[0]!.kind).toBe('interface');
    const m = byName(result, 'm')[0]!;
    expect(m.kind).toBe('method');
    expect(m.fqn).toBe('src/test.swift:Pr.m');
    const v = byName(result, 'v')[0]!;
    expect(v.kind).toBe('variable');
    expect(v.fqn).toBe('src/test.swift:Pr.v');
  });

  it('typealias → type kind', () => {
    const sym = extract(`typealias Meters = Double\n`).symbols[0]!;
    expect(sym.name).toBe('Meters');
    expect(sym.kind).toBe('type');
  });

  it('nested types use simple-name FQNs with distinct ids', () => {
    const result = extract(`struct Outer {\n    struct Inner {\n        func f() {}\n    }\n}\n`);
    expect(byName(result, 'Outer')[0]!.fqn).toBe('src/test.swift:Outer');
    expect(byName(result, 'Inner')[0]!.fqn).toBe('src/test.swift:Inner');
    expect(byName(result, 'f')[0]!.fqn).toBe('src/test.swift:Inner.f');
    const ids = new Set(result.symbols.map((s) => s.id));
    expect(ids.size).toBe(result.symbols.length);
  });
});

describe('swift extractor — members', () => {
  it('init → method named "init"; deinit → "deinit"', () => {
    const result = extract(`class C {\n    init(x: Int) {}\n    deinit {}\n}\n`);
    const init = byName(result, 'init')[0]!;
    expect(init.kind).toBe('method');
    expect(init.fqn).toBe('src/test.swift:C.init');
    expect(byName(result, 'deinit')[0]!.fqn).toBe('src/test.swift:C.deinit');
  });

  it('subscript → method "subscript"; signature stops before the body', () => {
    const sym = extract(`struct S {\n    subscript(i: Int) -> Int { return i }\n}\n`).symbols.find(
      (s) => s.name === 'subscript',
    )!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.swift:S.subscript');
    expect(sym.signature).toBe('subscript(i: Int) -> Int');
  });

  it('computed property signature omits the accessor body', () => {
    const sym = extract(`class C {\n    var area: Int { return 0 }\n}\n`).symbols.find(
      (s) => s.name === 'area',
    )!;
    expect(sym.kind).toBe('variable');
    expect(sym.signature).toBe('var area: Int');
  });

  it('a multi-binding let yields one variable per name', () => {
    const result = extract(`let a = 1, b = 2\n`);
    expect(byName(result, 'a')).toHaveLength(1);
    expect(byName(result, 'b')).toHaveLength(1);
  });

  it('private(set) keeps the getter visible (exported)', () => {
    const sym = extract(`struct S {\n    public private(set) var v = 0\n}\n`).symbols.find(
      (s) => s.name === 'v',
    )!;
    expect(sym.exported).toBe(true);
  });
});

describe('swift extractor — extensions', () => {
  it('extension members key on the extended type; the extension is not a symbol', () => {
    const result = extract(`struct P {}\nextension P {\n    func m() {}\n}\n`);
    const m = byName(result, 'm')[0]!;
    expect(m.kind).toBe('method');
    expect(m.fqn).toBe('src/test.swift:P.m');
    // No symbol for the extension itself.
    expect(result.symbols.filter((s) => s.name === 'P' && s.kind === 'class')).toHaveLength(1);
  });

  it('public extension exports its members; private extension does not', () => {
    const pub = extract(`struct P {}\npublic extension P {\n    func m() {}\n}\n`);
    expect(byName(pub, 'm')[0]!.exported).toBe(true);
    const priv = extract(`struct P {}\nprivate extension P {\n    func n() {}\n}\n`);
    expect(byName(priv, 'n')[0]!.exported).toBe(false);
  });

  it('generic/scoped extension targets unwrap to the base type name', () => {
    expect(byName(extract(`extension Array<Int> {\n    func f() {}\n}\n`), 'f')[0]!.fqn).toBe(
      'src/test.swift:Array.f',
    );
    expect(byName(extract(`extension Swift.String {\n    func g() {}\n}\n`), 'g')[0]!.fqn).toBe(
      'src/test.swift:String.g',
    );
  });
});

describe('swift extractor — references', () => {
  const resolvedTo = (result: ReturnType<typeof extract>, sourceName: string, targetName: string) => {
    const src = byName(result, sourceName)[0]!;
    const tgt = byName(result, targetName)[0]!;
    return result.references.some(
      (r) => r.sourceId === src.id && r.targetId === tgt.id && r.targetName === targetName,
    );
  };

  it('resolves a bare function call', () => {
    const result = extract(`func a() { b() }\nfunc b() {}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves an implicit-self bare method call', () => {
    const result = extract(`class C {\n    func a() { b() }\n    func b() {}\n}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('resolves self.method() and records selfReceiver', () => {
    const result = extract(`class C {\n    func a() { self.b() }\n    func b() {}\n}\n`);
    const a = byName(result, 'a')[0]!;
    const b = byName(result, 'b')[0]!;
    const ref = result.references.find((r) => r.sourceId === a.id && r.targetName === 'b')!;
    expect(ref.targetId).toBe(b.id);
    expect(ref.receiver).toBe('self');
    expect(ref.selfReceiver).toBe(true);
  });

  it('resolves Self.staticMethod()', () => {
    const result = extract(
      `struct S {\n    static func make() {}\n    func u() { Self.make() }\n}\n`,
    );
    expect(resolvedTo(result, 'u', 'make')).toBe(true);
  });

  it('resolves construction Type(...) to the class', () => {
    const result = extract(`struct P {\n    let x: Int\n}\nfunc make() -> P { return P(x: 1) }\n`);
    const make = byName(result, 'make')[0]!;
    const p = byName(result, 'P').find((s) => s.kind === 'class')!;
    expect(result.references.some((r) => r.sourceId === make.id && r.targetId === p.id)).toBe(true);
  });

  it('attributes a computed-property body call to the property (recall-critical)', () => {
    const result = extract(
      `class C {\n    var s: Int { return compute() }\n    func compute() -> Int { return 0 }\n}\n`,
    );
    const s = byName(result, 's')[0]!;
    const compute = byName(result, 'compute')[0]!;
    expect(
      result.references.some((r) => r.sourceId === s.id && r.targetId === compute.id),
    ).toBe(true);
  });

  it('attributes a didSet observer body call to the property', () => {
    const result = extract(
      `class C {\n    var x = 0 { didSet { notify() } }\n    func notify() {}\n}\n`,
    );
    const x = byName(result, 'x')[0]!;
    const notify = byName(result, 'notify')[0]!;
    expect(result.references.some((r) => r.sourceId === x.id && r.targetId === notify.id)).toBe(
      true,
    );
  });

  it('resolves an extension self-call against the merged type', () => {
    const result = extract(`struct P {}\nextension P {\n    func a() { b() }\n    func b() {}\n}\n`);
    expect(resolvedTo(result, 'a', 'b')).toBe(true);
  });

  it('descends closures but prunes nested functions', () => {
    const result = extract(
      `func outer() {\n    items.forEach { inner() }\n    func nested() { leaked() }\n    called()\n}\nfunc inner() {}\nfunc called() {}\nfunc leaked() {}\n`,
    );
    const outer = byName(result, 'outer')[0]!;
    const callees = result.references.filter((r) => r.sourceId === outer.id).map((r) => r.targetName);
    expect(callees).toContain('inner'); // inside a closure → attributed
    expect(callees).toContain('called');
    expect(callees).not.toContain('leaked'); // inside a nested func → pruned
  });

  it('suppresses unresolved stdlib bare callees', () => {
    const result = extract(`func f() { print("x") }\n`);
    expect(result.references.some((r) => r.targetName === 'print')).toBe(false);
  });

  it('does NOT treat subscript access as a call', () => {
    // `lookup[0]` is a subscript read; tree-sitter-swift models it as a
    // call_expression with bracketed value_arguments — must emit no ref.
    const result = extract(
      `func lookup(_ k: Int) -> Int { return k }\nfunc use() { let v = lookup[0] }\n`,
    );
    expect(result.references.some((r) => r.targetName === 'lookup')).toBe(false);
  });

  it('does NOT attribute calls inside property-wrapper/attribute arguments', () => {
    const result = extract(
      `struct T {\n  @Wrapper(boom())\n  let y: Int = 0\n  func boom() -> Int { return 1 }\n}\n`,
    );
    expect(result.references.some((r) => r.targetName === 'boom')).toBe(false);
  });

  it('attributes each multi-binding initializer call to its own binding', () => {
    const result = extract(
      `func foo() -> Int { return 1 }\nfunc bar() -> Int { return 2 }\nstruct S { let a = foo(), b = bar() }\n`,
    );
    const a = byName(result, 'a')[0]!;
    const b = byName(result, 'b')[0]!;
    const foo = byName(result, 'foo')[0]!;
    const bar = byName(result, 'bar')[0]!;
    expect(result.references.some((r) => r.sourceId === a.id && r.targetId === foo.id)).toBe(true);
    expect(result.references.some((r) => r.sourceId === b.id && r.targetId === bar.id)).toBe(true);
    // and NOT crossed: a does not call bar, b does not call foo.
    expect(result.references.some((r) => r.sourceId === a.id && r.targetId === bar.id)).toBe(false);
    expect(result.references.some((r) => r.sourceId === b.id && r.targetId === foo.id)).toBe(false);
  });
});

describe('swift extractor — docs', () => {
  it('extracts a /// line doc (first line of a block)', () => {
    expect(extract(`/// First\n/// Second\nfunc f() {}\n`).symbols[0]!.doc).toBe('First');
  });

  it('extracts a /** block */ doc', () => {
    expect(extract(`/** Block doc */\nfunc f() {}\n`).symbols[0]!.doc).toBe('Block doc');
  });

  it('a plain // comment is not a doc comment', () => {
    expect(extract(`// plain\nfunc f() {}\n`).symbols[0]!.doc).toBeNull();
  });

  it('a trailing comment is not doc for the next decl', () => {
    const result = extract(`let z = 1 // trailing\nfunc f() {}\n`);
    expect(byName(result, 'f')[0]!.doc).toBeNull();
  });
});

describe('swift extractor — imports', () => {
  it('a plain import is a whole-module namespace import', () => {
    const imp = extract(`import Foundation\n`).imports[0]!;
    expect(imp.sourceModule).toBe('Foundation');
    expect(imp.importedNames).toEqual([{ name: '*', kind: 'namespace' }]);
  });

  it('a kind import binds the single symbol', () => {
    const imp = extract(`import struct Foundation.Data\n`).imports[0]!;
    expect(imp.sourceModule).toBe('Foundation');
    expect(imp.importedNames).toEqual([{ name: 'Data' }]);
  });

  it('a dotted submodule import stays a namespace', () => {
    const imp = extract(`import A.B\n`).imports[0]!;
    expect(imp.sourceModule).toBe('A.B');
    expect(imp.importedNames[0]!.name).toBe('*');
  });
});

describe('swift extractor — robustness', () => {
  it('an empty file yields no symbols', () => {
    expect(extract(``).symbols).toHaveLength(0);
  });

  it('same-signature methods across a type and an extension get distinct ids', () => {
    const result = extract(`struct S {\n    func f() {}\n}\nextension S {\n    func f() {}\n}\n`);
    const fs = byName(result, 'f');
    expect(fs).toHaveLength(2);
    expect(fs[0]!.id).not.toBe(fs[1]!.id);
  });

  it('extracts declarations guarded by top-level #if directives', () => {
    const result = extract(`#if DEBUG\nfunc dbg() {}\n#endif\nfunc always() {}\n`);
    expect(byName(result, 'dbg')).toHaveLength(1);
    expect(byName(result, 'always')).toHaveLength(1);
  });

  it('keeps the enclosing type + members for an IN-BODY #if (directive neutralization)', () => {
    const result = extract(
      `struct S {\n  func a() {}\n  #if DEBUG\n  func b() {}\n  #endif\n  func c() {}\n}\n`,
    );
    expect(byName(result, 'S')[0]?.kind).toBe('class');
    for (const m of ['a', 'b', 'c']) {
      const sym = byName(result, m)[0]!;
      expect(sym.kind, `member ${m}`).toBe('method');
      expect(sym.fqn).toBe(`src/test.swift:S.${m}`);
    }
    // Offsets are preserved: `b` keeps its original line 4.
    expect(byName(result, 'b')[0]!.startLine).toBe(4);
  });

  it('keeps BOTH branches of an #if/#else (over-extraction, not silent loss)', () => {
    const result = extract(`#if A\nfunc only() {}\n#else\nfunc only() {}\n#endif\n`);
    const onlys = byName(result, 'only');
    expect(onlys).toHaveLength(2);
    expect(onlys[0]!.id).not.toBe(onlys[1]!.id);
  });

  it('does NOT neutralize a #if-looking line inside a string literal (clean parses are untouched)', () => {
    // The multiline string holds a line starting with `#if`; the file parses
    // cleanly, so neutralization must NOT run and corrupt it — the interpolated
    // compute() call inside the string stays resolvable.
    const result = extract(
      `func compute() -> Int { return 1 }\nlet banner = """\n#if DEBUG marker\nvalue: \\(compute())\n"""\nfunc keep() {}\n`,
    );
    const banner = byName(result, 'banner')[0]!;
    const compute = byName(result, 'compute')[0]!;
    expect(result.references.some((r) => r.sourceId === banner.id && r.targetId === compute.id)).toBe(
      true,
    );
  });

  it('a top-level dot-operator function is not misclassified as a class member', () => {
    const sym = extract(`func .* (a: Int, b: Int) -> Int { return a }\n`).symbols[0]!;
    expect(sym.kind).toBe('function');
    expect(sym.name).toBe('.*');
    // FQN `file:.*` must resolve to top-level (null), not a member of class "".
    expect(classNameFromFqn(sym.fqn)).toBeNull();
  });
});
