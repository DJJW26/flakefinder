// STUB — Agent E owns this file. Replace entirely with real stats helpers (PLAN §5).
import type { Observation } from '../types.js';

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function p95(values: number[]): number | null {
  // stub approximation — Agent E implements nearest-rank properly
  return median(values);
}

export function durationStats(_obs: Observation[]): { medianMs: number | null; p95Ms: number | null } {
  return { medianMs: null, p95Ms: null };
}
