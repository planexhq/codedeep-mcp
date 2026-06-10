import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, language = 'typescript', path = 'src/test.ts') {
  const tree = parseFile(src, language)!;
  return extractSymbols(tree, src, makeFileInfo(language, path));
}

describe('typescript extractor — function declarations', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a top-level function declaration', () => {
    const result = extract('function foo(a: number): number { return a; }');
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('foo');
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(false);
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(1);
    expect(sym.signature).toBe('function foo(a: number): number');
    expect(sym.fqn).toBe('src/test.ts:foo');
    expect(sym.file).toBe('src/test.ts');
    expect(sym.language).toBe('typescript');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
    expect(sym.doc).toBeNull();
  });

  it('marks exported when wrapped in export_statement', () => {
    const sym = extract('export function foo() {}').symbols[0]!;
    expect(sym.exported).toBe(true);
    expect(sym.signature).toBe('function foo()');
  });

  it('keeps async modifier in the signature', () => {
    const sym = extract('export async function foo(): Promise<void> { }').symbols[0]!;
    expect(sym.signature).toBe('async function foo(): Promise<void>');
    expect(sym.exported).toBe(true);
  });

  it('extracts a single-line JSDoc comment', () => {
    const src = '/** Validates the JWT token */\nexport function authenticate() {}';
    const sym = extract(src).symbols[0]!;
    expect(sym.doc).toBe('Validates the JWT token');
  });

  it('extracts the first non-empty line from a multi-line JSDoc, stripping leading *', () => {
    const src = '/**\n * Sums two numbers\n * @param a first\n */\nfunction add(a: number) { return a; }';
    const sym = extract(src).symbols[0]!;
    expect(sym.doc).toBe('Sums two numbers');
  });

  it('returns null doc when no preceding comment', () => {
    const sym = extract('function foo() {}').symbols[0]!;
    expect(sym.doc).toBeNull();
  });

  it('computes startLine/endLine across multi-line bodies', () => {
    const sym = extract('function foo() {\n  return 1;\n}').symbols[0]!;
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(3);
  });

  it('does not throw on syntactically broken input', () => {
    const result = extract('function broken( {\n  return\n');
    expect(result.symbols).toBeDefined();
    expect(result.references).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it('skips export_statement with no declaration field (export {} clause)', () => {
    const result = extract('function foo() {}\nexport { foo };');
    expect(result.symbols).toHaveLength(1);
    expect(result.symbols[0]!.name).toBe('foo');
    expect(result.symbols[0]!.exported).toBe(false);
  });

  it('extracts JS function_declaration via the same module', () => {
    const sym = extract('function add(a, b) { return a + b; }', 'javascript', 'src/test.js').symbols[0]!;
    expect(sym.name).toBe('add');
    expect(sym.language).toBe('javascript');
    expect(sym.signature).toBe('function add(a, b)');
  });
});

describe('typescript extractor — classes and methods', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a class with its methods', () => {
    const src = [
      'export class User {',
      '  validate(): boolean { return true; }',
      '  greet(name: string): string { return `Hello, ${name}`; }',
      '}',
    ].join('\n');
    const result = extract(src);
    expect(result.symbols).toHaveLength(3);

    const cls = result.symbols.find((s) => s.kind === 'class')!;
    expect(cls.name).toBe('User');
    expect(cls.fqn).toBe('src/test.ts:User');
    expect(cls.exported).toBe(true);
    expect(cls.startLine).toBe(1);
    expect(cls.endLine).toBe(4);

    const validate = result.symbols.find((s) => s.name === 'validate')!;
    expect(validate.kind).toBe('method');
    expect(validate.fqn).toBe('src/test.ts:User.validate');
    expect(validate.signature).toBe('validate(): boolean');
    expect(validate.exported).toBe(true);

    const greet = result.symbols.find((s) => s.name === 'greet')!;
    expect(greet.kind).toBe('method');
    expect(greet.fqn).toBe('src/test.ts:User.greet');
    expect(greet.signature).toBe('greet(name: string): string');
  });

  it('keeps class heritage (extends/implements) in the class signature', () => {
    const cls = extract('class A extends B implements C {}').symbols.find((s) => s.kind === 'class')!;
    expect(cls.signature).toBe('class A extends B implements C');
  });

  it('marks non-exported class and methods as not exported', () => {
    const src = 'class Internal {\n  static create() { return new Internal(); }\n}';
    const result = extract(src);
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    expect(cls.exported).toBe(false);
    const method = result.symbols.find((s) => s.kind === 'method')!;
    expect(method.name).toBe('create');
    expect(method.exported).toBe(false);
  });

  it('extracts JSDoc on individual methods', () => {
    const src = 'class A {\n  /** Validates input */\n  validate() {}\n}';
    const method = extract(src).symbols.find((s) => s.kind === 'method')!;
    expect(method.doc).toBe('Validates input');
  });

  it('produces unique ids for class and methods', () => {
    const src = 'class A { foo() {} bar() {} }';
    const result = extract(src);
    const ids = new Set(result.symbols.map((s) => s.id));
    expect(ids.size).toBe(3);
  });
});

