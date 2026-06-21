import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

// C reuses the C++ extractor wholesale (tree-sitter-c and tree-sitter-cpp produce
// byte-identical ASTs for the C subset). These tests cover what is C-SPECIFIC: the
// file-scope `static` → not-exported gate (C's privacy mechanism), the
// dedicated-grammar parse cases that tree-sitter-cpp gets wrong (K&R functions,
// C++-keyword identifiers), and that the shared struct/enum/typedef/function-pointer
// machinery behaves on `.c` input. The broad extractor behavior is covered by
// cpp.test.ts; the C++-specific constructs (classes/namespaces/templates/::/new/
// operators/extern "C") simply never appear in C.

function extract(src: string, path = 'src/test.c') {
  const tree = parseFile(src, 'c')!;
  return extractSymbols(tree, src, makeFileInfo('c', path));
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

const refTo = (result: Result, targetName: string) =>
  result.references.find((r) => r.targetName === targetName);

beforeAll(async () => {
  await initParser();
});

describe('c extractor — kinds, FQN, exportedness', () => {
  it('extracts a free function with kind/fqn/signature/exported/lines/id/doc/language', () => {
    const r = extract('// Adds two numbers.\nint add(int a, int b) {\n  return a + b;\n}\n');
    const add = byName(r, 'add');
    expect(add).toHaveLength(1);
    const s = add[0]!;
    expect(s.kind).toBe('function');
    expect(s.fqn).toBe('src/test.c:add');
    expect(s.signature).toBe('int add(int a, int b)');
    expect(s.exported).toBe(true);
    expect(s.startLine).toBe(2);
    expect(s.endLine).toBe(4);
    expect(s.file).toBe('src/test.c');
    expect(s.language).toBe('c'); // not 'cpp' — sourced from fileInfo.language
    expect(s.id).toMatch(/^[0-9a-f]{16}$/);
    expect(s.doc).toBe('Adds two numbers.');
  });

  it('struct/union → class kind; enum → enum kind; enumerators are not extracted', () => {
    const r = extract('struct B { int x; };\nunion C { int i; float f; };\nenum Color { RED, GREEN, BLUE };\n');
    expect(byName(r, 'B')[0]!.kind).toBe('class');
    expect(byName(r, 'C')[0]!.kind).toBe('class');
    expect(byName(r, 'Color')[0]!.kind).toBe('enum');
    expect(byName(r, 'RED')).toHaveLength(0);
    expect(byName(r, 'GREEN')).toHaveLength(0);
  });

  it('struct fields are variable members with a Type.field FQN; struct members are exported', () => {
    const r = extract('struct Point { int x; int y; };\n');
    expect(byName(r, 'Point')[0]!.fqn).toBe('src/test.c:Point');
    const x = byName(r, 'x')[0]!;
    expect(x.kind).toBe('variable');
    expect(x.fqn).toBe('src/test.c:Point.x');
    expect(x.exported).toBe(true); // struct has no access specifiers in C — all public
    expect(byName(r, 'y')[0]!.exported).toBe(true);
  });

  it('extracts bitfield struct members as variables with Type.field FQNs', () => {
    const r = extract('struct Flags { unsigned a : 1; unsigned b : 3; int c; };\n');
    expect(byName(r, 'Flags')[0]!.kind).toBe('class');
    expect(byName(r, 'a')[0]!.kind).toBe('variable');
    expect(byName(r, 'a')[0]!.fqn).toBe('src/test.c:Flags.a');
    expect(byName(r, 'b')[0]!.kind).toBe('variable');
    expect(byName(r, 'c')[0]!.kind).toBe('variable');
  });

  it('typedef (plain / struct / function-pointer) is type kind', () => {
    const r = extract(
      'typedef int MyInt;\ntypedef struct Pt { int x; } Point;\ntypedef int (*Callback)(int);\n',
    );
    expect(byName(r, 'MyInt')[0]!.kind).toBe('type');
    // typedef struct emits BOTH the inner record and the alias.
    expect(byName(r, 'Pt')[0]!.kind).toBe('class');
    expect(byName(r, 'Point')[0]!.kind).toBe('type');
    // a function-pointer typedef is an alias, NOT a function.
    expect(byName(r, 'Callback')[0]!.kind).toBe('type');
  });
});

describe('c extractor — file-scope static internal linkage (the one C-specific gate)', () => {
  it('a file-scope static function is NOT exported; a non-static one is', () => {
    const r = extract('static int helper(void) { return 1; }\nint pub(void) { return 2; }\n');
    expect(byName(r, 'helper')[0]!.kind).toBe('function');
    expect(byName(r, 'helper')[0]!.exported).toBe(false);
    expect(byName(r, 'pub')[0]!.exported).toBe(true);
  });

  it('a file-scope static global is NOT exported; a plain global and an extern are', () => {
    const r = extract('static int g_count = 0;\nint g_total = 0;\nextern int shared;\n');
    expect(byName(r, 'g_count')[0]!.kind).toBe('variable');
    expect(byName(r, 'g_count')[0]!.exported).toBe(false);
    expect(byName(r, 'g_total')[0]!.exported).toBe(true);
    expect(byName(r, 'shared')[0]!.exported).toBe(true); // extern = external linkage
  });

  it('a static multi-declarator marks every name not-exported (shared storage class)', () => {
    const r = extract('static int a, b;\nint c, d;\n');
    expect(byName(r, 'a')[0]!.exported).toBe(false);
    expect(byName(r, 'b')[0]!.exported).toBe(false);
    expect(byName(r, 'c')[0]!.exported).toBe(true);
    expect(byName(r, 'd')[0]!.exported).toBe(true);
  });

  it('static survives `static inline` (two storage-class specifiers)', () => {
    const r = extract('static inline int fast(void) { return 0; }\n');
    expect(byName(r, 'fast')[0]!.exported).toBe(false);
  });

  it('a static prototype is a (bodiless) not-exported function', () => {
    const r = extract('static int proto(int);\nint pubProto(int);\n');
    expect(byName(r, 'proto')[0]!.kind).toBe('function');
    expect(byName(r, 'proto')[0]!.exported).toBe(false);
    expect(byName(r, 'pubProto')[0]!.exported).toBe(true);
  });
});

describe('c extractor — function pointers are variables, not functions', () => {
  it('classifies a global / field function pointer as a variable', () => {
    const r = extract('int (*gfp)(int);\nstruct S { int (*cb)(int); };\n');
    expect(byName(r, 'gfp')[0]!.kind).toBe('variable');
    const cb = byName(r, 'cb')[0]!;
    expect(cb.kind).toBe('variable');
    expect(cb.fqn).toBe('src/test.c:S.cb');
  });

  it('keeps a real function returning a pointer as a function', () => {
    const r = extract('int* getPtr(int);\n');
    expect(byName(r, 'getPtr')[0]!.kind).toBe('function');
  });

  it('does not create a wrong-kind edge from a call to a function-pointer field', () => {
    // `s->cb(3)` must NOT resolve to the data member `cb` (a variable): a variable
    // can never be in methodsByClass, so the edge stays unresolved (no wrong-kind).
    const r = extract('struct S { int (*cb)(int); };\nvoid run(struct S* s) { s->cb(3); }\n');
    const ref = refTo(r, 'cb');
    expect(ref).toBeDefined();
    expect(ref!.receiver).toBe('s');
    expect(ref!.targetId).toBeNull();
  });
});

describe('c extractor — imports & call resolution', () => {
  it('#include directives (system + quoted) become imports', () => {
    const r = extract('#include <stdio.h>\n#include "util.h"\nint x;\n');
    expect(r.imports.map((i) => i.sourceModule).sort()).toEqual(['stdio.h', 'util.h']);
  });

  it('resolves a bare call to a free function', () => {
    const r = extract('int helper(void);\nvoid caller(void) { helper(); }\n');
    expect(resolvedTo(r, 'caller', 'helper')).toBe(true);
  });

  it('captures an object member call (-> / .) as an unresolved name-keyed ref with a receiver', () => {
    const r = extract(
      'struct Other { void (*run)(void); };\nvoid use(struct Other* o) { o->run(); }\n',
    );
    const ref = refTo(r, 'run');
    expect(ref).toBeDefined();
    expect(ref!.receiver).toBe('o');
    expect(ref!.targetId).toBeNull(); // run is a fn-ptr field (variable), never a method
  });
});

describe('c extractor — dedicated-grammar parse cases (tree-sitter-cpp gets these wrong)', () => {
  it('parses a K&R old-style function; its parameter declarations are not file-scope globals', () => {
    const r = extract('int sum(a, b)\nint a;\nint b;\n{\n  return a + b;\n}\n');
    expect(byName(r, 'sum')[0]!.kind).toBe('function');
    expect(byName(r, 'sum')[0]!.exported).toBe(true);
    // The K&R parameter declarations are clamped out of the signature.
    expect(byName(r, 'sum')[0]!.signature).toBe('int sum(a, b)');
    // The `int a;` / `int b;` K&R param decls are CHILDREN of function_definition,
    // not translation_unit siblings — so they must NOT appear as globals.
    expect(byName(r, 'a')).toHaveLength(0);
    expect(byName(r, 'b')).toHaveLength(0);
  });

  it('parses C code that uses C++ keywords as identifiers (function named `new`, param `delete`)', () => {
    const r = extract('int new(int delete) { return delete; }\n');
    const fn = byName(r, 'new');
    expect(fn).toHaveLength(1);
    expect(fn[0]!.kind).toBe('function');
  });

  it('parses a struct with a field named with a C++ keyword (`operator`)', () => {
    const r = extract('struct T { int operator; };\n');
    expect(byName(r, 'T')[0]!.kind).toBe('class');
    expect(byName(r, 'operator')[0]!.kind).toBe('variable');
  });

  it('an anonymous struct member does not produce a nameless/degenerate symbol', () => {
    const r = extract('struct Outer { struct { int hidden; }; int z; };\n');
    expect(byName(r, 'Outer')[0]!.kind).toBe('class');
    expect(byName(r, 'z')[0]!.kind).toBe('variable');
    expect(r.symbols.every((s) => s.name !== '')).toBe(true);
    expect(r.symbols.every((s) => s.fqn !== 'src/test.c:')).toBe(true);
  });

  it('an anonymous union member (C11) does not produce a nameless/degenerate symbol', () => {
    const r = extract('struct V { union { int i; float f; }; int tag; };\n');
    expect(byName(r, 'V')[0]!.kind).toBe('class');
    expect(byName(r, 'tag')[0]!.kind).toBe('variable');
    expect(r.symbols.every((s) => s.name !== '')).toBe(true);
    expect(r.symbols.every((s) => s.fqn !== 'src/test.c:')).toBe(true);
  });
});

describe('c extractor — id hygiene', () => {
  it('produces unique 16-hex ids across functions, prototypes, structs, and fields', () => {
    const r = extract(
      'int f(int);\nint f(int x) { return x; }\nstruct S { int a; int b; };\nstatic int g(void) { return 0; }\n',
    );
    const ids = r.symbols.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^[0-9a-f]{16}$/.test(id))).toBe(true);
  });
});
