import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { RECEIVER_OPAQUE } from '../../../src/types.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'rust', path = 'src/test.rs') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

describe('rust extractor — functions and exportedness', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a pub function with kind/fqn/signature/exported/lines', () => {
    const result = extract(`pub fn handle(req: String) -> bool {\n    true\n}\n`);
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('handle');
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.rs:handle');
    expect(sym.exported).toBe(true);
    expect(sym.signature).toBe('pub fn handle(req: String) -> bool');
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(3);
    expect(sym.language).toBe('rust');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
  });

  it('a private fn is not exported', () => {
    const result = extract(`fn helper() {}\n`);
    expect(result.symbols[0]!.exported).toBe(false);
  });

  it('pub(crate) / pub(super) / pub(in path) all count as exported', () => {
    const result = extract(
      `pub(crate) fn a() {}\npub(super) fn b() {}\npub(in crate::x) fn c() {}\n`,
    );
    expect(result.symbols.map((s) => s.exported)).toEqual([true, true, true]);
  });

  it('a top-level fn main is exported (entry point) even without pub', () => {
    const result = extract(`fn main() {}\n`);
    expect(result.symbols[0]!.name).toBe('main');
    expect(result.symbols[0]!.exported).toBe(true);
  });

  it('function modifiers (async/unsafe/const) stay in the signature', () => {
    const sym = extract(`pub async unsafe fn g() {}\n`).symbols[0]!;
    expect(sym.signature).toBe('pub async unsafe fn g()');
  });

  it('generics and where-clauses stay in the signature', () => {
    const sym = extract(
      `fn map<T, U>(x: T) -> U where T: Clone {\n    todo!()\n}\n`,
    ).symbols[0]!;
    expect(sym.signature).toBe('fn map<T, U>(x: T) -> U where T: Clone');
  });

  it('a raw identifier keeps its r# prefix in the name', () => {
    const sym = extract(`fn r#match() {}\n`).symbols[0]!;
    expect(sym.name).toBe('r#match');
  });

  it('caps the displayed signature at 120 chars', () => {
    const params = Array.from({ length: 40 }, (_, i) => `a${i}: i32`).join(', ');
    const sym = extract(`fn wide(${params}) {}\n`).symbols[0]!;
    expect(sym.signature.length).toBe(120);
  });
});

describe('rust extractor — structs, unions, and fields', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('struct → class kind with a member-block-free signature', () => {
    const sym = extract(`pub struct Point {\n    x: f64,\n}\n`).symbols.find(
      (s) => s.name === 'Point',
    )!;
    expect(sym.kind).toBe('class');
    expect(sym.signature).toBe('pub struct Point');
    expect(sym.fqn).toBe('src/test.rs:Point');
  });

  it('named struct fields → variable members with pub-gated export', () => {
    const result = extract(`pub struct P {\n    pub x: f64,\n    y: f64,\n}\n`);
    const x = result.symbols.find((s) => s.name === 'x')!;
    const y = result.symbols.find((s) => s.name === 'y')!;
    expect(x.kind).toBe('variable');
    expect(x.fqn).toBe('src/test.rs:P.x');
    expect(x.exported).toBe(true);
    expect(y.exported).toBe(false);
  });

  it('public fields of a private struct are not exported', () => {
    const result = extract(`struct P {\n    pub x: f64,\n}\n`);
    expect(result.symbols.find((s) => s.name === 'x')!.exported).toBe(false);
  });

  it('tuple structs and unit structs have no named members', () => {
    const result = extract(`struct Tup(i32, String);\nstruct Unit;\n`);
    expect(result.symbols.map((s) => s.name)).toEqual(['Tup', 'Unit']);
    expect(result.symbols.every((s) => s.kind === 'class')).toBe(true);
  });

  it('union → class kind with fields', () => {
    const result = extract(`pub union U {\n    a: i32,\n    b: f32,\n}\n`);
    const u = result.symbols.find((s) => s.name === 'U')!;
    expect(u.kind).toBe('class');
    expect(u.signature).toBe('pub union U');
    expect(result.symbols.filter((s) => s.kind === 'variable').map((s) => s.name)).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps generic parameters in the struct signature', () => {
    const sym = extract(`struct Container<T> {\n    item: T,\n}\n`).symbols.find(
      (s) => s.name === 'Container',
    )!;
    expect(sym.signature).toBe('struct Container<T>');
  });
});

