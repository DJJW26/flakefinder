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

describe('namespace tolerance (QA round 2)', () => {
  it('parses namespace-prefixed junit XML (x:testsuites / x:testsuite / x:testcase)', () => {
    const content =
      '<?xml version="1.0"?>' +
      '<x:testsuites xmlns:x="urn:x">' +
      '<x:testsuite name="NSP"><x:testcase name="nsp1" time="0.01"/></x:testsuite>' +
      '</x:testsuites>';
    expect(junitParser.sniff(content)).toBe(true);
    const { results, warnings } = junitParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      suite: 'NSP',
      name: 'nsp1',
      status: 'pass',
      durationMs: 10,
    });
  });
});

describe('duplicate roots (QA B-F6)', () => {
  it('two <testsuites> blocks: first wins with a warning, not silent zero results', () => {
    const content =
      '<testsuites><testsuite name="a"><testcase name="first"/></testsuite></testsuites>' +
      '<testsuites><testsuite name="b"><testcase name="second"/></testsuite></testsuites>';
    const { results, warnings } = junitParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('first');
    expect(warnings.some((w) => w.includes('multiple <testsuites> roots'))).toBe(true);
  });
});

describe('Surefire reruns (r5 #1)', () => {
  it('keeps the flaky signal of flakyFailure/flakyError instead of a plain pass', () => {
    const { results, warnings } = junitParser.parse(
      load('junit-surefire-reruns.xml'),
      'junit-surefire-reruns.xml',
    );
    expect(results).toHaveLength(4);
    const byName = new Map(results.map((r) => [r.name, r]));

    // never-failed test stays a plain pass with no message
    expect(byName.get('addsItem')).toMatchObject({ status: 'pass' });
    expect(byName.get('addsItem')).not.toHaveProperty('message');

    // final outcome is pass (the build was green), but the earlier failure survives
    const discount = byName.get('appliesDiscount')!;
    expect(discount.status).toBe('pass');
    expect(discount.message).toContain('flaky');
    expect(discount.message).toContain('failed 1 of 2 attempts');
    expect(discount.message).toContain('expected: <90> but was: <100>');
    expect(discount.stack).toContain('CartTest.java:42');

    const sync = byName.get('syncsInventory')!;
    expect(sync.status).toBe('pass');
    expect(sync.message).toContain('failed 2 of 3 attempts');
    expect(sync.message).toContain('Connection refused');

    // failed on every rerun: still a failure, with the attempt count noted
    const checkout = byName.get('checksOut')!;
    expect(checkout.status).toBe('fail');
    expect(checkout.message).toContain('total mismatch');
    expect(checkout.message).toContain('failed all 3 attempts');

    // the flake is called out loudly — warnings are what the CLI prints
    const flakyWarning = warnings.find((w) => w.includes('Surefire rerun'));
    expect(flakyWarning).toBeDefined();
    expect(flakyWarning).toContain('com.example.CartTest.appliesDiscount');
    expect(flakyWarning).toContain('com.example.CartTest.syncsInventory');
    expect(warnings).toHaveLength(1);

    // per-attempt statuses for the engine (QA PAR-6), oldest first, last = status
    expect(byName.get('addsItem')).not.toHaveProperty('attempts');
    expect(discount.attempts).toEqual(['fail', 'pass']);
    expect(sync.attempts).toEqual(['error', 'error', 'pass']);
    expect(checkout.attempts).toEqual(['fail', 'fail', 'fail']);
  });
});

