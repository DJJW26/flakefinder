import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { goTestParser } from './gotest.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('goTestParser', () => {
  it('parses the go test -json fixture exactly', () => {
    const { results, warnings } = goTestParser.parse(load('go-test.jsonl'), 'go-test.jsonl');
    // one malformed final line
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 29');
    expect(warnings[0]).toContain('invalid JSON');

    // package-level events ignored; results in first-seen order
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.name)).toEqual([
      'TestAdd',
      'TestDivide',
      'TestSkip',
      'TestUpper',
      'TestLong',
    ]);

    // TestAdd: pass, ANSI stripped from output, blank line dropped
    expect(results[0]).toMatchObject({
      testId: makeTestId('example.com/flakefinder/math', 'TestAdd'),
      suite: 'example.com/flakefinder/math',
      name: 'TestAdd',
      status: 'pass',
      durationMs: 1,
    });
    expect(results[0]?.message).toBe(
      '=== RUN   TestAdd\n    math_test.go:11: computing 2 + 3\n--- PASS: TestAdd (0.00s)',
    );

    // TestDivide: fail with detail from red-colored output
    expect(results[1]).toMatchObject({ status: 'fail', durationMs: 10 });
    expect(results[1]?.message).toBe(
      '=== RUN   TestDivide\n    math_test.go:25: division mismatch: got 3, want 3.5\n--- FAIL: TestDivide (0.01s)',
    );

    // TestSkip: skip, elapsed 0 → 0ms
    expect(results[2]).toMatchObject({ status: 'skip', durationMs: 0 });
    expect(results[2]?.message).toBe(
      '    math_test.go:30: skipping: not implemented on windows\n--- SKIP: TestSkip (0.00s)',
    );

    // TestUpper: pass with no output events → no message
    expect(results[3]).toMatchObject({
      testId: makeTestId('example.com/flakefinder/strings', 'TestUpper'),
      suite: 'example.com/flakefinder/strings',
      status: 'pass',
      durationMs: 2,
    });
    expect(results[3]).not.toHaveProperty('message');

    // TestLong: fixture output is small enough to survive uncapped (600 L's)
    const longText = ['=== RUN   TestLong', 'L'.repeat(600), '--- FAIL: TestLong (0.10s)'].join(
      '\n',
    );
    expect(results[4]).toMatchObject({ status: 'fail', durationMs: 100 });
    expect(results[4]?.message).toBe(longText);
    expect(results[4]?.message?.endsWith('(0.10s)')).toBe(true);
  });

  it('keeps the LAST 2000 chars of oversized test output', () => {
    const lines = [
      JSON.stringify({ Action: 'run', Package: 'big', Test: 'TestBig' }),
      JSON.stringify({
        Action: 'output',
        Package: 'big',
        Test: 'TestBig',
        Output: 'x'.repeat(3000),
      }),
      JSON.stringify({ Action: 'fail', Package: 'big', Test: 'TestBig', Elapsed: 0.4 }),
    ];
    const { results } = goTestParser.parse(lines.join('\n'), 'inline');
    expect(results[0]?.message).toHaveLength(2000);
    expect(results[0]?.message).toBe('x'.repeat(2000)); // tail kept (failure detail lives at the end)
  });

  it('parses old-format output (no elapsed on test events → null durations)', () => {
    const { results, warnings } = goTestParser.parse(
      load('go-test-old.jsonl'),
      'go-test-old.jsonl',
    );
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      suite: 'example.com/legacy/pkg',
      name: 'TestOldPass',
      status: 'pass',
      durationMs: null, // package-level elapsed must not leak into tests
    });
    expect(results[1]).toMatchObject({ name: 'TestOldFail', status: 'fail', durationMs: null });
    expect(results[2]).toMatchObject({ name: 'TestOldSkip', status: 'skip', durationMs: null });
  });

  it('accepts lowercase elapsed/output field spellings', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","output":"something logged\\n"}',
      '{"Action":"pass","Package":"p","Test":"T","elapsed":0.007}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ status: 'pass', durationMs: 7 });
    expect(results[0]?.message).toBe('something logged');
  });

  it('lets the last terminal action win for a repeated test', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0.01}',
      '{"Action":"pass","Package":"p","Test":"T","Elapsed":0.02}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'pass', durationMs: 20 });
  });

  it('reports at most 5 malformed lines then a summary', () => {
    const lines = Array.from({ length: 7 }, (_, i) => `garbage line ${i} {{`);
    lines.push('{"Action":"pass","Package":"p","Test":"Ok","Elapsed":0.001}');
    const { results, warnings } = goTestParser.parse(lines.join('\n'), 'inline');
    expect(results).toHaveLength(1);
    expect(warnings).toHaveLength(6);
    expect(warnings.slice(0, 5).every((w) => w.includes('invalid JSON'))).toBe(true);
    expect(warnings[5]).toBe('…and 2 more malformed lines');
  });

  it('sniffs NDJSON go test output and rejects other content', () => {
    expect(goTestParser.sniff(load('go-test.jsonl'))).toBe(true);
    expect(goTestParser.sniff(load('go-test-old.jsonl'))).toBe(true);
    expect(goTestParser.sniff('{"Action":"pass","Package":"p"}')).toBe(true);
    expect(goTestParser.sniff('\n\n  {"Action":"fail","Package":"p","Test":"T"}\n')).toBe(true);
    expect(goTestParser.sniff('hello world')).toBe(false);
    expect(goTestParser.sniff('{"Action":"pass"}')).toBe(false); // no Package
    expect(goTestParser.sniff(load('jest.json'))).toBe(false);
    expect(goTestParser.sniff('')).toBe(false);
  });
});

