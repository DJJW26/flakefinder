/**
 * TRX (.NET) parser — Visual Studio / `dotnet test` test-result XML.
 * Shape per the documented TRX schema (http://microsoft.com/schemas/VisualStudio/TeamTest/2010):
 *
 * <TestRun>
 *   <Results>
 *     <UnitTestResult testName="..." outcome="Passed|Failed|NotExecuted"
 *                     duration="00:00:00.1230000" ...>
 *       <Output><StdOut>…</StdOut>
 *               <ErrorInfo><Message>…</Message><StackTrace>…</StackTrace></ErrorInfo></Output>
 *     </UnitTestResult>
 *   </Results>
 *   <TestDefinitions>
 *     <UnitTest name="..." storage="dll path">
 *       <TestMethod className="Ns.Class" name="method"/>
 *     </UnitTest>
 *   </TestDefinitions>
 * </TestRun>
 *
 * Mapping: outcome Passed → pass, Failed → fail (error → 'error' when the
 * failure carries an ErrorInfo with a stack), NotExecuted/other → skip.
 * Suite = TestMethod/@_className (fallback: the UnitTest @_name).
 * duration "HH:MM:SS.fraction" → ms. Never throws.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripBom, toArray, trimTo } from './internal.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

interface Ctx {
  sourcePath: string;
  results: TestCaseResult[];
  warnings: string[];
}

function attr(node: Record<string, unknown>, name: string): string | undefined {
  const v = node[name];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function textOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (isObj(node)) {
    const t = node['#text'];
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.filter((p) => typeof p === 'string').join('');
  }
  return undefined;
}

/** TRX duration "[d.]HH:MM:SS.fraction" (.NET TimeSpan) → ms. */
function durationMs(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const m = raw.match(/^(?:(\d+)\.)?(?:(\d+)):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
  if (!m) return null;
  const days = m[1] !== undefined ? Number.parseInt(m[1]!, 10) : 0;
  const h = Number.parseInt(m[2]!, 10);
  const min = Number.parseInt(m[3]!, 10);
  const sec = Number.parseFloat(m[4]!);
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec) || sec < 0) return null;
  return Math.round((((days * 24 + h) * 60 + min) * 60 + sec) * 1000);
}

function outcomeStatus(outcome: string | undefined, hasErrorInfo: boolean): TestStatus | null {
  switch (outcome) {
    case 'Passed':
      return 'pass';
    case 'Failed':
      return hasErrorInfo ? 'error' : 'fail';
    case 'NotExecuted':
      return 'skip';
    default:
      return null;
  }
}

export const trxParser: ReportParser = {
  name: 'trx',

  sniff(content: string): boolean {
    const trimmed = stripBom(content).trimStart();
    return trimmed.startsWith('<') && /<(?:[\w.-]+:)?TestRun[\s>]/.test(trimmed);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const ctx: Ctx = { sourcePath, results: [], warnings: [] };
    const body = stripBom(content);
    if (body.trim() === '') {
      ctx.warnings.push(`trx: ${sourcePath}: file is empty`);
      return { results: ctx.results, warnings: ctx.warnings };
    }

    let doc: unknown;
    try {
      doc = xml.parse(body);
    } catch (err) {
      ctx.warnings.push(`trx: ${sourcePath}: failed to parse XML: ${errorMessage(err)}`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!isObj(doc)) {
      ctx.warnings.push(`trx: ${sourcePath}: XML did not parse to a document object`);
      return { results: ctx.results, warnings: ctx.warnings };
    }

    const rootKey = Object.keys(doc).find((k) => /(?:^|:)TestRun$/.test(k));
    if (rootKey === undefined) {
      ctx.warnings.push(`trx: ${sourcePath}: no <TestRun> root element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    let root = doc[rootKey];
    if (Array.isArray(root)) {
      // two <TestRun> blocks in one file: fast-xml-parser yields an array —
      // use the first and say so rather than silently dropping everything
      ctx.warnings.push(`trx: ${sourcePath}: multiple <TestRun> roots found — using the first`);
      root = root[0];
    }
    if (!isObj(root)) return { results: ctx.results, warnings: ctx.warnings };

    // TestDefinitions → className per test name (suite lookup)
    const suiteByTestName = new Map<string, string>();
    const defKey = Object.keys(root).find((k) => /(?:^|:)TestDefinitions$/.test(k));
    if (defKey !== undefined) {
      for (const unit of toArray((root[defKey] as Record<string, unknown>)?.UnitTest)) {
        if (!isObj(unit)) continue;
        const unitName = attr(unit, '@_name');
        const methodKey = Object.keys(unit).find((k) => /(?:^|:)TestMethod$/.test(k));
        const method = methodKey !== undefined ? (unit[methodKey] as unknown) : undefined;
        const className =
          method !== undefined && isObj(method) ? attr(method, '@_className') : undefined;
        if (unitName !== undefined && className !== undefined) {
          suiteByTestName.set(unitName, className);
        }
      }
    }

    const resultsKey = Object.keys(root).find((k) => /(?:^|:)Results$/.test(k));
    if (resultsKey === undefined) {
      ctx.warnings.push(`trx: ${sourcePath}: no <Results> element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    for (const r of toArray((root[resultsKey] as Record<string, unknown>)?.UnitTestResult)) {
      if (!isObj(r)) continue;
      const testName = attr(r, '@_testName');
      if (testName === undefined) {
        ctx.warnings.push(`trx: ${sourcePath}: skipping <UnitTestResult> without testName`);
        continue;
      }
      const outputKey = Object.keys(r).find((k) => /(?:^|:)Output$/.test(k));
      const output =
        outputKey !== undefined && isObj(r[outputKey])
          ? (r[outputKey] as Record<string, unknown>)
          : undefined;
      const errorKey =
        output !== undefined
          ? Object.keys(output).find((k) => /(?:^|:)ErrorInfo$/.test(k))
          : undefined;
      const errorInfo =
        errorKey !== undefined && isObj(output![errorKey])
          ? (output![errorKey] as Record<string, unknown>)
          : undefined;
      let message: string | undefined;
      let stack: string | undefined;
      if (errorInfo !== undefined) {
        const msgKey = Object.keys(errorInfo).find((k) => /(?:^|:)Message$/.test(k));
        if (msgKey !== undefined) message = textOf(errorInfo[msgKey]);
        const stackKey = Object.keys(errorInfo).find((k) => /(?:^|:)StackTrace$/.test(k));
        if (stackKey !== undefined) stack = textOf(errorInfo[stackKey]);
      }

      const status = outcomeStatus(attr(r, '@_outcome'), errorInfo !== undefined);
      if (status === null) {
        ctx.warnings.push(
          `trx: ${sourcePath}: unknown outcome "${attr(r, '@_outcome')}" — skipped ${testName}`,
        );
        continue;
      }
      const suite = suiteByTestName.get(testName) ?? 'unknown';
      const result: TestCaseResult = {
        testId: makeTestId(suite, testName),
        suite,
        name: testName,
        status,
        durationMs: durationMs(attr(r, '@_duration')),
      };
      const trimmedMessage = trimTo(message, 2000);
      if (trimmedMessage !== undefined) result.message = trimmedMessage;
      const trimmedStack = trimTo(stack, 1000);
      if (trimmedStack !== undefined) result.stack = trimmedStack;
      ctx.results.push(result);
    }
    return { results: ctx.results, warnings: ctx.warnings };
  },
};
