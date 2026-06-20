import { promises as fs } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';

import MiniSearch from 'minisearch';

import { errMsg, log } from '../logger.js';
import {
  IMPORT_DEFAULT,
  IMPORT_NAMESPACE,
  NON_CALLABLE_KINDS,
  RECEIVER_OPAQUE,
  classNameFromFqn,
} from '../types.js';
import type {
  CoChange,
  FileInfo,
  GitMeta,
  ImportedName,
  ImportInfo,
  IndexStats,
  Reference,
  Symbol,
  SymbolKind,
} from '../types.js';

// v15: per-symbol CYCLOMATIC + COGNITIVE complexity now also computed for Swift
// (`.swift`) — BOTH metrics in one slice (the Java/Rust pattern). CYCLOMATIC is
// pinned to SwiftLint's `cyclomatic_complexity` (the open, runnable oracle — the
// gocyclo/rust-code-analysis precedent of pinning the community tool; SwiftLint counts `guard`/`catch`/the 3
// loops/every switch case incl. `default`, `fallthrough` −1, and skips nested
// func/init; it does NOT count `&&`/`||`/ternary/`??`, so Swift is the only Probe
// language without cyclomatic booleans). COGNITIVE is SonarSource-whitepaper-aligned
// (no published cognitive spec for Swift exists, so there is no
// tool oracle; validated against
// hand-computed whitepaper fixtures). `guard` is +1 FLAT (the Rust let-else analog /
// Swift's nesting-reducing idiom). Swift's `if` is positional (no consequence/
// alternative field — a new engine path) and its booleans are distinct
// conjunction/disjunction nodes with lhs/rhs operands. Adding the fields to Swift
// symbols is an extraction-logic change `isUnchanged` (mtime/size/language) can't
// detect, so the bump force-invalidates warm caches.
// v14: per-symbol CYCLOMATIC + COGNITIVE complexity now also computed for Rust
// (`.rs`) — the first of the remaining 6 languages to get BOTH metrics at once.
// CYCLOMATIC is pinned to Mozilla's `rust-code-analysis` (the `rust-code-analysis-cli`
// oracle): the `?` try operator, every match arm, match-arm guards, closures, and
// the 3 loops all count (McCabe-complete; verified exact on ripgrep + serde modulo
// macro-internal control flow, which Probe's grammar treats as opaque token-trees,
// and nested fn/impl bodies, the per-symbol model). COGNITIVE is SonarSource-
// whitepaper/sonar-rust-aligned and DELIBERATELY does NOT replicate two
// rust-code-analysis cognitive bugs the oracle surfaced (it omits `loop` entirely,
// and carries boolean-run state across the whole function) — Probe counts all 3
// loops and per-expression boolean runs, the defensible number. Adding the fields to
// Rust symbols is an extraction-logic change `isUnchanged` (mtime/size/language)
// can't detect, so the bump force-invalidates warm caches.
// v13: per-symbol COGNITIVE complexity now also computed for Python (`.py`),
// VERIFIED-EXACT against sonar-python's CognitiveComplexityVisitor (0 mismatches on
// all ~5034 functions WITHOUT a nested scope across flask + django; differs from
// complexipy — sonar-python-aligned: `except` surcharges, booleans count everywhere
// with no paren-unwrap, `with`/`try` bodies are not nested, `match` is 0 structural,
// loop bodies nest via loopBodyField). Nested fns/lambdas/classes are excluded (the
// per-symbol model). Adding the field to Python symbols is an extraction-logic change
// `isUnchanged` (mtime/size/language) can't detect, so the bump force-invalidates
// warm caches.
// v12: per-symbol COGNITIVE complexity now also computed for Go (`.go`),
// VERIFIED-EXACT against uudashr/gocognit (376/376 functions: cobra 157 + gin 213
// + a synthetic edge-case fixture 6; differs
// from sonar-go — gocognit-aligned, like Go cyclomatic is gocyclo-aligned: no
// plain-else nesting, if-init walked, no paren-unwrap in boolean chains, +1 per
// direct-recursion call-site). Adding the field to Go symbols is an
// extraction-logic change `isUnchanged` (mtime/size/language) can't detect, so the
// bump force-invalidates warm caches.
// v11: per-symbol COGNITIVE complexity now also computed for TS/JS
// (`.ts`/`.tsx`/`.js`), VERIFIED-EXACT against SonarJS S3776 (differs from
// sonar-java: `&&`-runs-only booleans, JSX short-circuit exclusion). Adding the
// field to TS symbols is an extraction-logic change `isUnchanged`
// (mtime/size/language) can't detect, so the bump force-invalidates warm caches.
// v10: per-symbol COGNITIVE complexity (`Symbol.cognitiveComplexity?`, the
// SonarSource whitepaper nesting-aware metric) is now computed at extract time
// for Java, alongside cyclomatic which also rolled to Java this slice. A new
// extraction-computed field `isUnchanged` (mtime/size/language) can't detect, so
// the bump force-invalidates warm caches to re-extract and populate it. v9:
// per-symbol cyclomatic complexity (`Symbol.complexity?`, 1 + decision
// points) is now computed at extract time for TS/JS, Python, and Go. An
// extraction-computed field `isUnchanged` (mtime/size/language) can't detect, so
// the bump force-invalidates warm caches to re-extract and populate it. v8:
// chained/computed member calls (`a.b().c()`, `foo().bar()`) are now
// captured as name-keyed member refs with an opaque receiver (RECEIVER_OPAQUE).
// A pure extraction-logic change that `isUnchanged` (mtime/size/language) can't
// detect, so the bump force-invalidates warm caches to re-extract. v7: symbol
// ids hash the FULL untruncated signature (the stored signature stays capped at
// 120 chars for display). Under v6, overloads differing only past the cap shared
// an id, silently merging their reference graphs — the bump forces the rebuild
// that re-keys every long-signature symbol. (v6 added enum + namespace-declaration
// extraction; v5 added persisted git enrichment: FileInfo.commitFrequency,
// co-change lists, hotspots, gitMeta; v4 added member-expression call refs; v3
// added ImportedName.kind.)
// Exported so shape-validation tests can build fixtures at the CURRENT version
// (they must pass the version gate to reach the shape validators). Hardcoding
// the number in tests silently neutered them on each bump — see the v9→v10
// regression where version:9 fixtures began short-circuiting at the version check.
export const SCHEMA_VERSION = 15;

// Below this length, names like `do`/`is`/`set` flood with false-positive
// AST name matches across files. find_references and getCallerCount both
// fall back to precise within-file resolution at or below this threshold.
export const SHORT_NAME_THRESHOLD = 4;

// Score multiplier for exported symbols in `searchSymbols` — public API
// is the more likely target when exploring by keyword.
const EXPORTED_BOOST = 1.5;

export interface SearchSymbolsOptions {
  limit: number;
  // Index-internal language ids ('typescript', 'tsx', ...); callers expand
  // user-facing aliases before querying.
  languages?: ReadonlySet<string>;
  // Per-file score multiplier (git churn boost from search_structure).
  // Composes multiplicatively with the exported-symbol boost; files
  // absent from the map are neutral (1).
  boostByFile?: ReadonlyMap<string, number>;
}

// What GitService hands to applyGitAnalysis: the analyzer's products plus
// the provenance that drives staleness checks on the next startup.
export interface GitAnalysisResult {
  counts: ReadonlyMap<string, number>;
  cochanges: ReadonlyMap<string, CoChange[]>;
  hotspots: readonly string[];
  meta: GitMeta;
}

// Suffix candidates appended to a relative-import resolution to match an
// indexed file path. Order encodes language-specific resolution preference;
// each list is selected by `normalizeImportSpecifier` based on the
// importer's language and the specifier's explicit extension.

// Python imports cannot resolve to non-Python at runtime — strictly Python.
// Package directory wins over sibling module per CPython FileFinder
// semantics (`_find_spec` checks `_path_isdir(base)` before the suffix
// loop), so when both `pkg/b.py` and `pkg/b/__init__.py` exist,
// `from pkg import b` resolves to the package.
const PY_CANDIDATES: readonly string[] = ['/__init__.py', '.py'];

// JS importer: prefer JS-native; fall back to TS source for projects using
// allowJs/checkJs where the `.ts` is the canonical implementation.
const JS_CANDIDATES: readonly string[] = [
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '/index.js', '/index.jsx', '/index.mjs', '/index.cjs',
  '/index.ts', '/index.tsx',
];

// TS/TSX importer, no explicit JS-family extension or `.js` stripped:
// TS source first.
const TS_CANDIDATES: readonly string[] = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
  '/index.mjs', '/index.cjs',
];

// TS/TSX importer with `.jsx` specifier: prefer `.tsx` (Node16/NodeNext
// emits `.jsx` for `.tsx` source), then `.jsx` (explicit user-written
// JSX target), then `.ts` fallback. The explicit `.jsx` extension is a
// strong user signal — it should beat an unrelated `.ts` sibling at the
// same stem.
const TS_FROM_JSX_CANDIDATES: readonly string[] = [
  '.tsx', '.jsx', '.ts', '.js', '.mjs', '.cjs',
  '/index.tsx', '/index.jsx', '/index.ts', '/index.js',
  '/index.mjs', '/index.cjs',
];

// TS/TSX importer with `.js` specifier: prefer `.js` (explicit user
// signal — hand-written JS in mixed repos), then `.ts` (Node16/NodeNext
// emits `.js` for `.ts` source). Mirrors the `.jsx` precedence above.
const TS_FROM_JS_CANDIDATES: readonly string[] = [
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '/index.js', '/index.jsx', '/index.ts', '/index.tsx',
  '/index.mjs', '/index.cjs',
];

export const ENTRY_POINT_FILENAME_RE =
  /^(index|main|app|server|cli|__main__|__init__)\.(ts|tsx|js|mjs|cjs|jsx|py|java|go|rs|swift|kt|kts|dart|cs|php)$/i;

