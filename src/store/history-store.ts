import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { RunRecord } from '../types.js';

/** Location of the verdict snapshot used to diff "new flakes" between CI runs. */
export function snapshotPath(storeDir: string): string {
  return path.join(storeDir, 'verdicts-snapshot.json');
}

/**
 * Append-only JSONL history store. One RunRecord per line. Corrupt lines are
 * skipped on load and reported through `warnings` (capped at 10) rather than
 * aborting — history must never be the reason a CI run dies.
 */
export class HistoryStore {
  readonly path: string;
  readonly warnings: string[] = [];

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
    const lines = readFileSync(this.path, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        this.records.push(JSON.parse(line) as RunRecord);
      } catch {
        if (this.warnings.length < 10) {
          this.warnings.push(`skipping corrupt line ${i + 1} in ${this.path}`);
        }
      }
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

  append(run: RunRecord): void {
    this.ensureLoaded();
    appendFileSync(this.path, `${JSON.stringify(run)}\n`, 'utf8');
    this.records.push(run);
  }

  /** Keep only the last `maxRuns` records; rewrite the file atomically. */
  prune(maxRuns: number): void {
    this.ensureLoaded();
    if (this.records.length <= maxRuns) return;
    this.records = this.records.slice(-maxRuns);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    renameSync(tmp, this.path);
  }
}
