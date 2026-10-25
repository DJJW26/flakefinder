import { describe, expect, it } from 'vitest';
import { FLAKEFINDER_VERSION } from './types.js';
import { makeTestId } from './util/test-id.js';

describe('phase-0 smoke', () => {
  it('makeTestId is deterministic and whitespace-normalized', () => {
    expect(makeTestId('a/b.test.ts', 'does x')).toBe(makeTestId(' a/b.test.ts ', 'does  x '));
  });

  it('makeTestId separates suite and name contributions', () => {
    expect(makeTestId('a', 'b')).not.toBe(makeTestId('b', 'a'));
  });

  it('version constant exists', () => {
    expect(FLAKEFINDER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
