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

    // TestLong: oversized output → last 500 chars kept
    const longText = ['=== RUN   TestLong', 'L'.repeat(600), '--- FAIL: TestLong (0.10s)'].join(
      '\n',
    );
    expect(results[4]).toMatchObject({ status: 'fail', durationMs: 100 });
    expect(results[4]?.message).toBe(longText.slice(-500));
    expect(results[4]?.message).toHaveLength(500);
    expect(results[4]?.message?.endsWith('(0.10s)')).toBe(true);
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

  it('omits tests that never reach a terminal action', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"Started"}',
      '{"Action":"output","Package":"p","Test":"Started","Output":"mid-run crash"}',
      '{"Action":"fail","Package":"p","Elapsed":9.9}',
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'inline');
    expect(results).toEqual([]);
    expect(warnings).toEqual([]);
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
