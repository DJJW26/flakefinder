/**
 * TRX (.NET) parser — Visual Studio / `dotnet test --logger trx` test-result XML.
 * Shape per the documented TRX schema (http://microsoft.com/schemas/VisualStudio/TeamTest/2010):
 *
 * <TestRun>
 *   <Results>
 *     <UnitTestResult testId="<UnitTest id>" testName="..." outcome="Passed|Failed|…"
 *                     duration="00:00:00.1230000" ...>
 *       <Output><StdOut>…</StdOut>
 *               <ErrorInfo><Message>…</Message><StackTrace>…</StackTrace></ErrorInfo></Output>
 *       <InnerResults><UnitTestResult …/>…</InnerResults>   (data-driven rows, older MSTest)
 *     </UnitTestResult>
 *   </Results>
 *   <TestDefinitions>
 *     <UnitTest id="..." name="..." storage="dll path">
 *       <TestMethod className="Ns.Class" name="method"/>
 *     </UnitTest>
 *   </TestDefinitions>
 * </TestRun>
 *
 * Outcome mapping (TRX TestOutcome enum):
 * - Passed, PassedButRunAborted, Completed, Warning → pass
 * - Failed, Timeout → fail ('Failed' always carries ErrorInfo in real output,
 *   so ErrorInfo does not make it an 'error')
 * - Error, Aborted, Disconnected, NotRunnable, InProgress → error (the test
 *   could not run or never finished)
 * - NotExecuted, Inconclusive, Pending → skip
 * - anything else → dropped with a warning.
 * A fail/error result without an ErrorInfo message gets `outcome: <Outcome>`.
 *
 * Suite = the test's class: UnitTestResult/@testId → UnitTest/@id →
 * TestMethod/@className (two classes may share a method name, so the
 * testName is NOT a usable key; it is only a fallback for hand-written files
 * without ids). Name = UnitTestResult/@testName. Data-driven parents with
 * InnerResults are replaced by their rows (each row is its own result, same
 * identity as MSTest 3's flat rows); the parent is kept only when it failed
 * while none of its rows did. Message/stack are trimmed to 2000/1000 chars.
 * duration "[d.]HH:MM:SS.fraction" → ms. A file without a closing </TestRun> gets a
 * "truncated" warning; results whose testId has no <TestDefinitions> entry
 * (it follows <Results>, so truncation loses it) get a second one. Never throws.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripBom, toArray, trimTo, XML_OPTIONS } from './internal.js';

const xml = new XMLParser(XML_OPTIONS);

interface Ctx {
  sourcePath: string;
  results: TestCaseResult[];
  warnings: string[];
  /** Results whose testId matched no UnitTest definition (truncated file?). */
  unresolvedIds: number;
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

const OUTCOMES: Record<string, TestStatus> = {
  passed: 'pass',
  passedbutrunaborted: 'pass',
  completed: 'pass',
  warning: 'pass',
  failed: 'fail',
  timeout: 'fail',
  error: 'error',
  aborted: 'error',
  disconnected: 'error',
  notrunnable: 'error',
  inprogress: 'error',
  notexecuted: 'skip',
  inconclusive: 'skip',
  pending: 'skip',
};

function outcomeStatus(outcome: string | undefined): TestStatus | null {
  return outcome !== undefined ? (OUTCOMES[outcome.trim().toLowerCase()] ?? null) : null;
}

/** Namespace-tolerant child lookup (`Foo` or `x:Foo`); arrays flattened. */
function childList(el: Record<string, unknown>, localName: string): unknown[] {
  const key = Object.keys(el).find((k) => k === localName || k.endsWith(`:${localName}`));
  return key !== undefined ? toArray(el[key]) : [];
}

function child(
  el: Record<string, unknown>,
  localName: string,
): Record<string, unknown> | undefined {
  const first = childList(el, localName)[0];
  return isObj(first) ? first : undefined;
}

interface Suites {
  byId: Map<string, string>;
  byName: Map<string, string>;
}

