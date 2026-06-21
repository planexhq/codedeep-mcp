import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

function extract(src: string, path = 'src/test.rb') {
  const tree = parseFile(src, 'ruby')!;
  return extractSymbols(tree, src, makeFileInfo('ruby', path));
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

beforeAll(async () => {
  await initParser();
});

describe('ruby extractor — types & members', () => {
  it('extracts a class with kind/fqn/signature/exported/lines/id', () => {
    const result = extract(`class Widget\nend\n`);
    const sym = byName(result, 'Widget')[0]!;
    expect(sym.kind).toBe('class');
    expect(sym.fqn).toBe('src/test.rb:Widget');
    expect(sym.signature).toBe('class Widget');
    expect(sym.exported).toBe(true);
    expect(sym.startLine).toBe(1);
    expect(sym.language).toBe('ruby');
    expect(sym.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps the superclass in the class signature', () => {
    const result = extract(`class Dog < Animal\nend\n`);
    expect(byName(result, 'Dog')[0]!.signature).toBe('class Dog < Animal');
  });

  it('module → module kind', () => {
    const result = extract(`module Greeting\nend\n`);
    expect(byName(result, 'Greeting')[0]!.kind).toBe('module');
  });

  it('instance def → method with file:Class.name FQN; top-level def → function', () => {
    const result = extract(`def helper\nend\nclass C\n  def run\n  end\nend\n`);
    expect(byName(result, 'helper')[0]!.kind).toBe('function');
    expect(byName(result, 'helper')[0]!.fqn).toBe('src/test.rb:helper');
    const run = byName(result, 'run')[0]!;
    expect(run.kind).toBe('method');
    expect(run.fqn).toBe('src/test.rb:C.run');
  });

  it('def self.x → method keyed on the enclosing class', () => {
    const result = extract(`class C\n  def self.build\n  end\nend\n`);
    const sym = byName(result, 'build')[0]!;
    expect(sym.kind).toBe('method');
    expect(sym.fqn).toBe('src/test.rb:C.build');
  });

  it('class << self methods → class methods of the enclosing class', () => {
    const result = extract(`class C\n  class << self\n    def make\n    end\n  end\nend\n`);
    expect(byName(result, 'make')[0]!.fqn).toBe('src/test.rb:C.make');
  });

  it('def obj.x on an arbitrary object is skipped', () => {
    const result = extract(`obj = Object.new\ndef obj.singleton\nend\n`);
    expect(byName(result, 'singleton')).toHaveLength(0);
  });

  it('predicate/bang/setter/operator method names keep their suffix', () => {
    const result = extract(
      `class C\n  def valid?\n  end\n  def save!\n  end\n  def name=(v)\n  end\n  def +(o)\n  end\nend\n`,
    );
    expect(byName(result, 'valid?')[0]!.kind).toBe('method');
    expect(byName(result, 'save!')[0]!.kind).toBe('method');
    expect(byName(result, 'name=')[0]!.kind).toBe('method');
    expect(byName(result, '+')[0]!.kind).toBe('method');
  });

  it('attr_accessor/reader/writer synthesize one method per symbol', () => {
    const result = extract(`class C\n  attr_accessor :name, :age\n  attr_reader :id\nend\n`);
    expect(byName(result, 'name')[0]!.kind).toBe('method');
    expect(byName(result, 'name')[0]!.fqn).toBe('src/test.rb:C.name');
    expect(byName(result, 'age')[0]!.kind).toBe('method');
    expect(byName(result, 'id')[0]!.kind).toBe('method');
  });

  it('Capitalized constant assignment → variable; locals/ivars are not symbols', () => {
    const result = extract(`TOP = 1\nclass C\n  MAX = 9\n  @x = 2\n  y = 3\nend\n`);
    expect(byName(result, 'TOP')[0]!.kind).toBe('variable');
    expect(byName(result, 'TOP')[0]!.fqn).toBe('src/test.rb:TOP');
    expect(byName(result, 'MAX')[0]!.fqn).toBe('src/test.rb:C.MAX');
    expect(byName(result, 'y')).toHaveLength(0);
  });
});

describe('ruby extractor — visibility (stateful positional)', () => {
  it('a bare `private` flips visibility for following defs; `public` flips back', () => {
    const result = extract(
      `class C\n  def a\n  end\n  private\n  def b\n  end\n  public\n  def c\n  end\nend\n`,
    );
    expect(byName(result, 'a')[0]!.exported).toBe(true);
    expect(byName(result, 'b')[0]!.exported).toBe(false);
    expect(byName(result, 'c')[0]!.exported).toBe(true);
  });

  it('protected counts as exported (inheritance API)', () => {
    const result = extract(`class C\n  protected\n  def p\n  end\nend\n`);
    expect(byName(result, 'p')[0]!.exported).toBe(true);
  });

  it('`private :sym` retroactively marks an already-defined method private', () => {
    const result = extract(`class C\n  def secret\n  end\n  private :secret\nend\n`);
    expect(byName(result, 'secret')[0]!.exported).toBe(false);
  });

  it('`private def foo` marks just that def private without flipping the running state', () => {
    const result = extract(
      `class C\n  private def hidden\n  end\n  def shown\n  end\nend\n`,
    );
    expect(byName(result, 'hidden')[0]!.exported).toBe(false);
    expect(byName(result, 'shown')[0]!.exported).toBe(true);
  });

  it('visibility resets to public per class body (a nested/reopened class)', () => {
    const result = extract(
      `class A\n  private\n  def x\n  end\nend\nclass B\n  def y\n  end\nend\n`,
    );
    expect(byName(result, 'x')[0]!.exported).toBe(false);
    expect(byName(result, 'y')[0]!.exported).toBe(true);
  });

  it('top-level defs are always exported (no class visibility state)', () => {
    const result = extract(`def top\nend\n`);
    expect(byName(result, 'top')[0]!.exported).toBe(true);
  });

  it('visibility resets to public inside a nested singleton_class body', () => {
    // `private` in the enclosing class must NOT leak into `class << self` (a fresh
    // body scope); the instance def after it stays private.
    const result = extract(
      `class C\n  private\n  class << self\n    def cls_method\n    end\n  end\n  def inst_method\n  end\nend\n`,
    );
    expect(byName(result, 'cls_method')[0]!.exported).toBe(true);
    expect(byName(result, 'inst_method')[0]!.exported).toBe(false);
  });
});

describe('ruby extractor — calls & construction', () => {
  it('Foo.new resolves to the class (construction routing)', () => {
    const result = extract(`class Foo\nend\ndef make\n  Foo.new(1)\nend\n`);
    expect(resolvedTo(result, 'make', 'Foo')).toBe(true);
  });

  it('A::B.new resolves to the scoped class by simple name', () => {
    const result = extract(`class B\nend\ndef make\n  Mod::B.new\nend\n`);
    expect(resolvedTo(result, 'make', 'B')).toBe(true);
  });

  it('a bare call with args binds to a top-level function', () => {
    const result = extract(`def helper(x)\nend\ndef run\n  helper(1)\nend\n`);
    expect(resolvedTo(result, 'run', 'helper')).toBe(true);
  });

  it('an implicit-self call (with parens) binds to a sibling method', () => {
    const result = extract(`class C\n  def setup\n  end\n  def run\n    setup()\n  end\nend\n`);
    expect(resolvedTo(result, 'run', 'setup')).toBe(true);
  });

  it('a member call on a local receiver is captured but unresolved (no class collision)', () => {
    const result = extract(`def run(obj)\n  obj.process(1)\nend\n`);
    const ref = result.references.find((r) => r.targetName === 'process');
    expect(ref).toBeDefined();
    expect(ref!.targetId).toBeNull();
    expect(ref!.receiver).toBe('obj');
  });

  it('super and yield emit no reference', () => {
    const result = extract(`class C < B\n  def run\n    super(1)\n    yield 2\n  end\nend\n`);
    expect(hasRef(result, 'super')).toBe(false);
    expect(hasRef(result, 'yield')).toBe(false);
  });

  it('calls inside a block attribute to the enclosing method', () => {
    const result = extract(
      `def helper(x)\nend\ndef run(items)\n  items.each do |i|\n    helper(i)\n  end\nend\n`,
    );
    expect(resolvedTo(result, 'run', 'helper')).toBe(true);
  });

  it('require/require_relative → imports', () => {
    const result = extract(`require 'set'\nrequire_relative '../lib/foo'\n`);
    const mods = result.imports.map((i) => i.sourceModule).sort();
    expect(mods).toEqual(['../lib/foo', 'set']);
  });
});