// `symbol` is set when the caller is a declared source symbol; absent for
// module-level call sites. Invariant: when `symbol` is set, `file` and
// `line` mirror its declaration; when absent, they point to the call site.
export interface CallerEdge {
  file: string;
  line: number;
  symbol?: Symbol;
}

// --- getCallerTree (depth-N blast radius) ---------------------------------
//
// The caller tree is the `find_references` caller-recovery path
// (getReferencesByNameOrAlias + isCallerOf) applied RECURSIVELY: each
// surviving ref carries a `sourceId` (the enclosing caller symbol) to
// continue from. The hazard is false-edge amplification — one wrong
// name-keyed edge would spawn a whole false subtree. Two defenses, both
// aligned with the precision-over-recall stance: (1) per-path confidence
// that decays with depth AND edge weakness, gating expansion below a floor;
// (2) an expansion policy where only the stronger edge classes recurse —
// weak edges are SHOWN at the depth they're found but never expanded, so a
// real call is never silently dropped yet a wrong one can't fan out.

// Strength of a single caller edge, derived purely from the Reference shape
// + the source file's imports. Maps onto the existing render tags:
// resolved -> [structural]; import-connected/name-match -> [name match];
// weak-member -> [member call].
export type EdgeStrength =
  | 'resolved'          // within-file AST-resolved (targetId !== null)
  | 'import-connected'  // bare call whose file imports the target / same dir,
                        //   or member call through a namespace/module import
  | 'name-match'        // bare call, no import link — weak cross-file evidence
  | 'weak-member';      // unresolved `obj.method()` — receiver binds anywhere

export interface CallSite {
  file: string;
  line: number;
}

export interface CallerTreeNode {
  symbolId: string | null; // null means a module-level call site (terminal leaf)
  name: string;            // caller name, or the MODULE_LEVEL sentinel
  file: string;            // caller decl file (symbol) | call-site file (module)
  line: number;            // caller decl line (symbol) | earliest call-site line
  kind: SymbolKind | null;
  depth: number;           // root = 0; direct callers = 1
  strength: EdgeStrength;  // the edge from this caller INTO its parent/target
  sites: CallSite[];       // every call site from this caller into the target
  confidence: number;      // path confidence (0,1] — RANKING/GATING only
  via?: string;            // parent caller's name (depth >= 2); undefined at depth 1
  children: CallerTreeNode[];
  isCycle: boolean;        // sourceId already on this root->node path (shown once)
  isModuleLevel: boolean;
  leafByPolicy: boolean;   // shown but deliberately not expanded (weak edge)
  depthCapped: boolean;    // hit maxDepth wall — more callers may exist
  truncatedChildren: number; // children dropped by maxBreadth / maxNodes
}

export interface CallerTreeResult {
  root: CallerTreeNode;    // the target; root.children are depth-1 callers
  totalNodes: number;      // distinct caller nodes emitted (excludes root)
  truncated: boolean;      // a breadth/node cap fired somewhere
  limitations: readonly string[];
}

export interface CallerTreeOptions {
  maxDepth?: number;       // default 3 (root = depth 0)
  maxBreadth?: number;     // default 25 — per-node child cap (after sort)
  maxNodes?: number;       // default 200 — total expanded-node budget
  includeWeak?: boolean;   // default false — let name-match/weak-member recurse
}

// Distinct transitive callers under a caller tree (the impact-set size).
export interface CallerCounts {
  callers: number;         // distinct caller symbols/sites (DAG-diamond deduped)
  files: number;           // distinct files those callers live in
  depths: number;          // distinct hop depths reached
  depthCapped: boolean;    // a node hit the maxDepth wall — deeper callers exist
}

// Scalar blast radius. `truncated` means the count is a LOWER BOUND for ANY
// reason — a breadth/node cap (tree.truncated) OR the depth wall (depthCapped) —
// so a scalar consumer renders one `+` and points to `impact` for the full
// per-depth breakdown. (Distinct from CallerCounts: no depthCapped, since the
// scalar collapses both undercount sources into the single `+`.)
export interface BlastRadius {
  callers: number;
  files: number;
  depths: number;
  truncated: boolean;
}

// One row of the churn × coupling risk ranking (getRiskHotspots).
export interface RiskRow {
  file: string;
  symbol: string;          // offender: the highest-fan-in symbol in the file
  symbolId: string;
  churn: number;           // file commit frequency in the git window
  fanIn: number;           // offender's caller count (the coupling factor)
  blast: BlastRadius;      // offender's transitive blast radius (depth-bounded)
  score: number;           // log1p(churn) * log1p(fanIn)
}

// Ordinal edge weights feeding the path-confidence product, plus a rank for
// "strongest edge wins" when one caller reaches the target several ways.
const EDGE_WEIGHT: Readonly<Record<EdgeStrength, number>> = Object.freeze({
  resolved: 1.0,
  'import-connected': 0.8,
  'name-match': 0.5,
  'weak-member': 0.3,
});
const STRENGTH_RANK: Readonly<Record<EdgeStrength, number>> = Object.freeze({
  'weak-member': 0,
  'name-match': 1,
  'import-connected': 2,
  resolved: 3,
});
// Per-hop decay so even a chain of strong-but-unverified edges loses
// confidence with distance from the changed symbol.
const DEPTH_DECAY = 0.85;
// Path-confidence floor below which an edge is shown but not expanded.
const MIN_EXPAND_CONFIDENCE = 0.35;
const DEFAULT_CALLER_TREE_DEPTH = 3;
const DEFAULT_CALLER_TREE_BREADTH = 25;
const DEFAULT_CALLER_TREE_NODES = 200;
// Edge classes allowed to recurse by default; weak classes are leaf-only.
const EXPANDABLE_BY_DEFAULT: ReadonlySet<EdgeStrength> = new Set<EdgeStrength>([
  'resolved',
  'import-connected',
]);

// Risk Hotspots (churn × coupling) cost knobs. Hybrid ranking: rank a bounded
// candidate set by the O(1) cached fan-in, then run the expensive transitive
// getBlastRadius only for the rows actually displayed.
const RISK_CANDIDATE_FILES = 40;   // most-churned files scanned
const RISK_BLAST_DEPTH = 2;        // caller-tree depth for the displayed blast radius
const DEFAULT_RISK_HOTSPOTS = 10;  // rows returned by getRiskHotspots

// Static disclosure rendered as a footnote — the caller tree is upstream-only
// and inheritance-blind by construction, so an empty/shallow tree is a blind
// spot, not an "all clear".
const CALLER_TREE_LIMITATIONS: readonly string[] = Object.freeze([
  'Upstream callers only — cross-file callees (downstream) are not traversed (LSP, Phase 2).',
  'Inheritance/override edges are not modeled, so virtual-dispatch callers may be missing (LSP, Phase 2).',
  'Edges are heuristic AST name-matches, not compiler-verified; confidence is ordinal, not probabilistic.',
]);

export const zeroSymbolsByKind = (): Record<SymbolKind, number> => ({
  function: 0,
  class: 0,
  interface: 0,
  type: 0,
  variable: 0,
  method: 0,
  module: 0,
  enum: 0,
});

interface PersistedSchema {
  version: number;
  createdAt: number;
  projectRoot: string;
  symbols: Array<[string, Symbol]>;
  files: Array<[string, FileInfo]>;
  imports: Array<[string, ImportInfo[]]>;
  callees: Array<[string, string[]]>;
  callers: Array<[string, string[]]>;
  references: Reference[];
  // Git enrichment (v5). gitMeta null = no analysis has landed yet
  // (non-git project, gitEnabled=false, or saved before first analysis).
  cochanges: Array<[string, CoChange[]]>;
  hotspots: string[];
  gitMeta: GitMeta | null;
}

export class CodeIndex {
  private symbolById = new Map<string, Symbol>();
  private fileByPath = new Map<string, FileInfo>();
  private importsByFile = new Map<string, ImportInfo[]>();

  private symbolsByName = new Map<string, Symbol[]>();
  private symbolsByFile = new Map<string, Symbol[]>();
  private callees = new Map<string, Set<string>>();
  private callers = new Map<string, Set<string>>();

  // Indexed for find_references; covers both within-file and cross-file
  // (targetId=null) calls.
  private referencesByTargetName = new Map<string, Reference[]>();
  // Lets removeFile prune in O(refsInFile) instead of scanning by name.
  private referencesBySourceFile = new Map<string, Reference[]>();

  private sortedNames: string[] = [];
  private sortedNamesLower: string[] = [];
  private namesDirty = true;
  private searchIndex: MiniSearch<Symbol> | null = null;

  // Lazy-rebuilt cache for `getCallerCount` so find_symbol's
  // `References: ~N` doesn't re-walk all imports per result. Mirrors
  // the namesDirty/rebuildIndexesIfDirty pattern.
  private callerCountById = new Map<string, number>();
  private callerCountsDirty = true;

  // Inverted index of renaming value imports (`import { X as Y }`) keyed
  // by the EXPORTED name X. Rebuilt lazily like the caches above — without
  // it, every getReferencesByNameOrAlias call would scan every file's
  // imports (and the caller-count rebuild multiplies that by symbol count).
  private renamingAliasesByName = new Map<
    string,
    Array<{ filePath: string; sourceModule: string; alias: string }>
  >();
  private aliasIndexDirty = true;

  // Sorted file paths for hasFileUnder's binary search — the watcher
  // calls it per deleted path, so a linear scan would make bulk
  // deletions O(deletedPaths × indexedFiles).
  private sortedFilePaths: string[] = [];
  private filePathsDirty = true;

  // Git enrichment (schema v5). cochangesByFile is keyed by indexed
  // paths only; partner values inside the records may be any repo path.
  // hotspotList is <= 50 entries — linear scans are fine.
  private cochangesByFile = new Map<string, CoChange[]>();
  private hotspotList: string[] = [];
  private gitMetaState: GitMeta | null = null;

