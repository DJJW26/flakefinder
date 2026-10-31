import { describe, expect, it } from 'vitest';
import type {
  ResolvedConfig,
  RunRecord,
  TestCaseResult,
  TestStatus,
  TestVerdict,
} from '../types.js';
import { buildHistories, classifyAll } from './classify.js';

/**
 * PLAN §5 scoring cases S1–S28 (QA round 5 scoring harness, ported): each case
 * is a designed history for test `T` plus an always-passing filler, so "runs"
 * exist even where `T` is absent.
 */

const baseCfg: ResolvedConfig = {
  reports: [],
  storeDir: '.flakefinder',
  maxRuns: 300,
  minRuns: 3,
  liveRetries: 2,
  flakeScoreThreshold: 40,
  slowThresholdMs: 10_000,
  slowMultiplier: 5,
  quarantineFile: 'flakefinder.quarantine.json',
  runner: 'auto',
  failOnFlakes: false,
  retryMode: 'auto',
  timeoutSeconds: null,
};

type Code = 'P' | 'F' | 'E' | 'S' | '-';
/** [days ago, sha or null, per-attempt statuses] */
type RunSpec = [number, string | null, Code[]];

const STATUS: Record<Exclude<Code, '-'>, TestStatus> = {
  P: 'pass',
  F: 'fail',
  E: 'error',
  S: 'skip',
};

function records(runs: RunSpec[]): RunRecord[] {
  const now = Date.now();
  const out: RunRecord[] = [];
  let seq = 0;
  runs.forEach(([days, sha, atts], i) => {
    atts.forEach((code, a) => {
      seq++;
      const results: TestCaseResult[] = [
        { testId: 'filler', suite: 's', name: 'filler', status: 'pass', durationMs: 5 },
      ];
      if (code !== '-') {
        results.push({ testId: 'T', suite: 's', name: 'T', status: STATUS[code], durationMs: 5 });
      }
      out.push({
        runId: `run-${i}`,
        timestamp: new Date(now - days * 86_400_000 + seq * 1000).toISOString(),
        source: 'live',
        parsedFrom: 'junit',
        attempt: a + 1,
        commitSha: sha ? sha.repeat(40) : undefined,
        results,
      });
    });
  });
  return out;
}

function verdict(runs: RunSpec[], minRuns = 3): TestVerdict {
  const v = classifyAll(records(runs), { ...baseCfg, minRuns }).find((x) => x.testId === 'T');
  if (!v) throw new Error('no verdict for T');
  return v;
}

const seq = (shas: string, codes: string, days = 1): RunSpec[] =>
  [...codes].map((c, i) => [days, shas[i]!, [c as Code]]);

