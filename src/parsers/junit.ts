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
 * - status = fail (child <failure>) | error (child <error>) | skip (child <skipped>) | pass
 * - durationMs = round(@_time * 1000) when @_time parses as a finite number, else null
 * - message = failure/error @_message or its text content, trimmed to 500 chars
 * - stack   = failure/error text content, trimmed to 1000 chars
 *
 * Never throws: malformed input produces warnings.
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

function durationOf(timeAttr: string | undefined): number | null {
  if (timeAttr === undefined) return null;
  const seconds = Number.parseFloat(timeAttr);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null;
}

function mapTestCase(tc: unknown, suiteName: string, ctx: Ctx): void {
  if (!isObj(tc)) return;
  const name = attr(tc, '@_name');
  if (name === undefined) {
    ctx.warnings.push(`junit: ${ctx.sourcePath}: skipping <testcase> without a name attribute`);
    return;
  }
  const suite = attr(tc, '@_classname') ?? suiteName;

  let status: TestStatus = 'pass';
  let detail: unknown;
  if (tc.failure !== undefined) {
    status = 'fail';
    detail = tc.failure;
  } else if (tc.error !== undefined) {
    status = 'error';
    detail = tc.error;
  } else if (tc.skipped !== undefined) {
    status = 'skip';
  }

  const result: TestCaseResult = {
    testId: makeTestId(suite, name),
    suite,
    name,
    status,
    durationMs: durationOf(attr(tc, '@_time')),
  };
  if (detail !== undefined) {
    const detailMessage = isObj(detail) ? attr(detail, '@_message') : undefined;
    const message = trimTo(detailMessage, 2000) ?? trimTo(textOf(detail), 2000);
    const stack = trimTo(textOf(detail), 1000);
    if (message !== undefined) result.message = message;
    if (stack !== undefined) result.stack = stack;
  }
  ctx.results.push(result);
}

/**
 * Walk a testsuites/testsuite element: map its direct testcases, then recurse
 * into nested testsuites. A nested suite without @_name inherits the parent name.
 */
function walk(el: unknown, inheritedSuite: string, ctx: Ctx): void {
  if (!isObj(el)) return;
  const ownSuite = attr(el, '@_name') ?? inheritedSuite;
  for (const tc of toArray(el.testcase)) mapTestCase(tc, ownSuite, ctx);
  for (const ts of toArray(el.testsuite)) walk(ts, ownSuite, ctx);
}

export const junitParser: ReportParser = {
  name: 'junit',

  sniff(content: string): boolean {
    const trimmed = stripBom(content).trimStart();
    return trimmed.startsWith('<') && content.includes('<testsuit');
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const ctx: Ctx = { sourcePath, results: [], warnings: [] };
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

    const root = doc.testsuites !== undefined ? doc.testsuites : doc.testsuite;
    if (root === undefined) {
      ctx.warnings.push(`junit: ${sourcePath}: no <testsuites> or <testsuite> root element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    walk(root, 'unknown', ctx);
    return { results: ctx.results, warnings: ctx.warnings };
  },
};
