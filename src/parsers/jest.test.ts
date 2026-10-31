import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { jestParser } from './jest.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('jestParser', () => {
  it('parses the multi-file fixture exactly (passes, failure, pending, suite failure)', () => {
    const { results, warnings } = jestParser.parse(load('jest.json'), 'jest.json');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(5);

    // [0] pass with ancestorTitles
    expect(results[0]).toMatchObject({
      testId: makeTestId('Calculator > add', 'adds two numbers'),
      suite: 'Calculator > add',
      name: 'adds two numbers',
      status: 'pass',
      durationMs: 12,
    });
    expect(results[0]).not.toHaveProperty('message');

    // [1] failure with failureMessages[0] as message
    expect(results[1]).toMatchObject({
      testId: makeTestId('Calculator > divide', 'divides evenly'),
      suite: 'Calculator > divide',
      name: 'divides evenly',
      status: 'fail',
      durationMs: 8,
    });
    expect(results[1]?.message).toBe(
      'Expected: 2\nReceived: 1\n\n    at Object.<anonymous> (/repo/src/calc.test.js:23:5)\n    at Promise (native)',
    );

    // [2] pass without ancestorTitles → suite is the file path
    expect(results[2]).toMatchObject({
      testId: makeTestId('/repo/src/config.test.js', 'parses a config file'),
      suite: '/repo/src/config.test.js',
      name: 'parses a config file',
      status: 'pass',
      durationMs: 5,
    });

    // [3] pending → skip, duration null
    expect(results[3]).toMatchObject({
      suite: 'Config',
      name: 'skips legacy format',
      status: 'skip',
      durationMs: null,
    });
    expect(results[3]).not.toHaveProperty('message');

    // [4] file-level suite failure → one synthetic '(suite)' result
    expect(results[4]).toMatchObject({
      testId: makeTestId('/repo/src/util.test.js', '(suite)'),
      suite: '/repo/src/util.test.js',
      name: '(suite)',
      status: 'fail',
      durationMs: null,
    });
    expect(results[4]?.message).toMatch(/^FAIL \/repo\/src\/util\.test\.js/);
    expect(results[4]?.message).toContain('SyntaxError');
  });

  it('parses the minimal fixture (single pass, no ancestorTitles, no duration)', () => {
    const { results, warnings } = jestParser.parse(load('jest-minimal.json'), 'jest-minimal.json');
    expect(warnings).toEqual([]);
    expect(results).toEqual([
      {
        testId: makeTestId('/repo/smoke.test.js', 'works'),
        suite: '/repo/smoke.test.js',
        name: 'works',
        status: 'pass',
        durationMs: null,
      },
    ]);
  });

  it('normalizes windows file paths to forward slashes', () => {
    const content = JSON.stringify({
      testResults: [
        {
          name: 'C:\\repo\\src\\win.test.js',
          status: 'passed',
          assertionResults: [
            {
              status: 'passed',
              title: 'runs on windows',
              ancestorTitles: [],
              duration: 3,
              failureMessages: [],
            },
          ],
        },
      ],
    });
    const { results } = jestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({
      suite: 'C:/repo/src/win.test.js',
      name: 'runs on windows',
      status: 'pass',
      durationMs: 3,
    });
  });

  it('maps todo to skip and truncates messages to 2000 chars', () => {
    const longMessage = 'x'.repeat(3000);
    const content = JSON.stringify({
      testResults: [
        {
          name: '/repo/t.test.js',
          status: 'failed',
          assertionResults: [
            {
              status: 'todo',
              title: 'someday',
              ancestorTitles: [],
              failureMessages: [longMessage],
            },
          ],
        },
      ],
    });
    const { results } = jestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ name: 'someday', status: 'skip', durationMs: null });
    expect(results[0]?.message).toBe('x'.repeat(2000));
  });

  it('collects a warning instead of throwing on invalid JSON', () => {
    const { results, warnings } = jestParser.parse('{"testResults": [bro', 'bad.json');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('invalid JSON');
  });

  it('collects a warning when testResults is missing', () => {
    const { results, warnings } = jestParser.parse('{"success": true}', 'not-jest.json');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('testResults');
  });

  it('sniffs jest JSON and rejects other shapes', () => {
    expect(jestParser.sniff(load('jest.json'))).toBe(true);
    expect(jestParser.sniff(load('jest-minimal.json'))).toBe(true);
    expect(jestParser.sniff('hello world')).toBe(false);
    // an EMPTY testResults array is a jest run with no tests (r5 #10); a non-empty
    // one still needs assertionResults
    expect(jestParser.sniff('{"testResults": [{"name": "x"}]}')).toBe(false);
    expect(jestParser.sniff(load('mocha.json'))).toBe(false);
  });
});

