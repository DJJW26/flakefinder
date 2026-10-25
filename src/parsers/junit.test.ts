import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { junitParser } from './junit.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('junitParser', () => {
  it('parses the pytest-style fixture with nested testsuites exactly', () => {
    const { results, warnings } = junitParser.parse(load('junit-pytest.xml'), 'junit-pytest.xml');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(6);

    // [0] plain pass with duration
    expect(results[0]).toMatchObject({
      testId: makeTestId('tests.test_math', 'test_add'),
      suite: 'tests.test_math',
      name: 'test_add',
      status: 'pass',
      durationMs: 1,
    });
    expect(results[0]).not.toHaveProperty('message');
    expect(results[0]).not.toHaveProperty('stack');

    // [1] unicode name pass
    expect(results[1]).toMatchObject({
      testId: makeTestId('tests.test_math', 'test_unicode_ünïcode_名前'),
      suite: 'tests.test_math',
      name: 'test_unicode_ünïcode_名前',
      status: 'pass',
      durationMs: 2,
    });

    // [2] failure with message attr + traceback text
    expect(results[2]).toMatchObject({
      suite: 'tests.test_math',
      name: 'test_subtract',
      status: 'fail',
      durationMs: 3, // 0.0034s rounds to 3ms
    });
    expect(results[2]?.message).toBe('AssertionError: assert -1 == 0');
    expect(results[2]?.stack).toBe(
      'Traceback (most recent call last):\n  File "/repo/tests/test_math.py", line 21, in test_subtract\n    assert sub(2, 3) == 0\nAssertionError: assert -1 == 0',
    );

    // [3] failure with text only (no message attr) → message falls back to text
    const textOnly =
      'Traceback (most recent call last):\n  File "/repo/tests/test_math.py", line 30, in test_multiply\n    assert mul(2, 3) == 7\nAssertionError: assert 6 == 7';
    expect(results[3]).toMatchObject({
      suite: 'tests.test_math',
      name: 'test_multiply',
      status: 'fail',
      durationMs: 1,
    });
    expect(results[3]?.message).toBe(textOnly);
    expect(results[3]?.stack).toBe(textOnly);

    // [4] error inside nested testsuite
    expect(results[4]).toMatchObject({
      suite: 'tests.test_math.TestInner',
      name: 'test_boom',
      status: 'error',
      durationMs: 500,
    });
    expect(results[4]?.message).toBe('RuntimeError: boom');
    expect(results[4]?.stack).toContain("raise RuntimeError('boom')");

    // [5] skipped testcase without classname/time → suite = nearest testsuite name
    expect(results[5]).toMatchObject({
      testId: makeTestId('tests.test_math.TestInner', 'test_placeholder'),
      suite: 'tests.test_math.TestInner',
      name: 'test_placeholder',
      status: 'skip',
      durationMs: null,
    });
    expect(results[5]).not.toHaveProperty('message');
    expect(results[5]).not.toHaveProperty('stack');
  });

  it('parses the jest-junit flavor fixture (classname attrs, CDATA failure)', () => {
    const { results, warnings } = junitParser.parse(
      load('junit-jest-junit.xml'),
      'junit-jest-junit.xml',
    );
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(4);
    expect(results.map((r) => r.status)).toEqual(['pass', 'fail', 'pass', 'skip']);
    expect(results.map((r) => r.durationMs)).toEqual([123, 456, 124, 50]); // 0.1235 → 124
    expect(results[0]).toMatchObject({
      suite: 'src/app renders the login form',
      name: 'renders the login form',
    });
    expect(results[1]?.message).toBe(
      'expect(received).toBe(expected) // Object.is equality\n\nExpected: 200\nReceived: 401\n    at Object.<anonymous> (/repo/src/app.test.js:31:27)\n    at Promise (native)',
    );
    expect(results[1]?.stack).toBe(results[1]?.message);
    expect(results[3]).toMatchObject({
      suite: 'src/app remembers the session',
      name: 'remembers the session',
      status: 'skip',
    });
    // testId consistency across the board
    for (const r of results) {
      expect(r.testId).toBe(makeTestId(r.suite, r.name));
    }
  });

  it('returns zero results and zero warnings for <testsuites/> with no cases', () => {
    const { results, warnings } = junitParser.parse(load('junit-empty.xml'), 'junit-empty.xml');
    expect(results).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('yields warnings (and never throws) for truncated XML', () => {
    let parsed: { results: unknown[]; warnings: string[] } = { results: [], warnings: [] };
    expect(() => {
      parsed = junitParser.parse(load('malformed-xml.xml'), 'malformed-xml.xml');
    }).not.toThrow();
    expect(parsed.warnings.length).toBeGreaterThanOrEqual(1);
    expect(parsed.warnings.some((w) => w.includes('truncated'))).toBe(true);
    expect(Array.isArray(parsed.results)).toBe(true);
  });

  it('parses a bare <testsuite> root', () => {
    const content =
      '<?xml version="1.0"?><testsuite name="pkg.Module" tests="1">' +
      '<testcase name="test_bare" time="0.025"/></testsuite>';
    const { results, warnings } = junitParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results).toEqual([
      {
        testId: makeTestId('pkg.Module', 'test_bare'),
        suite: 'pkg.Module',
        name: 'test_bare',
        status: 'pass',
        durationMs: 25,
      },
    ]);
  });

  it('truncates message to 2000 and stack to 1000 characters', () => {
    const content =
      `<testsuites><testsuite name="s"><testcase classname="c" name="n" time="0.1">` +
      `<failure message="${'M'.repeat(3000)}">${'S'.repeat(1200)}</failure>` +
      `</testcase></testsuite></testsuites>`;
    const { results } = junitParser.parse(content, 'inline');
    expect(results[0]?.message).toHaveLength(2000);
    expect(results[0]?.message).toBe('M'.repeat(2000));
    expect(results[0]?.stack).toHaveLength(1000);
  });

  it('treats a non-finite @_time as null duration without warnings', () => {
    const content =
      '<testsuites><testsuite name="s"><testcase classname="c" name="n" time="abc"/></testsuite></testsuites>';
    const { results, warnings } = junitParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results[0]?.durationMs).toBeNull();
  });

  it('warns and skips testcases without a name', () => {
    const content =
      '<testsuites><testsuite name="s"><testcase classname="c"/></testsuite></testsuites>';
    const { results, warnings } = junitParser.parse(content, 'inline');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('without a name');
  });

  it('sniffs XML containing testsuit(e|es) and rejects other content', () => {
    expect(junitParser.sniff(load('junit-pytest.xml'))).toBe(true);
    expect(junitParser.sniff(load('junit-empty.xml'))).toBe(true);
    expect(junitParser.sniff('  <?xml version="1.0"?><testsuite name="s"/>')).toBe(true);
    expect(junitParser.sniff('hello world')).toBe(false);
    expect(junitParser.sniff('{"testResults": []}')).toBe(false);
    expect(junitParser.sniff('<html><body>no suites here</body></html>')).toBe(false);
  });
});
