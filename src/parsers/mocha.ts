/**
 * Mocha `json` reporter parser.
 *
 * Shape: `{ stats, tests|results: [...], passes: [...], failures: [...], pending: [...] }`
 * where every test carries `{ title, fullTitle, file, duration, err }`.
 * (Mocha's own reporter emits the all-tests array under `tests`; some tooling renames it
 * `results` — both are accepted.)
 *
 * Status is determined by membership: a test found in `failures` is 'fail', in `pending`
 * is 'skip', in `passes` is 'pass'. Membership is first checked by object identity within
 * the same parsed document, then by fullTitle string matching (JSON.parse produces distinct
 * objects for the same test, so the string fallback is what usually fires). As a last
 * resort the test's own `state` field is consulted; default 'pass'.
 *
 * suite = fullTitle with the title stripped (the describe chain), else `file`, else 'unknown'.
 * err.message trimmed to 500 chars; err.stack trimmed to 1000 chars.
 *
 * Never throws: malformed input produces warnings.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripBom, trimTo } from './internal.js';

function fullTitleSet(arr: unknown[]): Set<string> {
  const set = new Set<string>();
  for (const entry of arr) {
    if (isObj(entry) && typeof entry.fullTitle === 'string' && entry.fullTitle !== '') {
      set.add(entry.fullTitle);
    }
  }
  return set;
}

/** Suite = describe chain (fullTitle minus title), falling back to the source file. */
function deriveSuite(entry: Record<string, unknown>, title: string, fullTitle: string): string {
  if (fullTitle !== '' && fullTitle !== title && fullTitle.endsWith(title)) {
    const chain = fullTitle.slice(0, fullTitle.length - title.length).trim();
    if (chain !== '') return chain;
  }
  if (typeof entry.file === 'string' && entry.file.trim() !== '') {
    return entry.file.trim().replace(/\\/g, '/');
  }
  return fullTitle !== '' ? fullTitle : 'unknown';
}

function tryParseJson(content: string): { doc: unknown } | { error: string } {
  try {
    return { doc: JSON.parse(stripBom(content)) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export const mochaParser: ReportParser = {
  name: 'mocha',

  sniff(content: string): boolean {
    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) return false;
    const doc = parsed.doc;
    if (!isObj(doc)) return false;
    const hasTestList = Array.isArray(doc.results) || Array.isArray(doc.tests);
    if (hasTestList && doc.stats !== undefined) return true;
    return Array.isArray(doc.passes) && Array.isArray(doc.failures);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];

    const parsed = tryParseJson(content);
    if (!('doc' in parsed)) {
      return { results, warnings: [`mocha: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc)) {
      return { results, warnings: [`mocha: ${sourcePath}: not a JSON object`] };
    }

    const all = Array.isArray(doc.results)
      ? doc.results
      : Array.isArray(doc.tests)
        ? doc.tests
        : null;
    if (all === null) {
      return { results, warnings: [`mocha: ${sourcePath}: missing "tests"/"results" array`] };
    }
    const passes = Array.isArray(doc.passes) ? doc.passes : [];
    const failures = Array.isArray(doc.failures) ? doc.failures : [];
    const pending = Array.isArray(doc.pending) ? doc.pending : [];
    const passTitles = fullTitleSet(passes);
    const failTitles = fullTitleSet(failures);
    const pendingTitles = fullTitleSet(pending);

    for (const entry of all) {
      if (!isObj(entry)) {
        warnings.push(`mocha: ${sourcePath}: skipping non-object test entry`);
        continue;
      }
      const fullTitle = typeof entry.fullTitle === 'string' ? entry.fullTitle.trim() : '';
      const title =
        typeof entry.title === 'string' && entry.title.trim() !== ''
          ? entry.title.trim()
          : fullTitle !== ''
            ? fullTitle
            : '(unnamed)';

      let status: TestStatus | null = null;
      if (failures.includes(entry) || (fullTitle !== '' && failTitles.has(fullTitle))) {
        status = 'fail';
      } else if (pending.includes(entry) || (fullTitle !== '' && pendingTitles.has(fullTitle))) {
        status = 'skip';
      } else if (passes.includes(entry) || (fullTitle !== '' && passTitles.has(fullTitle))) {
        status = 'pass';
      } else if (entry.state === 'failed') {
        status = 'fail';
      } else if (entry.state === 'pending') {
        status = 'skip';
      }
      const finalStatus: TestStatus = status ?? 'pass';

      const suite = deriveSuite(entry, title, fullTitle);
      const durationMs =
        typeof entry.duration === 'number' && Number.isFinite(entry.duration)
          ? entry.duration
          : null;

      const result: TestCaseResult = {
        testId: makeTestId(suite, title),
        suite,
        name: title,
        status: finalStatus,
        durationMs,
      };

      const err = entry.err;
      if (typeof err === 'string') {
        const message = trimTo(err, 500);
        if (message !== undefined) result.message = message;
      } else if (isObj(err) && Object.keys(err).length > 0) {
        const message = trimTo(err.message, 500);
        const stack = trimTo(err.stack, 1000);
        if (message !== undefined) result.message = message;
        if (stack !== undefined) result.stack = stack;
      }
      results.push(result);
    }
    return { results, warnings };
  },
};
