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
      status: 'fail', // real TRX puts ErrorInfo on every Failed result — not an 'error' signal (r5 #7)
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
      '<TestRun><Results><UnitTestResult testName="a" outcome="Bogus" /></Results></TestRun>';
    const { results, warnings } = trxParser.parse(content, 'inline');
    expect(results).toEqual([]);
    expect(warnings.some((w) => w.includes('unknown outcome'))).toBe(true);
  });

  it('malformed XML → no throw, zero results (fast-xml-parser is lenient)', () => {
    const { results } = trxParser.parse('<TestRun><Results>', 'inline');
    expect(results).toEqual([]);
  });
});

describe('duplicate roots (QA B-F6)', () => {
  it('two <TestRun> blocks: first wins with a warning, not silent zero results', () => {
    const content =
      '<TestRun><Results><UnitTestResult testName="first" outcome="Passed" /></Results></TestRun>' +
      '<TestRun><Results><UnitTestResult testName="second" outcome="Passed" /></Results></TestRun>';
    const { results, warnings } = trxParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('first');
    expect(warnings.some((w) => w.includes('multiple <TestRun> roots'))).toBe(true);
  });
});

describe('TRX durations (QA B-F5)', () => {
  it('parses day-inclusive durations (d.hh:mm:ss.f)', () => {
    const content =
      '<TestRun><Results><UnitTestResult testName="Slow" outcome="Passed" duration="2.04:00:05.5" /></Results></TestRun>';
    const { results } = trxParser.parse(content, 'inline');
    // 2 days + 4h + 0m + 5.5s = 187205500 ms
    expect(results[0]!.durationMs).toBe(187205500);
  });
  it('zero and plain durations still parse (regression)', () => {
    const content =
      '<TestRun><Results><UnitTestResult testName="z" outcome="Passed" duration="00:00:00" /><UnitTestResult testName="o" outcome="Passed" duration="00:00:01.5" /></Results></TestRun>';
    const { results } = trxParser.parse(content, 'inline');
    expect(results[0]!.durationMs).toBe(0);
    expect(results[1]!.durationMs).toBe(1500);
  });
});