describe('vitest compatibility (QA round 2)', () => {
  it('maps status "skipped" (vitest) to skip, like "pending" (jest)', () => {
    const content = JSON.stringify({
      testResults: [
        {
          name: 'vitest.test.ts',
          status: 'skipped',
          assertionResults: [
            {
              title: 'vs',
              fullName: 'VS > vs',
              status: 'skipped',
              ancestorTitles: ['VS'],
              duration: 0,
            },
          ],
        },
      ],
    });
    const { results, warnings } = jestParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'vs', status: 'skip', suite: 'VS' });
  });
});

// jest-suite-failure.json / jest-no-tests.json: REAL `jest --json` (jest 29.7)
// output, paths rewritten to /repo. Files: only.test.js (test.only → the other
// test is pending, file status "focused"), statuses.test.js (pass, skip, todo,
// fail), after.test.js (afterAll throws; its only test PASSED), empty.test.js
// (no tests). jest-no-tests.json is `jest --json --passWithNoTests` on an
// empty tree.
describe('jest statuses + suite failures (r5 #10)', () => {
  it('maps disabled → skip and focused by its failure messages', () => {
    const a = (title: string, status: string, failureMessages: string[] = []) => ({
      title,
      status,
      ancestorTitles: ['s'],
      failureMessages,
    });
    const content = JSON.stringify({
      testResults: [
        {
          name: '/repo/x.test.js',
          status: 'passed',
          assertionResults: [
            a('dis', 'disabled'),
            a('foc', 'focused'),
            a('foc-bad', 'focused', ['boom']),
            a('todo', 'todo'),
          ],
        },
      ],
    });
    const { results, warnings } = jestParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'dis:skip',
      'foc:pass',
      'foc-bad:fail',
      'todo:skip',
    ]);
  });

  it('recognises {"testResults":[]} as jest with zero results and no warnings', () => {
    expect(jestParser.sniff(load('jest-no-tests.json'))).toBe(true);
    expect(jestParser.sniff('{"testResults":[]}')).toBe(true);
    expect(jestParser.parse(load('jest-no-tests.json'), 'x')).toEqual({
      results: [],
      warnings: [],
    });
  });

  it('surfaces a suite failure (afterAll threw) even though every test passed', () => {
    const { results, warnings } = jestParser.parse(load('jest-suite-failure.json'), 'jest.json');
    expect(warnings).toEqual([]);
    const after = results.filter((r) => r.suite.endsWith('after.test.js') || r.suite === 'db');
    expect(after.map((r) => `${r.suite} :: ${r.name}:${r.status}`)).toEqual([
      'db :: reads:pass',
      '/repo/j/after.test.js :: (suite):fail',
    ]);
    expect(after[1]!.message).toContain('teardown exploded');
    // a file whose failure is already carried by a failing test gets no extra row
    expect(results.filter((r) => r.name === '(suite)').map((r) => r.suite)).toEqual([
      '/repo/j/after.test.js',
      '/repo/j/empty.test.js',
    ]);
    // focused file: the non-.only test is pending → skip
    expect(results.find((r) => r.name === 'not focused')!.status).toBe('skip');
  });
});

// jest-qa.json: REAL jest 30 `--json` (QA fixture, paths → /repo) with
// `jest.retryTimes(2)`: `retried` fails once then passes (invocations 2),
// `slow` times out on all 3 invocations.
// vitest-qa.json: REAL vitest 3.2 json: `retried` ({retry: 2}) fails once then
// passes — status "passed" WITH a failureMessage.
describe('retry-then-pass (QA PAR-6)', () => {
  it('jest: a test that passed only on retry keeps the failure as a flaky note', () => {
    const { results, warnings } = jestParser.parse(load('jest-qa.json'), 'jest.json');
    const retried = results.find((r) => r.name === 'retried')!;
    expect(retried.status).toBe('pass');
    expect(retried.message).toMatch(/^flaky: failed 1 of 2 attempts before passing on jest retry/);
    expect(retried.message).toContain('Expected: 2');
    const slow = results.find((r) => r.name === 'slow')!;
    expect(slow.status).toBe('fail');
    expect(slow.message).toContain('(failed all 3 attempts)');
    const w = warnings.find((x) => x.includes('FLAKY'));
    expect(w).toContain('retried');
  });

  it('vitest: passed-with-failureMessages is a retry rescue, not a clean pass', () => {
    const { results, warnings } = jestParser.parse(load('vitest-qa.json'), 'vitest.json');
    const retried = results.find((r) => r.name === 'retried')!;
    expect(retried.status).toBe('pass');
    expect(retried.message).toMatch(
      /^flaky: failed 1 of 2 attempts before passing on vitest retry/,
    );
    expect(retried.message).toContain('expected 1 to be 2');
    expect(
      results.find((r) => r.name === 'passes' && r.suite === 'Outer > Inner'),
    ).not.toHaveProperty('message');
    expect(warnings.some((x) => x.includes('FLAKY') && x.includes('retried'))).toBe(true);
  });
});

