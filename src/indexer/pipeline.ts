import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { errMsg, log } from '../logger.js';
import { LANGUAGE_UNKNOWN, type FileInfo, type CodedeepConfig } from '../types.js';
import { CodeIndex } from './code-index.js';
import { extractSymbols } from './extractor.js';
import { initParser, parseFile, type Tree } from './parser.js';
import {
  compileExcludeMatcher,
  detectLanguage,
  isBinaryByContent,
  isBinaryByExtension,
  refineHeaderLanguage,
  scanProject,
  toPosix,
} from './scanner.js';

const BATCH_SIZE = 50;

// The ONE no-change policy, applied by both indexChanged's scan diff and
// indexFile's single-file path. mtime alone misses content swaps under
// coarse-resolution filesystems or `cp -p` / archive extraction that
// preserves timestamps; comparing size catches the common case cheaply.
// indexFile additionally hash-verifies (see indexFileInner) because it
// runs in response to an explicit fs event.
// `language` is the freshly DETECTED language for the path: an upgrade
// that teaches the scanner a new extension (e.g. `.java`) reclassifies
// files a cached index recorded as 'unknown' — those must re-index even
// though their bytes never changed, or the new language stays inert on
// every warm cache.
function isUnchanged(
  prev: FileInfo | undefined,
  mtimeMs: number,
  size: number,
  language: string,
): boolean {
  return (
    prev !== undefined &&
    prev.lastModified === mtimeMs &&
    prev.size === size &&
    prev.language === language
  );
}

// Exported so the note store's staleness check can re-hash an anchored file
// from disk with the SAME algorithm the indexer records in FileInfo.contentHash
// — staleness compares against DISK, not the (possibly-lagging) live index.
export function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16);
}

// Outcome of a single-file index request. The watcher keys its retry and
// save decisions on these:
//   'indexed'     — file (re)parsed and the index updated
//   'removed'     — the file's index entries were removed
//   'noop'        — completed without mutating the index (unchanged file,
//                   outside-root path, already-absent deletion, ...)
//   'cap-skipped' — a NEW file refused because the index is at maxFiles;
//                   retryable once a same-batch deletion frees a slot
//   'dropped'     — refused by the concurrency guard; retry later
export type IndexFileResult =
  | 'indexed'
  | 'removed'
  | 'noop'
  | 'cap-skipped'
  // Grammar load failed for this file's language — the file itself was NOT
  // judged (existing symbols kept, nothing deleted). Terminal for this event:
  // the loader already retried in place (parser.ts ensureLanguage's bounded
  // backoff), so a surviving failure is durable and re-queueing would only
  // cycle the watcher's retry tick. Recovery rides the next fs event or
  // rescan (the loader's memo self-resets on failure).
  | 'transient'
  | 'dropped';

export class Indexer {
  readonly cachePath: string;
  private readonly matchExclude: (relPath: string) => boolean;
  private indexing = false;
  private done = 0;
  private total = 0;
  ready = false;
  // Whether the most recent indexAll/indexChanged saw a COMPLETE scan.
  // A partial scan (transient readdir failure) resolves successfully but
  // preserves unseen cached entries — the watcher must know the rescan
  // it requested may not have covered everything.
  private lastScanCompleteFlag = true;
  // Languages whose grammar-load failure was already warned — dedupes the
  // per-file warn in processFile (one line per failure EPISODE per language,
  // not one per file). Entries clear on the next successful load.
  private readonly grammarWarnedLangs = new Set<string>();

  get lastScanComplete(): boolean {
    return this.lastScanCompleteFlag;
  }

  constructor(
    private readonly config: CodedeepConfig,
    private readonly index: CodeIndex,
  ) {
    this.cachePath = join(config.cacheDir, 'index.json');
    this.matchExclude = compileExcludeMatcher(config.exclude);
  }

  get isIndexing(): boolean {
    return this.indexing;
  }

  get progress(): { done: number; total: number } {
    return { done: this.done, total: this.total };
  }

