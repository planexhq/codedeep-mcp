import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, path = 'src/test.py') {
  const tree = parseFile(src, 'python')!;
  return extractSymbols(tree, src, makeFileInfo('python', path));
}

describe('python extractor — functions and classes', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts a top-level function', () => {
    const sym = extract('def foo(x: int) -> int:\n    return x\n').symbols[0]!;
    expect(sym.name).toBe('foo');
    expect(sym.kind).toBe('function');
    expect(sym.fqn).toBe('src/test.py:foo');
    expect(sym.signature).toBe('def foo(x: int) -> int:');
    expect(sym.startLine).toBe(1);
    expect(sym.endLine).toBe(2);
    expect(sym.exported).toBe(true);
  });

  it('marks underscore-prefixed names as not exported', () => {
    const result = extract('def _private(): pass\ndef public(): pass\n');
    const priv = result.symbols.find((s) => s.name === '_private')!;
    const pub = result.symbols.find((s) => s.name === 'public')!;
    expect(priv.exported).toBe(false);
    expect(pub.exported).toBe(true);
  });

  it('extracts a class with methods and proper FQNs', () => {
    const src = [
      'class User:',
      '    def __init__(self, name: str):',
      '        self.name = name',
      '    def greet(self) -> str:',
      '        return f"Hello, {self.name}"',
      '',
    ].join('\n');
    const result = extract(src);
    expect(result.symbols).toHaveLength(3);
    const cls = result.symbols.find((s) => s.kind === 'class')!;
    expect(cls.name).toBe('User');
    expect(cls.fqn).toBe('src/test.py:User');
    expect(cls.signature).toBe('class User:');

    const init = result.symbols.find((s) => s.name === '__init__')!;
    expect(init.kind).toBe('method');
    expect(init.fqn).toBe('src/test.py:User.__init__');
    expect(init.signature).toBe('def __init__(self, name: str):');

    const greet = result.symbols.find((s) => s.name === 'greet')!;
    expect(greet.fqn).toBe('src/test.py:User.greet');
    expect(greet.signature).toBe('def greet(self) -> str:');
  });

  it('extracts a docstring as the first non-empty line', () => {
    const src = 'def add(a, b):\n    """Sum two numbers.\n\n    Returns the sum.\n    """\n    return a + b\n';
    const sym = extract(src).symbols[0]!;
    expect(sym.doc).toBe('Sum two numbers.');
  });

  it('extracts a single-line docstring', () => {
    const src = 'def add(a, b):\n    """Sum."""\n    return a + b\n';
    const sym = extract(src).symbols[0]!;
    expect(sym.doc).toBe('Sum.');
  });

  it('returns null doc when first body statement is not a string', () => {
    const sym = extract('def add(a, b):\n    return a + b\n').symbols[0]!;
    expect(sym.doc).toBeNull();
  });
});

describe('python extractor — decorators', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('includes decorators in the function signature', () => {
    const src = '@decorator\ndef foo():\n    pass\n';
    const sym = extract(src).symbols[0]!;
    expect(sym.kind).toBe('function');
    expect(sym.signature).toBe('@decorator def foo():');
    expect(sym.startLine).toBe(1);
  });

  it('includes multiple decorators in the signature', () => {
    const src = '@app.route("/")\n@login_required\ndef home():\n    pass\n';
    const sym = extract(src).symbols[0]!;
    expect(sym.signature).toBe('@app.route("/") @login_required def home():');
  });

  it('handles decorated methods inside a class', () => {
    const src = [
      'class A:',
      '    @staticmethod',
      '    def helper():',
      '        pass',
      '',
    ].join('\n');
    const result = extract(src);
    const method = result.symbols.find((s) => s.kind === 'method')!;
    expect(method.name).toBe('helper');
    expect(method.fqn).toBe('src/test.py:A.helper');
    expect(method.signature).toBe('@staticmethod def helper():');
  });

  it('emits exactly one reference for a parametrized decorator (no double-emit)', () => {
    const src = '@route("/")\ndef home():\n    pass\n';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'route');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBeNull();
  });

  it('emits exactly one reference for a parametrized class decorator', () => {
    const src = '@register("svc")\nclass Svc:\n    pass\n';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'register');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBeNull();
  });
});

