/**
 * Jest `--json` parser.
 *
 * Shape: `{ testResults: [ { name: <file>, status, message, assertionResults: [ {
 * status: 'passed'|'failed'|'pending'|'todo', fullName, title, ancestorTitles: string[],
 * duration (ms), failureMessages: string[] } ] } ] }`
 *
 * Mapping:
 * - failed → 'fail', pending/todo → 'skip', passed → 'pass'
 * - suite = ancestorTitles.join(' > ') when non-empty, else the file path with forward slashes
 * - name = title (fullName as fallback)
 * - durationMs = duration ?? null
 * - message = failureMessages[0] trimmed to 500 chars
 *
 * A file with zero assertionResults but a suite-level failure (status 'failed') emits one
 * result named '(suite)' so suite-level failures (e.g. syntax errors) are not lost.
 *
 * Never throws: malformed input produces warnings.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripBom, toArray, trimTo } from './internal.js';

const SUITE_PLACEHOLDER = '(suite)';

function statusOf(status: unknown): TestStatus | null {
  switch (status) {
    case 'passed':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'pending':
    case 'skipped': // vitest's json reporter emits "skipped" (jest: "pending")
    case 'todo':
      return 'skip';
    default:
      return null;
  }
}

function tryParseJson(content: string): { doc: unknown } | { error: string } {
  try {
    return { doc: JSON.parse(stripBom(content)) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export const jestParser: ReportParser = {
  name: 'jest',

  sniff(content: string): boolean {
    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) return false;
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.testResults)) return false;
    return doc.testResults.some((file) => isObj(file) && Array.isArray(file.assertionResults));
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];

    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) {
      return { results, warnings: [`jest: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.testResults)) {
      return { results, warnings: [`jest: ${sourcePath}: missing testResults[] array`] };
    }

    for (const file of doc.testResults) {
      if (!isObj(file)) {
        warnings.push(`jest: ${sourcePath}: skipping non-object entry in testResults[]`);
        continue;
      }
      const filePath =
        typeof file.name === 'string' && file.name.trim() !== ''
          ? file.name.replace(/\\/g, '/')
          : '(unknown file)';
      const assertions = toArray(file.assertionResults);

      for (const assertion of assertions) {
        if (!isObj(assertion)) {
          warnings.push(`jest: ${sourcePath}: skipping non-object entry in assertionResults[]`);
          continue;
        }
        const status = statusOf(assertion.status);
        if (status === null) {
          warnings.push(
            `jest: ${sourcePath}: unknown assertion status ${JSON.stringify(assertion.status)}`,
          );
          continue;
        }
        const ancestors = Array.isArray(assertion.ancestorTitles)
          ? assertion.ancestorTitles.filter(
              (title): title is string => typeof title === 'string' && title.trim() !== '',
            )
          : [];
        const suite = ancestors.length > 0 ? ancestors.join(' > ') : filePath;
        const name =
          typeof assertion.title === 'string' && assertion.title.trim() !== ''
            ? assertion.title
            : typeof assertion.fullName === 'string' && assertion.fullName.trim() !== ''
              ? assertion.fullName
              : '(unnamed)';
        const durationMs =
          typeof assertion.duration === 'number' && Number.isFinite(assertion.duration)
            ? assertion.duration
            : null;
        const message = trimTo(toArray(assertion.failureMessages)[0], 2000);

        const result: TestCaseResult = {
          testId: makeTestId(suite, name),
          suite,
          name,
          status,
          durationMs,
        };
        if (message !== undefined) result.message = message;
        results.push(result);
      }

      // Suite-level failure (e.g. the file failed to even run): keep it as one synthetic test.
      if (assertions.length === 0 && file.status === 'failed') {
        const message = trimTo(file.message, 2000);
        const result: TestCaseResult = {
          testId: makeTestId(filePath, SUITE_PLACEHOLDER),
          suite: filePath,
          name: SUITE_PLACEHOLDER,
          status: 'fail',
          durationMs: null,
        };
        if (message !== undefined) result.message = message;
        results.push(result);
      }
    }
    return { results, warnings };
  },
};
