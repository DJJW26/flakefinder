import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '../types.js';

/** Location of the verdict snapshot used to diff "new flakes" between CI runs. */
export function snapshotPath(storeDir: string): string {
  return path.join(storeDir, 'verdicts-snapshot.json');
}

/** Current on-disk schema version, stamped as a {"version":N} header line. */
export const STORE_FORMAT_VERSION = 1;

/**
 * Append-only JSONL history store. One RunRecord per line, prefixed by a
 * `{"version":1}` schema header (v0.2.0+; legacy header-less files load
 * unchanged). Corrupt lines are skipped on load and reported through
 * `warnings` (capped at 10) rather than aborting — history must never be the
 * reason a CI run dies.
 */
export class HistoryStore {
  readonly path: string;
  readonly warnings: string[] = [];
  /** Schema version read from the file header; null for legacy header-less stores. */
  formatVersion: number | null = null;

  private loaded = false;
  private records: RunRecord[] = [];

  constructor(storeDir: string) {
    // deliberately does NOT create the directory: read-only commands (report,
    // doctor) must not leave a .flakefinder/ behind when nothing exists. Write
    // paths call ensureStoreDir() instead.
    this.path = path.join(storeDir, 'history.jsonl');
  }

  private ensureStoreDir(): void {
    mkdirSync(path.dirname(this.path), { recursive: true });
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.path)) return;
    // Indexed line iteration instead of split(): stores hold large records
    // (a run with 500 tests ≈ 44 KB/line), and split() duplicates the whole
    // file as a string array — this keeps peak memory to one copy.
    const raw = readFileSync(this.path, 'utf8');
    let start = 0;
    let lineNo = 0;
    while (start < raw.length) {
      let end = raw.indexOf('\n', start);
      if (end === -1) end = raw.length;
      const line = raw.slice(start, end).trim();
      lineNo++;
      this.processLine(line, lineNo);
      start = end + 1;
    }
    if (this.formatVersion !== null && this.formatVersion > STORE_FORMAT_VERSION) {
      this.warnings.unshift(
        `store format v${this.formatVersion} is newer than this flakefinder (v${STORE_FORMAT_VERSION}) — unknown fields will be preserved`,
      );
    }
  }

  private processLine(line: string, i: number): void {
    if (!line) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (this.warnings.length < 10) {
        this.warnings.push(`skipping corrupt line ${i} in ${this.path}`);
      }
      return;
    }
    // Schema marker: {"version":N} with no record fields. Legitimate at
    // line 0; elsewhere it means a merged/partial write — skip it, don't
    // crash downstream (RunRecord consumers iterate `results`).
    if (parsed.runId === undefined && parsed.results === undefined) {
      if (typeof parsed.version === 'number') {
        if (i === 1) this.formatVersion = parsed.version;
        else if (this.warnings.length < 10) {
          this.warnings.push(`unexpected schema marker at line ${i} — skipped`);
        }
        return;
      }
      if (this.warnings.length < 10) {
        this.warnings.push(`skipping record-shaped garbage at line ${i} in ${this.path}`);
      }
      return;
    }
    // Record shape validation: anything without a runId + results array is
    // skipped with a warning instead of blowing up the classifier later.
    if (typeof parsed.runId !== 'string' || !Array.isArray(parsed.results)) {
      if (this.warnings.length < 10) {
        this.warnings.push(`skipping invalid record at line ${i} in ${this.path}`);
      }
      return;
    }
    this.records.push(parsed as unknown as RunRecord);
  }

  private ensureHeader(): void {
    if (existsSync(this.path) && statSync(this.path).size > 0) return;
    appendFileSync(this.path, `${JSON.stringify({ version: STORE_FORMAT_VERSION })}\n`, 'utf8');
    this.formatVersion = STORE_FORMAT_VERSION;
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  /**
   * Advisory lock around writes (append/prune). Two CI matrix shards writing
   * multi-KB records can interleave in one append and corrupt a line — the
   * lock serializes them. Busy-waits in ≤50 ms slices (Atomics.wait) up to 2 s
   * before giving up with an actionable error; a lock older than 30 s is
   * treated as abandoned by a dead process and stolen.
   */
  private acquireLock(): void {
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, epoch: Date.now() }), {
          flag: 'wx',
        });
        return;
      } catch {
        let ageMs = Infinity;
        try {
          const holder = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { epoch?: number };
          if (typeof holder.epoch === 'number') ageMs = Date.now() - holder.epoch;
        } catch {
          // unreadable lock → treat as stale below
        }
        if (ageMs > 30_000) {
          rmSync(this.lockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `history store is busy (held by another flakefinder process for >2s): ${this.lockPath}. ` +
              'Run ingest steps serially, or give each CI shard its own storeDir.',
          );
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }

  private releaseLock(): void {
    rmSync(this.lockPath, { force: true });
  }

  loadAll(): RunRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  runs(): RunRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  append(run: RunRecord): void {
    this.ensureLoaded();
    this.ensureStoreDir(); // the lock file lives in the store dir — it must exist first
    this.acquireLock();
    try {
      this.ensureHeader();
      appendFileSync(this.path, `${JSON.stringify(run)}\n`, 'utf8');
      this.records.push(run);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Keep only the last `maxRuns` records; rewrite the file atomically.
   * Re-reads the file FRESH inside the lock: a stale in-memory snapshot
   * would silently delete records another process appended between our load
   * and this prune (verified 10/10 with two concurrent ingests before the
   * fix). In-memory records are resynced to the fresh state.
   */
  prune(maxRuns: number): void {
    this.ensureLoaded();
    if (!existsSync(this.path)) return;
    this.ensureStoreDir(); // lock file lives in the store dir
    this.acquireLock();
    try {
      // fresh read under the lock — the on-disk state may include other
      // processes' appends made after our ensureLoaded(). The early-return
      // check MUST use the fresh count: a stale in-memory count (e.g. 3 of
      // maxRuns=3) hid records another process appended.
      const fresh: RunRecord[] = [];
      try {
        const lines = readFileSync(this.path, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const parsed = JSON.parse(t) as Record<string, unknown>;
            if (typeof parsed.runId === 'string' && Array.isArray(parsed.results)) {
              fresh.push(parsed as unknown as RunRecord);
            }
          } catch {
            // corrupt lines are dropped by the rewrite — consistent with load
          }
        }
      } catch {
        // unreadable store: fall through with in-memory records
      }
      const source = fresh.length > 0 ? fresh : this.records;
      if (source.length <= maxRuns) {
        this.records = source;
        return;
      }
      const keep = source.slice(-maxRuns);
      const tmp = `${this.path}.tmp`;
      const header =
        this.formatVersion === null ? `${JSON.stringify({ version: STORE_FORMAT_VERSION })}\n` : '';
      writeFileSync(tmp, `${header}${keep.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
      renameSync(tmp, this.path);
      this.records = keep;
    } finally {
      this.releaseLock();
    }
  }
}
