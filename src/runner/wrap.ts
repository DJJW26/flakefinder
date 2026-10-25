// STUB — Agent C owns this file. Replace entirely with the live-run wrapper (PLAN §8).
import type { ResolvedConfig, RunRecord, TestVerdict } from '../types.js';

export interface LiveRunResult {
  attempts: RunRecord[];
  finalExitCode: number;
  verdicts: TestVerdict[];
  usedReportFiles: string[];
  suiteFlake: boolean;
}

export async function runLive(
  _command: string[],
  _cfg: ResolvedConfig,
  _opts: { retries: number; cwd: string; applyQuarantine: boolean },
): Promise<LiveRunResult> {
  throw new Error('stub: runLive not implemented');
}
