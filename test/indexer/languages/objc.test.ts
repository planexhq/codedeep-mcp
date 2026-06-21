import { beforeAll, describe, expect, it } from 'vitest';

import { extractSymbols } from '../../../src/indexer/extractor.js';
import { initParser, parseFile } from '../../../src/indexer/parser.js';
import { makeFileInfo } from '../../helpers.js';

// Objective-C is a C SUPERSET: objc.ts reuses cpp.ts's C-subset machinery (the
// static-linkage gate, struct/enum/typedef/function extraction, `#import`, the
// `->`/`::` member-call reader) and implements the OO surface itself. These tests
// cover what is OBJC-SPECIFIC: the @interface/@implementation/@protocol/@property/
// category surface, the FULL-SELECTOR method naming + the byte-identical call-side
// match, message-send resolution (self/class/instance/super), the cross-file decl/def
// split, the no-implicit-this divergence from cpp, and the NS_ASSUME_NONNULL
// neutralizer. The C-subset behavior is covered by cpp.test.ts / c.test.ts.

function extract(src: string, path = 'src/Greeter.m') {
  const tree = parseFile(src, 'objc')!;
  return extractSymbols(tree, src, makeFileInfo('objc', path));
}

type Result = ReturnType<typeof extract>;

const byName = (r: Result, name: string) => r.symbols.filter((s) => s.name === name);
const sym = (r: Result, name: string) => byName(r, name)[0];

// True iff a `sourceName` body has a resolved `calls` edge to `targetName`.
const resolvedTo = (r: Result, sourceName: string, targetName: string) => {
  const src = sym(r, sourceName);
  const tgt = sym(r, targetName);
  if (!src || !tgt) return false;
  return r.references.some((ref) => ref.sourceId === src.id && ref.targetId === tgt.id);
};

const refTo = (r: Result, targetName: string) =>
  r.references.find((ref) => ref.targetName === targetName);

beforeAll(async () => {
  await initParser();
});

describe('objc extractor — kinds, FQN, exportedness', () => {
  it('extracts @interface as a class, @property as a variable, methods as methods', () => {
    const r = extract(
      `@interface Greeter : NSObject <NSCopying>\n` +
        `@property (nonatomic, strong) NSString *name;\n` +
        `- (void)draw;\n` +
        `+ (instancetype)shared;\n` +
        `@end`,
      'src/Greeter.h',
    );
    const cls = sym(r, 'Greeter');
    expect(cls.kind).toBe('class');
    expect(cls.fqn).toBe('src/Greeter.h:Greeter');
    expect(cls.exported).toBe(true);
    expect(cls.signature).toContain('@interface Greeter : NSObject');

    const prop = sym(r, 'name');
    expect(prop.kind).toBe('variable');
    expect(prop.fqn).toBe('src/Greeter.h:Greeter.name');

    expect(sym(r, 'draw').kind).toBe('method');
    expect(sym(r, 'draw').fqn).toBe('src/Greeter.h:Greeter.draw');
    // A `+` class method is the SAME kind (Ruby def-self precedent), keyed on the class.
    expect(sym(r, 'shared').kind).toBe('method');
    expect(sym(r, 'shared').fqn).toBe('src/Greeter.h:Greeter.shared');
  });

  it('extracts @protocol as an interface with declaration-only members', () => {
    const r = extract(
      `@protocol Drawable <NSObject>\n@required\n- (void)render;\n` +
        `@property (readonly) int z;\n@optional\n- (void)willRender;\n@end`,
      'src/Drawable.h',
    );
    const p = sym(r, 'Drawable');
    expect(p.kind).toBe('interface');
    expect(p.fqn).toBe('src/Drawable.h:Drawable');
    // Members under @required AND @optional blocks are both reached.
    expect(sym(r, 'render').fqn).toBe('src/Drawable.h:Drawable.render');
    expect(sym(r, 'willRender').fqn).toBe('src/Drawable.h:Drawable.willRender');
    expect(sym(r, 'z').kind).toBe('variable');
  });

  it('file-scope C `static` is not exported; a non-static free function is (the C gate)', () => {
    const r = extract(`static int gCount = 0;\nint bump(void) { return ++gCount; }\nstatic void helper(void) { }`);
    expect(sym(r, 'gCount').exported).toBe(false);
    expect(sym(r, 'gCount').kind).toBe('variable');
    expect(sym(r, 'bump').exported).toBe(true);
    expect(sym(r, 'bump').kind).toBe('function');
    expect(sym(r, 'helper').exported).toBe(false);
  });

  it('does not extract ivars or enum members; @class / @protocol forward decls are skipped', () => {
    const r = extract(
      `@class Other;\n@protocol Fwd;\n` +
        `@interface C : NSObject {\n  int _hidden;\n}\n- (void)m;\n@end`,
      'src/C.h',
    );
    // ivar `_hidden` is NOT a symbol (v1 — private implementation detail).
    expect(byName(r, '_hidden')).toHaveLength(0);
    // forward declarations emit no symbol.
    expect(byName(r, 'Other')).toHaveLength(0);
    expect(byName(r, 'Fwd')).toHaveLength(0);
    expect(sym(r, 'C').kind).toBe('class');
    expect(sym(r, 'm').kind).toBe('method');
  });
});

