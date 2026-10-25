import { describe, expect, it } from 'vitest';
import type { TestVerdict } from '../types.js';
import { computeFixedFlakes, computeNewFlakes } from './diff.js';

function verdict(testId: string, classification: TestVerdict['classification']): TestVerdict {
  return {
    testId,
    suite: 's.ts',
    name: `n-${testId}`,
    classification,
    tags: [],
    flakeScore: classification.startsWith('flaky') ? 70 : 0,
    confidence: 100,
    passRate: 0.5,
    runsObserved: 5,
    lastStatus: 'pass',
    lastSeen: new Date().toISOString(),
    medianDurationMs: null,
    p95DurationMs: null,
    sameShaFlips: 0,
    retryRescues: 0,
    directionChanges: 0,
  };
}

describe('computeNewFlakes', () => {
  it('null previous → every flaky verdict is new', () => {
    const current = [verdict('a', 'flaky-confirmed'), verdict('b', 'passing'), verdict('c', 'flaky-retry')];
    expect(computeNewFlakes(current, null).map((v) => v.testId)).toEqual(['a', 'c']);
  });
  it('only flakes absent from the previous flaky set are new', () => {
    const previous = [verdict('a', 'flaky-confirmed'), verdict('x', 'passing')];
    const current = [verdict('a', 'flaky-suspected'), verdict('b', 'flaky-confirmed'), verdict('c', 'failing')];
    expect(computeNewFlakes(current, previous).map((v) => v.testId)).toEqual(['b']);
  });
  it('a test flaky before AND now is known, not new', () => {
    const previous = [verdict('a', 'flaky-retry')];
    const current = [verdict('a', 'flaky-confirmed')];
    expect(computeNewFlakes(current, previous)).toEqual([]);
  });
});

describe('computeFixedFlakes', () => {
  it('empty when previous is null', () => {
    expect(computeFixedFlakes([verdict('a', 'passing')], null)).toEqual([]);
  });
});

describe('computeFixedFlakes semantics', () => {
  it('fixed = previously flaky and now not flaky (passing, failing, or absent)', () => {
    const previous = [
      verdict('fixed-now-passing', 'flaky-confirmed'),
      verdict('degraded-to-failing', 'flaky-retry'),
      verdict('removed-from-suite', 'flaky-suspected'),
      verdict('still-flaky', 'flaky-confirmed'),
    ];
    const current = [
      verdict('fixed-now-passing', 'passing'),
      verdict('degraded-to-failing', 'failing'),
      verdict('still-flaky', 'flaky-confirmed'),
    ];
    const fixed = computeFixedFlakes(current, previous).map((v) => v.testId).sort();
    expect(fixed).toEqual(['degraded-to-failing', 'fixed-now-passing', 'removed-from-suite'].sort());
  });
});
