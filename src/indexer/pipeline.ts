import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { errMsg, log } from '../logger.js';
import type { FileInfo, ProbeConfig } from '../types.js';
import { CodeIndex } from './code-index.js';
import { extractSymbols } from './extractor.js';
import { initParser, parseFile, type Tree } from './parser.js';
import {
  compileExcludeMatcher,
  detectLanguage,
  isBinaryByExtension,
  scanProject,
  toPosix,
} from './scanner.js';

const BATCH_SIZE = 50;

export class Indexer {
  readonly cachePath: string;
  private readonly matchExclude: (relPath: string) => boolean;
  private indexing = false;
  private done = 0;
  private total = 0;
  ready = false;

  constructor(
    private readonly config: ProbeConfig,
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

  async indexAll(): Promise<void> {
    return this.runGuarded(async () => {
      await initParser();
      const { files: current, complete } = await scanProject(this.config);

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

  async indexChanged(): Promise<void> {
    return this.runGuarded(async () => {
      await initParser();
      const { files: current, complete } = await scanProject(this.config);

      const previous = new Map(
        this.index.getAllFiles().map((f) => [f.path, f]),
      );
      const toIndex: FileInfo[] = [];
      for (const f of current) {
        const prev = previous.get(f.path);
        // mtime alone misses content swaps under coarse-resolution
        // filesystems or `cp -p` / archive extraction that preserves
        // timestamps. Comparing size catches the common case cheaply.
        if (
          !prev ||
          prev.lastModified !== f.lastModified ||
          prev.size !== f.size
        ) {
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

      this.total = toIndex.length;
      await this.processBatched(toIndex);
      await this.persist();
      this.ready = true;
    });
  }

  // Does NOT call save() — callers debounce events and batch persistence themselves.
  async indexFile(rawPath: string): Promise<void> {
    return this.runGuarded(async () => {
      await initParser();
      // Canonicalize to a project-relative POSIX path so the cache key
      // aligns with the scanner's `src/a.ts` form regardless of whether
      // the watcher emits an absolute path, a `./`-prefix, or Windows
      // backslashes. Mismatched keys would orphan stale symbols and
      // create duplicate entries on update.
      const projectRoot = this.config.projectRoot;
      const absInput = isAbsolute(rawPath)
        ? rawPath
        : join(projectRoot, rawPath);
      const relPath = toPosix(relative(projectRoot, absInput));
      if (relPath === '' || relPath === '..' || relPath.startsWith('../')) {
        log.debug(
          `Indexer.indexFile: skip ${rawPath} (outside project root)`,
        );
        return;
      }
      if (this.matchExclude(relPath) || isBinaryByExtension(relPath)) {
        this.index.removeFile(relPath);
        return;
      }
      const language = detectLanguage(relPath);
      if (!language) return;
      if (!this.config.languages.includes(language)) return;

      const absPath = join(this.config.projectRoot, relPath);
      let stats;
      try {
        stats = await fs.lstat(absPath);
      } catch (err) {
        this.index.removeFile(relPath);
        log.debug(
          `Indexer.indexFile: stat failed for ${relPath} (${errMsg(err)}); treated as deletion`,
        );
        return;
      }
      if (stats.isSymbolicLink()) {
        this.index.removeFile(relPath);
        log.debug(`Indexer.indexFile: skip ${relPath} (symlink)`);
        return;
      }
      if (stats.size > this.config.maxFileSize) {
        this.index.removeFile(relPath);
        log.debug(
          `Indexer.indexFile: skip ${relPath} (size ${stats.size} > maxFileSize ${this.config.maxFileSize})`,
        );
        return;
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
      await this.processFile(file);
      this.done = 1;
    });
  }

  private async runGuarded(work: () => Promise<void>): Promise<void> {
    if (this.indexing) {
      log.warn('Indexer: indexing already in progress; refusing concurrent run');
      return;
    }
    this.indexing = true;
    this.done = 0;
    this.total = 0;
    try {
      await work();
    } finally {
      this.indexing = false;
    }
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

  private async processFile(file: FileInfo): Promise<void> {
    const absPath = join(this.config.projectRoot, file.path);

    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch (err) {
      log.warn(
        `Indexer: failed to read ${file.path}: ${errMsg(err)}`,
      );
      this.index.removeFile(file.path);
      return;
    }

    let tree: Tree | null;
    try {
      tree = parseFile(content, file.language);
    } catch (err) {
      log.warn(
        `Indexer: parseFile threw for ${file.path}: ${errMsg(err)}`,
      );
      this.index.removeFile(file.path);
      return;
    }
    if (!tree) {
      log.warn(
        `Indexer: parser returned null for ${file.path} (language=${file.language})`,
      );
      this.index.removeFile(file.path);
      return;
    }

    try {
      let result;
      try {
        result = extractSymbols(tree, content, file);
      } catch (err) {
        log.warn(
          `Indexer: extractSymbols threw for ${file.path}: ${errMsg(err)}`,
        );
        this.index.removeFile(file.path);
        return;
      }
      const annotated: FileInfo = {
        ...file,
        lastIndexed: Date.now(),
        symbolCount: result.symbols.length,
      };
      this.index.updateFile(
        annotated,
        result.symbols,
        result.references,
        result.imports,
      );
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