  // indexAll/indexChanged resolve `true` when the work ran and `false`
  // when the concurrency guard dropped the request; indexFile returns the
  // richer IndexFileResult so the watcher can tell mutation from idle
  // work and retry what deserves retrying.
  async indexAll(): Promise<boolean> {
    return this.runGuarded(async () => {
      // Scan FIRST, then load only the grammars the repo actually contains —
      // loading all 16 up front costs ~95MB RSS on a repo that needs one.
      const { files: current, complete } = await scanProject(this.config);
      await this.warmUpGrammars(current);
      this.lastScanCompleteFlag = complete;

      this.total = current.length;
      await this.processBatched(current);

      // Prune cached entries no longer in the scan, but only when the scan
      // was complete. A partial scan (transient readdir/stat failure) would
      // otherwise drop valid symbols until the next clean run.
      if (complete) {
        const currentPaths = new Set(current.map((f) => f.path));
        for (const existing of this.index.getAllFiles()) {
          if (!currentPaths.has(existing.path)) {
            this.index.removeFile(existing.path);
          }
        }
      } else {
        log.warn(
          'Indexer.indexAll: scan incomplete; preserving cached entries not seen in this scan',
        );
      }

      await this.persist();
      this.ready = true;
    });
  }

  async indexChanged(): Promise<boolean> {
    return this.runGuarded(async () => {
      const { files: current, complete } = await scanProject(this.config);
      this.lastScanCompleteFlag = complete;

      const previous = new Map(
        this.index.getAllFiles().map((f) => [f.path, f]),
      );
      const toIndex: FileInfo[] = [];
      for (const f of current) {
        const prev = previous.get(f.path);
        if (!isUnchanged(prev, f.lastModified, f.size, f.language)) {
          toIndex.push(f);
        }
        previous.delete(f.path);
      }

      let deletedCount = 0;
      if (complete) {
        deletedCount = previous.size;
        for (const stalePath of previous.keys()) {
          this.index.removeFile(stalePath);
        }
      } else if (previous.size > 0) {
        log.warn(
          `Indexer.indexChanged: scan incomplete; preserving ${previous.size} cached entries not seen`,
        );
      }

      if (toIndex.length === 0 && deletedCount === 0) {
        log.debug('Indexer: indexChanged found no changes');
        this.ready = true;
        return;
      }

      // Load only the grammars the CHANGED files need — the common warm start
      // (few or no changes) then loads few or no grammars at all.
      await this.warmUpGrammars(toIndex);
      this.total = toIndex.length;
      await this.processBatched(toIndex);
      await this.persist();
      this.ready = true;
    });
  }

  // Does NOT call save() — callers debounce events and batch persistence themselves.
  async indexFile(rawPath: string): Promise<IndexFileResult> {
    let outcome: IndexFileResult = 'noop';
    const ran = await this.runGuarded(async () => {
      outcome = await this.indexFileInner(rawPath);
    });
    return ran ? outcome : 'dropped';
  }

