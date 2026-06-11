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
  | 'module'
  | 'enum';

// SymbolKinds that bare-identifier calls (`foo()`) can never bind to:
// methods require member access (resolved separately via the receiver and
// `methodsByClass`); interfaces and types never appear at runtime. Used by
// the extractor's call resolver to exclude these from `nameToId`, and by
// `isCallerOf` to reject bare-name matches against these kinds (member
// refs — `receiver` present — may still match methods).
export const NON_CALLABLE_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'interface',
  'type',
  // Bare `Color()` is never a valid call on an enum, and enums have no
  // invocable members, so member refs can't target them either.
  'enum',
  // Same for namespaces: in declaration merging (`namespace fmt` +
  // `function fmt`) the call belongs to the function — without this
  // entry the namespace symbol would win the extractor's first-wins
  // nameToId and steal the function's resolved refs.
  'module',
]);

export type RefKind = 'calls' | 'imports' | 'implements' | 'type_ref';

// Sentinel values stored in `ImportInfo.importedNames[].name` to encode
// non-named imports. Both `default` and `*` are reserved words in module
// syntax and cannot collide with a real exported identifier; consumers
// distinguish them by these constants instead of comparing to literals.
export const IMPORT_DEFAULT = 'default' as const;
export const IMPORT_NAMESPACE = '*' as const;

// Discriminator for binding semantics, separate from the syntactic
// `name` slot. Bare `localName()` calls are evidence of a value-callable
// binding only when kind is 'value' (or absent — legacy persisted data
// is treated as 'value'). Non-value bindings are TypeErrors at runtime
// if invoked directly, so they shouldn't be attributed as callers of
// the source module's exports.
export type ImportKind = 'value' | 'type' | 'namespace' | 'module';

// Sentinel language tag for files whose extension we don't recognize.
// They're recorded as FileInfo (so overview can report them) but skipped
// at parse/extract time.
export const LANGUAGE_UNKNOWN = 'unknown' as const;

// Extracts `Class` from a member FQN `<file>:<Class>.<member>`; null for
// top-level FQNs (`<file>:<name>`). File paths can contain dots, so the
// split is the first `.` AFTER the first `:` — this function is the one
// parser of that contract (extractor member resolution and code-index
// member gating both rely on it).
export function classNameFromFqn(fqn: string): string | null {
  const colon = fqn.indexOf(':');
  if (colon === -1) return null;
  const dot = fqn.indexOf('.', colon + 1);
  if (dot === -1) return null;
  return fqn.slice(colon + 1, dot);
}

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
  // (cross-file calls, unknown names). targetName carries the called name
  // regardless, so cross-file lookups go through name, not id.
  targetId: string | null;
  targetName: string;
  kind: RefKind;
  file: string;
  line: number;
  // Present iff the call site was a member expression whose receiver is a
  // single identifier or this/self/cls — the literal source token ('this',
  // 'self', 'utils', 'Class', ...). Deeper chains (`a.b.c()`) are never
  // emitted, so `receiver !== undefined` ⟺ member-call ref. Drives
  // enclosing-class resolution, namespace-import resolution, and noise
  // gating in `isCallerOf`. The key is omitted (never set to undefined)
  // for bare calls so persisted JSON stays clean.
  receiver?: string;
  // True when the language extractor determined the receiver refers to
  // the enclosing class instance (TS `this` node; Python `self`/`cls`
  // parameters). Recorded by the extractor — NOT derivable from the
  // receiver token, since a TS identifier merely named `self` is an
  // ordinary object receiver. Set only for member refs.
  selfReceiver?: boolean;
}

export interface ImportedName {
  name: string;
  alias?: string;
  // Absence is interpreted as 'value' so legacy persisted indexes
  // (pre-schema-v3) keep their existing attribution semantics.
  kind?: ImportKind;
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
  // sha1 (first 16 hex) of the content that was indexed. Lets the
  // watcher distinguish an atomic-save echo from a real second edit when
  // mtime+size collide on coarse-mtime filesystems. Absent for
  // unknown-language files (never read) and pre-existing cache entries.
  contentHash?: string;
  // Commits touching this file inside the git analysis window. Absent
  // until the first analysis lands (and forever on non-git projects);
  // 0 after analysis for files with no commits in the window. The
  // indexing pipeline never sets this — CodeIndex.updateFile preserves
  // it across re-index so watcher flushes can't wipe git data.
  commitFrequency?: number;
}

// Behavioral coupling between two files, derived from commit co-occurrence
// in the analysis window. Canonical orientation: fileA < fileB
// lexicographically. Partner paths are NOT restricted to indexed files —
// a config/yaml file that co-commits with source is a legitimate partner
// — but the per-file lists in CodeIndex are keyed by indexed files only.
export interface CoChange {
  fileA: string;
  fileB: string;
  sharedCommits: number;
  // sharedCommits / commits(fileA): when fileA changes, how often fileB
  // changes too. Both denominators come from the same filtered commit
  // stream as the numerator (no-merges, <=30 files), so values are <= 1.
  confidenceAB: number;
  // sharedCommits / commits(fileB) — the reverse direction.
  confidenceBA: number;
  // Epoch ms of the newest shared commit.
  lastSeen: number;
}

// Provenance of the persisted git analysis; drives staleness detection.
// Stale when HEAD moved, the configured window changed, or the analysis
// is older than a day (the window is relative to "now", so counts drift).
export interface GitMeta {
  head: string;
  windowDays: number;
  analyzedAt: number;
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
  // Live re-indexing via fs.watch. Env PROBE_WATCH overrides the config
  // file's `watch`; defaults to true.
  readonly watch: boolean;
  // Git enrichment kill switch. Env PROBE_GIT overrides the config file's
  // `gitEnabled`; defaults to true (actual availability is still detected
  // at runtime — true just means "try").
  readonly gitEnabled: boolean;
  // Git analysis window in days (hotspots + co-change). Env PROBE_GIT_WINDOW
  // overrides the config file's `gitWindow`; defaults to 180.
  readonly gitWindow: number;
}
