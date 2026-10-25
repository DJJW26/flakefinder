// STUB — Agent E owns this file. Replace entirely with the real JSONL history store (PLAN §4).
import type { RunRecord } from '../types.js';

export function snapshotPath(storeDir: string): string {
  return `${storeDir}/verdicts-snapshot.json`;
}

export class HistoryStore {
  readonly path: string;

  constructor(storeDir: string) {
    this.path = `${storeDir}/history.jsonl`;
  }

  append(_run: RunRecord): void {
    // stub
  }

  loadAll(): RunRecord[] {
    return [];
  }

  runs(): RunRecord[] {
    return [];
  }

  prune(_maxRuns: number): void {
    // stub
  }
}
