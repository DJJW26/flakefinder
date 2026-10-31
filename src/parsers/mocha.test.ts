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

describe('mocha pass/fail-only shape (QA B-F1)', () => {
  it('parses a report with only passes/failures buckets (no tests/results array)', () => {
    const { results, warnings } = mochaParser.parse(load('mocha-passfail.json'), 'inline');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(2);
    // merged order: passes, then failures, then pending
    expect(results[0]).toMatchObject({
      suite: 'calc',
      name: 'adds up',
      status: 'pass',
      durationMs: 4,
    });
    expect(results[1]).toMatchObject({
      suite: 'calc',
      name: 'divides by zero',
      status: 'fail',
      durationMs: 2,
      message: 'Infinity is not a number',
    });
  });
});

// mocha-same-title-hook.json: REAL `mocha --reporter json` (mocha 10.8) for
// a.spec.js + b.spec.js (both `describe('api') > it('responds')`; only b's
// fails) and c.spec.js (`describe('db')` whose before() throws, so
// `it('queries')` never runs). Paths rewritten to /repo/test.
describe('mocha status matching + hook failures (r5 #9)', () => {
  it('one failure does not mark every same-titled test failed', () => {
    const { results } = mochaParser.parse(load('mocha-same-title-hook.json'), 'mocha.json');
    const responds = results.filter((r) => r.name === 'responds');
    expect(responds).toHaveLength(2);
    expect(responds.map((r) => r.status)).toEqual(['pass', 'fail']);
    expect(responds[0]).not.toHaveProperty('message');
    expect(responds[1]!.message).toContain('second api broke');
  });

  it('surfaces a "before all" hook failure that the tests array never lists', () => {
    const { results, warnings } = mochaParser.parse(
      load('mocha-same-title-hook.json'),
      'mocha.json',
    );
    const hook = results.find((r) => r.name.includes('hook'))!;
    expect(hook).toMatchObject({
      suite: 'db',
      name: '"before all" hook',
      status: 'fail',
      message: 'cannot connect',
    });
    expect(hook.stack).toContain('Error: cannot connect');
    expect(results).toHaveLength(3);
    expect(warnings.some((w) => w.includes('hook') && w.includes('db'))).toBe(true);
  });

  it('matches duplicates within one file in order (multiset, not set membership)', () => {
    const t = (title: string) => ({ title, fullTitle: `s ${title}`, file: 'f.js' });
    const doc = {
      stats: {},
      tests: [t('dup'), t('dup')],
      passes: [t('dup')],
      failures: [{ ...t('dup'), err: { message: 'boom' } }],
      pending: [],
    };
    const { results } = mochaParser.parse(JSON.stringify(doc), 'inline');
    expect(results.map((r) => r.status).sort()).toEqual(['fail', 'pass']);
  });
});

// mochawesome.json: REAL mochawesome output (QA fixture fx/mawe, paths → /repo)
// for the same spec as the QA mocha.json: 6 failures (4 tests + 2 hooks).
describe('mochawesome (QA PAR-1)', () => {
  it('parses the nested suite tree instead of one phantom passing test', () => {
    const { results, warnings } = mochaParser.parse(load('mochawesome.json'), 'mawe.json');
    expect(results.some((r) => r.name === '(unnamed)')).toBe(false);
    const fails = results.filter((r) => r.status === 'fail');
    expect(fails.map((r) => `${r.suite} :: ${r.name}`)).toEqual([
      'Outer :: slow',
      'Outer Inner :: fails',
      'Hooky :: "before all" hook',
      'Each :: "after each" hook',
      'Other :: same title',
      'Outer :: same title', // the SECOND `describe('Outer')` — the first one's passed
    ]);
    expect(fails[1]!.message).toContain('strictly deep-equal');
    expect(fails[1]!.stack).toContain('AssertionError');
    // tests a failing hook prevented from running are skips, not passes
    expect(results.find((r) => r.name === 'never runs')!.status).toBe('skip');
    expect(results.find((r) => r.name === 'x2')!.status).toBe('skip');
    expect(results.filter((r) => r.status === 'pass')).toHaveLength(5);
    // root-level test: suite falls back to the spec file, like mocha's own JSON
    expect(results.find((r) => r.name === 'root level')!.suite).toBe('/repo/js/mt/a.spec.js');
    expect(warnings.some((w) => w.includes('hook failure'))).toBe(true);
  });

  it('still sniffs as mocha (same parser, same identities as mocha --reporter json)', () => {
    expect(mochaParser.sniff(load('mochawesome.json'))).toBe(true);
  });
});

// mocha-qa.json: REAL `mocha --reporter json` (mocha 12, QA fixture fx/mocha.json,
// paths → /repo): a failing before() and afterEach(), --retries, and a duplicated
// `describe('Outer') > it('same title')` where only the SECOND copy fails.
describe('mocha QA fixture (QA PAR-3)', () => {
  it('records before/after hook failures that appear only in failures[]', () => {
    const { results, warnings } = mochaParser.parse(load('mocha-qa.json'), 'mocha.json');
    const hooks = results.filter((r) => r.name.endsWith('hook'));
    expect(hooks.map((r) => `${r.suite} :: ${r.name}:${r.status}`)).toEqual([
      'Hooky :: "before all" hook:fail',
      'Each :: "after each" hook:fail',
    ]);
    expect(hooks[0]!.message).toBe('before boom');
    expect(warnings.some((w) => w.includes('2 hook failure(s)'))).toBe(true);
    expect(results.filter((r) => r.status === 'fail')).toHaveLength(6);
  });

  it('gives a duplicated title its failure by err, not by position', () => {
    const { results } = mochaParser.parse(load('mocha-qa.json'), 'mocha.json');
    const dups = results.filter((r) => r.suite === 'Outer' && r.name === 'same title');
    expect(dups.map((r) => r.status)).toEqual(['pass', 'fail']);
    expect(dups[0]).not.toHaveProperty('message');
    expect(dups[1]!.message).toBe('dup describe fails');
  });
});

describe('mocha retries (QA PAR-6)', () => {
  it('a test that passed with currentRetry > 0 is flagged flaky', () => {
    const { results, warnings } = mochaParser.parse(load('mocha-qa.json'), 'mocha.json');
    const retried = results.find((r) => r.name === 'retried')!;
    expect(retried.status).toBe('pass');
    expect(retried.message).toBe('flaky: failed 1 of 2 attempts before passing on mocha retry');
    expect(warnings.some((w) => w.includes('FLAKY') && w.includes('Outer retried'))).toBe(true);
  });

  it('sets attempts for retried tests and none for single runs', () => {
    const { results } = mochaParser.parse(load('mocha-qa.json'), 'mocha.json');
    expect(results.find((r) => r.name === 'retried')!.attempts).toEqual(['fail', 'pass']);
    for (const r of results.filter((x) => x.name !== 'retried')) {
      expect(r).not.toHaveProperty('attempts');
    }
  });

  it('a test that failed after its retries failed all attempts', () => {
    const t = {
      title: 'net',
      fullTitle: 'S net',
      file: '/r/a.js',
      duration: 12.6,
      currentRetry: 2,
      err: { message: 'ECONNRESET' },
    };
    const doc = { stats: {}, tests: [t], passes: [], failures: [t], pending: [] };
    const { results } = mochaParser.parse(JSON.stringify(doc), 'inline');
    expect(results[0]).toMatchObject({
      status: 'fail',
      attempts: ['fail', 'fail', 'fail'],
      message: 'ECONNRESET\n(failed all 3 attempts)',
      durationMs: 13, // rounded (QA PAR-18)
    });
  });
});