  private writeLock: Promise<unknown> = Promise.resolve();
  private readonly projectRoot: string;

  constructor(projectRoot = '') {
    this.projectRoot = projectRoot;
  }

  addFile(
    file: FileInfo,
    symbols: Symbol[],
    references: Reference[],
    imports: ImportInfo[],
  ): void {
    this.fileByPath.set(file.path, file);
    this.importsByFile.set(file.path, [...imports]);
    this.symbolsByFile.set(file.path, [...symbols]);

    for (const sym of symbols) {
      this.symbolById.set(sym.id, sym);
      pushOrInit(this.symbolsByName, sym.name, sym);
    }

    this.referencesBySourceFile.set(file.path, [...references]);
    for (const ref of references) {
      pushOrInit(this.referencesByTargetName, ref.targetName, ref);
      // Module-level calls (sourceId=null) and cross-file unresolved refs
      // (targetId=null) skip the id-keyed adjacency; they're queried by name
      // via referencesByTargetName.
      if (ref.sourceId && ref.targetId) {
        addAdjacency(this.callees, ref.sourceId, ref.targetId);
        addAdjacency(this.callers, ref.targetId, ref.sourceId);
      }
    }

    this.namesDirty = true;
    this.callerCountsDirty = true;
    this.aliasIndexDirty = true;
    this.filePathsDirty = true;
  }

  // Returns true when the file was actually in the index (cascade ran);
  // false for a no-op so callers can tell mutation from idle work.
  removeFile(path: string): boolean {
    return this.removeFileInternal(path, true);
  }

  // pruneGit=false is the re-index path (updateFile): the file still
  // exists, so its co-change history and hotspot membership remain valid
  // and must survive the remove+add cycle.
  private removeFileInternal(path: string, pruneGit: boolean): boolean {
    const symsInFile = this.symbolsByFile.get(path);
    if (!symsInFile) return false;
    if (pruneGit) this.pruneGitData(path);

    const deletedIds = new Set<string>();
    for (const sym of symsInFile) {
      deletedIds.add(sym.id);
      this.symbolById.delete(sym.id);
      const list = this.symbolsByName.get(sym.name);
      if (!list) continue;
      const filtered = list.filter((s) => s.id !== sym.id);
      if (filtered.length === 0) this.symbolsByName.delete(sym.name);
      else this.symbolsByName.set(sym.name, filtered);
    }

    for (const id of deletedIds) {
      this.callees.delete(id);
      this.callers.delete(id);
    }
    pruneAdjacency(this.callers, deletedIds);
    pruneAdjacency(this.callees, deletedIds);

    const refsFromFile = this.referencesBySourceFile.get(path);
    if (refsFromFile) {
      // Group by targetName so each by-name list is filtered once even when
      // a file has many refs to the same target.
      const toRemove = new Map<string, Set<Reference>>();
      for (const ref of refsFromFile) {
        let set = toRemove.get(ref.targetName);
        if (!set) {
          set = new Set();
          toRemove.set(ref.targetName, set);
        }
        set.add(ref);
      }
      for (const [name, set] of toRemove) {
        const list = this.referencesByTargetName.get(name);
        if (!list) continue;
        const kept = list.filter((r) => !set.has(r));
        if (kept.length === 0) this.referencesByTargetName.delete(name);
        else this.referencesByTargetName.set(name, kept);
      }
      this.referencesBySourceFile.delete(path);
    }

    this.fileByPath.delete(path);
    this.importsByFile.delete(path);
    this.symbolsByFile.delete(path);
    this.namesDirty = true;
    this.callerCountsDirty = true;
    this.aliasIndexDirty = true;
    this.filePathsDirty = true;
    return true;
  }

  updateFile(
    file: FileInfo,
    symbols: Symbol[],
    references: Reference[],
    imports: ImportInfo[],
  ): void {
    // The pipeline never sets commitFrequency — carry it over from the
    // previous FileInfo, or every watcher flush would silently zero the
    // touched file's git data until the next analysis.
    const prevFrequency = this.fileByPath.get(file.path)?.commitFrequency;
    this.removeFileInternal(file.path, false);
    this.addFile(file, symbols, references, imports);
    if (file.commitFrequency === undefined && prevFrequency !== undefined) {
      file.commitFrequency = prevFrequency;
    }
  }

  // True deletion only (never the re-index path): drop the file's own
  // co-change key and hotspot membership. Records naming this file as a
  // PARTNER in other files' lists are deliberately retained — partner
  // values are allowed to be non-indexed paths (config/auth.yaml), and a
  // fresh analysis would re-derive exactly those records from history,
  // so pruning them here would just disagree with the next refresh.
  private pruneGitData(path: string): void {
    this.cochangesByFile.delete(path);
    if (this.hotspotList.includes(path)) {
      this.hotspotList = this.hotspotList.filter((p) => p !== path);
    }
  }

  // Swap in a completed analysis. Runs under the write lock so a save()
  // chained behind it persists the new data and apply can never land in
  // the middle of a save's snapshot. Membership may have drifted since
  // the analyzer snapshotted hasFile — re-filter keys here.
  applyGitAnalysis(result: GitAnalysisResult): Promise<void> {
    return this.runLocked(async () => {
      for (const [path, fi] of this.fileByPath) {
        fi.commitFrequency = result.counts.get(path) ?? 0;
      }
      const cochanges = new Map<string, CoChange[]>();
      for (const [path, list] of result.cochanges) {
        if (this.fileByPath.has(path)) cochanges.set(path, [...list]);
      }
      this.cochangesByFile = cochanges;
      this.hotspotList = result.hotspots.filter((p) => this.fileByPath.has(p));
      this.gitMetaState = result.meta;
    });
  }

  getCoChanges(path: string): CoChange[] {
    const list = this.cochangesByFile.get(path);
    return list ? [...list] : [];
  }

  // Ranked hotspot files with their window commit counts, strongest
  // first. Counts come from the live FileInfo so a just-deleted file
  // can't resurface (pruneGitData removed it from the list).
  getHotspots(limit = 10): Array<{ path: string; commits: number }> {
    return this.hotspotList.slice(0, Math.max(0, limit)).map((path) => ({
      path,
      commits: this.fileByPath.get(path)?.commitFrequency ?? 0,
    }));
  }

  // Non-null once a git analysis has landed (live or from cache). Tools
  // gate analysis-derived sections on this; per-call git queries gate on
  // their own null returns instead.
  getGitMeta(): GitMeta | null {
    return this.gitMetaState;
  }

  // Kill-switch / repo-gone path: when git is disabled (PROBE_GIT=0) or
  // the repo disappeared, persisted enrichment from an earlier enabled
  // session must not keep rendering forever — it could never refresh.
  // No-op when no git data is present.
  clearGitData(): Promise<boolean> {
    return this.runLocked(async () => {
      const hadData =
        this.gitMetaState !== null ||
        this.cochangesByFile.size > 0 ||
        this.hotspotList.length > 0;
      if (!hadData) return false;
      for (const fi of this.fileByPath.values()) {
        delete fi.commitFrequency;
      }
      this.cochangesByFile = new Map();
      this.hotspotList = [];
      this.gitMetaState = null;
      return true;
    });
  }

  findSymbolByName(name: string, kind?: SymbolKind, scope?: string): Symbol[] {
    const list = this.symbolsByName.get(name);
    if (!list) return [];
    return list.filter((s) => matchesKindScope(s, kind, scope));
  }

  findSymbolsByPrefix(
    prefix: string,
    limit: number,
    kind?: SymbolKind,
    scope?: string,
  ): Symbol[] {
    if (!prefix || limit <= 0) return [];
    this.rebuildIndexesIfDirty();
    const prefixLower = prefix.toLowerCase();
    const start = lowerBound(this.sortedNamesLower, prefixLower);
    const out: Symbol[] = [];
    for (let i = start; i < this.sortedNamesLower.length && out.length < limit; i++) {
      if (!this.sortedNamesLower[i].startsWith(prefixLower)) break;
      const syms = this.symbolsByName.get(this.sortedNames[i]);
      if (!syms) continue;
      for (const s of syms) {
        if (out.length >= limit) break;
        if (!matchesKindScope(s, kind, scope)) continue;
        out.push(s);
      }
    }
    return out;
  }

  suggest(
    query: string,
    limit: number,
    kind?: SymbolKind,
    scope?: string,
  ): Symbol[] {
    if (!query || limit <= 0) return [];
    this.rebuildIndexesIfDirty();
    if (!this.searchIndex) return [];
    const results = this.searchIndex.search(query);
    const out: Symbol[] = [];
    for (const r of results) {
      if (out.length >= limit) break;
      const sym = this.symbolById.get(r.id as string);
      if (!sym) continue;
      if (!matchesKindScope(sym, kind, scope)) continue;
      out.push(sym);
    }
    return out;
  }

  // Keyword search across names, signatures, and docstrings for
  // `search_structure`. Unlike `suggest` (did-you-mean, name-focused),
  // this widens to all indexed fields and boosts exported symbols.
  // `total` is the full match count so callers can report exactly how
  // many results the limit cut.
  searchSymbols(
    query: string,
    opts: SearchSymbolsOptions,
  ): { symbols: Symbol[]; total: number } {
    if (!query || opts.limit <= 0) return { symbols: [], total: 0 };
    this.rebuildIndexesIfDirty();
    if (!this.searchIndex) return { symbols: [], total: 0 };
    const { languages } = opts;
    const results = this.searchIndex.search(query, {
      fields: ['name', 'signature', 'doc', 'fqn'],
      boost: { name: 3, signature: 1.5, doc: 1, fqn: 1 },
      fuzzy: 0.2,
      prefix: true,
      // Equivalent to post-multiplying the total score (each term's
      // contribution is scaled), but lets MiniSearch do the re-ranking
      // so the limit slice below stays correct.
      boostDocument: (id) => {
        const sym = this.symbolById.get(id as string);
        if (!sym) return 1;
        return (
          (sym.exported ? EXPORTED_BOOST : 1) *
          (opts.boostByFile?.get(sym.file) ?? 1)
        );
      },
      // Filter inside search (not after the limit slice) so results
      // under-fill only when there genuinely aren't enough matches.
      filter: languages
        ? (r) => {
            const sym = this.symbolById.get(r.id as string);
            return sym !== undefined && languages.has(sym.language);
          }
        : undefined,
    });
    const symbols: Symbol[] = [];
    for (const r of results) {
      if (symbols.length >= opts.limit) break;
      const sym = this.symbolById.get(r.id as string);
      if (sym) symbols.push(sym);
    }
    return { symbols, total: results.length };
  }

