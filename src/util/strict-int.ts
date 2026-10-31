/**
 * Strict integer parsing for CLI flags (QA A7). `Number.parseInt` silently
 * accepts `2.5` → 2, `2x` → 2 and `50abc` → 50; flags must instead reject
 * anything that is not a plain base-10 integer inside [min, max].
 * Returns null when the value is malformed or out of range.
 */
export function parseStrictInt(value: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}