describe('objc extractor — selector naming (the byte-identity invariant)', () => {
  it('names methods by the FULL selector: no-arg, one-arg, multi-arg, class method', () => {
    const r = extract(
      `@implementation C\n` +
        `- (void)draw { }\n` +
        `- (id)initWithName:(NSString *)n { return self; }\n` +
        `- (id)initWithName:(NSString *)n age:(int)a { return self; }\n` +
        `+ (instancetype)sharedInstance { return nil; }\n` +
        `+ (id)greeterWithName:(NSString *)n { return nil; }\n` +
        `@end`,
    );
    expect(byName(r, 'draw')).toHaveLength(1); // no-arg: colon-free
    expect(byName(r, 'initWithName:')).toHaveLength(1); // one arg: one trailing colon
    expect(byName(r, 'initWithName:age:')).toHaveLength(1); // two args: two colons
    expect(byName(r, 'sharedInstance')).toHaveLength(1);
    expect(byName(r, 'greeterWithName:')).toHaveLength(1);
  });

  it('resolves a self-send, a multi-arg self-send, and a class-send to the right method', () => {
    const r = extract(
      `@implementation C\n` +
        `- (void)go {\n` +
        `  [self draw];\n` +
        `  [self initWithName:@"a" age:5];\n` +
        `  [C sharedInstance];\n` +
        `}\n` +
        `- (void)draw { }\n` +
        `- (id)initWithName:(NSString *)n age:(int)a { return self; }\n` +
        `+ (instancetype)sharedInstance { return nil; }\n` +
        `@end`,
    );
    expect(resolvedTo(r, 'go', 'draw')).toBe(true);
    expect(resolvedTo(r, 'go', 'initWithName:age:')).toBe(true);
    expect(resolvedTo(r, 'go', 'sharedInstance')).toBe(true);
  });

  it('a unary message and a one-keyword message are distinct selectors', () => {
    // `[x setObject:y forKey:z]` → setObject:forKey: ; `[x count]` → count
    const r = extract(
      `@implementation C\n- (void)go { [self setObject:nil forKey:nil]; [self count]; }\n` +
        `- (void)setObject:(id)o forKey:(id)k { }\n- (int)count { return 0; }\n@end`,
    );
    expect(resolvedTo(r, 'go', 'setObject:forKey:')).toBe(true);
    expect(resolvedTo(r, 'go', 'count')).toBe(true);
  });
});

