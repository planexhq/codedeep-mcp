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

export type RefKind = 'calls' | 'imports' | 'implements' | 'type_ref';

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
  sourceId: string;
  targetId: string;
  kind: RefKind;
  file: string;
  line: number;
}

export interface ImportInfo {
  file: string;
  sourceModule: string;
  importedNames: Array<{
    name: string;
    alias?: string;
  }>;
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
