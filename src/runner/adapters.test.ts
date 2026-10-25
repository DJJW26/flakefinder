import { describe, expect, it } from 'vitest';
import type { TestCaseResult } from '../types.js';
import { failedNamesOf, failedOnlyArgs } from './adapters.js';

function result(name: string, status: TestCaseResult['status']): TestCaseResult {
  return { testId: `id-${name}`, suite: 's.test.js', name, status, durationMs: 1 };
}

describe('failedNamesOf', () => {
  it('collects fail and error names, deduped, ignoring passes', () => {
    const records = [
      { results: [result('a', 'fail'), result('b', 'pass'), result('a', 'error')] },
      { results: [result('a', 'pass')] },
    ];
    expect(failedNamesOf(records)).toEqual(['a']);
  });
  it('empty records → empty list', () => {
    expect(failedNamesOf([])).toEqual([]);
  });
});

describe('failedOnlyArgs', () => {
  it('jest: single -t positive pattern, names regex-escaped', () => {
    const args = failedOnlyArgs('jest', ['does (x)', 'plain']);
    expect(args).toEqual(['-t', '^(?:.* )?(?:does \\(x\\)|plain)$']);
  });
  it('mocha: --grep with the same construction', () => {
    expect(failedOnlyArgs('mocha', ['one'])).toEqual(['--grep', '^(?:.* )?(?:one)$']);
  });
  it('go: anchored -run on top-level parents of subtests', () => {
    expect(failedOnlyArgs('go', ['TestX/sub', 'TestY'])).toEqual(['-run', '^(TestX|TestY)$']);
  });
  it('pytest: --lf (last-failed cache)', () => {
    expect(failedOnlyArgs('pytest', ['test_a'])).toEqual(['--lf']);
  });
  it('generic: no adapter → null (caller falls back to full re-run)', () => {
    expect(failedOnlyArgs('generic', ['a'])).toBeNull();
  });
  it('no failures → null regardless of runner', () => {
    expect(failedOnlyArgs('jest', [])).toBeNull();
  });
});

describe('boundary-anchored selectors (QA round 3)', () => {
  it('does NOT suffix-over-match: "update" must not select "math re-update"', () => {
    const args = failedOnlyArgs('jest', ['update'])!;
    const re = new RegExp(args[1]!);
    expect(re.test('suite update')).toBe(true);
    expect(re.test('math re-update')).toBe(false);
    expect(re.test('update')).toBe(true); // root-level test (no ancestors)
  });
  it('boundary form still selects nested ancestors and rejects mid-name matches', () => {
    const args = failedOnlyArgs('jest', ['case'])!;
    const re = new RegExp(args[1]!);
    expect(re.test('suite my case')).toBe(true);
    expect(re.test('suite case two')).toBe(false);
    expect(re.test('case')).toBe(true);
  });
  it('quarantined names get a boundary-anchored negative lookahead (suffix collision stays excluded)', () => {
    const args = failedOnlyArgs('jest', ['login ok'], ['renders login ok'])!;
    const re = new RegExp(args[1]!);
    expect(re.test('suite login ok')).toBe(true);
    expect(re.test('ui renders login ok')).toBe(false); // quarantined, suffix collision
  });
});