describe('typescript extractor — variables, arrows, interfaces, types', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('classifies a const with non-function initializer as variable', () => {
    const sym = extract('const x = 5;').symbols[0]!;
    expect(sym.name).toBe('x');
    expect(sym.kind).toBe('variable');
    expect(sym.signature).toBe('x = 5');
  });

  it('classifies an arrow function const as function (not variable)', () => {
    const sym = extract('const foo = (x: number) => x;').symbols[0]!;
    expect(sym.name).toBe('foo');
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('foo = (x: number)');
  });

  it('classifies a function_expression const as function', () => {
    const sym = extract('const foo = function (x) { return x; };').symbols[0]!;
    expect(sym.name).toBe('foo');
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('foo = function (x)');
  });

  it('extracts interface_declaration', () => {
    const sym = extract('export interface User { id: string; name: string; }').symbols[0]!;
    expect(sym.name).toBe('User');
    expect(sym.kind).toBe('interface');
    expect(sym.exported).toBe(true);
    expect(sym.signature).toBe('interface User');
  });

  it('extracts type_alias_declaration', () => {
    const sym = extract('export type ID = string;').symbols[0]!;
    expect(sym.name).toBe('ID');
    expect(sym.kind).toBe('type');
    expect(sym.exported).toBe(true);
    expect(sym.signature).toContain('type ID = string');
  });

  it('extracts multiple declarators in one statement', () => {
    const result = extract('export const a = 1, b = 2;');
    expect(result.symbols).toHaveLength(2);
    const [a, b] = result.symbols;
    expect(a!.name).toBe('a');
    expect(b!.name).toBe('b');
    expect(a!.exported).toBe(true);
    expect(b!.exported).toBe(true);
  });

  it('skips destructured variable declarations', () => {
    const result = extract('const { a, b } = obj;');
    expect(result.symbols).toHaveLength(0);
  });

  it('preserves arrow function with return type annotation in signature', () => {
    const sym = extract('export const f = (x: number): number => x * 2;').symbols[0]!;
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('f = (x: number): number');
  });

  it('handles arrow function with block body', () => {
    const sym = extract('const f = () => { return 1; };').symbols[0]!;
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('f = ()');
  });
});

describe('typescript extractor — imports', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts named imports', () => {
    const result = extract('import { hash, formatDate } from "./utils";');
    expect(result.imports).toHaveLength(1);
    const imp = result.imports[0]!;
    expect(imp.sourceModule).toBe('./utils');
    expect(imp.importedNames).toEqual([{ name: 'hash' }, { name: 'formatDate' }]);
    expect(imp.line).toBe(1);
    expect(imp.file).toBe('src/test.ts');
  });

  it('extracts named imports with aliases', () => {
    const result = extract('import { a, b as c } from "mod";');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'a' },
      { name: 'b', alias: 'c' },
    ]);
  });

  it('extracts default imports', () => {
    const result = extract('import React from "react";');
    expect(result.imports[0]!.importedNames).toEqual([{ name: 'default', alias: 'React' }]);
    expect(result.imports[0]!.sourceModule).toBe('react');
  });

  it('extracts namespace imports', () => {
    const result = extract('import * as fs from "node:fs";');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: '*', alias: 'fs', kind: 'namespace' },
    ]);
    expect(result.imports[0]!.sourceModule).toBe('node:fs');
  });

  it('extracts side-effect-only imports', () => {
    const result = extract('import "polyfill";');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.sourceModule).toBe('polyfill');
    expect(result.imports[0]!.importedNames).toEqual([]);
  });

  it('marks whole-statement `import type { X } from` as kind=type', () => {
    const result = extract('import type { Service } from "./m";');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'Service', kind: 'type' },
    ]);
  });

  it('marks only the type-prefixed specifier in `import { type X, Y } from`', () => {
    const result = extract('import { type X, Y } from "./m";');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'X', kind: 'type' },
      { name: 'Y' },
    ]);
  });

  it('marks `import type X from` (default-position type import) as kind=type', () => {
    const result = extract('import type Default from "./m";');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'default', alias: 'Default', kind: 'type' },
    ]);
  });
});