describe('rust extractor — enums and type aliases', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('enum → enum kind; variants are not extracted', () => {
    const result = extract(
      `pub enum Shape {\n    Circle { radius: f64 },\n    Square(f64),\n    Empty,\n}\n`,
    );
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.kind).toBe('enum');
    expect(sym.name).toBe('Shape');
    expect(sym.signature).toBe('pub enum Shape');
  });

  it('type alias → type kind', () => {
    const sym = extract(`pub type Pair = (i32, i32);\n`).symbols[0]!;
    expect(sym.kind).toBe('type');
    expect(sym.name).toBe('Pair');
  });
});

describe('rust extractor — traits and members', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('trait → interface kind with a body-free signature', () => {
    const sym = extract(`pub trait Drawable {\n    fn draw(&self);\n}\n`).symbols.find(
      (s) => s.name === 'Drawable',
    )!;
    expect(sym.kind).toBe('interface');
    expect(sym.signature).toBe('pub trait Drawable');
  });

  it('supertrait bounds stay in the trait signature', () => {
    const sym = extract(`trait Super: Base + Clone {\n    fn r(&self);\n}\n`).symbols.find(
      (s) => s.name === 'Super',
    )!;
    expect(sym.signature).toBe('trait Super: Base + Clone');
  });

  it('required and default methods are declaration-only / real method members', () => {
    const result = extract(
      `pub trait T {\n    fn req(&self);\n    fn def(&self) -> i32 {\n        0\n    }\n}\n`,
    );
    const req = result.symbols.find((s) => s.name === 'req')!;
    const def = result.symbols.find((s) => s.name === 'def')!;
    expect(req.kind).toBe('method');
    expect(req.fqn).toBe('src/test.rs:T.req');
    expect(def.kind).toBe('method');
    expect(def.fqn).toBe('src/test.rs:T.def');
  });

  it('trait members are exported iff the trait is exported (no visibility on items)', () => {
    const pub = extract(`pub trait T {\n    fn m(&self);\n}\n`);
    expect(pub.symbols.find((s) => s.name === 'm')!.exported).toBe(true);
    const priv = extract(`trait T {\n    fn m(&self);\n}\n`);
    expect(priv.symbols.find((s) => s.name === 'm')!.exported).toBe(false);
  });

  it('trait associated const → variable member, associated type → type member', () => {
    const result = extract(
      `pub trait T {\n    const NAME: &str;\n    type Output;\n}\n`,
    );
    const name = result.symbols.find((s) => s.name === 'NAME')!;
    const out = result.symbols.find((s) => s.name === 'Output')!;
    expect(name.kind).toBe('variable');
    expect(name.fqn).toBe('src/test.rs:T.NAME');
    expect(out.kind).toBe('type');
    expect(out.fqn).toBe('src/test.rs:T.Output');
  });
});