  getSymbolsInFile(path: string): Symbol[] {
    const list = this.symbolsByFile.get(path);
    return list ? [...list] : [];
  }

  getReferencesBySourceFile(path: string): Reference[] {
    const list = this.referencesBySourceFile.get(path);
    return list ? [...list] : [];
  }

  getAllFiles(): FileInfo[] {
    return [...this.fileByPath.values()];
  }

  hasFile(path: string): boolean {
    return this.fileByPath.has(path);
  }

  getFile(path: string): FileInfo | undefined {
    return this.fileByPath.get(path);
  }

  get fileCount(): number {
    return this.fileByPath.size;
  }

  // True when any indexed file lives under `dirPrefix` (must end with '/').
  // Binary search over the lazily-sorted path list: any key under the
  // directory sorts >= the prefix and shares it, so checking the first
  // key at the insertion point suffices.
  hasFileUnder(dirPrefix: string): boolean {
    this.rebuildFilePathsIfDirty();
    const at = lowerBound(this.sortedFilePaths, dirPrefix);
    return this.sortedFilePaths[at]?.startsWith(dirPrefix) ?? false;
  }

  // All indexed file paths under `dirPrefix` (must end with '/') — the
  // contiguous sorted range starting at the prefix's insertion point.
  filesUnder(dirPrefix: string): string[] {
    this.rebuildFilePathsIfDirty();
    const out: string[] = [];
    for (let i = lowerBound(this.sortedFilePaths, dirPrefix); i < this.sortedFilePaths.length; i++) {
      if (!this.sortedFilePaths[i].startsWith(dirPrefix)) break;
      out.push(this.sortedFilePaths[i]);
    }
    return out;
  }

  getCallees(symbolId: string): Symbol[] {
    return this.resolveIds(this.callees.get(symbolId));
  }

  // Fan-out: resolved within-file callees (id-keyed adjacency). A lower bound
  // — cross-file/unresolved calls live name-keyed and are NOT counted here,
  // unlike fan-in's getCallerCount which is reference-granular. Tag rendered
  // surfaces accordingly.
  getFanOut(symbolId: string): number {
    return this.callees.get(symbolId)?.size ?? 0;
  }

  getCallers(symbolId: string): Symbol[] {
    return this.resolveIds(this.callers.get(symbolId));
  }

  // Symbol callers come from the id-keyed adjacency set (already deduped
  // by sourceId); same-file module-level call sites are deduped per file
  // by earliest line. Cross-file unresolved name-match refs live in
  // `getCallerCount`.
  getCallerEdges(symbolId: string): CallerEdge[] {
    const sym = this.symbolById.get(symbolId);
    if (!sym) return [];
    const out: CallerEdge[] = this.resolveIds(this.callers.get(symbolId)).map(
      (s) => ({ file: s.file, line: s.startLine, symbol: s }),
    );

    const refs = this.referencesByTargetName.get(sym.name);
    if (refs) {
      const moduleByFile = new Map<string, number>();
      for (const ref of refs) {
        if (ref.targetId !== symbolId || ref.sourceId !== null) continue;
        const existing = moduleByFile.get(ref.file);
        if (existing === undefined || ref.line < existing) {
          moduleByFile.set(ref.file, ref.line);
        }
      }
      for (const [file, line] of moduleByFile) {
        out.push({ file, line });
      }
    }
    return out;
  }

  // Depth-N upstream blast radius. Walks the SAME cross-file caller-recovery
  // path as find_references (getReferencesByNameOrAlias + isCallerOf),
  // recursively. BFS so the node/breadth budget is spent on shallow,
  // highest-relevance callers first. Depth-1 children are exactly the
  // find_references caller set (grouped one node per caller symbol). The
  // amplification defenses are described above the CallerTreeNode type.
  getCallerTree(symbolId: string, opts: CallerTreeOptions = {}): CallerTreeResult {
    const maxDepth = opts.maxDepth ?? DEFAULT_CALLER_TREE_DEPTH;
    const maxBreadth = opts.maxBreadth ?? DEFAULT_CALLER_TREE_BREADTH;
    const maxNodes = opts.maxNodes ?? DEFAULT_CALLER_TREE_NODES;
    const includeWeak = opts.includeWeak ?? false;

    const target = this.symbolById.get(symbolId);
    if (!target) {
      const missing: CallerTreeNode = {
        symbolId, name: symbolId, file: '', line: 0, kind: null, depth: 0,
        strength: 'resolved', sites: [], confidence: 1, children: [],
        isCycle: false, isModuleLevel: false, leafByPolicy: false,
        depthCapped: false, truncatedChildren: 0,
      };
      return {
        root: missing, totalNodes: 0, truncated: false,
        limitations: CALLER_TREE_LIMITATIONS,
      };
    }

    const root: CallerTreeNode = {
      symbolId: target.id, name: target.name, file: target.file,
      line: target.startLine, kind: target.kind, depth: 0,
      strength: 'resolved', sites: [], confidence: 1, children: [],
      isCycle: false, isModuleLevel: false, leafByPolicy: false,
      depthCapped: false, truncatedChildren: 0,
    };

    const cache = new Map<string, Reference[]>();
    let totalNodes = 0;
    let truncated = false;

    interface Frame {
      node: CallerTreeNode;
      symbol: Symbol;
      ancestors: Set<string>;
    }
    const queue: Frame[] = [
      { node: root, symbol: target, ancestors: new Set([target.id]) },
    ];

    while (queue.length > 0) {
      const frame = queue.shift();
      if (!frame) break;
      const { node, symbol, ancestors } = frame;
      if (node.depth >= maxDepth) continue;

      const refs = this.resolveDirectCallers(symbol, cache);
      const groups = this.groupCallerRefs(refs, symbol);

      // Build candidate child nodes, then sort strongest-first before caps.
      const candidates = groups.map((g) => {
        const childSym =
          g.sourceId !== null ? this.symbolById.get(g.sourceId) ?? null : null;
        const earliest = g.sites.reduce((a, b) => (b.line < a.line ? b : a));
        const confidence =
          node.confidence * EDGE_WEIGHT[g.strength] * DEPTH_DECAY;
        const via = node.depth === 0 ? undefined : node.name;
        const child: CallerTreeNode = childSym
          ? {
              symbolId: childSym.id, name: childSym.name, file: childSym.file,
              line: childSym.startLine, kind: childSym.kind,
              depth: node.depth + 1, strength: g.strength, sites: g.sites,
              confidence, via, children: [], isCycle: false,
              isModuleLevel: false, leafByPolicy: false, depthCapped: false,
              truncatedChildren: 0,
            }
          : {
              // Module-level (or dangling sourceId): terminal leaf anchored at
              // the earliest call site. The renderer supplies the display
              // label from isModuleLevel — the index stays free of UI strings.
              symbolId: null, name: '', file: earliest.file, line: earliest.line,
              kind: null, depth: node.depth + 1, strength: g.strength,
              sites: g.sites, confidence, via, children: [], isCycle: false,
              isModuleLevel: true, leafByPolicy: false, depthCapped: false,
              truncatedChildren: 0,
            };
        return { child, symbol: childSym };
      });

      candidates.sort(
        (a, b) =>
          b.child.confidence - a.child.confidence ||
          STRENGTH_RANK[b.child.strength] - STRENGTH_RANK[a.child.strength] ||
          (a.child.file < b.child.file ? -1 : a.child.file > b.child.file ? 1 : 0) ||
          a.child.line - b.child.line,
      );

      let kept = candidates;
      if (candidates.length > maxBreadth) {
        node.truncatedChildren += candidates.length - maxBreadth;
        truncated = true;
        kept = candidates.slice(0, maxBreadth);
      }

      for (const { child, symbol: childSym } of kept) {
        if (totalNodes >= maxNodes) {
          node.truncatedChildren += 1;
          truncated = true;
          continue;
        }
        const cyclic = child.symbolId !== null && ancestors.has(child.symbolId);
        const atDepthWall = child.depth >= maxDepth;
        // include_weak is the explicit "accept the noise" override: it expands
        // every edge class AND bypasses the confidence floor (subject only to
        // depth/cycle/node caps). The default path expands only the stronger
        // classes above the floor, so one wrong weak edge can never fan out
        // into a false subtree.
        const policyOk = includeWeak || EXPANDABLE_BY_DEFAULT.has(child.strength);
        const confOk = includeWeak || child.confidence >= MIN_EXPAND_CONFIDENCE;
        const expandable =
          child.symbolId !== null && !cyclic && policyOk && confOk;

        // Coherent partition for a non-cyclic real-symbol child:
        //   not-expandable        -> leafByPolicy (weak edge class OR path
        //                            confidence below the floor) at ANY depth,
        //                            so include_weak is the actionable hint;
        //   expandable at the wall -> depthCapped (only the depth limit stops
        //                            it; "raise depth" is the hint);
        //   expandable, room left  -> recursed (no flag).
        // Module-level children (symbolId null) are terminal leaves handled by
        // isModuleLevel and need no flag.
        if (cyclic) {
          child.isCycle = true;
        } else if (!expandable && child.symbolId !== null) {
          child.leafByPolicy = true;
        } else if (expandable && atDepthWall) {
          child.depthCapped = true;
        }

        node.children.push(child);
        totalNodes++;

        if (expandable && !atDepthWall && childSym && child.symbolId) {
          queue.push({
            node: child,
            symbol: childSym,
            ancestors: new Set(ancestors).add(child.symbolId),
          });
        }
      }
    }

    return { root, totalNodes, truncated, limitations: CALLER_TREE_LIMITATIONS };
  }