describe('typescript extractor — within-file call references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a reference for a bare-identifier call to a top-level function', () => {
    const src = 'function helper() {}\nfunction caller() { helper(); }';
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const caller = result.symbols.find((s) => s.name === 'caller')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({
      sourceId: caller.id,
      targetId: helper.id,
      targetName: 'helper',
      kind: 'calls',
      file: 'src/test.ts',
      line: 2,
    });
  });

  it('skips member-expression calls (obj.method())', () => {
    const src = 'function caller() { obj.method(); }';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('attributes calls inside class methods to the method', () => {
    const src = [
      'function helper() {}',
      'class A {',
      '  method() { helper(); }',
      '}',
    ].join('\n');
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const method = result.symbols.find((s) => s.kind === 'method')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.sourceId).toBe(method.id);
    expect(result.references[0]!.targetId).toBe(helper.id);
  });

  it('emits references from arrow function variables', () => {
    const src = 'function helper() {}\nconst caller = () => { helper(); };';
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const caller = result.symbols.find((s) => s.name === 'caller')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.sourceId).toBe(caller.id);
    expect(result.references[0]!.targetId).toBe(helper.id);
  });

  it('emits unresolved refs (targetId=null) for calls to undefined names', () => {
    const src = 'function caller() { undefinedThing(); }';
    const result = extract(src);
    const caller = result.symbols.find((s) => s.name === 'caller')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({
      sourceId: caller.id,
      targetId: null,
      targetName: 'undefinedThing',
      kind: 'calls',
      file: 'src/test.ts',
      line: 1,
    });
  });

  it('resolves forward references (callee defined after caller)', () => {
    const src = 'function caller() { callee(); }\nfunction callee() {}';
    const result = extract(src);
    expect(result.references).toHaveLength(1);
  });

  it('does not attribute calls inside nested functions to the outer function', () => {
    const src = 'function helper() {}\nfunction outer() { function inner() { helper(); } }';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('does not attribute calls inside arrow-function closures to the outer function', () => {
    const src = 'function helper() {}\nfunction outer() { const cb = () => { helper(); }; }';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('prefers a runtime-callable symbol over a same-named type alias', () => {
    const src = [
      'type Helper = (x: number) => number;',
      'const Helper: Helper = (x) => x;',
      'function caller() { Helper(1); }',
    ].join('\n');
    const result = extract(src);
    const callable = result.symbols.find((s) => s.name === 'Helper' && s.kind === 'function')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.targetId).toBe(callable.id);
  });

  it('does not resolve calls to interfaces or type aliases (targetId=null)', () => {
    const src = [
      'interface Helper { (x: number): number; }',
      'function caller() { Helper(1); }',
    ].join('\n');
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.targetId).toBeNull();
    expect(result.references[0]!.targetName).toBe('Helper');
  });

  it('emits a module-level reference (sourceId=null) for top-level calls', () => {
    const src = "import { authenticate } from './auth';\nauthenticate(req);\n";
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({
      sourceId: null,
      targetId: null,
      targetName: 'authenticate',
      kind: 'calls',
      file: 'src/test.ts',
      line: 2,
    });
  });

  it('does not double-emit a module-level call when caller is also a declaration', () => {
    const src = 'function caller() { helper(); }\nfunction helper() {}';
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.sourceId).not.toBeNull();
  });
});