const cases: Array<[string, RunSpec[], number, Partial<TestVerdict>]> = [
  [
    'S1 same-sha flip',
    [
      [1, 'a', ['F']],
      [1, 'a', ['P']],
    ],
    3,
    {
      classification: 'flaky-confirmed',
      flakeScore: 50,
      confidence: 100,
      sameShaFlips: 1,
      directionChanges: 0,
      runsObserved: 2,
    },
  ],
  [
    'S2 retry rescue, no git',
    [[1, null, ['F', 'P']]],
    3,
    { classification: 'flaky-retry', flakeScore: 40, retryRescues: 1, runsObserved: 1 },
  ],
  [
    'S3 retry rescue in git (also same-sha)',
    [[1, 'a', ['F', 'P']]],
    3,
    { classification: 'flaky-confirmed', flakeScore: 90, sameShaFlips: 1, retryRescues: 1 },
  ],
  [
    'S4 F,F,P retry no git',
    [[1, null, ['F', 'F', 'P']]],
    3,
    { classification: 'flaky-retry', flakeScore: 40, retryRescues: 1 },
  ],
  [
    'S5 pass then fail within a run',
    [[1, null, ['P', 'F']]],
    3,
    { classification: 'new-failure', flakeScore: 0, retryRescues: 0 },
  ],
  [
    'S6 5 SHAs alternating, now',
    seq('abcde', 'PFPFP'),
    3,
    { classification: 'flaky-suspected', flakeScore: 24, confidence: 58, directionChanges: 4 },
  ],
  [
    'S7 same, 20 days ago (×0.6)',
    seq('abcde', 'PFPFP', 20),
    3,
    { classification: 'flaky-suspected', flakeScore: 19 },
  ],
  [
    'S8 same, 60 days ago (×0.3)',
    seq('abcde', 'PFPFP', 60),
    3,
    { classification: 'flaky-suspected', flakeScore: 10 },
  ],
  [
    'S9 old flips, most recent flip 1 day ago',
    [
      [60, 'a', ['F']],
      [60, 'b', ['P']],
      [60, 'c', ['F']],
      [1, 'd', ['P']],
    ],
    3,
    { classification: 'flaky-suspected', flakeScore: 24, directionChanges: 3 },
  ],
  [
    'S10 2 changes, exactly minRuns',
    seq('abc', 'PFP'),
    3,
    { classification: 'flaky-suspected', flakeScore: 16, confidence: 35, directionChanges: 2 },
  ],
  [
    'S11 2 changes, minRuns 5',
    seq('abc', 'PFP'),
    5,
    { classification: 'passing', flakeScore: 16, directionChanges: 2 },
  ],
  [
    'S12 PFPF minRuns 5',
    seq('abcd', 'PFPF'),
    5,
    { classification: 'new-failure', flakeScore: 24, confidence: 20, directionChanges: 3 },
  ],
  [
    'S13 5 fails on 5 SHAs',
    seq('abcde', 'FFFFF'),
    3,
    { classification: 'failing', flakeScore: 0, confidence: 50 },
  ],
  ['S14 2 fails', seq('ab', 'FF'), 3, { classification: 'new-failure', confidence: 20 }],
  [
    'S15 one run × 3 failed attempts, no git → ONE run',
    [[1, null, ['F', 'F', 'F']]],
    3,
    { classification: 'new-failure', confidence: 25, runsObserved: 1 },
  ],
  [
    'S16 one run × 3 failed attempts, git → ONE run',
    [[1, 'a', ['F', 'F', 'F']]],
    3,
    { classification: 'new-failure', runsObserved: 1 },
  ],
  [
    'S17 error is fail family',
    [
      [1, 'a', ['E']],
      [1, 'a', ['P']],
    ],
    3,
    { classification: 'flaky-confirmed', flakeScore: 50 },
  ],
  ['S18 all skipped', seq('ab', 'SS'), 3, { classification: 'skipped', flakeScore: 0 }],
  [
    'S19 skips ignored in flips',
    seq('abc', 'PSP'),
    3,
    { classification: 'passing', directionChanges: 0 },
  ],
  [
    'S20 revert A→B→A counts as two changes',
    seq('aba', 'PFP'),
    3,
    { classification: 'flaky-suspected', sameShaFlips: 0, directionChanges: 2 },
  ],
  [
    'S21 9 passes then a fail (+10 bonus)',
    seq('abcdefghij', 'PPPPPPPPPF'),
    3,
    { classification: 'new-failure', flakeScore: 18, directionChanges: 1 },
  ],
  [
    'S22 recently-fixed',
    seq('abcdefg', 'FFPPPPP'),
    3,
    { classification: 'passing', flakeScore: 8, tags: ['recently-fixed'] },
  ],
  [
    'S23 suspected beats failing',
    seq('abcdefg', 'FPFFFFF'),
    3,
    { classification: 'flaky-suspected', directionChanges: 2 },
  ],
  [
    'S24 absent from the next 30 runs → gone',
    [[2, 'a', ['F']], ...Array.from({ length: 30 }, (): RunSpec => [1, 'b', ['-']])],
    3,
    { classification: 'gone', tags: ['long-unseen'] },
  ],
  [
    'S25 absent from the last 29 runs → not gone',
    [[2, 'a', ['P']], ...Array.from({ length: 29 }, (): RunSpec => [1, 'b', ['-']])],
    3,
    { classification: 'passing' },
  ],
  [
    'S26 no-git P,F,P,F (runId states)',
    [
      [1, null, ['P']],
      [1, null, ['F']],
      [1, null, ['P']],
      [1, null, ['F']],
    ],
    3,
    { classification: 'flaky-suspected', directionChanges: 3, flakeScore: 24 },
  ],
  [
    'S27 no-git [F,P] twice',
    [
      [1, null, ['F', 'P']],
      [1, null, ['F', 'P']],
    ],
    3,
    { classification: 'flaky-retry', retryRescues: 2, directionChanges: 0, flakeScore: 40 },
  ],
  [
    'S28 PFFFFF on 6 SHAs',
    seq('abcdef', 'PFFFFF'),
    3,
    { classification: 'failing', flakeScore: 8, confidence: 50 },
  ],
];

