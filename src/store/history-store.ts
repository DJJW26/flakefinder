import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import type { RunRecord } from '../types.js';
import { renameOverSync } from '../util/atomic-rename.js';

/** Location of the verdict snapshot used to diff "new flakes" between CI runs. */
export function snapshotPath(storeDir: string): string {
  return path.join(storeDir, 'verdicts-snapshot.json');
}

/** Current on-disk schema version, stamped as a {"version":N} header line. */
export const STORE_FORMAT_VERSION = 1;

/** Thrown when the store lock stays held by another process past the wait deadline. */
export class StoreBusyError extends Error {}

/** A lock older than this is treated as abandoned by a dead process. */
const LOCK_STALE_MS = 30_000;

function uniqueSuffix(): string {
  return `${process.pid}-${randomBytes(6).toString('hex')}`;
}

/**
 * Age of a lock file. Uses the `epoch` recorded inside it; when the content
 * is empty or unparseable (a legacy writer caught between create and write,
 * or a torn write) the file's mtime is used instead — so a lock that was
 * JUST created always reads as fresh, never as "infinitely old".
 * Returns null when the lock cannot be stat'ed (it vanished).
 */
function lockAgeMs(lockPath: string, content: string | null): number | null {
  if (content) {
    try {
      const holder = JSON.parse(content) as { epoch?: unknown };
      if (typeof holder.epoch === 'number' && Number.isFinite(holder.epoch)) {
        return Date.now() - holder.epoch;
      }
    } catch {
      // fall through to mtime
    }
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return null;
  }
}