// trx-mstest3.trx / trx-mstest2-datarows.trx: REAL `dotnet test --logger trx`
// output (dotnet 8, MSTest 3.0.4 and MSTest 2.1.2; paths rewritten to /src).
// Classes CartTests and InvoiceTests BOTH have a `Checkout` method (one passes,
// one fails); CartTests.SlowLookup exceeds [Timeout(50)]; Ignored is
// [Ignore]d; MaybeLater calls Assert.Inconclusive; Adds is a [DataTestMethod]
// with rows (1,1) pass and (2,3) fail. MSTest 2 nests the rows as InnerResults.
describe('TRX real dotnet output (r5 #7)', () => {
  it('joins results to classes by testId, so same-named methods stay distinct', () => {
    const { results, warnings } = trxParser.parse(load('trx-mstest3.trx'), 'trx-mstest3.trx');
    expect(warnings).toEqual([]);
    const checkouts = results.filter((r) => r.name === 'Checkout');
    expect(checkouts.map((r) => `${r.suite}:${r.status}`).sort()).toEqual([
      'FlakeDemo.CartTests:pass',
      'FlakeDemo.InvoiceTests:fail',
    ]);
    expect(new Set(checkouts.map((r) => r.testId)).size).toBe(2);
    const invoice = checkouts.find((r) => r.suite === 'FlakeDemo.InvoiceTests')!;
    expect(invoice.testId).toBe(makeTestId('FlakeDemo.InvoiceTests', 'Checkout'));
    expect(invoice.message).toContain('invoice total wrong');
  });

  it('maps real outcomes: Failed → fail (ErrorInfo is always present), NotExecuted → skip', () => {
    const { results } = trxParser.parse(load('trx-mstest3.trx'), 'trx-mstest3.trx');
    const by = new Map(results.map((r) => [r.name, r]));
    expect(results).toHaveLength(7);
    expect(by.get('SlowLookup')).toMatchObject({ status: 'fail', suite: 'FlakeDemo.CartTests' });
    expect(by.get('SlowLookup')!.message).toContain('exceeded execution timeout');
    expect(by.get('Ignored')).toMatchObject({ status: 'skip', message: 'not ready' });
    expect(by.get('MaybeLater')).toMatchObject({ status: 'skip' });
    expect(by.get('Adds (1,1)')).toMatchObject({ status: 'pass', suite: 'FlakeDemo.CartTests' });
    expect(by.get('Adds (2,3)')).toMatchObject({ status: 'fail', suite: 'FlakeDemo.CartTests' });
  });

  it('emits data-driven InnerResults rows instead of the aggregate parent', () => {
    const { results, warnings } = trxParser.parse(
      load('trx-mstest2-datarows.trx'),
      'trx-mstest2-datarows.trx',
    );
    expect(warnings).toEqual([]);
    const adds = results.filter((r) => r.name.startsWith('Adds'));
    expect(adds.map((r) => `${r.name}:${r.status}`)).toEqual([
      'Adds (1,1):pass',
      'Adds (2,3):fail',
    ]);
    expect(adds.every((r) => r.suite === 'FlakeDemo.CartTests')).toBe(true);
    expect(adds[1]!.message).toContain('row mismatch');
    // same identities as MSTest 3's flat rows → history survives an adapter upgrade
    const flat = trxParser.parse(load('trx-mstest3.trx'), 'x').results;
    expect(adds.map((r) => r.testId).sort()).toEqual(
      flat
        .filter((r) => r.name.startsWith('Adds'))
        .map((r) => r.testId)
        .sort(),
    );
    const checkouts = results.filter((r) => r.name === 'Checkout');
    expect(new Set(checkouts.map((r) => r.suite)).size).toBe(2);
  });

  it('maps the remaining TRX outcomes instead of dropping them', () => {
    const outcomes = [
      'Timeout',
      'Error',
      'Aborted',
      'NotExecuted',
      'Inconclusive',
      'PassedButRunAborted',
      'Disconnected',
      'NotRunnable',
      'Warning',
      'Completed',
      'Pending',
      'InProgress',
    ];
    const content = `<TestRun><Results>${outcomes
      .map((o) => `<UnitTestResult testName="${o}" outcome="${o}" />`)
      .join('')}</Results></TestRun>`;
    const { results, warnings } = trxParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(Object.fromEntries(results.map((r) => [r.name, r.status]))).toEqual({
      Timeout: 'fail',
      Error: 'error',
      Aborted: 'error',
      NotExecuted: 'skip',
      Inconclusive: 'skip',
      PassedButRunAborted: 'pass',
      Disconnected: 'error',
      NotRunnable: 'error',
      Warning: 'pass',
      Completed: 'pass',
      Pending: 'skip',
      InProgress: 'error',
    });
    // a timeout with no ErrorInfo still says why it failed
    expect(results[0]!.message).toBe('outcome: Timeout');
  });

  it('keeps a failed data-driven parent whose rows all passed (e.g. cleanup failure)', () => {
    const content =
      '<TestRun><Results><UnitTestResult testId="t1" testName="Rows" outcome="Failed">' +
      '<Output><ErrorInfo><Message>cleanup blew up</Message></ErrorInfo></Output>' +
      '<InnerResults><UnitTestResult testId="t1" testName="Rows (1)" outcome="Passed" /></InnerResults>' +
      '</UnitTestResult></Results></TestRun>';
    const { results } = trxParser.parse(content, 'inline');
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual(['Rows (1):pass', 'Rows:fail']);
    expect(results[1]!.message).toBe('cleanup blew up');
  });
});

describe('TRX XML text fidelity (r5 #8)', () => {
  it('keeps numeric ErrorInfo text and decodes numeric character references', () => {
    const content =
      '<TestRun><Results><UnitTestResult testName="Caf&#xE9;Test" outcome="Failed">' +
      '<Output><ErrorInfo><Message>42</Message><StackTrace>1</StackTrace></ErrorInfo></Output>' +
      '</UnitTestResult></Results></TestRun>';
    const { results } = trxParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ name: 'CaféTest', message: '42', stack: '1' });
  });
});

// trx-truncated.trx: the QA's real MSTest TRX cut off mid-<Results> (paths → /repo)
describe('truncated TRX (QA PAR-10)', () => {
  it('warns that the file is truncated and that classes could not be resolved', () => {
    const { results, warnings } = trxParser.parse(load('trx-truncated.trx'), 'cut.trx');
    expect(results.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('truncated'))).toBe(true);
    expect(warnings.some((w) => w.includes("suite 'unknown'"))).toBe(true);
  });

  it('a complete real TRX gets neither warning', () => {
    expect(trxParser.parse(load('trx-mstest3.trx'), 'ok.trx').warnings).toEqual([]);
  });
});
