import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { trxParser } from './trx.js';

const load = (name: string): string =>
  readFileSync(path.join('tests', 'parsers-fixtures', name), 'utf8');

describe('trxParser', () => {
  it('sniffs TRX roots and rejects junit XML', () => {
    expect(trxParser.sniff(load('trx-dotnet.trx'))).toBe(true);
    expect(trxParser.sniff('<TestRun></TestRun>')).toBe(true);
    expect(trxParser.sniff('<testsuites/>')).toBe(false);
    expect(trxParser.sniff('TAP version 13')).toBe(false);
  });

  it('parses the fixture: outcomes, className suites, durations, ErrorInfo', () => {
    const { results, warnings } = trxParser.parse(load('trx-dotnet.trx'), 'trx.trx');
    // 3 real UnitTestResults — the nameless one is skipped with a warning
    expect(results).toHaveLength(3);
    expect(warnings.some((w) => w.includes('without testName'))).toBe(true);

    const byName = new Map(results.map((r) => [r.name, r]));

    const pass = byName.get('CalculatorTests.DividesEvenly')!;
    expect(pass).toMatchObject({
      status: 'pass',
      suite: 'App.CalculatorTests',
      durationMs: 123,
      testId: makeTestId('App.CalculatorTests', 'CalculatorTests.DividesEvenly'),
    });

    const failed = byName.get('CalculatorTests.ExplodesOnZero')!;
    expect(failed).toMatchObject({
      status: 'error', // ErrorInfo present → error family
      suite: 'App.CalculatorTests',
      durationMs: 456,
    });
    expect(failed.message).toContain('DivideByZeroException');
    expect(failed.stack).toContain('App.Calculator.Divide');

    const skipped = byName.get('CalculatorTests.NotExecutedYet')!;
    expect(skipped).toMatchObject({
      status: 'skip',
      suite: 'App.CalculatorTests',
      durationMs: null,
    });
  });

  it('Failed without ErrorInfo maps to fail (not error)', () => {
    const content =
      '<TestRun><Results><UnitTestResult testName="t" outcome="Failed" /></Results></TestRun>';
    const { results } = trxParser.parse(content, 'inline');
    expect(results[0]!.status).toBe('fail');
  });

  it('unknown outcomes are skipped with warnings, never throw', () => {
    const content =
      '<TestRun><Results><UnitTestResult testName="a" outcome="Aborted" /></Results></TestRun>';
    const { results, warnings } = trxParser.parse(content, 'inline');
    expect(results).toEqual([]);
    expect(warnings.some((w) => w.includes('unknown outcome'))).toBe(true);
  });

  it('malformed XML → no throw, zero results (fast-xml-parser is lenient)', () => {
    const { results } = trxParser.parse('<TestRun><Results>', 'inline');
    expect(results).toEqual([]);
  });
});