/** Check local process liveness before treating an old lock as abandoned. */
function ownerMayBeAlive(content: string): boolean {
  let owner: unknown;
  try {
    owner = JSON.parse(content);
  } catch {
    return false; // legacy or torn lock: use its age alone
  }
  if (!isJsonObject(owner)) return false;
  if (typeof owner.host === 'string' && owner.host !== hostname()) return true;
  if (
    typeof owner.pid !== 'number' ||
    !Number.isInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.pid > 0x7fff_ffff
  ) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Serialize stale recovery for this specific lock generation. Two waiters
 * must never move or remove a replacement lock while checking a stale one.
 * New writers can acquire the main lock only after the verified dead
 * holder's file has been removed. They never touch the recovery claim.
 */
export function breakStaleLock(lockPath: string, observed: string): boolean {
  if (ownerMayBeAlive(observed)) return false;
  const generation = createHash('sha256').update(observed).digest('hex').slice(0, 24);
  const claim = `${lockPath}.recover-${generation}`;
  let fd: number;
  try {
    fd = openSync(claim, 'wx');
  } catch {
    return false;
  }
  try {
    const current = readFileSync(lockPath, 'utf8');
    const age = lockAgeMs(lockPath, current);
    if (current !== observed || age === null || age <= LOCK_STALE_MS) return false;
    rmSync(lockPath);
    return true;
  } catch {
    return false; // released or already recovered
  } finally {
    closeSync(fd);
    rmSync(claim, { force: true });
  }
}

const warningListeners = new Set<(message: string) => void>();

/**
 * Receive every warning any HistoryStore records from now on (corrupt lines,
 * unreadable store, newer format, busy prune skipped, …). Each warning is
 * delivered once — a prune's fresh re-read is not reported twice. Returns
 * the unsubscribe function.
 */
export function subscribeStoreWarnings(listener: (message: string) => void): () => void {
  warningListeners.add(listener);
  return () => {
    warningListeners.delete(listener);
  };
}

/**
 * The records of the last `maxRuns` distinct runIds, in file order. Counting
 * records instead used to cut a retried run in half (attempt 1 dropped,
 * attempt 2 kept), turning a retry rescue into a plain pass.
 */
export function lastRuns(records: RunRecord[], maxRuns: number): RunRecord[] {
  if (records.length <= maxRuns) return records;
  const kept = new Set<string>();
  for (let i = records.length - 1; i >= 0 && kept.size < maxRuns; i--) {
    kept.add(records[i]!.runId);
  }
  if (kept.size === new Set(records.map((r) => r.runId)).size) return records;
  return records.filter((r) => kept.has(r.runId));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTestStatus(status: unknown): boolean {
  return status === 'pass' || status === 'fail' || status === 'skip' || status === 'error';
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isTestResult(result: unknown): boolean {
  return (
    isJsonObject(result) &&
    typeof result.testId === 'string' &&
    typeof result.suite === 'string' &&
    typeof result.name === 'string' &&
    isTestStatus(result.status) &&
    (result.durationMs === null || Number.isFinite(result.durationMs)) &&
    isOptionalString(result.message) &&
    isOptionalString(result.stack) &&
    (result.attempts === undefined ||
      (Array.isArray(result.attempts) && result.attempts.every(isTestStatus)))
  );
}

function hasValidRunData(record: Record<string, unknown>): boolean {
  return (
    typeof record.runId === 'string' &&
    typeof record.timestamp === 'string' &&
    // Older or hand-authored history can omit execution metadata.
    (record.attempt === undefined || Number.isInteger(record.attempt)) &&
    isOptionalString(record.commitSha) &&
    isOptionalString(record.branch) &&
    isOptionalString(record.ciRunId) &&
    Array.isArray(record.results) &&
    record.results.every(isTestResult)
  );
}

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
  /**
   * Set when `history.jsonl` exists but could not be read at all (EISDIR,
   * EACCES, …): the store then behaves as empty, but callers that diagnose
   * setup (doctor) must treat it as a hard failure, not as "0 runs".
   * Holds `<errno>: <message>`; null when the file was read or is absent.
   */
  unreadable: string | null = null;

  private loaded = false;
  private records: RunRecord[] = [];
  /** Content of the lock file this instance wrote; release only removes a lock that still matches. */
  private lockToken: string | null = null;

  constructor(storeDir: string) {
    // deliberately does NOT create the directory: read-only commands (report,
    // doctor) must not leave a .flakefinder/ behind when nothing exists. Write
    // paths call ensureStoreDir() instead.
    this.path = path.join(storeDir, 'history.jsonl');
  }

  /**
   * Record a warning on this instance and tell any subscribers. Callers that
   * never see the instance — `run` goes through runLive, which keeps its
   * store private — subscribe instead of losing e.g. "prune skipped".
   */
  private warn(message: string, first = false): void {
    if (first) this.warnings.unshift(message);
    else this.warnings.push(message);
    for (const listener of warningListeners) listener(message);
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
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      // e.g. the path exists but is a DIRECTORY (EISDIR) or unreadable
      // (EACCES) — degrade to an empty store instead of dying; doctor fails.
      const e = err as NodeJS.ErrnoException;
      const code = e.code ?? 'error';
      // node's fs messages already start with the errno ("EISDIR: illegal …")
      this.unreadable = e.message.startsWith(code) ? e.message : `${code}: ${e.message}`;
      this.warn(`history store unreadable (${code}): ${this.path}`);
      return;
    }
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
      this.warn(
        `store format v${this.formatVersion} is newer than this flakefinder (v${STORE_FORMAT_VERSION}) — unknown fields will be preserved`,
        true,
      );
    }
  }

  private processLine(line: string, i: number): void {
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (this.warnings.length < 10) {
        this.warn(`skipping corrupt line ${i} in ${this.path}`);
      }
      return;
    }
    if (!isJsonObject(parsed)) {
      if (this.warnings.length < 10) {
        this.warn(`skipping record-shaped garbage at line ${i} in ${this.path}`);
      }
      return;
    }
    // Schema marker: {"version":N} with no record fields. Legitimate at
    // the first line; elsewhere it means a merged/partial write.
    if (parsed.runId === undefined && parsed.results === undefined) {
      if (typeof parsed.version === 'number') {
        if (i === 1) this.formatVersion = parsed.version;
        else if (this.warnings.length < 10) {
          this.warn(`unexpected schema marker at line ${i} — skipped`);
        }
        return;
      }
      if (this.warnings.length < 10) {
        this.warn(`skipping record-shaped garbage at line ${i} in ${this.path}`);
      }
      return;
    }
    if (!hasValidRunData(parsed)) {
      if (this.warnings.length < 10) {
        this.warn(`skipping invalid record at line ${i} in ${this.path}`);
      }
      return;
    }
    parsed.attempt ??= 1; // header-less histories can predate live retry metadata
    this.records.push(parsed as unknown as RunRecord);
  }

  /** Append one complete line even if a prior write ended before its newline. */
  private appendLine(run: RunRecord): void {
    const line = JSON.stringify(run);
    const fd = openSync(this.path, 'a+');
    try {
      const size = fstatSync(fd).size;
      let prefix = '';
      if (size === 0) {
        prefix = `${JSON.stringify({ version: STORE_FORMAT_VERSION })}\n`;
      } else {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) prefix = '\n';
      }
      writeFileSync(fd, `${prefix}${line}\n`, 'utf8');
      if (size === 0) this.formatVersion = STORE_FORMAT_VERSION;
    } finally {
      closeSync(fd);
    }
  }

  private get lockPath(): string {
    return `${this.path}.lock`;
  }

  /**
   * Advisory lock around writes (append/prune). Two CI matrix shards writing
   * multi-KB records can interleave in one append and corrupt a line — the
   * lock serializes them. Busy-waits in ≤50 ms slices (Atomics.wait) up to 2 s
   * before giving up with an actionable error; a lock older than 30 s is
   * reclaimed only when its host/process information permits recovery.
   *
   * The lock file is created atomically WITH its content (write a private
   * temp file, then link() it into place — link fails if the lock exists), so
   * competitors never see a half-written lock. Empty/unparseable locks (older
   * flakefinder versions, torn writes) are aged by mtime, and stale locks are
   * reclaimed one waiter at a time (breakStaleLock).
   */
  private acquireLock(): void {
    const deadline = Date.now() + 2000;
    for (;;) {
      if (this.tryCreateLock()) return;
      // checked on EVERY iteration — no path below may spin past it
      if (Date.now() >= deadline) {
        throw new StoreBusyError(
          `history store is busy (held by another flakefinder process for >2s): ${this.lockPath}. ` +
            'Run ingest steps serially, or give each CI shard its own storeDir. ' +
            'If the writer stopped on another host or during lock recovery, verify all writers have stopped before removing the abandoned lock and its .recover-* file.',
        );
      }
      let content: string;
      try {
        content = readFileSync(this.lockPath, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue; // released in between — retry now
        throw this.lockError(code, 'exists but cannot be read as a lock file');
      }
      const ageMs = lockAgeMs(this.lockPath, content);
      if (ageMs === null) continue; // vanished — retry now
      if (ageMs > LOCK_STALE_MS && breakStaleLock(this.lockPath, content)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }

  private lockError(code: string | undefined, what: string): Error {
    return new Error(
      `history store lock ${this.lockPath} ${what} (${code ?? 'error'}) — ` +
        'check that the store directory is writable and that the lock path is not a directory',
    );
  }

  /**
   * One attempt to take the lock: true on success, false ONLY when another
   * process holds it (EEXIST). Anything else — read-only directory (EACCES,
   * EROFS), missing dir, … — throws: retrying cannot fix it, and treating it
   * as "held" used to spin forever.
   */
  private tryCreateLock(): boolean {
    const token = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      epoch: Date.now(),
      nonce: randomBytes(6).toString('hex'),
    });
    const tmp = `${this.lockPath}.${uniqueSuffix()}.tmp`;
    try {
      writeFileSync(tmp, token, 'utf8');
    } catch (err) {
      throw this.lockError((err as NodeJS.ErrnoException).code, 'cannot be created');
    }
    try {
      linkSync(tmp, this.lockPath);
      this.lockToken = token;
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      // filesystems without hard links (EPERM/ENOTSUP/…): exclusive create.
      // The empty window this leaves is covered by mtime-based aging.
      try {
        writeFileSync(this.lockPath, token, { flag: 'wx' });
        this.lockToken = token;
        return true;
      } catch (err2) {
        const code2 = (err2 as NodeJS.ErrnoException).code;
        if (code2 === 'EEXIST') return false;
        throw this.lockError(code2, 'cannot be created');
      }
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private releaseLock(): void {
    const token = this.lockToken;
    this.lockToken = null;
    try {
      // only remove the lock if it is still OURS — it may have been broken as
      // stale and re-acquired by another process while we held it
      if (readFileSync(this.lockPath, 'utf8') === token) rmSync(this.lockPath, { force: true });
    } catch {
      // already gone
    }
  }

  loadAll(): RunRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  runs(): RunRecord[] {
    this.ensureLoaded();
    return [...this.records];
  }

  /**
   * Write paths must not surface raw EISDIR/EACCES: a directory (or other
   * non-file) at the store path is a setup error that should name the file.
   */
  private assertWritableFile(): void {
    if (existsSync(this.path) && !statSync(this.path).isFile()) {
      throw new Error(
        `history store ${this.path} exists but is not a regular file — delete or rename it (flakefinder recreates it on the next write)`,
      );
    }
  }

  /**
   * Appends without reading the store: when this instance has not loaded the
   * file yet, the record simply becomes part of the next (lazy) read.
   */
  append(run: RunRecord): void {
    this.ensureStoreDir(); // the lock file lives in the store dir — it must exist first
    this.assertWritableFile();
    this.acquireLock();
    try {
      try {
        this.appendLine(run);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        throw new Error(
          `cannot write history store ${this.path} (${e.code ?? 'error'}) — check it is a writable regular file`,
        );
      }
      if (this.loaded) this.records.push(run);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Keep only the last `maxRuns` RUNS (distinct runIds — one `run` with
   * retries writes one record per attempt, all sharing a runId, and they are
   * kept or dropped together); rewrite the file atomically.
   * Re-reads the file FRESH inside the lock: a stale in-memory snapshot
   * would silently delete records another process appended between our load
   * and this prune (verified 10/10 with two concurrent ingests before the
   * fix). In-memory records are resynced to the fresh state — including an
   * empty one: the stale view is only kept when the fresh read FAILED, and
   * then nothing is rewritten.
   */
  prune(maxRuns: number): void {
    if (this.unreadable) return; // never rewrite a store we could not read
    if (!existsSync(this.path)) return;
    this.ensureStoreDir(); // lock file lives in the store dir
    try {
      this.acquireLock();
    } catch (err) {
      // pruning is maintenance: when another writer holds the lock, skip it
      // (the next write prunes) rather than fail a command whose record was
      // already appended — a retry would then double-count that run
      if (!(err instanceof StoreBusyError)) throw err;
      this.warn(`history store busy — prune skipped this time: ${this.path}`);
      return;
    }
    try {
      // fresh read under the lock — the on-disk state may include other
      // processes' appends made after our load. A separate instance parses
      // it with the same (line-indexed, single-copy) loader.
      const fresh = new HistoryStore(path.dirname(this.path));
      const source = fresh.runs();
      if (fresh.unreadable !== null) {
        if (this.loaded) {
          // keep the in-memory view, but do not rewrite from it
          this.warn(`history store unreadable during prune — not pruned: ${this.path}`);
        } else {
          this.adopt(fresh);
        }
        return;
      }
      const keep = lastRuns(source, maxRuns);
      if (keep.length === source.length) {
        this.adopt(fresh);
        return;
      }
      // always (re)write the header; a newer-version header is preserved
      // rather than downgraded, since unknown fields are kept verbatim
      const version = Math.max(fresh.formatVersion ?? STORE_FORMAT_VERSION, STORE_FORMAT_VERSION);
      const tmp = `${this.path}.tmp`;
      const fd = openSync(tmp, 'w');
      try {
        writeFileSync(fd, `${JSON.stringify({ version })}\n`, 'utf8');
        for (const r of keep) writeFileSync(fd, `${JSON.stringify(r)}\n`, 'utf8');
      } finally {
        closeSync(fd);
      }
      renameOverSync(tmp, this.path);
      this.adopt(fresh);
      this.records = keep;
      this.formatVersion = version;
    } finally {
      this.releaseLock();
    }
  }

  /** Resync this instance's view to a fresh read of the same store. */
  private adopt(fresh: HistoryStore): void {
    if (!this.loaded) this.warnings.push(...fresh.warnings);
    this.loaded = true;
    this.records = fresh.runs();
    this.formatVersion = fresh.formatVersion;
    this.unreadable = fresh.unreadable;
  }
}