// vitest-retry.json: REAL vitest 5.0 json: `flaky twice` ({retry: 3}) fails
// twice then passes; `always fails` ({retry: 2}) fails all 3 attempts.
describe('in-report attempts (QA PAR-6)', () => {
  it('jest: invocations become attempts, oldest first, last = status', () => {
    const { results } = jestParser.parse(load('jest-qa.json'), 'jest.json');
    expect(results.find((r) => r.name === 'retried')!.attempts).toEqual(['fail', 'pass']);
    expect(results.find((r) => r.name === 'slow')!.attempts).toEqual(['fail', 'fail', 'fail']);
    // a test that ran once has no attempts
    for (const r of results.filter((x) => x.name !== 'retried' && x.name !== 'slow')) {
      expect(r).not.toHaveProperty('attempts');
    }
  });

  it('vitest: a pass after failed retries lists one fail per failureMessage', () => {
    const { results } = jestParser.parse(load('vitest-retry.json'), 'vitest.json');
    const flaky = results.find((r) => r.name === 'flaky twice')!;
    expect(flaky).toMatchObject({ status: 'pass', attempts: ['fail', 'fail', 'pass'] });
    expect(flaky.message).toMatch(/^flaky: failed 2 of 3 attempts before passing on vitest retry/);
    expect(results.find((r) => r.name === 'passes')).not.toHaveProperty('attempts');
    const qa = jestParser.parse(load('vitest-qa.json'), 'vitest.json').results;
    expect(qa.find((r) => r.name === 'retried')!.attempts).toEqual(['fail', 'pass']);
  });

  it('vitest: a failed test is not given attempts (several messages may be expect.soft)', () => {
    const { results } = jestParser.parse(load('vitest-retry.json'), 'vitest.json');
    const failed = results.find((r) => r.name === 'always fails')!;
    expect(failed.status).toBe('fail');
    expect(failed).not.toHaveProperty('attempts');
  });

  it('jest: a failed test with invocations but no failureMessages still notes the attempts', () => {
    const doc = {
      testResults: [
        {
          name: '/r/a.test.js',
          assertionResults: [
            {
              title: 't',
              ancestorTitles: [],
              status: 'failed',
              invocations: 2,
              failureMessages: [],
            },
          ],
        },
      ],
    };
    const { results } = jestParser.parse(JSON.stringify(doc), 'inline');
    expect(results[0]).toMatchObject({
      status: 'fail',
      attempts: ['fail', 'fail'],
      message: '(failed all 2 attempts)',
    });
  });
});

describe('durations (QA PAR-18)', () => {
  it('rounds vitest fractional durations to whole milliseconds', () => {
    for (const fixture of ['vitest-qa.json', 'vitest-retry.json']) {
      const { results } = jestParser.parse(load(fixture), fixture);
      for (const r of results) {
        if (r.durationMs !== null) expect(Number.isInteger(r.durationMs)).toBe(true);
      }
    }
    const { results } = jestParser.parse(load('vitest-retry.json'), 'v.json');
    expect(results.find((r) => r.name === 'flaky twice')!.durationMs).toBe(5); // 5.0594…
    expect(results.find((r) => r.name === 'passes')!.durationMs).toBe(0); // 0.1788…
  });

  it('treats a negative or non-finite duration as unknown', () => {
    const doc = {
      testResults: [
        {
          name: 'f',
          assertionResults: [
            { title: 'a', status: 'passed', duration: -1 },
            { title: 'b', status: 'passed', duration: '12' },
          ],
        },
      ],
    };
    const { results } = jestParser.parse(JSON.stringify(doc), 'inline');
    expect(results.map((r) => r.durationMs)).toEqual([null, null]);
  });
});

describe('jest error status + vitest hook failures (QA PAR-7, PAR-8)', () => {
  it('maps assertion status "error" (jest-junit suite errors) instead of dropping it', () => {
    const { results, warnings } = jestParser.parse(load('jest-qa.json'), 'jest.json');
    expect(warnings.some((w) => w.includes('unknown assertion status'))).toBe(false);
    const syntax = results.filter((r) => r.suite === '/repo/js/jt/b/syntax.test.js');
    // one row, on the same '(suite)' identity a plain jest --json run produces
    expect(syntax.map((r) => `${r.name}:${r.status}`)).toEqual(['(suite):error']);
    expect(syntax[0]!.message).toContain('Test suite failed to run');
  });

  it('vitest: a failing beforeAll (tests skipped, file failed) is a (suite) failure', () => {
    const { results } = jestParser.parse(load('vitest-qa.json'), 'vitest.json');
    const b = results.filter((r) => r.suite === '/repo/vt/t/b.test.ts' || r.name === 'passes');
    expect(results.find((r) => r.suite === 'Outer' && r.name === 'passes')!.status).toBe('skip');
    const suite = b.find((r) => r.name === '(suite)')!;
    expect(suite.status).toBe('fail');
    // vitest leaves the file message empty — say what happened instead of nothing
    expect(suite.message).toContain('failed outside any test');
  });
});
