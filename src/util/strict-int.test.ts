import { describe, expect, it } from 'vitest';
import { parseStrictInt } from './strict-int.js';

describe('parseStrictInt (QA A7)', () => {
  it('accepts plain integers inside the range, including both bounds', () => {
    expect(parseStrictInt('0', 0, 10)).toBe(0);
    expect(parseStrictInt('10', 0, 10)).toBe(10);
    expect(parseStrictInt('7', 0, 10)).toBe(7);
    expect(parseStrictInt('-3', -5, 5)).toBe(-3);
    expect(parseStrictInt('007', 0, 10)).toBe(7);
  });

  it.each(['2.5', '2x', '50abc', 'abc', '', ' 2', '2 ', '+2', '1e3', '0x10', '-', '--1'])(
    'rejects malformed %j',
    (v) => {
      expect(parseStrictInt(v, -100, 10_000)).toBeNull();
    },
  );

  it('rejects out-of-range values', () => {
    expect(parseStrictInt('11', 0, 10)).toBeNull();
    expect(parseStrictInt('-1', 0, 10)).toBeNull();
    expect(parseStrictInt('0', 1, 1_000_000)).toBeNull();
    expect(parseStrictInt('99999999999999999999', 0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});