  // Transitive blast radius (impact-set size) as a scalar — the same distinct
  // counting impact.ts renders, shared via countDistinctCallers so the two
  // surfaces agree. NOT tree.totalNodes, which double-counts a caller reached
  // through several upstream branches (a DAG diamond).
  getBlastRadius(symbolId: string, opts?: CallerTreeOptions): BlastRadius {
    const tree = this.getCallerTree(symbolId, opts);
    const counts = countDistinctCallers(tree.root);
    // Lower bound if EITHER a breadth/node cap fired OR the depth wall stopped
    // expansion — the scalar can't carry impact's two distinct hints, so one `+`.
    return {
      callers: counts.callers,
      files: counts.files,
      depths: counts.depths,
      truncated: tree.truncated || counts.depthCapped,
    };
  }

  // Risk Hotspots: files ranked by churn × coupling (the CodeScene/Feathers
  // intersection model — churny-but-decoupled and coupled-but-frozen both fall
  // away). Empty off-git (no churn signal). Hybrid for cost: rank a bounded
  // candidate set by the O(1) cached fan-in, run the expensive transitive
  // blast-radius walk only for the rows returned.
  getRiskHotspots(limit = DEFAULT_RISK_HOTSPOTS): RiskRow[] {
    if (this.gitMetaState === null) return [];

    // Tie-break the candidate cut by path so the slice is deterministic across
    // re-index orderings (getAllFiles is raw Map insertion order).
    const candidates = this.getAllFiles()
      .filter((f) => (f.commitFrequency ?? 0) > 0)
      .sort(
        (a, b) =>
          (b.commitFrequency ?? 0) - (a.commitFrequency ?? 0) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, RISK_CANDIDATE_FILES);
    if (candidates.length === 0) return [];

    // Per file the offender is its single highest-fan-in symbol (MAX, not sum:
    // a file's risk is its most-coupled hub, not a pile of trivial helpers).
    // Single pass — only the max is consumed.
    const scored: Array<{
      file: string;
      symbol: Symbol;
      fanIn: number;
      churn: number;
    }> = [];
    for (const f of candidates) {
      let best: Symbol | null = null;
      let bestFanIn = 0;
      for (const s of this.getSymbolsInFile(f.path)) {
        const fanIn = this.getCallerCount(s.id);
        if (fanIn > bestFanIn) {
          bestFanIn = fanIn;
          best = s;
        }
      }
      if (best && bestFanIn > 0) {
        scored.push({
          file: f.path,
          symbol: best,
          fanIn: bestFanIn,
          churn: f.commitFrequency ?? 0,
        });
      }
    }
    if (scored.length === 0) return [];

    // Product on a log scale (heavy-tailed counts). No Math.max(...spread)
    // anywhere — the ranking is a pure per-row product, so the RangeError
    // guard that gitBoostMap needs does not apply here. Tie-break by file so
    // equal-score rows order (and survive the limit slice) deterministically.
    const rows = scored
      .map((s) => ({ ...s, score: Math.log1p(s.churn) * Math.log1p(s.fanIn) }))
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
      .slice(0, Math.max(0, limit));

    // Expensive transitive walk ONLY for the displayed rows.
    return rows.map((r) => ({
      file: r.file,
      symbol: r.symbol.name,
      symbolId: r.symbol.id,
      churn: r.churn,
      fanIn: r.fanIn,
      blast: this.getBlastRadius(r.symbol.id, { maxDepth: RISK_BLAST_DEPTH }),
      score: r.score,
    }));
  }

  // Filtered + memoized direct callers of `target` — the same candidate set
  // find_references draws from (getReferencesByNameOrAlias + isCallerOf). The
  // underlying caller set is identical, but the RENDERED cardinality can differ:
  // the tree groups per caller symbol and caps breadth at
  // DEFAULT_CALLER_TREE_BREADTH, while find_references lists per ref-site and
  // caps weak member rows at WEAK_MEMBER_ROW_CAP.
  private resolveDirectCallers(
    target: Symbol,
    cache: Map<string, Reference[]>,
  ): Reference[] {
    const hit = cache.get(target.id);
    if (hit) return hit;
    const refs = this.getReferencesByNameOrAlias(
      target.name,
      target.file,
      isClassMember(target),
    ).filter((r) => isCallerOf(r, target));
    cache.set(target.id, refs);
    return refs;
  }

  // Collapse caller refs into one group per caller symbol (or per file for
  // module-level call sites): all call sites in `sites`, strongest edge wins.
  private groupCallerRefs(
    refs: Reference[],
    target: Symbol,
  ): Array<{ sourceId: string | null; sites: CallSite[]; strength: EdgeStrength }> {
    const groups = new Map<
      string,
      { sourceId: string | null; sites: CallSite[]; strength: EdgeStrength }
    >();
    for (const ref of refs) {
      const strength = this.edgeStrength(ref, target);
      const key = ref.sourceId ?? `\0module:${ref.file}`;
      let g = groups.get(key);
      if (!g) {
        g = { sourceId: ref.sourceId, sites: [], strength };
        groups.set(key, g);
      }
      g.sites.push({ file: ref.file, line: ref.line });
      if (STRENGTH_RANK[strength] > STRENGTH_RANK[g.strength]) {
        g.strength = strength;
      }
    }
    return [...groups.values()];
  }

  // Classify one caller edge by how strongly its source binds to `target`.
  private edgeStrength(ref: Reference, target: Symbol): EdgeStrength {
    if (ref.targetId !== null) return 'resolved';
    const imports = this.importsByFile.get(ref.file) ?? [];
    if (ref.receiver === undefined) {
      if (
        fileImportsName(imports, target.name) ||
        posix.dirname(ref.file) === posix.dirname(target.file)
      ) {
        return 'import-connected';
      }
      return 'name-match';
    }
    // An opaque (chained/computed) receiver can never name an import, so skip
    // the guaranteed-false scan and weak-classify directly — the same
    // short-circuit rankRefs applies, keeping the two classifiers in lockstep on
    // the hot impact caller-tree path (chained capture makes opaque dominant).
    return ref.receiver !== RECEIVER_OPAQUE && fileImportsReceiver(imports, ref.receiver)
      ? 'import-connected'
      : 'weak-member';
  }

  // Approximate caller count surfaced by find_symbol's `References: ~N`.
  // Reference-granular: one count per call site / `new` / JSX usage.
  // O(1) lookup against a lazily rebuilt cache — `find_symbol` calls
  // this once per result, so a per-call walk would be O(results × files
  // × imports). The full rebuild runs at most once between index updates.
  getCallerCount(symbolId: string): number {
    this.rebuildCallerCountsIfDirty();
    return this.callerCountById.get(symbolId) ?? 0;
  }

  getReferencesByName(name: string): Reference[] {
    const list = this.referencesByTargetName.get(name);
    return list ? [...list] : [];
  }

  // Alias-aware: includes refs whose `targetName` is a local alias of `name`
  // in the importing file (`import { name as alias }`; `alias()` site). The
  // extractor records the call-site identifier, so plain by-name lookup misses
  // these.
  //
  // When `targetFile` is provided, both alias refs AND unresolved primary
  // refs are scoped by import resolution — preventing cross-file leakage
  // when two files define a symbol with the same name. Within-file resolved
  // refs (targetId !== null) flow through; the caller's `isCallerOf` filter
  // rejects refs that precisely resolve to a different homonym.
  getReferencesByNameOrAlias(
    name: string,
    targetFile?: string,
    targetIsMember = false,
  ): Reference[] {
    const primary = this.referencesByTargetName.get(name) ?? [];
    const filteredPrimary =
      targetFile === undefined
        ? primary
        : primary.filter((ref) =>
            this.primaryRefMatchesTarget(ref, name, targetFile, targetIsMember),
          );
    const out = filteredPrimary.slice();
    const seen = new Set<Reference>(filteredPrimary);
    this.rebuildAliasIndexIfDirty();
    for (const entry of this.renamingAliasesByName.get(name) ?? []) {
      const { filePath, sourceModule, alias } = entry;
      if (targetFile !== undefined) {
        const importingFile = this.fileByPath.get(filePath);
        if (!importingFile) continue;
        const resolved = this.resolveImportTarget(importingFile, sourceModule);
        // Skip ONLY when the specifier resolves to a known different
        // file. null (unresolvable specifier — TS path alias, workspace
        // pkg, Python absolute import) falls through to best-effort
        // include; same policy as primaryRefMatchesTarget.
        if (resolved !== null && resolved !== targetFile) continue;
      }
      const aliasRefs = this.referencesByTargetName.get(alias);
      if (!aliasRefs) continue;
      for (const ref of aliasRefs) {
        if (ref.file !== filePath) continue;
        // `obj.h()` where h happens to equal a local import alias —
        // a member call's property never binds through a top-level
        // import; only bare `h()` sites do.
        if (ref.receiver !== undefined) continue;
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push(ref);
      }
    }
    return out;
  }

  getSymbolById(id: string): Symbol | undefined {
    return this.symbolById.get(id);
  }

  getImports(filePath: string): ImportInfo[] {
    const list = this.importsByFile.get(filePath);
    return list ? [...list] : [];
  }