describe('dangling runs (v0.2.0 — crash coverage)', () => {
  it('synthesizes error results for tests that started but never finished', () => {
    const content = [
      JSON.stringify({ Action: 'run', Package: 'pkg/a', Test: 'TestCrash' }),
      JSON.stringify({
        Action: 'output',
        Package: 'pkg/a',
        Test: 'TestCrash',
        Output: '=== RUN TestCrash\n',
      }),
      JSON.stringify({ Action: 'run', Package: 'pkg/a', Test: 'TestSurvives' }),
      JSON.stringify({ Action: 'pass', Package: 'pkg/a', Test: 'TestSurvives', Elapsed: 0.01 }),
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'crash.jsonl');
    const crashed = results.find((r) => r.name === 'TestCrash')!;
    expect(crashed).toBeDefined();
    expect(crashed.status).toBe('error');
    expect(crashed.message).toContain('never reported a result');
    expect(results.find((r) => r.name === 'TestSurvives')!.status).toBe('pass');
    expect(warnings.some((w) => w.includes('1 test(s) started but never reported'))).toBe(true);
  });

  it('emits no warning when every test reaches a terminal action', () => {
    const content = [
      JSON.stringify({ Action: 'run', Package: 'p', Test: 'T' }),
      JSON.stringify({ Action: 'pass', Package: 'p', Test: 'T', Elapsed: 0.5 }),
    ].join('\n');
    const { warnings } = goTestParser.parse(content, 'ok.jsonl');
    expect(warnings).toEqual([]);
  });
});

describe('go parser robustness (review round)', () => {
  it('does not invent phantom crashes from output-only events', () => {
    const content = [
      '{"Action":"output","Package":"p","Test":"TestGhost","Output":"orphan line"}',
      '{"Action":"pause","Package":"p","Test":"TestGhost"}',
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'ghost.jsonl');
    expect(results).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('synthesizes a (package) error when a package fails before running any test', () => {
    const content = [
      '{"Action":"start","Package":"p2"}',
      '{"Action":"output","Package":"p2","Output":"# p2"}',
      '{"Action":"output","Package":"p2","Output":"main.go:5:2: syntax error"}',
      '{"Action":"fail","Package":"p2"}',
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'build.jsonl');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('(package)');
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.message).toContain('build or init crash');
    expect(results[0]!.message).toContain('syntax error');
    expect(warnings.some((w) => w.includes('no test results'))).toBe(true);
  });

  it('does not double-report when a package fails WITH tests (dangling logic covers it)', () => {
    const content = [
      '{"Action":"run","Package":"p3","Test":"TestA"}',
      '{"Action":"fail","Package":"p3"}', // package-level
    ].join('\n');
    const { results } = goTestParser.parse(content, 'mixed.jsonl');
    expect(results).toHaveLength(1); // dangling TestA only, no (package) row
    expect(results[0]!.name).toBe('TestA');
  });
});
