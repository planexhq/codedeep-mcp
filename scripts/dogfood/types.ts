// Record shapes for the dogfooding harness. The run.json artifact is a
// serialized RunRecord; report.md is rendered from the same data.

import type { IndexStats } from '../../src/types.js';

// One invocation of one tool against one selected input.
export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  // Where the input came from: which selection bucket + the seed, so an
  // empty result on a top-referenced symbol reads as a finding while an
  // empty result on a random leaf reads as expected.
  provenance: string;
  // !isError && !isEmpty — matches the report's per-tool ok/empty/error
  // partition exactly, so run.json and report.md can never disagree.
  ok: boolean;
  isError: boolean;
  isEmpty: boolean;
  bytes: number;
  estTokens: number;
  wallMs: number;
  // Heuristic flags pulled from the output text for the report's gap scan.
  notes: string[];
  // First ~1500 chars for the report; full text dumped to a file by report.ts.
  textPreview: string;
  // Transient: full output text, moved to disk + dropped before run.json.
  fullText?: string;
  // Relative path under the run dir where the full text was dumped.
  textPath?: string;
}

export type OracleVerdict = 'clean' | 'suspicious' | 'mismatch' | 'info' | 'skipped';

export interface OracleResult {
  oracle: 'ripgrep' | 'file-slice' | 'git-log' | 'symbol-sanity';
  target: string;
  verdict: OracleVerdict;
  detail: string;
  data?: Record<string, unknown>;
}

export interface Timing {
  // Clean indexAll() wall-clock (ms).
  indexAllMs: number;
  // Warm reload + indexChanged() wall-clock (ms), or null if not measured.
  indexChangedMs: number | null;
  // GitService.start() wall-clock (ms), or null if git disabled.
  gitStartMs: number | null;
  peakHeapBytes: number;
  peakRssBytes: number;
  cacheBytes: number | null;
}

export interface RepoResult {
  name: string;
  url: string;
  commit: string;
  lang: string;
  dimension: string;
  // Set only on a catastrophic failure (clone/index threw); the run
  // continues with the next repo.
  error?: string;
  stats: IndexStats | null;
  timing: Timing | null;
  gitState: string;
  // ext -> count for unknown-language ("Other files") — drives the
  // Go/Rust accuracy check.
  otherFilesByExt: Record<string, number>;
  calls: ToolCallRecord[];
  oracles: OracleResult[];
  // Auto-detected gap flags, human-readable, for the report's Gaps section.
  gaps: string[];
}

export interface RunRecord {
  harnessVersion: string;
  startedAt: string;
  finishedAt: string;
  seed: number;
  node: string;
  probeMcpCommit: string;
  cleanCache: boolean;
  repos: RepoResult[];
}