  getStats(): IndexStats {
    const filesByLanguage: Record<string, number> = {};
    for (const fi of this.fileByPath.values()) {
      filesByLanguage[fi.language] = (filesByLanguage[fi.language] ?? 0) + 1;
    }

    const symbolsByKind = zeroSymbolsByKind();
    const entries: IndexStats['entryPoints'] = [];
    for (const sym of this.symbolById.values()) {
      symbolsByKind[sym.kind]++;
      if (sym.exported && ENTRY_POINT_FILENAME_RE.test(basename(sym.file))) {
        entries.push({ file: sym.file, symbol: sym.name, line: sym.startLine });
      }
    }
    entries.sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol),
    );

    return {
      totalFiles: this.fileByPath.size,
      totalSymbols: this.symbolById.size,
      filesByLanguage,
      symbolsByKind,
      entryPoints: entries.slice(0, 20),
    };
  }

  save(cachePath: string): Promise<void> {
    return this.runLocked(async () => {
      const allRefs: Reference[] = [];
      for (const refs of this.referencesBySourceFile.values()) {
        for (const ref of refs) allRefs.push(ref);
      }
      const data: PersistedSchema = {
        version: SCHEMA_VERSION,
        createdAt: Date.now(),
        projectRoot: this.projectRoot,
        symbols: [...this.symbolById.entries()],
        files: [...this.fileByPath.entries()],
        imports: [...this.importsByFile.entries()],
        callees: adjacencyToEntries(this.callees),
        callers: adjacencyToEntries(this.callers),
        references: allRefs,
        cochanges: [...this.cochangesByFile.entries()],
        hotspots: [...this.hotspotList],
        gitMeta: this.gitMetaState,
      };
      const json = JSON.stringify(data);
      const tmp = `${cachePath}.tmp.${process.pid}.${Date.now()}`;

      await fs.mkdir(dirname(cachePath), { recursive: true });

      try {
        const fh = await fs.open(tmp, 'w');
        try {
          await fh.writeFile(json);
          await fh.sync();
        } finally {
          await fh.close();
        }
        try {
          await fs.rename(tmp, cachePath);
        } catch {
          // Windows can't rename over an existing file; retry after unlink.
          await fs.unlink(cachePath).catch(() => undefined);
          await fs.rename(tmp, cachePath);
        }
      } catch (err) {
        await fs.unlink(tmp).catch(() => undefined);
        throw err;
      }
    });
  }

  async load(cachePath: string): Promise<boolean> {
    await this.cleanupStaleTmp(cachePath);

    let raw: string;
    try {
      raw = await fs.readFile(cachePath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        log.warn(
          `CodeIndex.load: failed to read cache at ${cachePath}: ${errMsg(err)}`,
        );
      }
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`CodeIndex.load: cache is malformed at ${cachePath}; deleting`);
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }

    if (!isValidPersisted(parsed, SCHEMA_VERSION)) {
      log.warn(
        `CodeIndex.load: cache failed validation at ${cachePath}; deleting`,
      );
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }
    if (this.projectRoot && parsed.projectRoot !== this.projectRoot) {
      log.warn(
        `CodeIndex.load: cache projectRoot mismatch (cache=${parsed.projectRoot}, ` +
          `expected=${this.projectRoot}); deleting`,
      );
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }

    const symbolById = new Map<string, Symbol>();
    const fileByPath = new Map<string, FileInfo>();
    const importsByFile = new Map<string, ImportInfo[]>();
    const symbolsByName = new Map<string, Symbol[]>();
    const symbolsByFile = new Map<string, Symbol[]>();
    const callees = new Map<string, Set<string>>();
    const callers = new Map<string, Set<string>>();
    const referencesByTargetName = new Map<string, Reference[]>();
    const referencesBySourceFile = new Map<string, Reference[]>();
    const cochangesByFile = new Map<string, CoChange[]>();
    const hotspotList: string[] = [];

    try {
      for (const [id, sym] of parsed.symbols) symbolById.set(id, sym);
      for (const [path, fi] of parsed.files) fileByPath.set(path, fi);
      for (const [path, imps] of parsed.imports) importsByFile.set(path, imps);
      for (const [src, targets] of parsed.callees) callees.set(src, new Set(targets));
      for (const [tgt, sources] of parsed.callers) callers.set(tgt, new Set(sources));
      for (const ref of parsed.references) {
        if (!isPersistedReference(ref)) {
          throw new Error('persisted reference has invalid shape');
        }
        pushOrInit(referencesByTargetName, ref.targetName, ref);
        pushOrInit(referencesBySourceFile, ref.file, ref);
      }
      for (const entry of parsed.cochanges) {
        if (
          !Array.isArray(entry) ||
          typeof entry[0] !== 'string' ||
          !Array.isArray(entry[1]) ||
          !entry[1].every(isPersistedCoChange)
        ) {
          throw new Error('persisted cochange entry has invalid shape');
        }
        cochangesByFile.set(entry[0], entry[1]);
      }
      for (const path of parsed.hotspots) {
        if (typeof path !== 'string') {
          throw new Error('persisted hotspot entry has invalid shape');
        }
        hotspotList.push(path);
      }

      // Seed entries for zero-symbol files so removeFile's symsInFile guard fires (mirrors addFile).
      for (const path of fileByPath.keys()) symbolsByFile.set(path, []);
      for (const sym of symbolById.values()) {
        pushOrInit(symbolsByName, sym.name, sym);
        pushOrInit(symbolsByFile, sym.file, sym);
      }
    } catch (err) {
      log.warn(
        `CodeIndex.load: cache failed validation at ${cachePath} (${errMsg(
          err,
        )}); deleting`,
      );
      await fs.unlink(cachePath).catch(() => undefined);
      return false;
    }

    this.symbolById = symbolById;
    this.fileByPath = fileByPath;
    this.importsByFile = importsByFile;
    this.symbolsByName = symbolsByName;
    this.symbolsByFile = symbolsByFile;
    this.callees = callees;
    this.callers = callers;
    this.referencesByTargetName = referencesByTargetName;
    this.referencesBySourceFile = referencesBySourceFile;
    this.cochangesByFile = cochangesByFile;
    this.hotspotList = hotspotList;
    this.gitMetaState = parsed.gitMeta;
    // Derived caches: reset; rebuild*IfDirty repopulates lazily.
    this.sortedNames = [];
    this.sortedNamesLower = [];
    this.searchIndex = null;
    this.namesDirty = true;
    this.callerCountById.clear();
    this.callerCountsDirty = true;
    this.aliasIndexDirty = true;
    this.filePathsDirty = true;

    return true;
  }

  private async cleanupStaleTmp(cachePath: string): Promise<void> {
    try {
      const dir = dirname(cachePath);
      const base = basename(cachePath);
      const entries = await fs.readdir(dir);
      const tmpPrefix = `${base}.tmp.`;
      await Promise.all(
        entries
          .filter((e) => e.startsWith(tmpPrefix))
          .map((e) => fs.unlink(join(dir, e)).catch(() => undefined)),
      );
    } catch {
      // ignore: parent dir may not exist yet
    }
  }

  private rebuildIndexesIfDirty(): void {
    if (!this.namesDirty) return;
    const names = [...this.symbolsByName.keys()];
    const pairs: Array<[string, string]> = names.map((n) => [n, n.toLowerCase()]);
    // Codepoint compare (not localeCompare) so sort order matches `lowerBound`'s `<`.
    pairs.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    this.sortedNames = pairs.map((p) => p[0]);
    this.sortedNamesLower = pairs.map((p) => p[1]);
    // All four fields are indexed so `searchSymbols` can match signatures
    // and docstrings, but the DEFAULT search options pin `fields` to
    // name+fqn — `suggest` (did-you-mean) must not surface doc-only hits.
    // BM25 stats are per-field, so suggest's scores are unchanged by the
    // extra indexed fields.
    this.searchIndex = new MiniSearch<Symbol>({
      fields: ['name', 'fqn', 'signature', 'doc'],
      idField: 'id',
      searchOptions: {
        fields: ['name', 'fqn'],
        fuzzy: 0.2,
        prefix: true,
        boost: { name: 2 },
      },
    });
    this.searchIndex.addAll([...this.symbolById.values()]);
    this.namesDirty = false;
  }

  private rebuildCallerCountsIfDirty(): void {
    if (!this.callerCountsDirty) return;
    this.callerCountById.clear();
    // isCallerOf rejects every UNRESOLVED ref for short names, so the
    // hot homonym buckets (`get`/`set`/`run` — mostly unresolved member
    // calls) are pre-filtered to resolved refs ONCE per name instead of
    // rescanned in full per same-named symbol. The predicate stays
    // isCallerOf so counts can never desync from find_references' rows.
    const resolvedShortRefs = new Map<string, Reference[]>();
    for (const sym of this.symbolById.values()) {
      let count = 0;
      if (sym.name.length < SHORT_NAME_THRESHOLD) {
        let resolved = resolvedShortRefs.get(sym.name);
        if (!resolved) {
          resolved = (this.referencesByTargetName.get(sym.name) ?? []).filter(
            (r) => r.targetId !== null,
          );
          resolvedShortRefs.set(sym.name, resolved);
        }
        for (const ref of resolved) {
          if (isCallerOf(ref, sym)) count++;
        }
      } else {
        const refs = this.getReferencesByNameOrAlias(
          sym.name,
          sym.file,
          isClassMember(sym),
        );
        for (const ref of refs) {
          if (isCallerOf(ref, sym)) count++;
        }
      }
      // Skip zero-count entries — getCallerCount returns `?? 0`, so the
      // observable behavior is identical and we save one Map slot per
      // never-called helper (common for leaf utilities).
      if (count > 0) this.callerCountById.set(sym.id, count);
    }
    this.callerCountsDirty = false;
  }

  private rebuildFilePathsIfDirty(): void {
    if (!this.filePathsDirty) return;
    this.sortedFilePaths = [...this.fileByPath.keys()].sort();
    this.filePathsDirty = false;
  }

  private rebuildAliasIndexIfDirty(): void {
    if (!this.aliasIndexDirty) return;
    this.renamingAliasesByName.clear();
    for (const [filePath, imports] of this.importsByFile) {
      for (const imp of imports) {
        for (const named of imp.importedNames) {
          if (!named.alias || named.alias === named.name) continue;
          // Renaming type-only aliases (`import type { X as Y }`) are
          // erased at runtime; their alias-named call sites can't bind
          // through the import.
          if (!isValueBinding(named)) continue;
          pushOrInit(this.renamingAliasesByName, named.name, {
            filePath,
            sourceModule: imp.sourceModule,
            alias: named.alias,
          });
        }
      }
    }
    this.aliasIndexDirty = false;
  }

  private resolveIds(ids: Iterable<string> | undefined): Symbol[] {
    if (!ids) return [];
    const out: Symbol[] = [];
    for (const id of ids) {
      const sym = this.symbolById.get(id);
      if (sym) out.push(sym);
    }
    return out;
  }

  private runLocked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(work);
    // Swallow rejections on the lock chain so one failed save doesn't block
    // future ones; the original promise still rejects to the caller.
    this.writeLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // Decides whether a primary ref should be attributed to `targetFile`.
  // Resolved refs (targetId !== null) always flow through — `isCallerOf`
  // filters precise mismatches downstream. For unresolved refs the policy
  // distinguishes four states of the source file's matching imports:
  //
  // - resolves to targetFile → include (precise match);
  // - resolves to a different indexed file → drop (binds elsewhere);
  // - matches but specifier is unresolvable (TS path alias, workspace
  //   pkg, Python absolute) → fall through to best-effort include;
  // - no matching import at all → drop. The bare `name()` call binds
  //   to a parameter, local, nested-function, or global — attributing
  //   it to every same-named export is wrong.
  private primaryRefMatchesTarget(
    ref: Reference,
    name: string,
    targetFile: string,
    targetIsMember: boolean,
  ): boolean {
    if (ref.targetId !== null) return true;
    if (ref.receiver !== undefined) {
      return this.memberRefMatchesTarget(ref, ref.receiver, targetFile, targetIsMember);
    }
    const importingFile = this.fileByPath.get(ref.file);
    if (!importingFile) return true;
    // Go: files of one package call each other's top-level functions with
    // NO import statement (the no-matching-import drop below would hide
    // every sibling-file caller — the dominant Go call pattern). One
    // directory = one package, so a same-directory bare ref is attributed
    // directly — but only to a top-level Go target: a bare Go identifier
    // can never bind to a same-named TS/Python symbol that happens to share
    // the directory, nor to a struct FIELD or other member (members are
    // reachable only through a receiver). `_test` files share the directory
    // and slip through; acceptable — they really do call the target.
    if (
      !targetIsMember &&
      importingFile.language === 'go' &&
      this.fileByPath.get(targetFile)?.language === 'go' &&
      posix.dirname(ref.file) === posix.dirname(targetFile)
    ) {
      return true;
    }
    const imports = this.importsByFile.get(ref.file) ?? [];
    let hasUnresolvableMatch = false;
    for (const imp of imports) {
      for (const named of imp.importedNames) {
        if (isWildcardImport(named)) {
          const resolved = this.resolveImportTarget(importingFile, imp.sourceModule);
          if (resolved === null) {
            hasUnresolvableMatch = true;
          } else if (resolved === targetFile) {
            return true;
          }
          continue;
        }
        const localName = named.alias ?? named.name;
        if (localName !== name) continue;
        if (!isValueBinding(named)) continue;
        // The local binding `name` is an alias for a different export.
        // The alias loop attributes via resolveImportTarget; skip here
        // so the ref isn't double-attributed to a same-named homonym.
        if (isRenamingNamedAlias(named)) return false;
        const resolved = this.resolveImportTarget(importingFile, imp.sourceModule);
        if (resolved === null) {
          hasUnresolvableMatch = true;
          continue;
        }
        if (resolved === targetFile) return true;
        // Specifier resolves to a different indexed file: bare `name`
        // binds elsewhere. JS/TS forbids duplicate top-level bindings,
        // so no other matching import can change that.
        return false;
      }
    }
    return hasUnresolvableMatch;
  }

  // Scoping for unresolved member refs (`receiver.name()`). Deliberately
  // asymmetric with the bare-name policy above: a bare `save()` with no
  // matching import provably binds locally (drop), but `obj.save()` says
  // nothing about where obj's class lives — and methods are unreachable
  // by any other Phase-1 mechanism — so unknown receivers weakly include
  // (recall over precision; isCallerOf and output labeling counterbalance).
  // Module/namespace receivers ARE statically resolvable: `utils.foo()`
  // binds to an export of whatever module `utils` names, so those admit
  // or drop precisely.
  private memberRefMatchesTarget(
    ref: Reference,
    receiver: string,
    targetFile: string,
    targetIsMember: boolean,
  ): boolean {
    // An opaque (chained/computed) receiver can never name an import binding,
    // so the scan below would always fall through to the weak include — skip
    // it, matching rankRefs and edgeStrength (the sibling classifiers named in
    // types.ts), which both short-circuit the same guaranteed-false scan for
    // RECEIVER_OPAQUE. Keeps the three in lockstep on the hot per-call path
    // (chained capture makes opaque the dominant member-ref shape).
    if (receiver === RECEIVER_OPAQUE) return true;
    const importingFile = this.fileByPath.get(ref.file);
    if (!importingFile) return true;
    for (const imp of this.importsByFile.get(ref.file) ?? []) {
      for (const named of imp.importedNames) {
        if ((named.alias ?? named.name) !== receiver) continue;
        if (named.kind === 'namespace' || named.kind === 'module') {
          // Module-object access reaches only TOP-LEVEL exports —
          // `utils.save()` can never invoke `Cache.prototype.save`, so a
          // class-member target is out of reach through this binding.
          if (targetIsMember) return false;
          const resolved = this.resolveImportTarget(
            importingFile,
            moduleSpecifierFor(imp, named),
          );
          if (resolved === null) return true; // path alias / absolute py — best effort
          return resolved === targetFile;
        }
        // Type-only bindings are erased at runtime; member access through
        // them can't be a call into the target.
        if (named.kind === 'type') return false;
        // Value binding: the receiver is an object, and the defining file
        // of its class is statically unknowable — weak include.
        return true;
      }
    }
    // Unknown receiver (local, parameter, field) — weak name-grade match.
    return true;
  }

  // Returns the indexed file the specifier resolves to, or null if the
  // specifier is unrecognized (TS path alias, workspace pkg, Python
  // absolute import) or if no candidate is indexed. Picks the FIRST
  // indexed candidate (direct match, then suffix candidates in
  // language-specific order) — when the same stem is indexed under
  // multiple extensions (`foo.ts` AND `foo.js`), this disambiguates to
  // one. The candidate list and order come from `normalizeImportSpecifier`
  // and depend on the importer's language and the specifier's explicit
  // extension — see the *_CANDIDATES constants.
  private resolveImportTarget(
    importingFile: FileInfo,
    sourceModule: string,
  ): string | null {
    const norm = normalizeImportSpecifier(importingFile, sourceModule);
    if (norm === null) return null;
    const baseDir = posix.dirname(importingFile.path);
    const resolved = posix.join(baseDir, norm.specifier);
    if (this.fileByPath.has(resolved)) return resolved;
    for (const suffix of norm.candidates) {
      const candidate = resolved + suffix;
      if (this.fileByPath.has(candidate)) return candidate;
    }
    return null;
  }
}