describe('typescript extractor — decorator references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a module-level reference for a class decorator', () => {
    const src = 'function dec() { return () => {}; }\n@dec()\nclass Foo {}';
    const result = extract(src);
    const decRef = result.references.find((r) => r.targetName === 'dec');
    expect(decRef).toBeDefined();
    expect(decRef!.sourceId).toBeNull();
    expect(decRef!.line).toBe(2);
  });

  it('attributes a method decorator to its enclosing class', () => {
    const src = [
      'function methodDec() { return () => {}; }',
      'class Foo {',
      '  @methodDec()',
      '  bar() {}',
      '}',
    ].join('\n');
    const result = extract(src);
    const fooSym = result.symbols.find((s) => s.name === 'Foo' && s.kind === 'class');
    expect(fooSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'methodDec');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(fooSym!.id);
  });

  it('attributes a field decorator to its enclosing class', () => {
    const src = [
      'function fieldDec() { return () => {}; }',
      'class Foo {',
      '  @fieldDec()',
      '  prop = 1;',
      '}',
    ].join('\n');
    const result = extract(src);
    const fooSym = result.symbols.find((s) => s.name === 'Foo' && s.kind === 'class');
    expect(fooSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'fieldDec');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(fooSym!.id);
  });

  it('finds decorators inside an exported class', () => {
    const src = [
      'function inner() { return () => {}; }',
      'export class Baz {',
      '  @inner()',
      '  m() {}',
      '}',
    ].join('\n');
    const result = extract(src);
    const bazSym = result.symbols.find((s) => s.name === 'Baz' && s.kind === 'class');
    expect(bazSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'inner');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(bazSym!.id);
  });

  it('emits exactly one reference per decorator invocation', () => {
    const src = 'function dec() { return () => {}; }\n@dec()\nclass Foo {}';
    const result = extract(src);
    const decRefs = result.references.filter((r) => r.targetName === 'dec');
    expect(decRefs).toHaveLength(1);
  });

  // class_declaration is in TS_SKIP_TYPES, so walkCalls inside an enclosing
  // function body never reaches a nested class. walkDecorators must run
  // per-body too — otherwise the nested-class decorator's only ref comes
  // from the moduleRoot pass with sourceId=null.
  it('attributes a decorator on a nested class to the enclosing function', () => {
    const src = [
      'function dec() { return () => {}; }',
      'function outer() {',
      '  @dec()',
      '  class Inner {}',
      '  return Inner;',
      '}',
    ].join('\n');
    const result = extract(src);
    const outer = result.symbols.find((s) => s.name === 'outer')!;
    const decRef = result.references.find((r) => r.targetName === 'dec');
    expect(decRef).toBeDefined();
    expect(decRef!.sourceId).toBe(outer.id);
  });

  // Regression guard for the body-level walkDecorators pass: top-level
  // classes/methods aren't in `bodies`, so their decorators must still
  // attribute to module-level.
  it('keeps a top-level class decorator attributed to module-level', () => {
    const src = 'function dec() { return () => {}; }\n@dec()\nclass TopLevel {}';
    const result = extract(src);
    const decRef = result.references.find((r) => r.targetName === 'dec');
    expect(decRef).toBeDefined();
    expect(decRef!.sourceId).toBeNull();
  });

  // walkDecorators skips nested function bodies (mirroring walkCalls'
  // skipTypes behavior). A decorator inside a nested function only fires
  // when that function is invoked, so it must not attribute to the outer
  // function — otherwise calling outer() would falsely register as a
  // caller of dec.
  it('does not attribute a decorator inside a nested function body to the outer function', () => {
    const src = [
      'function dec() { return () => {}; }',
      'function outer() {',
      '  function inner() {',
      '    @dec()',
      '    class Deepest {}',
      '    return Deepest;',
      '  }',
      '  return inner;',
      '}',
    ].join('\n');
    const result = extract(src);
    const outer = result.symbols.find((s) => s.name === 'outer')!;
    const decRefsFromOuter = result.references.filter(
      (r) => r.targetName === 'dec' && r.sourceId === outer.id,
    );
    expect(decRefsFromOuter).toHaveLength(0);
  });
});