describe('objc extractor — message-send resolution', () => {
  it('super and instance sends do not resolve; bare C calls do (no implicit-this)', () => {
    const r = extract(
      `int helper(void) { return 1; }\n` +
        `@implementation C\n- (void)go {\n` +
        `  [super draw];\n` + // super → dropped (no ref)
        `  [other greet];\n` + // instance send → unresolved-but-findable
        `  helper();\n` + // bare C call → resolves to the free function
        `  sibling();\n` + // bare call is a FREE function, NEVER an implicit-self method
        `}\n- (void)draw { }\n- (void)sibling { }\n@end`,
    );
    // super dispatch emits no reference at all.
    expect(r.references.some((ref) => ref.targetName === 'draw')).toBe(false);
    // instance send is captured but unresolved (dynamic typing).
    const greet = refTo(r, 'greet');
    expect(greet?.targetId).toBeNull();
    expect(greet?.receiver).toBe('other');
    // bare C call resolves to the free function.
    expect(resolvedTo(r, 'go', 'helper')).toBe(true);
    // a bare `sibling()` is a C free function call, NOT `[self sibling]` — so it does
    // NOT resolve to the sibling METHOD (the no-implicit-this divergence from cpp).
    expect(resolvedTo(r, 'go', 'sibling')).toBe(false);
  });

  it('construction `[[Foo alloc] init]` and alloc/init/new are suppressed, never wrong edges', () => {
    const r = extract(
      `@implementation C\n- (id)make { return [[Foo alloc] init]; }\n@end`,
    );
    // alloc/init are in ignoredMemberCallees → no flood; the nested receiver is opaque.
    expect(r.references.some((ref) => ref.targetName === 'alloc' && ref.targetId !== null)).toBe(false);
    expect(r.references.some((ref) => ref.targetName === 'init' && ref.targetId !== null)).toBe(false);
  });

  it('a block (^{…}) closure send rolls into the enclosing method', () => {
    const r = extract(
      `@implementation C\n- (void)go { void(^b)(void) = ^{ [self draw]; }; b(); }\n- (void)draw { }\n@end`,
    );
    expect(resolvedTo(r, 'go', 'draw')).toBe(true);
  });
});

describe('objc extractor — categories, class extensions, decl/def split', () => {
  it('a category and a class-extension merge members into the class (no duplicate class)', () => {
    const r = extract(
      `@implementation C\n- (void)base { [self extra]; [self priv]; }\n- (void)extra { }\n@end\n` +
        `@interface C (Cat)\n- (void)extra;\n@end\n` +
        `@interface C ()\n- (void)priv;\n@end\n` +
        `@implementation C (Cat)\n- (void)extra { }\n@end`,
    );
    // exactly ONE `class` symbol named C (the category impl/interface do not duplicate it);
    // a second would make C ambiguous and break all method resolution.
    expect(byName(r, 'C').filter((s) => s.kind === 'class')).toHaveLength(1);
    // a category method send resolves against the class.
    expect(resolvedTo(r, 'base', 'extra')).toBe(true);
  });

  it('a header decl and an impl def of one method are two symbols with DISTINCT ids', () => {
    const r = extract(
      `@interface C : NSObject\n- (void)draw;\n@end\n` +
        `@implementation C\n- (void)draw { }\n@end`,
      'src/C.m',
    );
    const draws = byName(r, 'draw');
    expect(draws).toHaveLength(2); // the bodiless header decl + the impl def
    expect(draws[0].id).not.toBe(draws[1].id); // OccurrenceCounter keeps ids unique
  });

  it('a SAME-FILE @interface + @implementation emits ONE class and still resolves self/class sends', () => {
    // Regression: two `class C` symbols in one parse would flag C ambiguous and EXCLUDE
    // it from methodsByClass, breaking ALL [self …]/[C …] resolution (a private helper
    // class fully defined in a .m, a single-file program, an umbrella header).
    const r = extract(
      `@interface C : NSObject\n- (void)draw;\n@end\n` +
        `@implementation C\n- (void)go { [self draw]; [C make]; }\n- (void)draw { }\n+ (void)make { }\n@end`,
    );
    expect(byName(r, 'C').filter((s) => s.kind === 'class')).toHaveLength(1);
    expect(resolvedTo(r, 'go', 'draw')).toBe(true); // self-send
    expect(resolvedTo(r, 'go', 'make')).toBe(true); // class-send
  });
});

describe('objc extractor — @property name extraction (pointer/block/multi-declarator)', () => {
  it('resolves a block-typed property name through the block_pointer_declarator', () => {
    const r = extract(`@interface C : NSObject\n@property (copy) void (^handler)(int);\n@end`, 'src/C.h');
    expect(sym(r, 'handler')?.kind).toBe('variable');
    expect(sym(r, 'handler')?.fqn).toBe('src/C.h:C.handler');
  });

  it('extracts EVERY declarator of a multi-declarator property', () => {
    const r = extract(`@interface C : NSObject\n@property (assign) int a, b, c;\n@end`, 'src/C.h');
    expect(byName(r, 'a')).toHaveLength(1);
    expect(byName(r, 'b')).toHaveLength(1);
    expect(byName(r, 'c')).toHaveLength(1);
  });

  it('resolves a pointer property name (NSString *name)', () => {
    const r = extract(`@interface C : NSObject\n@property (strong) NSString *name;\n@end`, 'src/C.h');
    expect(sym(r, 'name')?.kind).toBe('variable');
  });
});