function mapResult(r: unknown, suites: Suites, ctx: Ctx): void {
  if (!isObj(r)) return;
  const testName = attr(r, '@_testName');
  if (testName === undefined) {
    ctx.warnings.push(`trx: ${ctx.sourcePath}: skipping <UnitTestResult> without testName`);
    return;
  }
  const outcome = attr(r, '@_outcome');
  const status = outcomeStatus(outcome);
  if (status === null) {
    ctx.warnings.push(`trx: ${ctx.sourcePath}: unknown outcome "${outcome}" — skipped ${testName}`);
    return;
  }

  // data-driven rows: emit each row; the aggregate parent only when its own
  // failure is not carried by any row
  const inner = child(r, 'InnerResults');
  const rows = inner !== undefined ? childList(inner, 'UnitTestResult') : [];
  let rowFailed = false;
  if (rows.length > 0) {
    const before = ctx.results.length;
    for (const row of rows) mapResult(row, suites, ctx);
    rowFailed = ctx.results.slice(before).some((x) => x.status === 'fail' || x.status === 'error');
    if (rowFailed || (status !== 'fail' && status !== 'error')) return;
  }

  const errorInfo = (() => {
    const output = child(r, 'Output');
    return output !== undefined ? child(output, 'ErrorInfo') : undefined;
  })();
  let message: string | undefined;
  let stack: string | undefined;
  if (errorInfo !== undefined) {
    message = textOf(childList(errorInfo, 'Message')[0]);
    stack = textOf(childList(errorInfo, 'StackTrace')[0]);
  }

  const testId = attr(r, '@_testId');
  const known =
    (testId !== undefined ? suites.byId.get(testId.toLowerCase()) : undefined) ??
    suites.byName.get(testName);
  if (known === undefined && testId !== undefined) ctx.unresolvedIds++;
  const suite = known ?? 'unknown';
  const result: TestCaseResult = {
    testId: makeTestId(suite, testName),
    suite,
    name: testName,
    status,
    durationMs: durationMs(attr(r, '@_duration')),
  };
  const trimmedMessage =
    trimTo(message, 2000) ??
    (status === 'fail' || status === 'error' ? `outcome: ${outcome}` : undefined);
  if (trimmedMessage !== undefined) result.message = trimmedMessage;
  const trimmedStack = trimTo(stack, 1000);
  if (trimmedStack !== undefined) result.stack = trimmedStack;
  ctx.results.push(result);
}

export const trxParser: ReportParser = {
  name: 'trx',

  sniff(content: string): boolean {
    const trimmed = stripBom(content).trimStart();
    return trimmed.startsWith('<') && /<(?:[\w.-]+:)?TestRun[\s>]/.test(trimmed);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const ctx: Ctx = { sourcePath, results: [], warnings: [], unresolvedIds: 0 };
    const body = stripBom(content);
    if (body.trim() === '') {
      ctx.warnings.push(`trx: ${sourcePath}: file is empty`);
      return { results: ctx.results, warnings: ctx.warnings };
    }

    if (!/<\/(?:[\w.-]+:)?TestRun>\s*$/.test(body)) {
      ctx.warnings.push(`trx: ${sourcePath}: content appears truncated (no closing </TestRun>)`);
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

    // TestDefinitions → className per UnitTest id (and per name, as a fallback)
    const suites: Suites = { byId: new Map(), byName: new Map() };
    const definitions = child(root, 'TestDefinitions');
    for (const unit of definitions !== undefined ? childList(definitions, 'UnitTest') : []) {
      if (!isObj(unit)) continue;
      const method = child(unit, 'TestMethod');
      const className = method !== undefined ? attr(method, '@_className') : undefined;
      if (className === undefined) continue;
      const id = attr(unit, '@_id');
      if (id !== undefined) suites.byId.set(id.toLowerCase(), className);
      const unitName = attr(unit, '@_name');
      if (unitName !== undefined && !suites.byName.has(unitName)) {
        suites.byName.set(unitName, className);
      }
    }

    const resultsEl = child(root, 'Results');
    if (resultsEl === undefined && !Object.keys(root).some((k) => /(?:^|:)Results$/.test(k))) {
      ctx.warnings.push(`trx: ${sourcePath}: no <Results> element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    for (const r of resultsEl !== undefined ? childList(resultsEl, 'UnitTestResult') : []) {
      mapResult(r, suites, ctx);
    }
    // dotnet writes <Results> BEFORE <TestDefinitions>: a cut-off file loses
    // every class name, and 'unknown' suites would fork the tests' history
    if (ctx.unresolvedIds > 0) {
      ctx.warnings.push(
        `trx: ${sourcePath}: ${ctx.unresolvedIds} result(s) have a testId with no matching <TestDefinitions> entry — recorded with suite 'unknown' (their ids differ from complete reports)`,
      );
    }
    return { results: ctx.results, warnings: ctx.warnings };
  },
};