describe('PLAN §5 scoring cases', () => {
  for (const [name, runs, minRuns, expected] of cases) {
    it(name, () => {
      const v = verdict(runs, minRuns);
      for (const [k, want] of Object.entries(expected)) {
        expect(v[k as keyof TestVerdict], k).toEqual(want);
      }
    });
  }
});

describe('a run is one invocation (RUN-8)', () => {
  it('retry attempts never satisfy minRuns on their own', () => {
    const v = verdict([[1, null, ['F', 'F', 'F']]], 2);
    expect(v.runsObserved).toBe(1);
    expect(v.classification).toBe('new-failure');
  });

  it('the run outcome is its final attempt: F,P runs count as passes for "failing"', () => {
    const v = verdict([
      [1, 'a', ['F']],
      [1, 'b', ['F']],
      [1, 'c', ['F']],
      [1, null, ['F', 'P']],
    ]);
    expect(v.runsObserved).toBe(4);
    expect(v.classification).toBe('flaky-retry');
  });

  it('+10 data bonus needs 10 runs, not 10 attempts', () => {
    const fourRuns: RunSpec[] = Array.from(
      { length: 4 },
      (): RunSpec => [1, null, ['F', 'F', 'P']],
    );
    const v = verdict(fourRuns);
    expect(v.runsObserved).toBe(4);
    expect(v.flakeScore).toBe(40); // rescues only, no bonus despite 12 executions
    const tenRuns: RunSpec[] = Array.from({ length: 10 }, (): RunSpec => [1, null, ['F', 'P']]);
    expect(verdict(tenRuns).flakeScore).toBe(50);
  });
});

/** One report-ingest run whose result carries in-report retry attempts. */
function inReport(
  status: TestStatus,
  attempts: TestStatus[] | undefined,
  opts: { runId?: string; sha?: string; attempt?: number; message?: string; ts?: number } = {},
): RunRecord {
  return {
    runId: opts.runId ?? `r-${Math.random()}`,
    timestamp: new Date(opts.ts ?? Date.now()).toISOString(),
    source: 'report',
    parsedFrom: 'jest',
    attempt: opts.attempt ?? 1,
    commitSha: opts.sha,
    results: [
      {
        testId: 'T',
        suite: 's',
        name: 'T',
        status,
        durationMs: 12,
        message: opts.message,
        attempts,
      },
    ],
  };
}

const classifyT = (runs: RunRecord[]): TestVerdict =>
  classifyAll(runs, baseCfg).find((v) => v.testId === 'T')!;

