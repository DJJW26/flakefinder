import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
    mkdirSync(storeDir, { recursive: true });
    this.path = path.join(storeDir, 'history.jsonl');
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
    this.ensureHeader();
    appendFileSync(this.path, `${JSON.stringify(run)}\n`, 'utf8');
    this.records.push(run);
  }

  /** Keep only the last `maxRuns` records; rewrite the file atomically. */
  prune(maxRuns: number): void {
    this.ensureLoaded();
    if (this.records.length <= maxRuns) return;
    this.records = this.records.slice(-maxRuns);
    const tmp = `${this.path}.tmp`;
    const header =
      this.formatVersion === null ? `${JSON.stringify({ version: STORE_FORMAT_VERSION })}\n` : '';
    writeFileSync(
      tmp,
      `${header}${this.records.map((r) => JSON.stringify(r)).join('\n')}\n`,
      'utf8',
    );
    renameSync(tmp, this.path);
  }
}