  private async indexFileInner(rawPath: string): Promise<IndexFileResult> {
    // No up-front initParser: processFile ensures the ONE grammar this file
    // needs right before parsing (a watcher event on an unchanged file then
    // loads nothing at all).
    // Canonicalize to a project-relative POSIX path so the cache key
    // aligns with the scanner's `src/a.ts` form regardless of whether
    // the watcher emits an absolute path, a `./`-prefix, or Windows
    // backslashes. Mismatched keys would orphan stale symbols and
    // create duplicate entries on update.
    const projectRoot = this.config.projectRoot;
    const absInput = isAbsolute(rawPath) ? rawPath : join(projectRoot, rawPath);
    const relPath = toPosix(relative(projectRoot, absInput));
    if (relPath === '' || relPath === '..' || relPath.startsWith('../')) {
      log.debug(`Indexer.indexFile: skip ${rawPath} (outside project root)`);
      return 'noop';
    }
    const removed = (): IndexFileResult =>
      this.index.removeFile(relPath) ? 'removed' : 'noop';
    if (this.matchExclude(relPath) || isBinaryByExtension(relPath)) {
      return removed();
    }

    // Stat before language detection so deletions and size-cap rejections
    // remove cached entries even for unknown-language files.
    const absPath = join(this.config.projectRoot, relPath);
    let stats;
    try {
      stats = await fs.lstat(absPath);
    } catch (err) {
      log.debug(
        `Indexer.indexFile: stat failed for ${relPath} (${errMsg(err)}); treated as deletion`,
      );
      return removed();
    }
    if (stats.isSymbolicLink()) {
      log.debug(`Indexer.indexFile: skip ${relPath} (symlink)`);
      return removed();
    }
    // FIFOs/sockets/devices must not reach isBinaryByContent — opening
    // a writer-less named pipe blocks forever and would wedge the
    // watcher's flush chain. (Directories land here too when called
    // directly; the watcher routes those to a rescan first.)
    if (!stats.isFile()) {
      log.debug(`Indexer.indexFile: skip ${relPath} (not a regular file)`);
      return removed();
    }
    // Mirror the scanner's maxFiles cap for files not already indexed —
    // without this, watcher events could grow the index unboundedly
    // past the configured bound until the next full scan prunes it.
    if (
      this.config.maxFiles > 0 &&
      !this.index.hasFile(relPath) &&
      this.index.fileCount >= this.config.maxFiles
    ) {
      log.debug(
        `Indexer.indexFile: skip ${relPath} (index at maxFiles=${this.config.maxFiles})`,
      );
      return 'cap-skipped';
    }
    // Metadata-only events (and the trailing event of an atomic-save
    // pair) would otherwise pay a full parse + index update + save. But
    // mtime+size alone cannot distinguish an atomic-save echo from a
    // REAL second same-size edit landing in the same coarse-mtime tick
    // (HFS+/FAT/NFS report whole seconds) — an explicit fs event fired,
    // so verify by content hash (read without parse) before skipping.
    let language = detectLanguage(relPath) ?? LANGUAGE_UNKNOWN;
    // A `.h` mapped to 'cpp' may be an Objective-C header — content-sniff it (no-op
    // unless `.h` AND objc configured). MUST run before isUnchanged (which compares
    // the stored language), so a `.h` re-classified by a heuristic tweak re-indexes.
    if (language === 'cpp') {
      language = await refineHeaderLanguage(absPath, language, new Set(this.config.languages));
    }
    const existing = this.index.getFile(relPath);
    if (isUnchanged(existing, stats.mtimeMs, stats.size, language)) {
      if (existing?.contentHash !== undefined) {
        try {
          const content = await fs.readFile(absPath, 'utf8');
          if (hashContent(content) === existing.contentHash) {
            log.debug(`Indexer.indexFile: ${relPath} unchanged; skipping`);
            return 'noop';
          }
          // Same stat fingerprint, different bytes — fall through and
          // re-index for real.
        } catch (err) {
          log.debug(
            `Indexer.indexFile: hash check read failed for ${relPath} (${errMsg(err)}); treated as deletion`,
          );
          return removed();
        }
      } else {
        // No stored hash (unknown-language entry) — stat match suffices;
        // these files carry no symbols to go stale.
        log.debug(`Indexer.indexFile: ${relPath} unchanged; skipping`);
        return 'noop';
      }
    }
    if (stats.size > this.config.maxFileSize) {
      log.debug(
        `Indexer.indexFile: skip ${relPath} (size ${stats.size} > maxFileSize ${this.config.maxFileSize})`,
      );
      return removed();
    }

    if (
      language !== LANGUAGE_UNKNOWN &&
      !this.config.languages.includes(language)
    ) {
      return removed();
    }
    if (language === LANGUAGE_UNKNOWN) {
      try {
        if (await isBinaryByContent(absPath)) {
          return removed();
        }
      } catch (err) {
        log.warn(
          `Indexer.indexFile: byte check failed for ${relPath}: ${errMsg(err)}`,
        );
        return removed();
      }
    }

    const file: FileInfo = {
      path: relPath,
      language,
      size: stats.size,
      lastModified: stats.mtimeMs,
      lastIndexed: 0,
      symbolCount: 0,
    };
    this.total = 1;
    const result = await this.processFile(file);
    this.done = 1;
    return result;
  }

  // Parallel bulk load of the grammars `files` need. A WARM-UP, not a
  // correctness requirement (processFile re-ensures per-file), so failure is
  // TOLERATED: one missing/corrupt .wasm must degrade that one language
  // (per-file 'transient' + deduped warns), not abort indexing for every
  // other language.
  private async warmUpGrammars(files: readonly FileInfo[]): Promise<void> {
    await initParser(files.map((f) => f.language)).catch((err) =>
      log.warn(
        `Indexer: bulk grammar warm-up failed (${errMsg(err)}); ` +
          `grammars will load per-file`,
      ),
    );
  }

  // Resolves `false` when a run is already in flight (the request is
  // dropped, not queued); `true` when the work ran to completion.
  private async runGuarded(work: () => Promise<void>): Promise<boolean> {
    if (this.indexing) {
      log.warn('Indexer: indexing already in progress; refusing concurrent run');
      return false;
    }
    this.indexing = true;
    this.done = 0;
    this.total = 0;
    try {
      await work();
    } finally {
      this.indexing = false;
    }
    return true;
  }

