import { describe, expect, it } from 'vitest';
import { durationStats, median, p95 } from './stats.js';
import type { Observation } from '../types.js';

describe('median', () => {
  it('returns null for empty input', () => {
    expect(median([])).toBeNull();
  });
  it('odd count returns middle value', () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  it('even count returns mean of middle two', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
  it('does not mutate input', () => {
    const input = [5, 1];
    median(input);
    expect(input).toEqual([5, 1]);
  });
});

describe('p95 (nearest-rank)', () => {
  it('returns null for empty input', () => {
    expect(p95([])).toBeNull();
  });
  it('single value returns that value', () => {
    expect(p95([42])).toBe(42);
  });
  it('n=20 → index ceil(0.95*20)-1 = 18 (19th value ascending)', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(p95(values)).toBe(19);
  });
  it('n=100 → 95th value ascending', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(values)).toBe(95);
  });
  it('n=10 → index ceil(9.5)-1 = 9 (10th value)', () => {
    const values = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(p95(values)).toBe(10);
  });
});

describe('durationStats', () => {
  it('handles all-undefined durations', () => {
    const obs = [{ durationMs: undefined }, {}] as Observation[];
    expect(durationStats(obs)).toEqual({ medianMs: null, p95Ms: null });
  });
  it('uses only defined numeric durations', () => {
    const obs = [
      { durationMs: 100 },
      { durationMs: 300 },
      { durationMs: undefined },
      { durationMs: 200 },
    ] as Observation[];
    expect(durationStats(obs)).toEqual({ medianMs: 200, p95Ms: 300 });
  });
});