describe('objc extractor — preprocessor include guards', () => {
  it('extracts an @interface wrapped in an #ifndef/#define guard', () => {
    const r = extract(
      `#ifndef C_H\n#define C_H\n@interface C : NSObject\n- (void)draw;\n@end\n#endif`,
      'src/C.h',
    );
    expect(sym(r, 'C')?.kind).toBe('class');
    expect(sym(r, 'draw')?.kind).toBe('method');
  });

  it('extracts BOTH branches of an #if/#else over @interfaces', () => {
    const r = extract(
      `#if TARGET_OS_IPHONE\n@interface Mobile : NSObject\n- (void)a;\n@end\n#else\n@interface Desktop : NSObject\n- (void)b;\n@end\n#endif`,
      'src/C.h',
    );
    expect(sym(r, 'Mobile')?.kind).toBe('class');
    expect(sym(r, 'Desktop')?.kind).toBe('class');
  });
});

describe('objc extractor — imports', () => {
  it('captures #import, @import, but not @class/@protocol forward decls', () => {
    const r = extract(
      `#import <Foundation/Foundation.h>\n#import "Local.h"\n@import UIKit;\n@class Fwd;`,
      'src/C.m',
    );
    const modules = r.imports.map((i) => i.sourceModule).sort();
    expect(modules).toEqual(['Foundation/Foundation.h', 'Local.h', 'UIKit']);
    // every import is namespace-style (a header/module has no named binding).
    expect(r.imports.every((i) => i.importedNames[0]?.name === '*')).toBe(true);
  });

  it('records the FULL dotted module path for a submodule @import', () => {
    const r = extract(`@import Foo.Bar.Baz;`, 'src/C.m');
    expect(r.imports.map((i) => i.sourceModule)).toEqual(['Foo.Bar.Baz']);
  });
});

describe('objc extractor — NS_ASSUME_NONNULL neutralizer', () => {
  it('recovers an @interface bracketed by NS_ASSUME_NONNULL_BEGIN/END', () => {
    const src =
      `NS_ASSUME_NONNULL_BEGIN\n` +
      `@interface C : NSObject\n@property (strong) NSString *name;\n- (void)draw;\n@end\n` +
      `NS_ASSUME_NONNULL_END`;
    const r = extract(src, 'src/C.h');
    // Without the parser.ts neutralizer the whole @interface is dropped (0 symbols).
    expect(sym(r, 'C')?.kind).toBe('class');
    expect(sym(r, 'name')?.kind).toBe('variable');
    expect(sym(r, 'draw')?.kind).toBe('method');
  });

  it('offsets are preserved through neutralization (signatures still match the source)', () => {
    const src = `NS_ASSUME_NONNULL_BEGIN\n@interface C : NSObject\n- (void)draw;\n@end\nNS_ASSUME_NONNULL_END`;
    const r = extract(src, 'src/C.h');
    const draw = sym(r, 'draw');
    // the signature is sliced from the (offset-preserved) source.
    expect(src.slice(0).includes(draw.signature.replace(/\s+/g, ' '))).toBe(true);
    expect(draw.signature).toContain('- (void)draw');
  });

  it('adopts a neutralized parse that still has residual macro errors (fewer-errors path)', () => {
    // NS_ASSUME_NONNULL brackets the interface AND an intervening NS_ENUM is opaque to
    // the grammar (a residual error). The raw parse buries the @interface; the
    // neutralized parse recovers it despite the lingering NS_ENUM error — the `<=`
    // adopt path (the objc-vs-swift divergence: fewer errors, not zero).
    const src =
      `NS_ASSUME_NONNULL_BEGIN\n` +
      `typedef NS_ENUM(NSInteger, Color) { ColorRed, ColorBlue };\n` +
      `@interface C : NSObject\n- (void)draw;\n@end\n` +
      `NS_ASSUME_NONNULL_END`;
    const r = extract(src, 'src/C.h');
    expect(sym(r, 'C')?.kind).toBe('class');
    expect(sym(r, 'draw')?.kind).toBe('method');
  });
});
