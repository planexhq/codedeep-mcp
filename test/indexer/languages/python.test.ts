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
      importedNames: [{ name: 'os' }],
      line: 1,
    });
  });

  it('extracts aliased import', () => {
    const result = extract('import numpy as np\n');
    expect(result.imports[0]!.sourceModule).toBe('numpy');
    expect(result.imports[0]!.importedNames).toEqual([{ name: 'numpy', alias: 'np' }]);
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
      kind: 'calls',
      file: 'src/test.py',
      line: 3,
    });
  });

  it('skips attribute calls (obj.method())', () => {
    const src = 'def caller():\n    obj.method()\n';
    const result = extract(src);
    expect(result.references).toEqual([]);
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
