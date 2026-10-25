import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { mochaParser } from './mocha.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('mochaParser', () => {
  it('parses the mocha json fixture exactly (statuses by membership, err mapping)', () => {
    const { results, warnings } = mochaParser.parse(load('mocha.json'), 'mocha.json');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(5);

    // [0] pass with file attr
    expect(results[0]).toMatchObject({
      testId: makeTestId('Array #indexOf()', 'should return -1 when the value is not present'),
      suite: 'Array #indexOf()',
      name: 'should return -1 when the value is not present',
      status: 'pass',
      durationMs: 2,
    });
    expect(results[0]).not.toHaveProperty('message');
    expect(results[0]).not.toHaveProperty('stack');

    // [1] pass, empty file → suite still derived from fullTitle
    expect(results[1]).toMatchObject({
      suite: 'Math max()',
      name: 'should return 3',
      status: 'pass',
      durationMs: 1,
    });

    // [2] failure matched by fullTitle (JSON.parse creates distinct objects)
    expect(results[2]).toMatchObject({
      testId: makeTestId('Math max()', 'should return the max'),
      suite: 'Math max()',
      name: 'should return the max',
      status: 'fail',
      durationMs: 5,
    });
    expect(results[2]?.message).toBe('expected 3 to equal 4');
    expect(results[2]?.stack).toBe(
      'AssertionError: expected 3 to equal 4\n    at Context.<anonymous> (test/math.test.js:14:20)\n    at processImmediate (node:internal/timers:471:21)',
    );

    // [3] pass with nested describe chain
    expect(results[3]).toMatchObject({
      suite: 'API user login',
      name: 'rejects bad password',
      status: 'pass',
      durationMs: 45,
    });

    // [4] pending → skip, no duration field → null
    expect(results[4]).toMatchObject({
      suite: 'String #split()',
      name: 'should be fast',
      status: 'skip',
      durationMs: null,
    });
    expect(results[4]).not.toHaveProperty('message');

    // testId consistency
    for (const r of results) {
      expect(r.testId).toBe(makeTestId(r.suite, r.name));
    }
  });

  it('accepts the "results" array spelling of the document', () => {
    const content = JSON.stringify({
      stats: { tests: 1, passes: 1, failures: 0, pending: 0 },
      results: [{ title: 'works', fullTitle: 'thing works', duration: 4, err: {} }],
      passes: [{ title: 'works', fullTitle: 'thing works' }],
      failures: [],
      pending: [],
    });
    const { results, warnings } = mochaParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results).toEqual([
      {
        testId: makeTestId('thing', 'works'),
        suite: 'thing',
        name: 'works',
        status: 'pass',
        durationMs: 4,
      },
    ]);
  });

  it('prefers fail when a fullTitle appears in both failures and passes (retries)', () => {
    const test = { title: 'flaky', fullTitle: 'suite flaky', duration: 9, err: {} };
    const content = JSON.stringify({
      stats: { tests: 1 },
      tests: [test],
      passes: [{ title: 'flaky', fullTitle: 'suite flaky' }],
      failures: [{ title: 'flaky', fullTitle: 'suite flaky' }],
      pending: [],
    });
    const { results } = mochaParser.parse(content, 'inline');
    expect(results[0]?.status).toBe('fail');
  });

  it('falls back to the test state field when membership lists are absent', () => {
    const content = JSON.stringify({
      stats: { tests: 1 },
      tests: [{ title: 'only', fullTitle: 'suite only', state: 'failed', err: {} }],
    });
    const { results } = mochaParser.parse(content, 'inline');
    expect(results[0]?.status).toBe('fail');
  });

  it('defaults unknown membership to pass and maps a string err to message', () => {
    const content = JSON.stringify({
      stats: { tests: 1 },
      tests: [{ title: 'odd', fullTitle: 'suite odd', err: 'boom happened' }],
    });
    const { results } = mochaParser.parse(content, 'inline');
    expect(results[0]?.status).toBe('pass');
    expect(results[0]?.message).toBe('boom happened');
    expect(results[0]).not.toHaveProperty('stack');
  });

  it('collects a warning instead of throwing on invalid JSON', () => {
    const { results, warnings } = mochaParser.parse('{ stats: ', 'bad.json');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('invalid JSON');
  });

  it('sniffs mocha documents and rejects other shapes', () => {
    expect(mochaParser.sniff(load('mocha.json'))).toBe(true);
    // passes + failures without stats is still mocha
    expect(mochaParser.sniff('{"passes": [], "failures": []}')).toBe(true);
    // results + stats is mocha
    expect(mochaParser.sniff('{"results": [], "stats": {}}')).toBe(true);
    expect(mochaParser.sniff('hello world')).toBe(false);
    expect(mochaParser.sniff('{}')).toBe(false);
    expect(mochaParser.sniff(load('jest.json'))).toBe(false);
  });
});