describe('rust extractor — impl blocks and methods', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('the impl is not a symbol; methods key on the implementing type', () => {
    const result = extract(
      `struct Point;\nimpl Point {\n    pub fn new() -> Self {\n        Point\n    }\n    fn helper(&self) {}\n}\n`,
    );
    expect(result.symbols.some((s) => s.name === 'impl')).toBe(false);
    const newM = result.symbols.find((s) => s.name === 'new')!;
    expect(newM.kind).toBe('method');
    expect(newM.fqn).toBe('src/test.rs:Point.new');
    expect(newM.exported).toBe(true);
    expect(result.symbols.find((s) => s.name === 'helper')!.exported).toBe(false);
  });

  it('generic impl resolves the base type name', () => {
    const sym = extract(
      `struct Container<T> { item: T }\nimpl<T> Container<T> {\n    fn get(&self) {}\n}\n`,
    ).symbols.find((s) => s.name === 'get')!;
    expect(sym.fqn).toBe('src/test.rs:Container.get');
  });

  it('impl Trait for Type keys methods on the implementing type, not the trait', () => {
    const sym = extract(
      `struct Point;\nimpl Display for Point {\n    fn fmt(&self) {}\n}\n`,
    ).symbols.find((s) => s.name === 'fmt')!;
    expect(sym.fqn).toBe('src/test.rs:Point.fmt');
  });

  it('trait-impl conformance methods are not exported (no pub keyword possible)', () => {
    const sym = extract(
      `struct Point;\nimpl Display for Point {\n    fn fmt(&self) {}\n}\n`,
    ).symbols.find((s) => s.name === 'fmt')!;
    expect(sym.exported).toBe(false);
  });

  it('impl-level associated const and type become members', () => {
    const result = extract(
      `struct Foo;\nimpl Foo {\n    const MAX: i32 = 10;\n    type Alias = i32;\n}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'MAX')!.fqn).toBe('src/test.rs:Foo.MAX');
    expect(result.symbols.find((s) => s.name === 'Alias')!.kind).toBe('type');
  });

  it('methods scoped to a non-nominal impl target are skipped', () => {
    const result = extract(`impl &Foo {\n    fn m(&self) {}\n}\n`);
    expect(result.symbols.some((s) => s.name === 'm')).toBe(false);
  });

  it('same-signature methods across two trait impls on one type get distinct ids', () => {
    const result = extract(
      `struct T;\nimpl A for T {\n    fn id(&self) {}\n}\nimpl B for T {\n    fn id(&self) {}\n}\n`,
    );
    const ids = result.symbols.filter((s) => s.name === 'id').map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('rust extractor — modules and macros', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('inline mod → module symbol plus recursion into its items', () => {
    const result = extract(
      `pub mod inner {\n    pub fn nested() {}\n    fn priv_fn() {}\n}\n`,
    );
    const mod = result.symbols.find((s) => s.name === 'inner')!;
    expect(mod.kind).toBe('module');
    const nested = result.symbols.find((s) => s.name === 'nested')!;
    expect(nested.kind).toBe('function');
    expect(nested.fqn).toBe('src/test.rs:nested');
    expect(nested.exported).toBe(true);
    expect(result.symbols.find((s) => s.name === 'priv_fn')!.exported).toBe(false);
  });

  it('pub items in a private module are not exported (container gating)', () => {
    const result = extract(`mod inner {\n    pub fn nested() {}\n}\n`);
    expect(result.symbols.find((s) => s.name === 'nested')!.exported).toBe(false);
  });

  it('a same-named fn in two modules gets distinct ids despite a shared FQN', () => {
    const result = extract(
      `mod a {\n    pub fn f() {}\n}\nmod b {\n    pub fn f() {}\n}\n`,
    );
    const fns = result.symbols.filter((s) => s.name === 'f' && s.kind === 'function');
    expect(fns).toHaveLength(2);
    expect(fns.every((s) => s.fqn === 'src/test.rs:f')).toBe(true);
    expect(new Set(fns.map((s) => s.id)).size).toBe(2);
  });

  it('external mod declaration → declaration-only module symbol', () => {
    const result = extract(`pub mod external;\n`);
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.kind).toBe('module');
    expect(result.symbols[0]!.name).toBe('external');
  });

  it('macro_rules! → a findable function symbol, always unexported', () => {
    const result = extract(`macro_rules! my_macro {\n    () => {};\n}\n`);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('my_macro');
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(false);
  });

  it('extern blocks are transparent: foreign fns/statics enter the namespace', () => {
    const result = extract(
      `extern "C" {\n    pub fn ext_fn(x: i32) -> i32;\n    static G: i32;\n}\n`,
    );
    const fn = result.symbols.find((s) => s.name === 'ext_fn')!;
    expect(fn.kind).toBe('function');
    expect(fn.exported).toBe(true);
    expect(result.symbols.find((s) => s.name === 'G')!.kind).toBe('variable');
  });
});

describe('rust extractor — const and static', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('const and static → variable kind, pub-gated export', () => {
    const result = extract(`pub const MAX: usize = 10;\nstatic G: i32 = 0;\n`);
    const max = result.symbols.find((s) => s.name === 'MAX')!;
    const g = result.symbols.find((s) => s.name === 'G')!;
    expect(max.kind).toBe('variable');
    expect(max.exported).toBe(true);
    expect(g.kind).toBe('variable');
    expect(g.exported).toBe(false);
  });
});

describe('rust extractor — docs', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('takes an outer /// doc line directly above the item', () => {
    const sym = extract(`/// Greets people.\npub fn greet() {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Greets people.');
  });

  it('takes the FIRST line of a multi-line /// block', () => {
    const sym = extract(`/// Summary.\n/// Detail.\npub fn f() {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Summary.');
  });

  it('skips intervening #[attr] siblings to find the doc comment', () => {
    const sym = extract(
      `/// A point.\n#[derive(Debug)]\n#[repr(C)]\npub struct Point {\n    x: f64,\n}\n`,
    ).symbols.find((s) => s.name === 'Point')!;
    expect(sym.doc).toBe('A point.');
  });

  it('a doc comment placed after an attribute still documents the item', () => {
    // `///` desugars to `#[doc]`; doc comments are order-independent among
    // attributes, so this DOES document f (rustdoc shows it).
    const sym = extract(`#[inline]\n/// Doc after attr.\npub fn f() {}\n`).symbols.find(
      (s) => s.name === 'f',
    )!;
    expect(sym.doc).toBe('Doc after attr.');
  });

  it('handles /** block */ docs, stripping continuation markers', () => {
    const sym = extract(`/** Block summary.\n * more. */\npub fn f() {}\n`).symbols[0]!;
    expect(sym.doc).toBe('Block summary.');
  });

  it('plain // and /* */ comments are not docs', () => {
    expect(extract(`// not a doc\npub fn f() {}\n`).symbols[0]!.doc).toBeNull();
    expect(extract(`/* not a doc */\npub fn f() {}\n`).symbols[0]!.doc).toBeNull();
  });

  it('an inner //! comment does not document the following item', () => {
    const result = extract(`//! Crate doc.\npub fn f() {}\n`);
    expect(result.symbols.find((s) => s.name === 'f')!.doc).toBeNull();
  });

  it('a blank line detaches the doc block', () => {
    const sym = extract(`/// detached\n\npub fn f() {}\n`).symbols[0]!;
    expect(sym.doc).toBeNull();
  });

  it('a trailing comment on the previous line is not doc', () => {
    const sym = extract(`let z = 1; // trailing\npub fn f() {}\n`).symbols.find(
      (s) => s.name === 'f',
    )!;
    expect(sym.doc).toBeNull();
  });

  it('documents struct fields and methods', () => {
    const result = extract(
      `pub struct S {\n    /// The id.\n    pub id: u32,\n}\nimpl S {\n    /// Builds one.\n    pub fn new() -> Self {\n        S { id: 0 }\n    }\n}\n`,
    );
    expect(result.symbols.find((s) => s.name === 'id')!.doc).toBe('The id.');
    expect(result.symbols.find((s) => s.name === 'new')!.doc).toBe('Builds one.');
  });
});

