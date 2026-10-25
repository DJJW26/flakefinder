import { describe, expect, it } from 'vitest';
import type { ResolvedConfig, RunRecord } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { classifyAll } from './classify.js';

const cfg: ResolvedConfig = {
  reports: [],
  storeDir: '.ff',
  maxRuns: 300,
  minRuns: 3,
  liveRetries: 2,
  flakeScoreThreshold: 30,
  slowThresholdMs: 10_000,
  slowMultiplier: 5,
  quarantineFile: 'q.json',
  runner: 'auto',
  failOnFlakes: false,
  timeoutSeconds: null,
  retryMode: 'auto',
};

function mk(
  runId: string,
  attempt: number,
  sha: string,
  status: 'pass' | 'fail',
  timestamp: string,
  name: string,
): RunRecord {
  return {
    runId,
    timestamp,
    source: 'report',
    parsedFrom: 'jest',
    attempt,
    commitSha: sha,
    results: [{ testId: makeTestId('s.js', name), suite: 's.js', name, status, durationMs: 10 }],
  };
}

describe('repro: identical timestamps + retry rescue', () => {
  it('distinct timestamps → rescue detected (control)', () => {
    const runs = [
      mk('R', 1, 'shaA', 'fail', '2026-10-26T10:00:00.000Z', 't'),
      mk('R', 2, 'shaA', 'pass', '2026-10-26T10:00:01.000Z', 't'),
    ];
    const v = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(v.retryRescues).toBe(1);
  });
  it('IDENTICAL timestamps → rescue still detected (regression probe)', () => {
    const runs = [
      mk('R', 1, 'shaA', 'fail', '2026-10-26T10:00:00.000Z', 't'),
      mk('R', 2, 'shaA', 'pass', '2026-10-26T10:00:00.000Z', 't'),
    ];
    const v = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(v.retryRescues).toBe(1);
  });
});

describe('runId-grouped ordering (QA round 4 regression)', () => {
  it('retry pairs survive identical timestamps interleaved with other runIds', () => {
    const T = '2026-10-26T10:00:00.000Z';
    const runs = [
      mk('R', 1, 'shaA', 'fail', T, 't'),
      mk('R2', 1, 'shaB', 'fail', T, 't'),
      mk('R3', 1, 'shaC', 'pass', T, 't'),
      mk('R4', 1, 'shaD', 'pass', T, 't'),
      mk('R', 2, 'shaA', 'pass', T, 't'),
    ];
    const v = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(v.retryRescues).toBe(1);
    expect(v.sameShaFlips).toBe(1);
    expect(v.classification).toBe('flaky-confirmed');
    // 50 (flip) + 40 (rescue) + 16 (2 direction changes × 8, fresh) → capped 100
    expect(v.directionChanges).toBe(2);
    expect(v.flakeScore).toBe(100);
  });
});
