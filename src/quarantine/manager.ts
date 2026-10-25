// STUB — Agent C owns this file. Replace entirely (PLAN §9).
import type { QuarantineEntry, RunnerKind, TestVerdict } from '../types.js';

export class QuarantineManager {
  constructor(_filePath: string) {}

  list(): QuarantineEntry[] {
    return [];
  }

  add(_entry: QuarantineEntry): void {}

  remove(_testId: string): boolean {
    return false;
  }

  prune(_verdicts: TestVerdict[], _unseenRunCount?: number): QuarantineEntry[] {
    return [];
  }

  save(): void {}
}

export function exclusionArgs(
  _runner: Exclude<RunnerKind, 'auto'>,
  _entries: QuarantineEntry[],
): string[] {
  return [];
}
