import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { playwrightParser } from './playwright.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

// playwright.json: hand-made in the Playwright 1.48 JSON reporter shape (no
// Playwright install was available) — projects chromium + firefox, retries 2:
// - Cart › adds item: chromium fails then passes on retry, firefox passes
// - Cart › checks out: chromium passes, firefox fails all 3 attempts (last timedOut)
// - Cart › discounts › known bug: test.fail() that failed as expected
// - has title: passes in both; webkit only: skipped in both
const parse = () => playwrightParser.parse(load('playwright.json'), 'playwright.json');

describe('playwrightParser (QA PAR-21)', () => {
  it('sniffs the JSON reporter shape only', () => {
    expect(playwrightParser.sniff(load('playwright.json'))).toBe(true);
    expect(playwrightParser.sniff('{"suites": []}')).toBe(false);
    expect(playwrightParser.sniff('{"testResults": []}')).toBe(false);
    expect(playwrightParser.sniff('{"suites": [], "config": {')).toBe(false);
  });

  it('uses the Playwright JUnit identity: suite = file, name = describes › title', () => {
    const { results } = parse();
    expect(results.map((r) => `${r.suite} :: ${r.name}`)).toEqual([
      'cart.spec.ts :: Cart › adds item',
      'cart.spec.ts :: Cart › checks out',
      'cart.spec.ts :: Cart › discounts › known bug',
      'home.spec.ts :: has title',
      'home.spec.ts :: webkit only',
    ]);
    expect(results[0]!.testId).toBe(makeTestId('cart.spec.ts', 'Cart › adds item'));
  });

  it('a retry-rescued pass keeps the failure: flaky message, attempts, warning', () => {
    const { results, warnings } = parse();
    const adds = results[0]!;
    expect(adds).toMatchObject({ status: 'pass', attempts: ['fail', 'pass'], durationMs: 641 });
    expect(adds.message).toMatch(
      /^\[chromium\] flaky: failed 1 of 2 attempts before passing on Playwright retry/,
    );
    expect(adds.message).toContain('Expected: 2');
    expect(adds.message).not.toContain('\u001b['); // ANSI stripped
    const w = warnings.find((x) => x.includes('FLAKY'));
    expect(w).toContain('cart.spec.ts > Cart › adds item');
  });

  it('folds projects into one row: a failure in one project is not masked', () => {
    const checks = parse().results[1]!;
    expect(checks).toMatchObject({
      status: 'fail',
      attempts: ['fail', 'fail', 'fail'],
      durationMs: 30001,
    });
    expect(checks.message).toBe(
      '[firefox] Test timeout of 30000ms exceeded.\n(failed all 3 attempts)',
    );
    expect(checks.stack).toContain('Test timeout');
  });

  it('expected failures (test.fail) pass; skips carry their reason; single runs have no attempts', () => {
    const { results } = parse();
    expect(results[2]).toMatchObject({ status: 'pass' });
    expect(results[2]).not.toHaveProperty('message');
    expect(results[3]).toMatchObject({ status: 'pass', durationMs: 300 });
    expect(results[4]).toMatchObject({ status: 'skip', message: 'needs webkit' });
    for (const r of results.slice(2)) expect(r).not.toHaveProperty('attempts');
  });

  it('ignores interrupted attempts; a test with no result is a skip', () => {
    const doc = {
      config: {},
      suites: [
        {
          title: 'a.spec.ts',
          specs: [
            {
              title: 'stopped',
              tests: [
                {
                  projectName: '',
                  expectedStatus: 'passed',
                  results: [
                    { status: 'failed', duration: 5, error: { message: 'x' } },
                    { status: 'interrupted', duration: 1 },
                  ],
                },
              ],
            },
            { title: 'never ran', tests: [{ projectName: '', results: [] }] },
          ],
        },
      ],
      errors: [],
    };
    const { results } = playwrightParser.parse(JSON.stringify(doc), 'inline');
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual(['stopped:fail', 'never ran:skip']);
    expect(results[0]).toMatchObject({ message: 'x' });
    expect(results[0]).not.toHaveProperty('attempts');
  });

  it('repeat-each repetitions are attempts; any failure makes the row fail (listed last)', () => {
    const t = (status: string) => ({
      projectName: 'chromium',
      expectedStatus: 'passed',
      results: [
        { status, duration: 1, error: status === 'failed' ? { message: 'flap' } : undefined },
      ],
    });
    const doc = {
      config: {},
      suites: [
        {
          title: 'r.spec.ts',
          specs: [{ title: 't', tests: [t('passed'), t('failed'), t('passed')] }],
        },
      ],
    };
    const { results } = playwrightParser.parse(JSON.stringify(doc), 'inline');
    expect(results[0]).toMatchObject({
      status: 'fail',
      attempts: ['pass', 'pass', 'fail'],
      message: 'flap',
    });
  });

  it('global errors become one (global) error row and a warning', () => {
    const doc = {
      config: {},
      suites: [],
      errors: [
        { message: '\u001b[31mError: Cannot find module "./x"\u001b[39m', stack: 'Error: …' },
        { message: 'second' },
      ],
    };
    const { results, warnings } = playwrightParser.parse(JSON.stringify(doc), 'inline');
    expect(results).toEqual([
      {
        testId: makeTestId('playwright', '(global)'),
        suite: 'playwright',
        name: '(global)',
        status: 'error',
        durationMs: null,
        message: 'Error: Cannot find module "./x"\n(+1 more)',
        stack: 'Error: …',
      },
    ]);
    expect(warnings[0]).toContain('2 error(s) outside any test');
  });

  it('never throws on malformed input', () => {
    expect(playwrightParser.parse('{"suites": [', 'x').warnings[0]).toContain('invalid JSON');
    expect(playwrightParser.parse('{"suites": 1}', 'x').warnings[0]).toContain('suites');
    const odd =
      '{"config":{},"suites":[1,{"specs":[null,{"title":"t","tests":[null,{"results":[7]}]}]}]}';
    expect(() => playwrightParser.parse(odd, 'x')).not.toThrow();
  });
});