describe('typescript extractor — new expression references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a reference for `new X()` to a same-file class', () => {
    const src = 'class Service {}\nfunction boot() { const s = new Service(); return s; }';
    const result = extract(src);
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    const boot = result.symbols.find((s) => s.name === 'boot')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({
      sourceId: boot.id,
      targetId: cls.id,
      targetName: 'Service',
      kind: 'calls',
      file: 'src/test.ts',
      line: 2,
    });
  });

  it('emits a module-level reference for top-level `new X()`', () => {
    const src = 'class Service {}\nconst s = new Service();';
    const result = extract(src);
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    const newRef = result.references.find((r) => r.targetName === 'Service');
    expect(newRef).toBeDefined();
    expect(newRef!.sourceId).toBeNull();
    expect(newRef!.targetId).toBe(cls.id);
  });

  it('skips `new this.X()` (member-expression constructor)', () => {
    const src = 'function f() { return new this.Service(); }';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('skips `new ns.X()` (member-expression constructor)', () => {
    const src = 'function f() { return new ns.Service(); }';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('emits unresolved ref for `new X()` to undefined name', () => {
    const src = 'function f() { return new Unknown(); }';
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.targetName).toBe('Unknown');
    expect(result.references[0]!.targetId).toBeNull();
  });
});

describe('typescript extractor — JSX component references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a reference for `<Cmp />` (self-closing) attributed to enclosing function', () => {
    const src = 'function Cmp() { return null; }\nfunction App() { return <Cmp />; }';
    const result = extract(src, 'tsx', 'src/test.tsx');
    const cmp = result.symbols.find((s) => s.name === 'Cmp')!;
    const app = result.symbols.find((s) => s.name === 'App')!;
    const jsxRef = result.references.find((r) => r.targetName === 'Cmp');
    expect(jsxRef).toBeDefined();
    expect(jsxRef!.sourceId).toBe(app.id);
    expect(jsxRef!.targetId).toBe(cmp.id);
  });

  it('emits exactly one reference for `<Cmp>hi</Cmp>` (paired element)', () => {
    const src = 'function Cmp() { return null; }\nfunction App() { return <Cmp>hi</Cmp>; }';
    const result = extract(src, 'tsx', 'src/test.tsx');
    const refs = result.references.filter((r) => r.targetName === 'Cmp');
    expect(refs).toHaveLength(1);
  });

  it('skips lowercase HTML tags (<div>, <span>)', () => {
    const src = 'function App() { return <div><span>hi</span></div>; }';
    const result = extract(src, 'tsx', 'src/test.tsx');
    expect(result.references).toEqual([]);
  });

  it('skips namespaced JSX (<ns.Cmp />) — member-expression name', () => {
    const src = 'function App() { return <ns.Cmp />; }';
    const result = extract(src, 'tsx', 'src/test.tsx');
    expect(result.references).toEqual([]);
  });

  it('emits a module-level JSX reference (sourceId=null) for top-level usage', () => {
    const src = 'function Cmp() { return null; }\nconst x = <Cmp />;';
    const result = extract(src, 'tsx', 'src/test.tsx');
    const ref = result.references.find((r) => r.targetName === 'Cmp');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBeNull();
  });

  it('does not double-emit between paired JSX and an inner self-closing of the same name', () => {
    const src = 'function Cmp() { return null; }\nfunction App() { return <Cmp><Cmp /></Cmp>; }';
    const result = extract(src, 'tsx', 'src/test.tsx');
    const refs = result.references.filter((r) => r.targetName === 'Cmp');
    expect(refs).toHaveLength(2);
  });
});

describe('typescript extractor — method ID stability across classes', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('produces distinct method ids when two classes share method name and signature', () => {
    const src = 'class A { save() {} }\nclass B { save() {} }';
    const result = extract(src);
    const methods = result.symbols.filter((s) => s.kind === 'method');
    expect(methods).toHaveLength(2);
    expect(methods[0]!.id).not.toBe(methods[1]!.id);
  });
});

describe('typescript extractor — ambient declarations', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts an ambient function declaration', () => {
    const sym = extract('declare function foo(x: number): void;').symbols[0]!;
    expect(sym.name).toBe('foo');
    expect(sym.kind).toBe('function');
    expect(sym.exported).toBe(false);
    expect(sym.signature).toContain('foo');
  });

  it('marks an exported ambient function as exported', () => {
    const sym = extract('export declare function foo(): void;').symbols[0]!;
    expect(sym.name).toBe('foo');
    expect(sym.exported).toBe(true);
  });

  it('extracts an ambient const as a variable', () => {
    const sym = extract('declare const x: number;').symbols[0]!;
    expect(sym.name).toBe('x');
    expect(sym.kind).toBe('variable');
  });

  it('extracts an ambient class with method signatures', () => {
    const result = extract('declare class C { method(): void; }');
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    const method = result.symbols.find((s) => s.kind === 'method')!;
    expect(cls.name).toBe('C');
    expect(method.name).toBe('method');
    expect(method.fqn).toBe('src/test.ts:C.method');
  });
});

