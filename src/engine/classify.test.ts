import { describe, expect, it } from 'vitest';
import type { ResolvedConfig, RunRecord, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { buildHistories, classifyAll } from './classify.js';

const cfg: ResolvedConfig = {
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

interface TestSpec {
  /** testId; defaults to makeTestId('suite.ts', id) */
  id?: string;
  suite?: string;
  name?: string;
  status: TestStatus;
  sha?: string;
  /** days ago for this observation; default 0 (now) */
  daysAgo?: number;
  attempt?: number;
  runId?: string;
  durationMs?: number;
  message?: string;
}

let clock = 0;

/** Build one RunRecord from specs; records get increasing timestamps (stable chronological order). */
function run(specs: TestSpec[]): RunRecord {
  const ts = new Date(Date.now() - 10_000 + clock++).toISOString();
  const defaultRunId = `run-${clock}`;
  return {
    runId: specs[0]?.runId ?? defaultRunId,
    timestamp: specs[0]
      ? new Date(Date.now() - (specs[0].daysAgo ?? 0) * 86_400_000).toISOString()
      : ts,
    source: 'report',
    parsedFrom: 'junit',
    attempt: specs[0]?.attempt ?? 1,
    commitSha: specs[0]?.sha,
    results: specs.map((s): TestCaseResult => {
      const suite = s.suite ?? 'suite.ts';
      const name = s.name ?? s.id ?? 'test';
      return {
        testId: s.id ?? makeTestId(suite, name),
        suite,
        name,
        status: s.status,
        durationMs: s.durationMs ?? null,
        message: s.message,
      };
    }),
  };
}

/** Runs where each RunRecord carries ONE test observation (the common case in tests). */
function history(...specs: TestSpec[]): RunRecord[] {
  return specs.map((s) => run([s]));
}

function verdictOf(runs: RunRecord[], name = 'test') {
  const all = classifyAll(runs, cfg);
  const v = all.find((x) => x.name === name);
  if (!v) throw new Error(`no verdict for ${name}: got ${all.map((x) => x.name).join(', ')}`);
  return v;
}

describe('classification precedence (PLAN §5)', () => {
  it('same-commit pass+fail → flaky-confirmed, score 50, confidence 100', () => {
    const runs = history({ status: 'fail', sha: 'aaa' }, { status: 'pass', sha: 'aaa' });
    const v = verdictOf(runs);
    expect(v.classification).toBe('flaky-confirmed');
    expect(v.flakeScore).toBe(50);
    expect(v.confidence).toBe(100);
    expect(v.sameShaFlips).toBe(1);
    expect(v.passRate).toBe(0.5);
  });

  it('failed attempt then retry pass (same runId) → flaky-retry, score 40', () => {
    const runs = [
      run([{ status: 'fail', runId: 'R', attempt: 1 }]),
      run([{ status: 'pass', runId: 'R', attempt: 2 }]),
    ];
    const v = verdictOf(runs);
    expect(v.classification).toBe('flaky-retry');
    expect(v.flakeScore).toBe(40);
    expect(v.retryRescues).toBe(1);
  });

  it('precedence: same-sha flip beats retry rescue → flaky-confirmed with score 90', () => {
    const runs = [
      run([{ status: 'fail', runId: 'R', attempt: 1, sha: 'aaa' }]),
      run([{ status: 'pass', runId: 'R', attempt: 2, sha: 'aaa' }]),
    ];
    const v = verdictOf(runs);
    expect(v.classification).toBe('flaky-confirmed');
    expect(v.flakeScore).toBe(90); // 50 + 40
  });

  it('alternating distinct commits → flaky-suspected', () => {
    const runs = history(
      { status: 'fail', sha: 'a' },
      { status: 'pass', sha: 'b' },
      { status: 'fail', sha: 'c' },
      { status: 'pass', sha: 'd' },
    );
    const v = verdictOf(runs);
    expect(v.classification).toBe('flaky-suspected');
    expect(v.directionChanges).toBe(3);
    expect(v.flakeScore).toBe(24); // 3 changes × 8 × 1.0, no caps hit
    expect(v.confidence).toBe(47); // min(70, round(35 * 4/3))
  });

  it('all recent fails with enough data → failing', () => {
    const runs = history(
      { status: 'fail', sha: 'a' },
      { status: 'fail', sha: 'b' },
      { status: 'fail', sha: 'c' },
      { status: 'fail', sha: 'd' },
      { status: 'fail', sha: 'e' },
    );
    const v = verdictOf(runs);
    expect(v.classification).toBe('failing');
    expect(v.confidence).toBe(50); // min(95, 25 + 5*5)
    expect(v.flakeScore).toBe(0);
  });

  it('single fail → new-failure with low confidence', () => {
    const v = verdictOf(history({ status: 'fail', sha: 'a' }));
    expect(v.classification).toBe('new-failure');
    expect(v.confidence).toBe(15); // 10 + 5*1
  });

  it('all passes → passing with score 0', () => {
    const v = verdictOf(history({ status: 'pass', sha: 'a' }, { status: 'pass', sha: 'b' }));
    expect(v.classification).toBe('passing');
    expect(v.flakeScore).toBe(0);
    expect(v.confidence).toBe(100);
  });

  it('all skips → skipped with zero runs observed', () => {
    const v = verdictOf(history({ status: 'skip' }, { status: 'skip' }));
    expect(v.classification).toBe('skipped');
    expect(v.runsObserved).toBe(0);
    expect(v.passRate).toBe(0);
  });

  it('skips are excluded from flake math (4 passes + 2 skips → runsObserved 4)', () => {
    const v = verdictOf(
      history(
        { status: 'pass', sha: 'a' },
        { status: 'skip' },
        { status: 'pass', sha: 'b' },
        { status: 'pass', sha: 'c' },
        { status: 'skip' },
        { status: 'pass', sha: 'd' },
      ),
    );
    expect(v.runsObserved).toBe(4);
    expect(v.passRate).toBe(1);
  });
});

describe('gone / long-unseen', () => {
  it('test absent from the last 30 runs → gone + long-unseen tag', () => {
    const targetId = makeTestId('old.ts', 'ancient');
    const runs: RunRecord[] = [];
    // run 1 (oldest): target passes
    runs.push(run([{ id: targetId, suite: 'old.ts', name: 'ancient', status: 'pass' }]));
    // 30 filler runs without the target — target's record must be OUTSIDE the recent window
    for (let i = 0; i < 30; i++) {
      runs.push(run([{ suite: 'f.ts', name: 'filler', status: 'pass' }]));
    }
    const v = classifyAll(runs, cfg).find((x) => x.name === 'ancient')!;
    expect(v.classification).toBe('gone');
    expect(v.tags).toContain('long-unseen');
    const filler = classifyAll(runs, cfg).find((x) => x.name === 'filler')!;
    expect(filler.classification).toBe('passing');
  });
});

describe('score arithmetic and caps', () => {
  it('sameShaFlips capped at 50', () => {
    const specs: TestSpec[] = [];
    for (let i = 0; i < 10; i++) {
      specs.push({ status: 'fail', sha: `sha${i}` });
      specs.push({ status: 'pass', sha: `sha${i}` });
    }
    const v = verdictOf(history(...specs));
    expect(v.sameShaFlips).toBe(10);
    expect(v.classification).toBe('flaky-confirmed');
    expect(v.flakeScore).toBe(60); // 50 (cap) + 0 direction + 10 data bonus (20 runs)
  });

  it('retryRescues capped at 40', () => {
    const specs: TestSpec[] = [
      { status: 'fail', runId: 'R', attempt: 1 },
      { status: 'pass', runId: 'R', attempt: 2 },
      { status: 'fail', runId: 'R', attempt: 3 },
      { status: 'pass', runId: 'R', attempt: 4 },
      { status: 'fail', runId: 'R', attempt: 5 },
      { status: 'pass', runId: 'R', attempt: 6 },
    ];
    const v = verdictOf(history(...specs));
    expect(v.retryRescues).toBe(3);
    expect(v.flakeScore).toBe(40);
  });

  it('directionChanges capped at 24', () => {
    const specs: TestSpec[] = [];
    for (let i = 0; i < 11; i++) {
      specs.push({ status: i % 2 === 0 ? 'fail' : 'pass', sha: `s${i}` });
    }
    const v = verdictOf(history(...specs));
    expect(v.directionChanges).toBe(10);
    expect(v.flakeScore).toBe(34); // min(24, 10*8) + data bonus 10 (21 runs)
  });

  it('data bonus +10 at exactly 10 observations', () => {
    const specs: TestSpec[] = [
      { status: 'fail', sha: 'a' },
      { status: 'pass', sha: 'a' },
    ];
    for (let i = 0; i < 8; i++) specs.push({ status: 'pass', sha: `fill${i}` });
    const v = verdictOf(history(...specs));
    expect(v.runsObserved).toBe(10);
    expect(v.flakeScore).toBe(60); // 50 same-sha + 0 direction + 10 bonus
  });

  it('recency multiplier tiers keyed on the most recent flip: 1.0 (≤14d), 0.6 (≤30d), 0.3 (older)', () => {
    const seq = (flipDaysAgo: number): TestSpec[] => [
      { status: 'fail', sha: 'a', daysAgo: 100 },
      { status: 'pass', sha: 'b', daysAgo: 99 },
      { status: 'fail', sha: 'c', daysAgo: 98 },
      { status: 'pass', sha: 'd', daysAgo: flipDaysAgo },
    ];
    expect(verdictOf(history(...seq(5))).flakeScore).toBe(24); // 3×8×1.0
    expect(verdictOf(history(...seq(20))).flakeScore).toBe(14); // round(3×8×0.6)=14.4→14
    expect(verdictOf(history(...seq(90))).flakeScore).toBe(7); // round(3×8×0.3)=7.2→7
  });

  it('recency keys on the latest flip, not the latest failure (RUN-9)', () => {
    // F/P/F 60 days ago, then the F→P flip yesterday: the flip is fresh
    const v = verdictOf(
      history(
        { status: 'fail', sha: 'a', daysAgo: 60 },
        { status: 'pass', sha: 'b', daysAgo: 60 },
        { status: 'fail', sha: 'c', daysAgo: 60 },
        { status: 'pass', sha: 'd', daysAgo: 1 },
      ),
    );
    expect(v.directionChanges).toBe(3);
    expect(v.flakeScore).toBe(24);
    // passes after the flip do not move the anchor: the flip itself is 40 days old
    const stale = verdictOf(
      history(
        { status: 'fail', sha: 'a', daysAgo: 60 },
        { status: 'pass', sha: 'b', daysAgo: 50 },
        { status: 'fail', sha: 'c', daysAgo: 45 },
        { status: 'pass', sha: 'd', daysAgo: 40 },
        { status: 'pass', sha: 'e', daysAgo: 1 },
      ),
    );
    expect(stale.directionChanges).toBe(3);
    expect(stale.flakeScore).toBe(7); // round(3×8×0.3)
  });

  it('unparseable timestamp treated as recent (multiplier 1.0)', () => {
    const runs: RunRecord[] = [
      {
        runId: 'r1',
        timestamp: 'not-a-date',
        source: 'report',
        parsedFrom: 'junit',
        attempt: 1,
        commitSha: 'a',
        results: [
          {
            testId: makeTestId('suite.ts', 'test'),
            suite: 'suite.ts',
            name: 'test',
            status: 'fail',
            durationMs: null,
          },
        ],
      },
      run([{ status: 'pass', sha: 'b' }]),
      run([{ status: 'fail', sha: 'c' }]),
      run([{ status: 'pass', sha: 'd' }]),
    ];
    const v = verdictOf(runs);
    expect(v.classification).toBe('flaky-suspected');
    expect(v.flakeScore).toBe(24);
  });
});

describe('tags', () => {
  it('slow: absolute median over threshold', () => {
    const v = verdictOf(
      history({ status: 'pass', sha: 'a', durationMs: 20_000 }, { status: 'pass', sha: 'b' }),
    );
    expect(v.tags).toContain('slow');
  });

  it('slow: relative p95 vs suite median', () => {
    const mk = (name: string, durationMs: number) =>
      Array.from({ length: 5 }, (_, i) => ({
        suite: 'same.ts',
        name,
        status: 'pass' as TestStatus,
        sha: `s${name}-${i}`,
        durationMs,
      }));
    // suite medians: [100, 100, 100, 6002] → median 100 → relative bar = 500
    const v = verdictOf(
      history(
        ...mk('steady1', 100),
        ...mk('steady2', 100),
        ...mk('steady3', 100),
        ...mk('spiky', 6002),
      ),
      'spiky',
    );
    expect(v.p95DurationMs).toBe(6002);
    expect(v.tags).toContain('slow'); // 6002 > 5 × 100
    const steady = verdictOf(
      history(
        ...mk('steady1', 100),
        ...mk('steady2', 100),
        ...mk('steady3', 100),
        ...mk('spiky', 6002),
      ),
      'steady1',
    );
    expect(steady.tags).not.toContain('slow');
  });

  it('recently-fixed: fails in first half, all passes in last window', () => {
    const specs: TestSpec[] = [];
    for (let i = 0; i < 5; i++) specs.push({ status: 'fail', sha: `f${i}` });
    for (let i = 0; i < 5; i++) specs.push({ status: 'pass', sha: `p${i}` });
    const v = verdictOf(history(...specs));
    expect(v.tags).toContain('recently-fixed');
    expect(v.classification).toBe('passing');
  });
});

describe('misc verdict fields', () => {
  it('lastMessage comes from the latest fail-family observation', () => {
    const v = verdictOf(
      history(
        { status: 'fail', sha: 'a', message: 'older failure' },
        { status: 'fail', sha: 'b', message: 'latest failure' },
        { status: 'pass', sha: 'c' },
      ),
    );
    expect(v.lastMessage).toBe('latest failure');
  });

  it('runsObserved counts each invocation once, even with retries and duplicate report lines', () => {
    const cases: Array<{ runId: string; attempt: number; specs: TestSpec[] }> = [
      { runId: 'R', attempt: 1, specs: [{ status: 'fail' }, { status: 'fail' }] },
      { runId: 'R', attempt: 2, specs: [{ status: 'pass' }] },
    ];
    const runs = cases.map((c) => {
      const specs = c.specs.map((s) => ({ ...s, runId: c.runId, attempt: c.attempt }));
      const rec = run(specs);
      rec.runId = c.runId;
      rec.attempt = c.attempt;
      return rec;
    });
    const v = verdictOf(runs);
    expect(v.runsObserved).toBe(1); // one runId = one run (RUN-8)
    expect(v.retryRescues).toBe(1);
    expect(v.passRate).toBe(0.5); // over executions: attempt 1 fail, attempt 2 pass
  });
});

describe('buildHistories', () => {
  it('latest suite/name wins and observations are chronological', () => {
    const id = makeTestId('new-name.ts', 'renamed');
    const runs: RunRecord[] = [
      {
        runId: 'r2',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        source: 'report' as const,
        parsedFrom: 'junit',
        attempt: 1,
        results: [
          { testId: id, suite: 'new-name.ts', name: 'renamed', status: 'pass', durationMs: null },
        ],
      },
      {
        runId: 'r1',
        timestamp: new Date(Date.now() - 5000).toISOString(),
        source: 'report' as const,
        parsedFrom: 'junit',
        attempt: 1,
        results: [
          { testId: id, suite: 'old-name.ts', name: 'old', status: 'fail', durationMs: null },
        ],
      },
    ];
    const h = buildHistories(runs);
    expect(h).toHaveLength(1);
    expect(h[0]!.suite).toBe('new-name.ts');
    expect(h[0]!.observations[0]!.runId).toBe('r1');
    expect(h[0]!.observations[1]!.runId).toBe('r2');
  });
});

describe('edge cases', () => {
  it('empty runs → empty verdicts', () => {
    expect(classifyAll([], cfg)).toEqual([]);
  });

  it('passRate excludes skips: 3 pass + 1 fail → 0.75', () => {
    const v = verdictOf(
      history(
        { status: 'pass', sha: 'a' },
        { status: 'pass', sha: 'b' },
        { status: 'fail', sha: 'c' },
        { status: 'pass', sha: 'd' },
      ),
    );
    expect(v.passRate).toBe(0.75);
  });
});

describe('SHA-less histories (no git repo)', () => {
  it('alternating pass/fail across distinct runs without commitShas → flaky-suspected', () => {
    // Before the runId-fallback fix, directionChanges was commit-only and this
    // classified as new-failure/passing — silently hiding real flakes.
    const specs: TestSpec[] = [
      { status: 'fail', runId: 'r1' },
      { status: 'pass', runId: 'r2' },
      { status: 'fail', runId: 'r3' },
      { status: 'pass', runId: 'r4' },
      { status: 'fail', runId: 'r5' },
      { status: 'pass', runId: 'r6' },
    ];
    const v = verdictOf(history(...specs));
    expect(v.directionChanges).toBe(5);
    expect(v.classification).toBe('flaky-suspected');
    expect(v.flakeScore).toBe(24); // min(24, 5×8×1.0)
  });

  it('same-runId retry attempts stay ONE bucket (no phantom direction changes)', () => {
    const specs: TestSpec[] = [
      { status: 'fail', runId: 'R', attempt: 1 },
      { status: 'pass', runId: 'R', attempt: 2 },
    ];
    const v = verdictOf(history(...specs));
    expect(v.directionChanges).toBe(0);
    expect(v.classification).toBe('flaky-retry');
  });
});