describe('python extractor — __all__ and exports', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('honors __all__ when present', () => {
    const src = [
      "__all__ = ['authenticate']",
      '',
      'def authenticate(): pass',
      'def _helper(): pass',
      'def utility(): pass',
      '',
    ].join('\n');
    const result = extract(src);
    const auth = result.symbols.find((s) => s.name === 'authenticate')!;
    const helper = result.symbols.find((s) => s.name === '_helper')!;
    const util = result.symbols.find((s) => s.name === 'utility')!;
    expect(auth.exported).toBe(true);
    expect(helper.exported).toBe(false);
    expect(util.exported).toBe(false);
  });

  it('does not emit __all__ itself as a symbol', () => {
    const src = "__all__ = ['foo']\ndef foo(): pass\n";
    const result = extract(src);
    expect(result.symbols.find((s) => s.name === '__all__')).toBeUndefined();
  });
});

describe('python extractor — module-level variables', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts simple module-level assignments as variable kind', () => {
    const result = extract('SALT_ROUNDS = 10\n');
    expect(result.symbols).toHaveLength(1);
    const sym = result.symbols[0]!;
    expect(sym.name).toBe('SALT_ROUNDS');
    expect(sym.kind).toBe('variable');
    expect(sym.signature).toBe('SALT_ROUNDS = 10');
    expect(sym.exported).toBe(true);
  });

  it('skips destructured assignments (tuple unpacking)', () => {
    const result = extract('a, b = 1, 2\n');
    expect(result.symbols).toEqual([]);
  });
});

describe('python extractor — imports', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('extracts plain import', () => {
    const result = extract('import os\n');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]).toEqual({
      file: 'src/test.py',
      sourceModule: 'os',
      importedNames: [{ name: 'os', kind: 'module' }],
      line: 1,
    });
  });

  it('extracts aliased import', () => {
    const result = extract('import numpy as np\n');
    expect(result.imports[0]!.sourceModule).toBe('numpy');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'numpy', alias: 'np', kind: 'module' },
    ]);
  });

  it('extracts multi-import as separate ImportInfo records', () => {
    const result = extract('import os, sys\n');
    expect(result.imports).toHaveLength(2);
    expect(result.imports.map((i) => i.sourceModule).sort()).toEqual(['os', 'sys']);
  });

  it('extracts from-import with multiple names', () => {
    const result = extract('from .utils import hash_password, verify_token\n');
    expect(result.imports).toHaveLength(1);
    expect(result.imports[0]!.sourceModule).toBe('.utils');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'hash_password' },
      { name: 'verify_token' },
    ]);
  });

  it('extracts from-import with alias', () => {
    const result = extract('from os.path import join as j\n');
    expect(result.imports[0]!.sourceModule).toBe('os.path');
    expect(result.imports[0]!.importedNames).toEqual([{ name: 'join', alias: 'j' }]);
  });

  it('extracts wildcard from-import', () => {
    const result = extract('from .helpers import *\n');
    expect(result.imports[0]!.importedNames).toEqual([{ name: '*' }]);
  });

  it('marks `from . import utils` as kind=module', () => {
    const result = extract('from . import utils\n');
    expect(result.imports[0]!.sourceModule).toBe('.');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'utils', kind: 'module' },
    ]);
  });

  it('marks `from .. import sub` (multi-dot bare) as kind=module', () => {
    const result = extract('from .. import sub\n');
    expect(result.imports[0]!.sourceModule).toBe('..');
    expect(result.imports[0]!.importedNames).toEqual([
      { name: 'sub', kind: 'module' },
    ]);
  });

  it('does not mark `from .pkg import name` as kind=module (named submodule import is a value)', () => {
    const result = extract('from .pkg import name\n');
    expect(result.imports[0]!.sourceModule).toBe('.pkg');
    expect(result.imports[0]!.importedNames).toEqual([{ name: 'name' }]);
  });
});

