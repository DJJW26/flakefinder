/**
 * JUnit XML parser.
 *
 * Supports the common flavors:
 * - `<testsuites>` root wrapping one or more `<testsuite>` elements (pytest, jest-junit, …)
 * - a bare `<testsuite>` root (Maven surefire per-class files)
 * - nested `<testsuite>` hierarchies (aggregated reports)
 *
 * Per `<testcase>`:
 * - name   = @_name (testcases without a name are skipped with a warning)
 * - suite  = @_classname when present, else the nearest enclosing testsuite's @_name
 * - status = skip (child <skipped>, unless an <error> is also present — a failing TODO test is
 *   a skip, as in TAP) | fail (<failure>) | error (<error>) | pass. With several
 *   <failure>/<error> children the first one is used and the rest are counted in the message.
 * - durationMs = round(@_time * 1000) when @_time parses as a finite number, else null
 *   (decimal comma `1,5` → 1.5 s; grouping commas `1,033.42` → 1033.42 s)
 * - text and attribute values are never coerced to numbers; numeric character
 *   references (`&#65;`) are decoded
 * - message = failure/error @_message (ignored when it is a bare "Failed", as gotestsum
 *   writes) or its text content, else its @_type; trimmed to 2000 chars
 * - stack   = failure/error text content, trimmed to 1000 chars
 *
 * Maven Surefire/Failsafe reruns (`-Dsurefire.rerunFailingTestsCount=N`):
 * - `<flakyFailure>`/`<flakyError>` on a testcase without `<failure>`/`<error>`
 *   means it failed, was re-run, and finally passed. The result stays 'pass'
 *   (that is the build's verdict, and `flakefinder run` must not turn a green
 *   build red), but the message records "flaky: failed k of n attempts" with
 *   the first failure's message/stackTrace, and one warning per file lists
 *   the affected tests. The engine collapses same-testId results within a run
 *   (last wins), so the attempts travel in `attempts`, not as extra rows.
 * - `<rerunFailure>`/`<rerunError>` next to `<failure>`/`<error>`: it failed on
 *   every attempt — still 'fail'/'error', message notes the attempt count.
 * - Both set `attempts` (oldest first, last = status): flaky → one 'fail'/'error'
 *   per flaky element then 'pass'; failed-all → n × the final status.
 *
 * pytest-rerunfailures (`<testsuite name="pytest">` reports): rerun attempts are written as
 * empty duplicate testcases; they are collapsed into the final result with the same flaky
 * note / "(failed all n attempts)" representation and `attempts` (see collapsePytestReruns).
 *
 * Never throws: malformed input produces warnings.
 */
import { XMLParser } from 'fast-xml-parser';
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import {
  errorMessage,
  flakyRetryMessage,
  flakyRetryWarning,
  isObj,
  retryAttempts,
  stripBom,
  trimTo,
  XML_OPTIONS,
} from './internal.js';

const xml = new XMLParser(XML_OPTIONS);

const MESSAGE_MAX_CHARS = 2000;
const STACK_MAX_CHARS = 1000;

interface Ctx {
  sourcePath: string;
  results: TestCaseResult[];
  warnings: string[];
  /** `suite.name` of tests that passed only after a Surefire rerun. */
  flaky: string[];
  /** The report came from pytest (`<testsuite name="pytest">`). */
  pytest: boolean;
}

