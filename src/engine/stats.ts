import type { Observation } from '../types.js';

/** Standard median. Even count → mean of the two middle values. Empty → null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Nearest-rank percentile: index = ceil(p/100 * n) - 1 over ascending sort. Empty → null. */
export function p95(values: number[]): number | null {
  return percentile(values, 95);
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Median/p95 over the defined durationMs values of a chronology of observations. */
export function durationStats(obs: Observation[]): { medianMs: number | null; p95Ms: number | null } {
  const vals = obs
    .map((o) => o.durationMs)
    .filter((v): v is number => typeof v === 'number');
  return { medianMs: median(vals), p95Ms: p95(vals) };
}