  private async processBatched(files: FileInfo[]): Promise<void> {
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const end = Math.min(i + BATCH_SIZE, files.length);
      for (let j = i; j < end; j++) {
        await this.processFile(files[j]);
        this.done++;
      }
      log.debug(`Indexed ${this.done}/${this.total} files`);
      // Yield to the event loop so concurrent MCP requests can be served.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private async processFile(file: FileInfo): Promise<IndexFileResult> {
    // Recorded for audit but never parsed — keeps overview's "Other files"
    // count accurate without invoking the parser on unsupported grammars.
    if (file.language === LANGUAGE_UNKNOWN) {
      this.index.updateFile(
        { ...file, lastIndexed: Date.now() },
        [],
        [],
        [],
      );
      return 'indexed';
    }

    const absPath = join(this.config.projectRoot, file.path);
    const removed = (): IndexFileResult =>
      this.index.removeFile(file.path) ? 'removed' : 'noop';

    // Memoized per-language ensure — a resolved-promise await after the first
    // load. Covers the watcher path (a NEW language can appear after the
    // startup scan chose the initial grammar set). Runs BEFORE the content
    // read (no point reading bytes a failed grammar can't parse — a
    // permanently corrupt .wasm would otherwise cost one full-file read per
    // affected file per rescan) and OUTSIDE the parse try/catch below: a
    // grammar-LOAD failure says nothing about the FILE, so it returns
    // 'transient' (existing symbols kept — genuinely-transient causes were
    // already retried in place by ensureLanguage's bounded backoff), never
    // cascade-deletes them the way an unparseable file does. The warn is
    // deduped per LANGUAGE (5,000 Python files must not produce 5,000
    // identical lines); the dedup entry clears on the next successful load so
    // a NEW failure episode warns again.
    try {
      await initParser([file.language]);
      this.grammarWarnedLangs.delete(file.language);
    } catch (err) {
      // Preserve the pre-existing precedence "unreadable bytes always prune
      // the entry" even when the grammar is down: without this, a file that
      // is itself gone/unreadable would keep serving stale symbols from the
      // persisted cache indefinitely. One cheap access() probe, only on the
      // (rare) grammar-failure path.
      try {
        await fs.access(absPath, fs.constants.R_OK);
      } catch {
        return removed();
      }
      if (!this.grammarWarnedLangs.has(file.language)) {
        this.grammarWarnedLangs.add(file.language);
        log.warn(
          `Indexer: grammar load failed for ${file.language} (first: ${file.path}): ` +
            `${errMsg(err)}. Files of this language are missing or stale in the ` +
            `index until the grammar loads (fix the installation; probed again on ` +
            `the next change or rescan). Existing symbols are kept.`,
        );
      }
      return 'transient';
    }

    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      log.warn(
        `Indexer: failed to read ${file.path}: ${errMsg(err)}`,
      );
      return removed();
    }

    let tree: Tree | null;
    try {
      tree = parseFile(content, file.language);
    } catch (err) {
      log.warn(
        `Indexer: parseFile threw for ${file.path}: ${errMsg(err)}`,
      );
      return removed();
    }
    if (!tree) {
      log.warn(
        `Indexer: parser returned null for ${file.path} (language=${file.language})`,
      );
      return removed();
    }

    try {
      let result;
      try {
        result = extractSymbols(tree, content, file);
      } catch (err) {
        log.warn(
          `Indexer: extractSymbols threw for ${file.path}: ${errMsg(err)}`,
        );
        return removed();
      }
      const annotated: FileInfo = {
        ...file,
        lastIndexed: Date.now(),
        symbolCount: result.symbols.length,
        contentHash: hashContent(content),
      };
      this.index.updateFile(
        annotated,
        result.symbols,
        result.references,
        result.imports,
      );
      return 'indexed';
    } finally {
      // tree-sitter trees hold WASM memory that JS GC won't reclaim.
      tree.delete();
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.index.save(this.cachePath);
      log.debug(`Indexer: saved cache to ${this.cachePath}`);
    } catch (err) {
      log.error(`Indexer: failed to save cache: ${errMsg(err)}`);
      // Do not rethrow — the in-memory index remains usable.
    }
  }
}
