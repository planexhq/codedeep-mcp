// Shared types for probe-mcp.
//
// Note: the `Symbol` interface name shadows the global `Symbol` constructor
// when imported, but only as a *type* — the runtime `Symbol(...)` value is
// untouched. Module-scoped interfaces do NOT merge with `lib.es5.d.ts`'s
// global `Symbol` (that would require `declare global`).

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'method'
  | 'module';

// SymbolKinds that aren't callable at the syntactic level: methods are only
// reached via `obj.method()` (member expressions, filtered by call selectors);
// interfaces and types never appear at runtime. Used by the extractor's call
// resolver to exclude these from `nameToId`, and by `isCallerOf` to reject
// name-only matches against these kinds.
export const NON_CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'interface',
  'type',
]);

export type RefKind = 'calls' | 'imports' | 'implements' | 'type_ref';

// Sentinel values stored in `ImportInfo.importedNames[].name` to encode
// non-named imports. Both `default` and `*` are reserved words in module
// syntax and cannot collide with a real exported identifier; consumers
// distinguish them by these constants instead of comparing to literals.
export const IMPORT_DEFAULT = 'default' as const;
export const IMPORT_NAMESPACE = '*' as const;

// Sentinel language tag for files whose extension we don't recognize.
// They're recorded as FileInfo (so overview can report them) but skipped
// at parse/extract time.
export const LANGUAGE_UNKNOWN = 'unknown' as const;

export interface Symbol {
  id: string;
  name: string;
  fqn: string;
  kind: SymbolKind;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  doc: string | null;
  exported: boolean;
  language: string;
}

export interface Reference {
  // null for module-level calls — call sites that aren't inside any declared
  // symbol's body (e.g. `import { foo } from './x'; foo();` at file scope).
  sourceId: string | null;
  // null when the call's target couldn't be resolved within the source file
  // (cross-file calls, unknown names). targetName carries the bare-identifier
  // call token regardless, so cross-file lookups go through name, not id.
  targetId: string | null;
  targetName: string;
  kind: RefKind;
  file: string;
  line: number;
}

export interface ImportedName {
  name: string;
  alias?: string;
}

export interface ImportInfo {
  file: string;
  sourceModule: string;
  importedNames: ImportedName[];
  line: number;
}

export interface FileInfo {
  path: string;
  language: string;
  size: number;
  lastModified: number;
  lastIndexed: number;
  symbolCount: number;
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  filesByLanguage: Record<string, number>;
  symbolsByKind: Record<SymbolKind, number>;
  entryPoints: Array<{ file: string; symbol: string; line: number }>;
}

export interface ProbeConfig {
  readonly projectRoot: string;
  readonly exclude: readonly string[];
  readonly languages: readonly string[];
  readonly maxFiles: number;
  readonly maxFileSize: number;
  readonly cacheDir: string;
}
