import { describe, expect, it } from 'vitest';
import type { ResolvedConfig, RunRecord, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { classifyAll } from './classify.js';

const cfg: ResolvedConfig = {
  reports: [],
  storeDir: '.flakefinder',
  maxRuns: 300,
  minRuns: 3,
  liveRetries: 2,
  flakeScoreThreshold: 30,
  slowThresholdMs: 10_000,
  slowMultiplier: 5,
  quarantineFile: 'q.json',
  runner: 'auto',
  failOnFlakes: false,
  retryMode: 'auto',
  timeoutSeconds: null,
};

let clock = 0;
function run(
  status: TestStatus,
  opts: {
    name?: string;
    suite?: string;
    sha?: string;
    runId?: string;
    timestamp?: string;
    durationMs?: number | null;
  } = {},
): RunRecord {
  clock++;
  const name = opts.name ?? 't';
  const suite = opts.suite ?? 's.ts';
  return {
    runId: opts.runId ?? `r${clock}`,
    timestamp: opts.timestamp ?? new Date(Date.now() - 1000 + clock).toISOString(),
    source: 'report',
    parsedFrom: 'junit',
    attempt: 1,
    commitSha: opts.sha,
    results: [
      {
        testId: makeTestId(suite, name),
        suite,
        name,
        status,
        durationMs: opts.durationMs ?? 10,
        message: status === 'fail' || status === 'error' ? `${name} broke` : undefined,
      },
    ],
  };
}

describe('QA probes: engine edge cases', () => {
  it('future timestamps do not produce NaN or negative-age weirdness', () => {
    const runs = [
      run('fail', { sha: 'a', timestamp: '2030-01-01T00:00:00.000Z' }),
      run('pass', { sha: 'b' }),
      run('fail', { sha: 'c' }),
      run('pass', { sha: 'd' }),
    ];
    const verdict = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(Number.isFinite(verdict.flakeScore)).toBe(true);
    expect(verdict.flakeScore).toBeLessThanOrEqual(100);
    expect(verdict.classification).toBe('flaky-suspected');
  });

  it('resurrected-gone test: present, 31 absent runs, present again → not gone', () => {
    const target = makeTestId('s.ts', 't');
    const runs: RunRecord[] = [run('pass', { runId: 'first' })];
    for (let i = 0; i < 31; i++)
      runs.push(run('pass', { name: 'filler', suite: 'f.ts', runId: `f${i}` }));
    runs.push(run('pass', { runId: 'resurrected' }));
    const t = classifyAll(runs, cfg).find((x) => x.testId === target)!;
    expect(t.classification).not.toBe('gone');
    expect(t.runsObserved).toBe(2);
  });

  it('error-only statuses classify as failing (fail family), message captured', () => {
    const runs = [
      run('error', { sha: 'a' }),
      run('error', { sha: 'b' }),
      run('error', { sha: 'c' }),
    ];
    const verdict = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(verdict.classification).toBe('failing');
    expect(verdict.lastMessage).toBe('t broke');
  });

  it('single-test suite below absolute bar: no self-inflicted slow tag', () => {
    const runs = [run('pass', { sha: 'a', durationMs: 500 })];
    expect(classifyAll(runs, cfg).find((x) => x.name === 't')!.tags).not.toContain('slow');
  });

  it('same name in different suites keeps separate histories', () => {
    const a = run('fail', { sha: 'a', name: 't', suite: 'a.ts' });
    const b = run('pass', { sha: 'a', name: 't', suite: 'b.ts' });
    const all = classifyAll([a, b], cfg);
    expect(all).toHaveLength(2);
    expect(all.every((x) => x.runsObserved === 1)).toBe(true);
  });

  it('gone boundary at exactly 30 absent runs', () => {
    const mk = (fillers: number) => {
      const runs: RunRecord[] = [run('pass', { runId: 'first' })];
      for (let i = 0; i < fillers; i++)
        runs.push(run('pass', { name: 'filler', suite: 'f.ts', runId: `f${i}` }));
      return classifyAll(runs, cfg).find((x) => x.suite === 's.ts')!;
    };
    expect(mk(29).classification).not.toBe('gone'); // first run is the 30th-most-recent → inside window
    expect(mk(30).classification).toBe('gone'); // pushed out (absent from the last 30 runs)
  });

  it('gone counts RUNS, not records: one run with many report files/attempts is one run (R5 bug 8)', () => {
    const target = makeTestId('s.ts', 't');
    const runs: RunRecord[] = [run('pass', { runId: 'first' })];
    // a single later run that ingested 40 report files and retried twice
    for (let i = 0; i < 40; i++) {
      const rec = run('pass', { name: `filler${i}`, suite: 'f.ts', runId: 'big' });
      runs.push(rec, { ...rec, attempt: 2 }, { ...rec, attempt: 3 });
    }
    const t = classifyAll(runs, cfg).find((x) => x.testId === target)!;
    expect(t.classification).not.toBe('gone'); // only ONE run has happened since
    expect(t.tags).not.toContain('long-unseen');
  });
});

// Merged from the former scratch-repro.test.ts (QA round 4 regression probes).
function attemptRecord(
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

describe('retry rescue with identical timestamps', () => {
  it('distinct timestamps → rescue detected (control)', () => {
    const runs = [
      attemptRecord('R', 1, 'shaA', 'fail', '2026-10-26T10:00:00.000Z', 't'),
      attemptRecord('R', 2, 'shaA', 'pass', '2026-10-26T10:00:01.000Z', 't'),
    ];
    const v = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(v.retryRescues).toBe(1);
  });

  it('IDENTICAL timestamps → rescue still detected', () => {
    const runs = [
      attemptRecord('R', 1, 'shaA', 'fail', '2026-10-26T10:00:00.000Z', 't'),
      attemptRecord('R', 2, 'shaA', 'pass', '2026-10-26T10:00:00.000Z', 't'),
    ];
    const v = classifyAll(runs, cfg).find((x) => x.name === 't')!;
    expect(v.retryRescues).toBe(1);
  });
});

describe('runId-grouped ordering (QA round 4 regression)', () => {
  it('retry pairs survive identical timestamps interleaved with other runIds', () => {
    const T = '2026-10-26T10:00:00.000Z';
    const runs = [
      attemptRecord('R', 1, 'shaA', 'fail', T, 't'),
      attemptRecord('R2', 1, 'shaB', 'fail', T, 't'),
      attemptRecord('R3', 1, 'shaC', 'pass', T, 't'),
      attemptRecord('R4', 1, 'shaD', 'pass', T, 't'),
      attemptRecord('R', 2, 'shaA', 'pass', T, 't'),
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