describe('XML text fidelity (r5 #8)', () => {
  it('keeps numeric-looking failure text as a string (no number coercion)', () => {
    const content =
      '<testsuite name="s">' +
      '<testcase classname="c" name="n1"><failure>42</failure></testcase>' +
      '<testcase classname="c" name="n2"><error type="E">007</error></testcase>' +
      '</testsuite>';
    const { results } = junitParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ status: 'fail', message: '42', stack: '42' });
    expect(results[1]).toMatchObject({ status: 'error', message: '007', stack: '007' });
  });

  it('decodes numeric character references in names and messages', () => {
    const content =
      '<testsuite name="s"><testcase classname="caf&#233;" name="&#x41;dds &#65;">' +
      '<failure message="expected &#x2264; 3">x</failure></testcase></testsuite>';
    const { results } = junitParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ suite: 'café', name: 'Adds A', message: 'expected ≤ 3' });
    expect(results[0]!.testId).toBe(makeTestId('café', 'Adds A'));
  });

  it('reads comma-decimal and grouped times correctly', () => {
    const tc = (name: string, time: string) =>
      `<testcase classname="c" name="${name}" time="${time}"/>`;
    const content = `<testsuite name="s">${tc('a', '1,5')}${tc('b', '0,025')}${tc('c', '1,033.42')}${tc('d', '2.5')}</testsuite>`;
    const { results } = junitParser.parse(content, 'inline');
    expect(results.map((r) => r.durationMs)).toEqual([1500, 25, 1033420, 2500]);
  });
});

// QA fixtures (real tool output, paths → /repo):
// junit-pytest-reruns.xml — pytest 9 + pytest-rerunfailures `--reruns 2`:
//   test_flips fails once then passes; test_always fails all 3 attempts. Each
//   rerun attempt is written as an EMPTY duplicate <testcase>.
// junit-node-test.xml — node 20 `--test-reporter=junit` (a failing TODO test
//   carries both <skipped> and <failure>).
// junit-gotestsum.xml — gotestsum 1.12 (message="Failed" on every failure).
// junit-attrs.xml — QA's hand-made edge cases (multiple <failure>, bare <error type>).
describe('JUnit QA findings (PAR-13, PAR-14, PAR-17)', () => {
  it('PAR-13: pytest-rerunfailures duplicates collapse into one flaky/failing result', () => {
    const { results, warnings } = junitParser.parse(load('junit-pytest-reruns.xml'), 'r.xml');
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'test_flips:pass',
      'test_always:fail',
    ]);
    expect(results[0]!.message).toBe(
      'flaky: failed 1 of 2 attempts before passing on pytest-rerunfailures rerun',
    );
    expect(results[1]!.message).toContain('AssertionError: always');
    expect(results[1]!.message).toContain('(failed all 3 attempts)');
    expect(results[0]!.attempts).toEqual(['fail', 'pass']);
    expect(results[1]!.attempts).toEqual(['fail', 'fail', 'fail']);
    expect(warnings.some((w) => w.includes('FLAKY') && w.includes('rr.test_rr.test_flips'))).toBe(
      true,
    );
  });

  it('PAR-13: duplicates outside pytest reports are left alone', () => {
    const content =
      '<testsuites><testsuite name="a"><testcase classname="c" name="t"/></testsuite>' +
      '<testsuite name="b"><testcase classname="c" name="t"/></testsuite></testsuites>';
    const { results, warnings } = junitParser.parse(content, 'inline');
    expect(results).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it('PAR-14: <skipped> + <failure> (node TODO that failed) is a skip, like TAP', () => {
    const { results } = junitParser.parse(load('junit-node-test.xml'), 'node.xml');
    expect(results.find((r) => r.name === 'todo failing')!.status).toBe('skip');
    const attrs = junitParser.parse(load('junit-attrs.xml'), 'attrs.xml').results;
    expect(attrs.find((r) => r.name === 'skipped-and-failure')!.status).toBe('skip');
  });

  it('PAR-17: multiple <failure>s keep the first message; bare <error type> uses the type', () => {
    const { results } = junitParser.parse(load('junit-attrs.xml'), 'attrs.xml');
    const both = results.find((r) => r.name === 'both')!;
    expect(both).toMatchObject({ status: 'fail', message: 'm1\n(+1 more failure)', stack: 't1' });
    expect(results.find((r) => r.name === 'err-attr-only')).toMatchObject({
      status: 'error',
      message: 'java.lang.NPE',
    });
  });

  it('PAR-17: gotestsum\'s generic message="Failed" yields to the real output', () => {
    const { results } = junitParser.parse(load('junit-gotestsum.xml'), 'g.xml');
    const fails = results.filter((r) => r.status === 'fail');
    expect(fails.length).toBeGreaterThan(0);
    expect(fails.every((r) => r.message !== 'Failed')).toBe(true);
    expect(fails.some((r) => r.message?.includes('unicode fail'))).toBe(true);
  });
});