describe('typescript extractor — abstract classes', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts an abstract class with abstract and concrete methods', () => {
    const src = 'export abstract class Service { abstract handle(): void; concrete() {} }';
    const result = extract(src);
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    expect(cls.name).toBe('Service');
    expect(cls.exported).toBe(true);
    const methods = result.symbols.filter((s) => s.kind === 'method');
    expect(methods.map((m) => m.name).sort()).toEqual(['concrete', 'handle']);
    const handle = methods.find((m) => m.name === 'handle')!;
    expect(handle.fqn).toBe('src/test.ts:Service.handle');
  });
});

describe('typescript extractor — class field members', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts an arrow-function class field as a method', () => {
    const src = 'function helper() {}\nclass A { save = () => helper(); }';
    const result = extract(src);
    const save = result.symbols.find((s) => s.name === 'save')!;
    expect(save.kind).toBe('method');
    expect(save.fqn).toBe('src/test.ts:A.save');
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.sourceId).toBe(save.id);
    expect(result.references[0]!.targetId).toBe(helper.id);
  });

  it('extracts a non-callable class field as a variable', () => {
    const src = 'class A { count: number = 0; }';
    const sym = extract(src).symbols.find((s) => s.name === 'count')!;
    expect(sym.kind).toBe('variable');
    expect(sym.fqn).toBe('src/test.ts:A.count');
  });
});

describe('typescript extractor — bare decorator references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a module-level reference for a bare class decorator', () => {
    const src = '@injectable\nclass Service {}';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'injectable');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBeNull();
    expect(refs[0]!.kind).toBe('calls');
    expect(refs[0]!.line).toBe(1);
  });

  it('does not double-emit when a decorator is parametrized', () => {
    const src = 'function injectable() { return () => {}; }\n@injectable()\nclass Service {}';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'injectable');
    expect(refs).toHaveLength(1);
  });

  it('emits no reference for a member-expression bare decorator (`@scope.cached`)', () => {
    const src = '@scope.cached\nclass Service {}';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('emits no reference for a member-expression parametrized decorator (`@scope.cached()`)', () => {
    const src = '@scope.cached()\nclass Service {}';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('emits a reference for a bare method decorator inside a class', () => {
    const src = ['class C {', '  @bound', '  m() {}', '}'].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const refs = result.references.filter((r) => r.targetName === 'bound');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBe(cSym!.id);
  });

  it('emits a reference for a bare field decorator', () => {
    const src = ['class C {', '  @observable', '  count = 0;', '}'].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const refs = result.references.filter((r) => r.targetName === 'observable');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBe(cSym!.id);
  });

  it('emits one ref per decorator when bare and parametrized are stacked', () => {
    const src = [
      'function b() { return () => {}; }',
      '@a',
      '@b()',
      'class C {}',
    ].join('\n');
    const result = extract(src);
    const aRefs = result.references.filter((r) => r.targetName === 'a');
    const bRefs = result.references.filter((r) => r.targetName === 'b');
    expect(aRefs).toHaveLength(1);
    expect(bRefs).toHaveLength(1);
  });
});

describe('typescript extractor — class body call extraction', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('attributes a static-block call to the enclosing class', () => {
    const src = [
      'function helper() {}',
      'class C {',
      '  static { helper(); }',
      '}',
    ].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'helper');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(cSym!.id);
  });

  it('attributes a static-field-initializer call to the class', () => {
    const src = [
      'function h() { return 1; }',
      'class C {',
      '  static x = h();',
      '}',
    ].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'h');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(cSym!.id);
  });

  it('attributes an instance-field-initializer call to the class', () => {
    const src = [
      'function h() { return 1; }',
      'class C {',
      '  x = h();',
      '}',
    ].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'h');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(cSym!.id);
  });

  it('still attributes method-body calls to the method, not the class', () => {
    const src = [
      'function h() {}',
      'class C {',
      '  foo() { h(); }',
      '}',
    ].join('\n');
    const result = extract(src);
    const fooSym = result.symbols.find((s) => s.name === 'foo' && s.kind === 'method');
    expect(fooSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'h');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(fooSym!.id);
  });
});