/** Attribute value as a non-empty string (whitespace-only counts as absent). */
function attr(node: Record<string, unknown>, name: string): string | undefined {
  const v = node[name];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Text content of an XML node (`#text` when the node also carries attributes). */
function textOf(node: unknown): string | undefined {
  if (typeof node === 'string') return node;
  if (isObj(node)) {
    const t = node['#text'];
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return t.filter((part) => typeof part === 'string').join('');
  }
  return undefined;
}

/**
 * `time` in seconds → ms. Localized writers emit a decimal comma (`1,5`);
 * old Surefire emits grouping commas (`1,033.42`). A lone comma is a
 * decimal separator; commas alongside a '.' are grouping.
 */
function durationOf(timeAttr: string | undefined): number | null {
  if (timeAttr === undefined) return null;
  const raw = timeAttr.trim();
  const normalized = raw.includes('.')
    ? raw.replace(/,/g, '')
    : raw.replace(/^(\d*),(\d+)$/, '$1.$2');
  const seconds = Number.parseFloat(normalized);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

/** message attribute, else text content, else the Surefire `<stackTrace>` child's text. */
function detailMessage(detail: unknown): string | undefined {
  let fromAttr = isObj(detail) ? attr(detail, '@_message') : undefined;
  // gotestsum writes message="Failed" on every failure — no information; the
  // text content (the test's output) is the real message
  if (fromAttr !== undefined && /^\s*(?:failed|failure|error)\s*$/i.test(fromAttr)) {
    fromAttr = undefined;
  }
  return (
    trimTo(fromAttr, MESSAGE_MAX_CHARS) ??
    trimTo(detailStack(detail), MESSAGE_MAX_CHARS) ??
    // `<error type="java.lang.NPE"/>`: the type is all there is
    (isObj(detail) ? trimTo(attr(detail, '@_type'), MESSAGE_MAX_CHARS) : undefined)
  );
}

/** Text content, else the Surefire `<stackTrace>` child (rerun/flaky elements nest it). */
function detailStack(detail: unknown): string | undefined {
  const text = textOf(detail);
  if (text !== undefined && text.trim() !== '') return text;
  if (isObj(detail)) {
    const nested = children(detail, 'stackTrace')[0];
    return textOf(nested);
  }
  return undefined;
}

function mapTestCase(tc: unknown, suiteName: string, ctx: Ctx): void {
  if (!isObj(tc)) return;
  const name = attr(tc, '@_name');
  if (name === undefined) {
    ctx.warnings.push(`junit: ${ctx.sourcePath}: skipping <testcase> without a name attribute`);
    return;
  }
  const suite = attr(tc, '@_classname') ?? suiteName;

  const failures = children(tc, 'failure');
  const errors = children(tc, 'error');
  const skipped = children(tc, 'skipped').length > 0;

  // <skipped> + <failure> is a skipped/TODO test that failed anyway (node:test
  // TODO) → skip, as TAP reports it. A real <error> still wins over <skipped>.
  let status: TestStatus = 'pass';
  let details: unknown[] = [];
  if (skipped && errors.length === 0) {
    status = 'skip';
  } else if (failures.length > 0) {
    status = 'fail';
    details = failures;
  } else if (errors.length > 0) {
    status = 'error';
    details = errors;
  } else if (skipped) {
    status = 'skip';
  }
  const detail = details[0];

  const result: TestCaseResult = {
    testId: makeTestId(suite, name),
    suite,
    name,
    status,
    durationMs: durationOf(attr(tc, '@_time')),
  };
  if (detail !== undefined) {
    let message = detailMessage(detail);
    if (details.length > 1) {
      // several <failure>/<error> children: keep the first, count the rest
      const kind = status === 'fail' ? 'failure' : 'error';
      const more = `(+${details.length - 1} more ${kind}${details.length > 2 ? 's' : ''})`;
      message = trimTo(message !== undefined ? `${message}\n${more}` : more, MESSAGE_MAX_CHARS);
    }
    const stack = trimTo(textOf(detail), STACK_MAX_CHARS);
    if (message !== undefined) result.message = message;
    if (stack !== undefined) result.stack = stack;
  }

  // Surefire rerun evidence (see the header comment for the representation).
  const reruns = [...children(tc, 'rerunFailure'), ...children(tc, 'rerunError')];
  const flakes = [...children(tc, 'flakyFailure'), ...children(tc, 'flakyError')];
  if ((status === 'fail' || status === 'error') && reruns.length > 0) {
    const note = `(Surefire: failed all ${reruns.length + 1} attempts)`;
    result.message = trimTo(
      result.message !== undefined ? `${result.message}\n${note}` : note,
      MESSAGE_MAX_CHARS,
    );
    result.attempts = retryAttempts(reruns.length, status, status);
  } else if (status === 'pass' && flakes.length > 0) {
    const first = flakes[0];
    result.message = flakyRetryMessage(
      flakes.length,
      'Surefire rerun',
      detailMessage(first),
      MESSAGE_MAX_CHARS,
    );
    const stack = trimTo(detailStack(first), STACK_MAX_CHARS);
    if (stack !== undefined) result.stack = stack;
    const failedKinds: TestStatus[] = [
      ...children(tc, 'flakyFailure').map((): TestStatus => 'fail'),
      ...children(tc, 'flakyError').map((): TestStatus => 'error'),
    ];
    result.attempts = [...failedKinds, 'pass'];
    ctx.flaky.push(`${suite}.${name}`);
  }
  ctx.results.push(result);
}

/**
 * pytest-rerunfailures writes every rerun attempt as an EMPTY duplicate
 * <testcase> before the final one (the rerun outcome has no JUnit form), so a
 * fail→pass test looked like two clean passes. In a pytest report, a test
 * whose earlier duplicates are all empty passes is collapsed into its final
 * result: pass → flaky note (like Surefire reruns), fail → "(failed all n
 * attempts)". Other duplicates are left as they are.
 */
function collapsePytestReruns(ctx: Ctx): void {
  const groups = new Map<string, TestCaseResult[]>();
  for (const r of ctx.results) {
    const g = groups.get(r.testId);
    if (g) g.push(r);
    else groups.set(r.testId, [r]);
  }
  const out: TestCaseResult[] = [];
  for (const group of groups.values()) {
    const final = group[group.length - 1]!;
    const earlier = group.slice(0, -1);
    const reruns =
      earlier.length > 0 &&
      earlier.every((r) => r.status === 'pass' && r.message === undefined && r.stack === undefined);
    if (!reruns) {
      out.push(...group);
      continue;
    }
    const how = 'pytest-rerunfailures rerun';
    if (final.status === 'pass') {
      final.message = flakyRetryMessage(earlier.length, how, undefined, MESSAGE_MAX_CHARS);
      final.attempts = retryAttempts(earlier.length, 'pass');
      ctx.flaky.push(`${final.suite}.${final.name}`);
    } else if (final.status === 'fail' || final.status === 'error') {
      const note = `(failed all ${group.length} attempts)`;
      final.message = trimTo(
        final.message !== undefined ? `${final.message}\n${note}` : note,
        MESSAGE_MAX_CHARS,
      );
      final.attempts = retryAttempts(earlier.length, final.status, final.status);
    }
    out.push(final);
  }
  ctx.results = out;
}

/**
 * Namespace-tolerant child lookup: matches `testcase`, `x:testcase`, etc.
 * fast-xml-parser keeps the namespace prefix in tag names.
 */
function children(el: Record<string, unknown>, localName: string): unknown[] {
  const out: unknown[] = [];
  for (const [key, value] of Object.entries(el)) {
    if (key === localName || key.endsWith(`:${localName}`)) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
  }
  return out;
}

/**
 * Walk a testsuites/testsuite element: map its direct testcases, then recurse
 * into nested testsuites. A nested suite without @_name inherits the parent name.
 */
function walk(el: unknown, inheritedSuite: string, ctx: Ctx): void {
  if (!isObj(el)) return;
  const ownSuite = attr(el, '@_name') ?? inheritedSuite;
  if (ownSuite === 'pytest') ctx.pytest = true;
  for (const tc of children(el, 'testcase')) mapTestCase(tc, ownSuite, ctx);
  for (const ts of children(el, 'testsuite')) walk(ts, ownSuite, ctx);
}

export const junitParser: ReportParser = {
  name: 'junit',

  sniff(content: string): boolean {
    const trimmed = stripBom(content).trimStart();
    // namespace prefixes allowed: <testsuit…>, <x:testsuit…>
    return trimmed.startsWith('<') && /<(?:[\w.-]+:)?testsuit/.test(trimmed);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const ctx: Ctx = { sourcePath, results: [], warnings: [], flaky: [], pytest: false };
    const body = stripBom(content);

    if (body.trim() === '') {
      ctx.warnings.push(`junit: ${sourcePath}: file is empty`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!body.trimEnd().endsWith('>')) {
      ctx.warnings.push(`junit: ${sourcePath}: content appears truncated (does not end with '>')`);
    }

    let doc: unknown;
    try {
      doc = xml.parse(body);
    } catch (err) {
      ctx.warnings.push(`junit: ${sourcePath}: failed to parse XML: ${errorMessage(err)}`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!isObj(doc)) {
      ctx.warnings.push(`junit: ${sourcePath}: XML did not parse to a document object`);
      return { results: ctx.results, warnings: ctx.warnings };
    }

    // namespace-tolerant root lookup: <testsuites>, <testsuite>, <x:testsuites>…
    const rootKey = Object.keys(doc).find((k) => /(?:^|:)testsuites?$/.test(k));
    let root = rootKey !== undefined ? doc[rootKey] : undefined;
    if (Array.isArray(root)) {
      // two <testsuites> blocks in one file: fast-xml-parser yields an array —
      // use the first and say so rather than silently dropping everything
      ctx.warnings.push(
        `junit: ${sourcePath}: multiple <testsuites> roots found — using the first`,
      );
      root = root[0];
    }
    if (root === undefined) {
      ctx.warnings.push(`junit: ${sourcePath}: no <testsuites> or <testsuite> root element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    walk(root, 'unknown', ctx);
    if (ctx.pytest) collapsePytestReruns(ctx);
    if (ctx.flaky.length > 0) {
      const how = ctx.pytest ? 'pytest-rerunfailures rerun' : 'Surefire rerun';
      ctx.warnings.push(flakyRetryWarning('junit', sourcePath, how, ctx.flaky));
    }
    return { results: ctx.results, warnings: ctx.warnings };
  },
};