interface NormalizedSpecifier {
  // Resolved stem to which `candidates` are appended (relative to the
  // importing file's directory). May be the original specifier, a stripped
  // form, or a Python-translated path.
  specifier: string;
  // Candidate suffixes tried in order after a direct-match miss. Selected
  // per importer language so the loop never tries impossible targets
  // (e.g., `.ts` for a Python importer).
  candidates: readonly string[];
}

// Translates a raw import specifier into a POSIX relative path plus the
// candidate-suffix order that should follow. Returns null for specifiers
// that can't be resolved without project config (bare specifiers, TS path
// aliases, Python absolute imports, bare-package Python imports like
// `from . import x` whose target is reached via the imported NAME).
function normalizeImportSpecifier(
  importingFile: FileInfo,
  sourceModule: string,
): NormalizedSpecifier | null {
  // Python relative imports use dot-prefix syntax with no slashes:
  // `.utils`, `..pkg.sub`. n leading dots = (n-1) levels up; remaining
  // dots in the module path are package separators → '/'.
  if (importingFile.language === 'python') {
    const m = sourceModule.match(/^(\.+)(.*)$/);
    if (!m) return null;
    const [, dots, rest] = m;
    if (rest.length === 0) return null;
    const upParts = Array(dots.length - 1).fill('..');
    return {
      specifier: posix.join(...upParts, rest.replace(/\./g, '/')),
      candidates: PY_CANDIDATES,
    };
  }
  if (!sourceModule.startsWith('.')) return null;
  // JS importers can't resolve to TS source at runtime — keep explicit
  // extensions exact so the resolution returns the actual JS file. The
  // JS candidate list still includes `.ts/.tsx` as a fallback for the
  // extensionless case (`./foo`) under allowJs/checkJs projects.
  if (importingFile.language === 'javascript') {
    return { specifier: sourceModule, candidates: JS_CANDIDATES };
  }
  // TS/TSX with `.jsx` specifier: Node16/NodeNext emits `.jsx` for `.tsx`
  // source. Strip and use TS_FROM_JSX_CANDIDATES so `.tsx` wins over
  // `.ts` at the same stem.
  if (sourceModule.endsWith('.jsx')) {
    return {
      specifier: sourceModule.slice(0, -'.jsx'.length),
      candidates: TS_FROM_JSX_CANDIDATES,
    };
  }
  // TS/TSX with `.js` specifier: strip and use TS_FROM_JS_CANDIDATES so
  // explicit `.js` siblings beat `.ts` at the same stem (hand-written JS
  // in mixed repos), while still falling back to `.ts` when only the
  // source is indexed (Node16/NodeNext emit case). `.mjs`/`.cjs` are
  // literal JS targets — `endsWith('.js')` doesn't match them, so they
  // fall through to direct match. Direct `.ts`/`.tsx` specifiers also
  // fall through. (Add `.mts`/`.cts` to scanner + candidate lists if
  // those source kinds are ever supported.)
  if (sourceModule.endsWith('.js')) {
    return {
      specifier: sourceModule.slice(0, -'.js'.length),
      candidates: TS_FROM_JS_CANDIDATES,
    };
  }
  return { specifier: sourceModule, candidates: TS_CANDIDATES };
}

