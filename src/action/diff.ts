import type { TestVerdict } from '../types.js';

const FLAKY = new Set(['flaky-confirmed', 'flaky-retry', 'flaky-suspected']);

/** Flaky now, and not flaky in the previous snapshot. Null previous → all flaky are new. */
export function computeNewFlakes(current: TestVerdict[], previous: TestVerdict[] | null): TestVerdict[] {
  const prevFlaky = new Set((previous ?? []).filter((v) => FLAKY.has(v.classification)).map((v) => v.testId));
  return current.filter((v) => FLAKY.has(v.classification) && !prevFlaky.has(v.testId));
}

/** Was flaky before, and is not flaky anymore (fixed, or degraded to failing). */
export function computeFixedFlakes(current: TestVerdict[], previous: TestVerdict[] | null): TestVerdict[] {
  if (previous === null) return [];
  const currentById = new Map(current.map((v) => [v.testId, v]));
  return previous.filter((v) => {
    if (!FLAKY.has(v.classification)) return false;
    const now = currentById.get(v.testId);
    return now === undefined || !FLAKY.has(now.classification);
  });
}