describe('rust extractor — references: bare calls and constructors', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('resolves a bare call to a same-file function', () => {
    const result = extract(`fn helper() {}\nfn f() {\n    helper();\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'helper')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'helper')!.id);
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'f')!.id);
    expect(ref.receiver).toBeUndefined();
  });

  it('emits unknown bare calls unresolved (cross-file lookup by name)', () => {
    const result = extract(`fn f() {\n    new_client();\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'new_client')!;
    expect(ref.targetId).toBeNull();
  });

  it('a struct-expression resolves to the struct (constructor edge)', () => {
    const result = extract(
      `struct Point { x: f64 }\nfn make() -> Point {\n    Point { x: 1.0 }\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'Point')!;
    expect(ref.targetId).toBe(
      result.symbols.find((s) => s.name === 'Point' && s.kind === 'class')!.id,
    );
  });

  it('turbofish struct construction resolves to the struct', () => {
    const result = extract(
      `struct Pair { x: i32 }\nfn make() -> Pair {\n    Pair::<i32> { x: 1 }\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'Pair')!;
    expect(ref.targetId).toBe(
      result.symbols.find((s) => s.name === 'Pair' && s.kind === 'class')!.id,
    );
  });

  it('Self { .. } construction emits no junk reference', () => {
    const result = extract(
      `struct P { x: i32 }\nimpl P {\n    fn make() -> Self {\n        Self { x: 0 }\n    }\n}\n`,
    );
    expect(result.references.some((r) => r.targetName === 'Self')).toBe(false);
  });

  it('bare calls never bind to structs (tuple-struct ctors stay unresolved)', () => {
    const result = extract(`struct Tup(i32);\nfn f() {\n    let _ = Tup(1);\n}\n`);
    expect(result.references.find((r) => r.targetName === 'Tup')!.targetId).toBeNull();
  });

  it('Some/Ok/Err prelude constructors emit no references', () => {
    const result = extract(
      `fn f() -> Result<i32, ()> {\n    let _ = Some(1);\n    Ok(2)\n}\n`,
    );
    expect(result.references.some((r) => ['Some', 'Ok', 'Err'].includes(r.targetName))).toBe(
      false,
    );
  });

  it('a file-local fn shadowing Ok keeps its refs', () => {
    const result = extract(`fn Ok() {}\nfn f() {\n    Ok();\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'Ok')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'Ok')!.id);
  });

  it('calls inside closures attribute to the enclosing function', () => {
    const result = extract(
      `fn inner() {}\nfn f() {\n    let c = || {\n        inner();\n    };\n    c();\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'inner')!;
    expect(ref.sourceId).toBe(result.symbols.find((s) => s.name === 'f')!.id);
  });

  it('macro invocations emit no references', () => {
    const result = extract(`fn f() {\n    println!("{}", 1);\n    vec![1, 2];\n}\n`);
    expect(result.references).toHaveLength(0);
  });
});

describe('rust extractor — references: self, Self, and member calls', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('self.method() resolves to the enclosing impl type and is self-flagged', () => {
    const result = extract(
      `struct P;\nimpl P {\n    fn a(&self) {\n        self.b();\n    }\n    fn b(&self) {}\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'b')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'b')!.id);
    expect(ref.selfReceiver).toBe(true);
    expect(ref.receiver).toBe('self');
  });

  it('Self::assoc() resolves to the enclosing impl type', () => {
    const result = extract(
      `struct P;\nimpl P {\n    fn a() {\n        Self::origin();\n    }\n    fn origin() {}\n}\n`,
    );
    const ref = result.references.find((r) => r.targetName === 'origin')!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'origin')!.id);
    expect(ref.selfReceiver).toBe(true);
  });

  it('Type::assoc() resolves to that type’s method (associated-fn call)', () => {
    const result = extract(
      `struct P;\nimpl P {\n    fn new() -> Self {\n        P\n    }\n    fn other() {\n        P::new();\n    }\n}\n`,
    );
    const ref = result.references.find(
      (r) => r.targetName === 'new' && r.receiver === 'P',
    )!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'new')!.id);
  });

  it('a multi-segment path call emits a ref keyed on its immediate qualifier', () => {
    // `crate::defs::target_fn()` → receiver=defs, property=target_fn — the
    // same shape as `defs::target_fn()`, so it resolves cross-file through the
    // existing member-ref machinery (this is the cross-file recall fix).
    const result = extract(`fn c() {\n    crate::defs::target_fn();\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'target_fn')!;
    expect(ref).toBeDefined();
    expect(ref.receiver).toBe('defs');
    expect(ref.targetId).toBeNull();
  });

  it('a root-relative super:: path call emits a ref', () => {
    const result = extract(`fn c() {\n    super::helper();\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'helper')!;
    expect(ref).toBeDefined();
    expect(ref.receiver).toBe('super');
  });

  it('an external (non-crate-rooted) path call emits NO ref — precision over recall', () => {
    // std::io::stdout()'s final segment routinely collides with a same-named
    // in-repo member; the weak member-include can't see the receiver, so
    // capturing external paths would inject false cross-file callers. Only
    // crate/self/super-rooted multi-segment paths are captured.
    const result = extract(`fn c(a: i32, b: i32) {\n    std::mem::swap(&mut a, &mut b);\n}\n`);
    expect(result.references.some((r) => r.targetName === 'swap')).toBe(false);
  });

  it('a multi-segment path to a same-file type method resolves at extract time', () => {
    const result = extract(
      `struct T;\nimpl T {\n    fn assoc() {}\n}\nfn c() {\n    crate::T::assoc();\n}\n`,
    );
    const ref = result.references.find(
      (r) => r.targetName === 'assoc' && r.receiver === 'T',
    )!;
    expect(ref.targetId).toBe(result.symbols.find((s) => s.name === 'assoc')!.id);
  });

  it('obj.method() is a member ref with the receiver token, unresolved', () => {
    const result = extract(`fn f(obj: T) {\n    obj.run();\n}\n`);
    const ref = result.references.find((r) => r.targetName === 'run')!;
    expect(ref.receiver).toBe('obj');
    expect(ref.targetId).toBeNull();
    expect(ref.selfReceiver).toBeUndefined();
  });

  it('chained `.` calls capture the outer method under an opaque receiver', () => {
    const result = extract(`fn f(obj: T) {\n    obj.a().b();\n}\n`);
    // `obj.a()` keeps its single-identifier receiver; the chained `.b()` (value
    // is a call_expression) is now captured under RECEIVER_OPAQUE — findable by
    // method name (recall) but never resolved.
    const a = result.references.find((r) => r.targetName === 'a')!;
    expect(a.receiver).toBe('obj');
    const b = result.references.find((r) => r.targetName === 'b')!;
    expect(b.receiver).toBe(RECEIVER_OPAQUE);
    expect(b.targetId).toBeNull();
  });

  it('suppresses unresolved chained calls to common stdlib names', () => {
    const result = extract(`fn f(obj: T) {\n    obj.iter().collect();\n}\n`);
    const names = result.references.map((r) => r.targetName);
    // iter/collect ∈ RUST_IGNORED_MEMBER_CALLEES and unresolved → dropped.
    expect(names).not.toContain('iter');
    expect(names).not.toContain('collect');
  });

  it('captures trimmed domain names (bytes, remove) but keeps canonical ones (parse, is_empty)', () => {
    const result = extract(
      `fn f(obj: T) {\n    obj.a().bytes();\n    obj.b().remove(0);\n    obj.c().parse();\n    obj.d().is_empty();\n}\n`,
    );
    const names = result.references.map((r) => r.targetName);
    // bytes/remove were REMOVED from RUST_IGNORED_MEMBER_CALLEES after the ripgrep
    // dogfood (distinctive domain methods with in-repo recall stake) → now captured.
    expect(names).toContain('bytes');
    expect(names).toContain('remove');
    // parse/is_empty stay suppressed (canonical stdlib; ~0–2% in-repo target on
    // ripgrep → capturing would inject mostly-false weak callers).
    expect(names).not.toContain('parse');
    expect(names).not.toContain('is_empty');
  });

  it('exempts qualified `::`-path calls from the ignore set, but still suppresses `.method()` calls', () => {
    const result = extract(
      `fn f(obj: T) {\n    crate::config::parse();\n    config::read();\n    obj.c().parse();\n    obj.d().read();\n}\n`,
    );
    // `::`-path calls are pathQualified → EXEMPT from RUST_IGNORED_MEMBER_CALLEES
    // (a small intra-crate population, not the dot-method flood the set targets),
    // so they survive despite parse/read ∈ the set — `crate::config::parse()` to
    // an in-repo `fn parse` stays findable. The chained `.parse()`/`.read()`
    // (field_expression dot-method) remain suppressed, so only the path form
    // survives for each name.
    const parse = result.references.filter((r) => r.targetName === 'parse');
    expect(parse).toHaveLength(1);
    expect(parse[0]!.receiver).toBe('config');
    expect(parse[0]!.targetId).toBeNull();
    const read = result.references.filter((r) => r.targetName === 'read');
    expect(read).toHaveLength(1);
    expect(read[0]!.receiver).toBe('config');
  });
});

describe('rust extractor — imports', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a simple scoped use as one import', () => {
    const result = extract(`use std::collections::HashMap;\n`);
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.sourceModule).toBe('std::collections');
    expect(result.imports[0]!.importedNames[0]!.name).toBe('HashMap');
  });

  it('use ... as alias records the alias', () => {
    const result = extract(`use crate::foo::Bar as Baz;\n`);
    expect(result.imports[0]!.importedNames[0]).toMatchObject({ name: 'Bar', alias: 'Baz' });
  });

  it('use a::{self, B} binds the module and the names', () => {
    const result = extract(`use std::fmt::{self, Display};\n`);
    const names = result.imports.map((i) => i.importedNames[0]!.name);
    expect(names).toContain('fmt');
    expect(names).toContain('Display');
  });

  it('wildcard use → namespace import', () => {
    const result = extract(`use other::*;\n`);
    expect(result.imports[0]!.importedNames[0]!.name).toBe('*');
  });

  it('strips a crate::/self::/super:: anchor from the import sourceModule', () => {
    const result = extract(`use crate::foo::Bar;\nuse super::baz::Qux;\nuse other::Thing;\n`);
    const src = (n: string) => result.imports.find((i) => i.importedNames[0]!.name === n)!.sourceModule;
    expect(src('Bar')).toBe('foo'); // not 'crate::foo'
    expect(src('Qux')).toBe('baz'); // not 'super::baz'
    expect(src('Thing')).toBe('other'); // unanchored, unchanged
  });

  it('nested use lists recurse, one import per leaf with the right prefix', () => {
    const result = extract(`use a::b::{c::d, e::{f, g}};\n`);
    const got = result.imports.map((i) => `${i.sourceModule}::${i.importedNames[0]!.name}`);
    expect(got).toEqual(['a::b::c::d', 'a::b::e::f', 'a::b::e::g']);
  });
});

describe('rust extractor — error tolerance', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('an empty file yields nothing', () => {
    const result = extract(``);
    expect(result.symbols).toHaveLength(0);
    expect(result.references).toHaveLength(0);
  });

  it('a partial/broken declaration does not crash', () => {
    const result = extract(`pub fn f(\n`);
    expect(Array.isArray(result.symbols)).toBe(true);
  });

  it('symbol ids are unique across a representative file', () => {
    const result = extract(
      `pub struct S { pub x: i32 }\nimpl S {\n    pub fn new() -> Self { S { x: 0 } }\n    fn a(&self) {}\n}\npub trait T { fn m(&self); }\npub enum E { A, B }\npub fn free() {}\npub mod m { pub fn g() {} }\n`,
    );
    const ids = result.symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