// Resolvable specifier for a module-object binding. Python's bare-dot form
// (`from . import x`, `from .. import x`) binds the SUBMODULE x — the real
// specifier is the dots plus the bound name; everything else (TS namespace
// imports, Python `import a.b`) resolves by sourceModule directly. The
// kind gate matters: a TS `import * as pkg from '.'` has named.name '*'
// (the namespace sentinel), which must NOT be appended to the dots.
function moduleSpecifierFor(imp: ImportInfo, named: ImportedName): string {
  return named.kind === 'module' &&
    /^\.+$/.test(imp.sourceModule) &&
    named.name !== imp.sourceModule
    ? `${imp.sourceModule}${named.name}`
    : imp.sourceModule;
}

// `import { X as Y }` where X is a regular identifier (not default or
// namespace) and X !== Y. The local binding Y points to export X — bare
// `Y()` calls bind to X, so same-name scoping by Y would misattribute.
function isRenamingNamedAlias(named: ImportedName): boolean {
  return (
    named.alias !== undefined &&
    named.alias !== named.name &&
    named.name !== IMPORT_DEFAULT &&
    named.name !== IMPORT_NAMESPACE
  );
}

// Python `from .x import *` — `alias === undefined` distinguishes it from
// TS `import * as ns from './x'`, which carries alias='ns' and exposes
// member access only (bare callees don't bind through it).
export function isWildcardImport(named: ImportedName): boolean {
  return named.name === IMPORT_NAMESPACE && named.alias === undefined;
}

// Bindings where bare `localName()` is a legitimate value-callable site.
// kind='type' (TS `import type`), 'namespace' (TS `import * as ns`), and
// 'module' (Python `import x` / `from . import x`) all bind something
// that throws TypeError when invoked directly, so they shouldn't be
// admitted as evidence that a bare call resolves through the import.
// Absent kind defaults to 'value' for legacy persisted indexes.
function isValueBinding(named: ImportedName): boolean {
  return named.kind === undefined || named.kind === 'value';
}

// Filters refs to those that should be surfaced as callers of `target`.
// Used by both find_references's renderCallers and getCallerCount so the
// rendered list and `References: ~N` always agree.
export function isCallerOf(ref: Reference, target: Symbol): boolean {
  // Recursion: target calling itself.
  if (ref.sourceId === target.id) return false;
  // Homonym already resolved precisely to a different same-named symbol.
  if (ref.targetId !== null && ref.targetId !== target.id) return false;
  if (ref.targetId === null) {
    const isMember = ref.receiver !== undefined;
    // Go package scope: a top-level name is unique within a package (one
    // directory), so same-directory Go refs warrant two exceptions below —
    // unexported MEMBERS are reachable package-wide, and a bare `Pairs{}`
    // composite literal / `Pairs(x)` conversion can only mean THE type.
    // Computed lazily: only the two carve-out branches consult it, and the
    // dominant refs (exported members, bare function calls, short names)
    // never reach them, so the dirname work is usually skipped.
    const goSamePackage = (): boolean =>
      target.language === 'go' &&
      ref.file.endsWith('.go') &&
      posix.dirname(ref.file) === posix.dirname(target.file);
    // Self-receiver refs (extractor-determined: TS `this` node, Python
    // self/cls) that extract-time resolution did NOT bind to a sibling
    // method can only target an inherited method — LSP territory. An
    // ordinary receiver merely NAMED `self` is not affected.
    if (isMember && ref.selfReceiver) return false;
    // Bare-name matches never bind to method/interface/type — bare
    // `save()` calls a top-level function, not `C.prototype.save`.
    // Member matches (`obj.save()`) ARE evidence for methods — the point
    // of member extraction — but still never for interface/type, which
    // are never invoked at runtime. Go 'type'-kind symbols are the
    // exception: a same-package BARE composite literal / conversion
    // (`Pairs{}`, `Pairs(x)`) does target the type, and extract-time
    // resolution covers same-file only.
    if (
      NON_CALLABLE_KINDS.has(target.kind) &&
      !(isMember && target.kind === 'method') &&
      !(!isMember && target.kind === 'type' && goSamePackage())
    ) {
      return false;
    }
    // Short names like `do`/`is` (and `x.get()`/`x.set()`) flood with
    // cross-file false matches; only count precisely-resolved refs.
    if (target.name.length < SHORT_NAME_THRESHOLD) return false;
    // Cross-file member access can only reach exported targets. (Python
    // exported-ness is the __all__/underscore heuristic, so legal
    // `utils._helper()` access is filtered — accepted Phase-1 precision.)
    // Go same-package siblings reach unexported MEMBERS (methods and
    // func-typed fields) legally — the member analog of the same-package
    // bare carve-out. Gated on the target actually being a member: a member
    // ref (`x.foo()`) can never reach a top-level function or variable.
    if (
      isMember &&
      ref.file !== target.file &&
      !target.exported &&
      !(isClassMember(target) && goSamePackage())
    ) {
      return false;
    }
  }
  return true;
}

export function isClassMember(s: Symbol): boolean {
  return classNameFromFqn(s.fqn) !== null;
}

// Distinct transitive callers under a caller-tree root. Walks EVERY emitted
// node (cycles included — shown once) and dedupes by symbolId, falling back to
// `m:file:line` for module-level call sites (null symbolId). This is the exact
// counting impact.ts renders ("N callers across D depths (F files)"), shared so
// impact and the risk surface never diverge — and deduped, unlike
// CallerTreeResult.totalNodes which double-counts DAG diamonds.
export function countDistinctCallers(root: CallerTreeNode): CallerCounts {
  const callers = new Set<string>();
  const files = new Set<string>();
  const depths = new Set<number>();
  let depthCapped = false;
  const walk = (node: CallerTreeNode): void => {
    for (const child of node.children) {
      callers.add(child.symbolId ?? `m:${child.file}:${child.line}`);
      files.add(child.file);
      depths.add(child.depth);
      if (child.depthCapped) depthCapped = true;
      walk(child);
    }
  };
  walk(root);
  return { callers: callers.size, files: files.size, depths: depths.size, depthCapped };
}

// True when `imports` brings `name` into scope as a value binding the bare
// call site could resolve to (named import, alias, or wildcard). Shared by
// getCallerTree's edge classification and find_references' rankRefs so the
// two stay in lockstep — a one-sided edit would desync impact's edge labels
// from find_references' caller tiers.
export function fileImportsName(imports: ImportInfo[], name: string): boolean {
  for (const imp of imports) {
    for (const named of imp.importedNames) {
      if (named.name === name || named.alias === name) return true;
      if (isWildcardImport(named)) return true;
    }
  }
  return false;
}

// True when `receiver` names a namespace/module import in `imports` — the only
// receiver bindings whose target module is statically resolvable. Shared with
// find_references' rankRefs (see fileImportsName).
export function fileImportsReceiver(
  imports: ImportInfo[],
  receiver: string,
): boolean {
  for (const imp of imports) {
    for (const named of imp.importedNames) {
      if (named.kind !== 'namespace' && named.kind !== 'module') continue;
      if ((named.alias ?? named.name) === receiver) return true;
    }
  }
  return false;
}

export function matchesKindScope(
  s: Symbol,
  kind?: SymbolKind,
  scope?: string,
): boolean {
  if (kind && s.kind !== kind) return false;
  if (!scope) return true;
  return scope.endsWith('/') ? s.file.startsWith(scope) : s.file === scope;
}

function pushOrInit<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addAdjacency(
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

function pruneAdjacency(
  map: Map<string, Set<string>>,
  deleted: Set<string>,
): void {
  for (const [key, set] of map) {
    for (const id of deleted) set.delete(id);
    if (set.size === 0) map.delete(key);
  }
}

function adjacencyToEntries(
  map: Map<string, Set<string>>,
): Array<[string, string[]]> {
  const out: Array<[string, string[]]> = [];
  for (const [k, set] of map) out.push([k, [...set]]);
  return out;
}

function lowerBound(arr: string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isPersistedReference(ref: unknown): ref is Reference {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  return (
    (r.sourceId === null || typeof r.sourceId === 'string') &&
    (r.targetId === null || typeof r.targetId === 'string') &&
    typeof r.targetName === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.file === 'string' &&
    typeof r.line === 'number' &&
    (r.receiver === undefined || typeof r.receiver === 'string') &&
    (r.selfReceiver === undefined || typeof r.selfReceiver === 'boolean')
  );
}

function isPersistedCoChange(value: unknown): value is CoChange {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.fileA === 'string' &&
    typeof c.fileB === 'string' &&
    typeof c.sharedCommits === 'number' &&
    typeof c.confidenceAB === 'number' &&
    typeof c.confidenceBA === 'number' &&
    typeof c.lastSeen === 'number'
  );
}

function isPersistedGitMeta(value: unknown): value is GitMeta {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.head === 'string' &&
    typeof m.windowDays === 'number' &&
    typeof m.analyzedAt === 'number'
  );
}

function isValidPersisted(
  data: unknown,
  expectedVersion: number,
): data is PersistedSchema {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.version === expectedVersion &&
    typeof d.createdAt === 'number' &&
    typeof d.projectRoot === 'string' &&
    Array.isArray(d.symbols) &&
    Array.isArray(d.files) &&
    Array.isArray(d.imports) &&
    Array.isArray(d.callees) &&
    Array.isArray(d.callers) &&
    Array.isArray(d.references) &&
    Array.isArray(d.cochanges) &&
    Array.isArray(d.hotspots) &&
    (d.gitMeta === null || isPersistedGitMeta(d.gitMeta))
  );
}