describe('in-report retry attempts (PAR-6 / TestCaseResult.attempts)', () => {
  it('fail then final pass → flaky-retry, exactly like a live retry rescue', () => {
    const v = classifyT([inReport('pass', ['fail', 'pass'])]);
    expect(v.classification).toBe('flaky-retry');
    expect(v.retryRescues).toBe(1);
    expect(v.flakeScore).toBe(40);
    expect(v.runsObserved).toBe(1);
    expect(v.passRate).toBe(0.5);
    const live = classifyT([
      inReport('fail', undefined, { runId: 'L', attempt: 1 }),
      inReport('pass', undefined, { runId: 'L', attempt: 2 }),
    ]);
    for (const k of ['classification', 'retryRescues', 'flakeScore', 'runsObserved'] as const) {
      expect(v[k]).toEqual(live[k]);
    }
  });

  it('with a commit SHA it is also a same-SHA flip (like a live rescue in git)', () => {
    const v = classifyT([inReport('pass', ['fail', 'fail', 'pass'], { sha: 'abc' })]);
    expect(v.classification).toBe('flaky-confirmed');
    expect(v.sameShaFlips).toBe(1);
    expect(v.retryRescues).toBe(1);
    expect(v.flakeScore).toBe(90);
  });

  it('errors count as the fail family', () => {
    expect(classifyT([inReport('pass', ['error', 'pass'])]).classification).toBe('flaky-retry');
  });

  it('all attempts failing → new-failure with every failed execution as evidence', () => {
    const v = classifyT([inReport('fail', ['fail', 'fail', 'fail'])]);
    expect(v.classification).toBe('new-failure');
    expect(v.runsObserved).toBe(1);
    expect(v.confidence).toBe(25); // 10 + 5×3
    expect(v.retryRescues).toBe(0);
  });

  it('pass then fail is not a rescue', () => {
    const v = classifyT([inReport('fail', ['pass', 'fail'])]);
    expect(v.retryRescues).toBe(0);
    expect(v.classification).toBe('new-failure');
  });

  it('a missing final entry is filled from status; junk entries are ignored', () => {
    expect(classifyT([inReport('pass', ['fail'])]).retryRescues).toBe(1);
    const junk = ['bogus', 'fail', 'pass'] as unknown as TestStatus[];
    expect(classifyT([inReport('pass', junk)]).retryRescues).toBe(1);
  });

  it('results without attempts (or a single attempt) behave exactly as before', () => {
    const plain = [
      inReport('fail', undefined, { sha: 'a', ts: 1_000 }),
      inReport('pass', undefined, { sha: 'b', ts: 2_000 }),
    ];
    const single = [
      inReport('fail', ['fail'], { sha: 'a', ts: 1_000 }),
      inReport('pass', ['pass'], { sha: 'b', ts: 2_000 }),
    ];
    expect(classifyT(single)).toEqual(classifyT(plain));
    expect(classifyT(plain).retryRescues).toBe(0);
  });

  it('an in-report failure rescued by the NEXT live attempt counts once', () => {
    const v = classifyT([
      inReport('fail', ['fail', 'fail'], { runId: 'R', attempt: 1 }),
      inReport('pass', undefined, { runId: 'R', attempt: 2 }),
    ]);
    expect(v.retryRescues).toBe(1);
    expect(v.runsObserved).toBe(1);
    expect(v.classification).toBe('flaky-retry');
  });

  it('message and duration: message on every execution, duration only on the last', () => {
    const v = classifyT([inReport('pass', ['fail', 'pass'], { message: 'flaky: failed 1 of 2' })]);
    expect(v.lastMessage).toBe('flaky: failed 1 of 2');
    expect(v.medianDurationMs).toBe(12);
    const h = buildHistories([inReport('pass', ['fail', 'pass'])]);
    expect(h[0]!.observations.map((o) => o.status)).toEqual(['fail', 'pass']);
    expect(h[0]!.observations.map((o) => o.durationMs)).toEqual([undefined, 12]);
    expect(h[0]!.observations[0]).not.toHaveProperty('sub');
  });
});

describe('slow tag floor (RUN-14)', () => {
  it('a 1 ms test in a 0 ms-median suite is not slow', () => {
    const runs: RunRecord[] = [0, 1, 2].map((i) => ({
      runId: `r${i}`,
      timestamp: new Date(Date.now() - 10_000 + i).toISOString(),
      source: 'report',
      parsedFrom: 'jest',
      attempt: 1,
      results: [
        { testId: 'a', suite: 's', name: 'a', status: 'pass', durationMs: 0 },
        { testId: 'b', suite: 's', name: 'b', status: 'pass', durationMs: 0 },
        { testId: 'c', suite: 's', name: 'c', status: 'pass', durationMs: 1 },
      ],
    }));
    const c = classifyAll(runs, baseCfg).find((v) => v.testId === 'c')!;
    expect(c.p95DurationMs).toBe(1);
    expect(c.tags).not.toContain('slow');
  });

  it('a 150 ms test in a 1 ms-median suite still is', () => {
    const runs: RunRecord[] = [0, 1].map((i) => ({
      runId: `r${i}`,
      timestamp: new Date(Date.now() - 10_000 + i).toISOString(),
      source: 'report',
      parsedFrom: 'jest',
      attempt: 1,
      results: [
        { testId: 'a', suite: 's', name: 'a', status: 'pass', durationMs: 1 },
        { testId: 'b', suite: 's', name: 'b', status: 'pass', durationMs: 1 },
        { testId: 'c', suite: 's', name: 'c', status: 'pass', durationMs: 150 },
      ],
    }));
    expect(classifyAll(runs, baseCfg).find((v) => v.testId === 'c')!.tags).toContain('slow');
  });
});