describe('python extractor — within-file calls', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a reference for a bare-identifier call to a top-level function', () => {
    const src = 'def helper(): pass\ndef caller():\n    helper()\n';
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const caller = result.symbols.find((s) => s.name === 'caller')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({
      sourceId: caller.id,
      targetId: helper.id,
      targetName: 'helper',
      kind: 'calls',
      file: 'src/test.py',
      line: 3,
    });
  });

  it('emits an unresolved member ref with receiver for obj.method()', () => {
    const src = 'def caller():\n    obj.method()\n';
    const result = extract(src);
    const caller = result.symbols.find((s) => s.name === 'caller')!;
    expect(result.references).toEqual([
      {
        sourceId: caller.id,
        targetId: null,
        targetName: 'method',
        kind: 'calls',
        file: 'src/test.py',
        line: 2,
        receiver: 'obj',
      },
    ]);
  });

  it('resolves self.helper() to the sibling method of the enclosing class', () => {
    const src = [
      'class Service:',
      '    def helper(self): pass',
      '    def run(self):',
      '        self.helper()',
      '',
    ].join('\n');
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const run = result.symbols.find((s) => s.name === 'run')!;
    expect(result.references).toEqual([
      {
        sourceId: run.id,
        targetId: helper.id,
        targetName: 'helper',
        kind: 'calls',
        file: 'src/test.py',
        line: 4,
        receiver: 'self',
        selfReceiver: true,
      },
    ]);
  });

  it('resolves cls.helper() inside a classmethod', () => {
    const src = [
      'class Service:',
      '    def helper(cls): pass',
      '    @classmethod',
      '    def build(cls):',
      '        cls.helper()',
      '',
    ].join('\n');
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const clsRef = result.references.find((r) => r.receiver === 'cls')!;
    expect(clsRef.targetId).toBe(helper.id);
    expect(clsRef.targetName).toBe('helper');
  });

  it('resolves ClassName.method() against a same-file class', () => {
    const src = [
      'class Factory:',
      '    def create(self): pass',
      'def caller():',
      '    Factory.create()',
      '',
    ].join('\n');
    const result = extract(src);
    const create = result.symbols.find((s) => s.name === 'create')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.targetId).toBe(create.id);
    expect(result.references[0]!.receiver).toBe('Factory');
  });

  it('leaves self.x() unresolved when x is not a method of the class', () => {
    const src = [
      'class Store:',
      '    def load(self):',
      '        self.refresh()',
      '',
    ].join('\n');
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.targetId).toBeNull();
    expect(result.references[0]!.receiver).toBe('self');
  });

  it('does not flag self.x() in a plain function as a self-receiver', () => {
    // `self` is only special as a method's first parameter; in a plain
    // function it is an ordinary variable, and the ref must stay an
    // ordinary member ref (weak name-match evidence) instead of being
    // rejected by isCallerOf's inherited-method rule.
    const src = 'def handler(self):\n    self.process()\n';
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.receiver).toBe('self');
    expect(result.references[0]!.selfReceiver).toBeUndefined();
  });

  it('skips super().method() and chained attribute calls', () => {
    const src = [
      'class Child(Base):',
      '    def render(self):',
      '        super().render()',
      '        a.b.c()',
      '',
    ].join('\n');
    const result = extract(src);
    // super() itself is a bare call and still emits; the .render() and
    // a.b.c() attribute chains do not.
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.targetName).toBe('super');
  });

  it('attributes self-calls inside a decorated method to the method', () => {
    const src = [
      'class Service:',
      '    def helper(self): pass',
      '    @retry',
      '    def run(self):',
      '        self.helper()',
      '',
    ].join('\n');
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const run = result.symbols.find((s) => s.name === 'run')!;
    const selfRef = result.references.find((r) => r.receiver === 'self')!;
    expect(selfRef.sourceId).toBe(run.id);
    expect(selfRef.targetId).toBe(helper.id);
  });

  it('attributes calls inside a method to the method', () => {
    const src = [
      'def helper(): pass',
      'class A:',
      '    def method(self):',
      '        helper()',
      '',
    ].join('\n');
    const result = extract(src);
    const helper = result.symbols.find((s) => s.name === 'helper')!;
    const method = result.symbols.find((s) => s.kind === 'method')!;
    expect(result.references).toHaveLength(1);
    expect(result.references[0]!.sourceId).toBe(method.id);
    expect(result.references[0]!.targetId).toBe(helper.id);
  });

  it('does not throw on syntactically broken input', () => {
    const result = extract('def broken(:\n    pass\n');
    expect(result.symbols).toBeDefined();
    expect(result.references).toEqual([]);
    expect(result.imports).toEqual([]);
  });

  it('does not attribute calls inside nested defs to the outer function', () => {
    const src = [
      'def helper(): pass',
      'def outer():',
      '    def inner():',
      '        helper()',
      '',
    ].join('\n');
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('does not attribute calls inside lambdas to the enclosing function', () => {
    const src = [
      'def helper(x): return x',
      'def outer():',
      '    cb = lambda x: helper(x)',
      '    return cb',
      '',
    ].join('\n');
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('emits a module-level reference (sourceId=null) for top-level calls', () => {
    const src = 'from auth import authenticate\nauthenticate(req)\n';
    const result = extract(src);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toEqual({
      sourceId: null,
      targetId: null,
      targetName: 'authenticate',
      kind: 'calls',
      file: 'src/test.py',
      line: 2,
    });
  });
});

describe('python extractor — method ID stability across classes', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('produces distinct ids for __init__ on two different classes', () => {
    const src = [
      'class A:',
      '    def __init__(self): pass',
      'class B:',
      '    def __init__(self): pass',
      '',
    ].join('\n');
    const result = extract(src);
    const inits = result.symbols.filter((s) => s.name === '__init__');
    expect(inits).toHaveLength(2);
    expect(inits[0]!.id).not.toBe(inits[1]!.id);
  });
});

describe('python extractor — bare decorator references', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('emits a module-level reference for a bare class decorator', () => {
    const src = '@dataclass\nclass Foo:\n    pass\n';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'dataclass');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBeNull();
    expect(refs[0]!.kind).toBe('calls');
    expect(refs[0]!.line).toBe(1);
  });

  it('emits a module-level reference for a bare function decorator', () => {
    const src = '@login_required\ndef view():\n    pass\n';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'login_required');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBeNull();
  });

  it('does not double-emit when a decorator is parametrized', () => {
    const src = 'def dataclass(): pass\n@dataclass()\nclass Foo:\n    pass\n';
    const result = extract(src);
    const refs = result.references.filter((r) => r.targetName === 'dataclass');
    expect(refs).toHaveLength(1);
  });

  it('emits no reference for an attribute-form decorator (`@my.dec`)', () => {
    const src = '@my.dec\ndef f():\n    pass\n';
    const result = extract(src);
    expect(result.references).toEqual([]);
  });

  it('emits a reference for a bare method decorator inside a class', () => {
    const src = ['class C:', '    @staticmethod', '    def m(): pass', ''].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const refs = result.references.filter((r) => r.targetName === 'staticmethod');
    expect(refs).toHaveLength(1);
    expect(refs[0]!.sourceId).toBe(cSym!.id);
  });

  // walkDecorators skips nested function bodies (and lambdas). A
  // decorator inside a nested def only fires when that def is invoked,
  // so attributing it to the enclosing function would falsely register
  // outer() as a caller of dataclass.
  it('does not attribute a decorator inside a nested def to the outer function', () => {
    const src = [
      'def outer():',
      '    def inner():',
      '        @dataclass',
      '        class Deepest: pass',
      '        return Deepest',
      '    return inner',
      '',
    ].join('\n');
    const result = extract(src);
    const outer = result.symbols.find((s) => s.name === 'outer')!;
    const refsFromOuter = result.references.filter(
      (r) => r.targetName === 'dataclass' && r.sourceId === outer.id,
    );
    expect(refsFromOuter).toHaveLength(0);
  });
});

describe('python extractor — class body call extraction', () => {
  beforeAll(async () => {
    await initParser();
  });

  it('attributes a class-body assignment call to the class', () => {
    const src = ['def h(): pass', 'class C:', '    x = h()', ''].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'h');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(cSym!.id);
  });

  it('attributes a bare class-body call to the class', () => {
    const src = ['def h(): pass', 'class C:', '    h()', ''].join('\n');
    const result = extract(src);
    const cSym = result.symbols.find((s) => s.name === 'C' && s.kind === 'class');
    expect(cSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'h');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(cSym!.id);
  });

  it('still attributes method-body calls to the method, not the class', () => {
    const src = [
      'def h(): pass',
      'class C:',
      '    def foo(self):',
      '        h()',
      '',
    ].join('\n');
    const result = extract(src);
    const fooSym = result.symbols.find((s) => s.name === 'foo' && s.kind === 'method');
    expect(fooSym).toBeDefined();
    const ref = result.references.find((r) => r.targetName === 'h');
    expect(ref).toBeDefined();
    expect(ref!.sourceId).toBe(fooSym!.id);
  });
});
