/**
 * Mocha `json` reporter parser.
 *
 * Shape: `{ stats, tests|results: [...], passes: [...], failures: [...], pending: [...] }`
 * where every test carries `{ title, fullTitle, file, duration, err }`.
 * (Mocha's own reporter emits the all-tests array under `tests`; some tooling renames it
 * `results` — both are accepted.)
 *
 * Status is determined by membership: a test found in `failures` is 'fail', in `pending`
 * is 'skip', in `passes` is 'pass' (checked in that order). Membership is matched on
 * (file, fullTitle) as a multiset — each bucket entry is consumed by one test — so two
 * same-titled tests in different files (or twice in one file) do not share one verdict.
 * As a last resort the test's own `state` field is consulted; default 'pass'.
 *
 * Hook failures (`"before all" hook for "x"` …) appear in `failures` but not in `tests` —
 * the tests they guard never run. Every `failures` entry no test consumed is emitted as a
 * failure of its own, named after the hook without the variable ` for "<first test>"`
 * suffix (e.g. `"before all" hook`, suite = its describe chain), plus one warning.
 *
 * mochawesome JSON (`results[]` = suite trees with `tests`/`suites`/`beforeHooks`/`afterHooks`)
 * is recognised and flattened into the same entries — status from `state`, never-run tests
 * (`skipped`) → skip, failed hooks → failures — so both reporters give the same identities.
 *
 * Retries (`this.retries(n)`): a passing test with `currentRetry` > 0 failed that many times
 * first — it stays 'pass' with a "flaky: failed k of n attempts before passing on mocha retry"
 * message and one warning per file (same representation as Surefire reruns). A failing test
 * with `currentRetry` = k failed all k+1 attempts ("(failed all n attempts)"). Both set
 * `attempts` (['fail', …, final]); it stays undefined for a test that ran once.
 * durationMs is rounded to whole ms.
 *
 * suite = fullTitle with the title stripped (the describe chain), else `file`, else 'unknown'.
 * err.message trimmed to 2000 chars; err.stack trimmed to 1000 chars.
 *
 * Never throws: malformed input produces warnings.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import {
  flakyRetryMessage,
  flakyRetryWarning,
  isObj,
  msOf,
  parseJson,
  retryAttempts,
  trimTo,
} from './internal.js';

/** Match key: (file, fullTitle); empty when the entry has no fullTitle (unmatchable). */
function keyOf(entry: Record<string, unknown>): string {
  const fullTitle = typeof entry.fullTitle === 'string' ? entry.fullTitle.trim() : '';
  if (fullTitle === '') return '';
  const file = typeof entry.file === 'string' ? entry.file.trim() : '';
  return `${file}\u0000${fullTitle}`;
}

/** A status bucket (passes/failures/pending) as consumable queues per key. */
function bucket(arr: unknown[]): Map<string, Record<string, unknown>[]> {
  const map = new Map<string, Record<string, unknown>[]>();
  for (const entry of arr) {
    if (!isObj(entry)) continue;
    const key = keyOf(entry);
    if (key === '') continue;
    const queue = map.get(key);
    if (queue) queue.push(entry);
    else map.set(key, [entry]);
  }
  return map;
}

/** Remove and report one entry for `key` from a bucket. */
function consume(b: Map<string, Record<string, unknown>[]>, key: string): boolean {
  if (key === '') return false;
  const queue = b.get(key);
  if (queue === undefined || queue.length === 0) return false;
  queue.shift();
  return true;
}

/** mochawesome wraps mocha's suite tree: `results: [{ uuid, tests: [], suites: [] … }]`. */
function isMochawesome(doc: Record<string, unknown>): boolean {
  if (!Array.isArray(doc.results) || doc.results.length === 0) return false;
  const first = doc.results[0];
  return isObj(first) && Array.isArray(first.tests) && Array.isArray(first.suites);
}

const AWESOME_STATE: Record<string, TestStatus> = {
  passed: 'pass',
  failed: 'fail',
  pending: 'skip',
};

/**
 * Flatten a mochawesome suite tree into mocha-JSON-like entries with their status.
 * Tests carry no `file`: use the enclosing suite's `fullFile`, or — for root-level
 * tests — the report's only spec file when there is exactly one. A test with no
 * state (`skipped: true`) never ran because a hook failed → skip. Failed
 * before/after hooks are emitted as failing entries.
 */
function mochawesomeEntries(roots: unknown[]): Array<[Record<string, unknown>, TestStatus]> {
  const files = new Set<string>();
  const collectFiles = (suite: unknown): void => {
    if (!isObj(suite)) return;
    if (typeof suite.fullFile === 'string' && suite.fullFile !== '') files.add(suite.fullFile);
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) collectFiles(child);
  };
  for (const root of roots) collectFiles(root);
  const onlyFile = files.size === 1 ? [...files][0] : undefined;

  const out: Array<[Record<string, unknown>, TestStatus]> = [];
  const walk = (suite: unknown): void => {
    if (!isObj(suite)) return;
    const file =
      typeof suite.fullFile === 'string' && suite.fullFile !== '' ? suite.fullFile : onlyFile;
    const toEntry = (t: Record<string, unknown>): Record<string, unknown> => {
      const err = isObj(t.err) ? { message: t.err.message, stack: t.err.estack } : t.err;
      return { ...t, file, err };
    };
    const hooks = [
      ...(Array.isArray(suite.beforeHooks) ? suite.beforeHooks : []),
      ...(Array.isArray(suite.afterHooks) ? suite.afterHooks : []),
    ];
    for (const t of Array.isArray(suite.tests) ? suite.tests : []) {
      if (!isObj(t)) continue;
      const state = typeof t.state === 'string' ? AWESOME_STATE[t.state] : undefined;
      out.push([toEntry(t), state ?? 'skip']);
    }
    for (const h of hooks) {
      if (isObj(h) && h.state === 'failed') out.push([toEntry(h), 'fail']);
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) walk(child);
  };
  for (const root of roots) walk(root);
  return out;
}

/** mocha's `err` is `{}` for tests that did not fail. */
function hasErr(err: unknown): boolean {
  return (typeof err === 'string' && err !== '') || (isObj(err) && Object.keys(err).length > 0);
}

const HOOK_TITLE = /^"(?:before|after) (?:all|each)" hook\b/;

/** `"before all" hook for "queries"` → `"before all" hook` (the suffix names whichever test ran first). */
function hookName(title: string): string {
  return title.replace(/ (?:for|in) ".*"$/, '');
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

export const mochaParser: ReportParser = {
  name: 'mocha',

  sniff(content: string): boolean {
    const parsed = parseJson(content);
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

    const parsed = parseJson(content);
    if (!('doc' in parsed)) {
      return { results, warnings: [`mocha: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc)) {
      return { results, warnings: [`mocha: ${sourcePath}: not a JSON object`] };
    }

    const passes = Array.isArray(doc.passes) ? doc.passes : [];
    const failures = Array.isArray(doc.failures) ? doc.failures : [];
    const pending = Array.isArray(doc.pending) ? doc.pending : [];
    const testList = Array.isArray(doc.results)
      ? doc.results
      : Array.isArray(doc.tests)
        ? doc.tests
        : null;
    if (testList === null && !Array.isArray(doc.passes) && !Array.isArray(doc.failures)) {
      return { results, warnings: [`mocha: ${sourcePath}: missing "tests"/"results" array`] };
    }

    const entries: Record<string, unknown>[] = [];
    const statuses: Array<TestStatus | null> = [];
    const add = (entry: unknown, status: TestStatus | null): void => {
      if (!isObj(entry)) {
        warnings.push(`mocha: ${sourcePath}: skipping non-object test entry`);
        return;
      }
      entries.push(entry);
      statuses.push(status);
    };
    if (isMochawesome(doc)) {
      // mochawesome: results[] are suite TREES, not tests (QA PAR-1)
      for (const [entry, status] of mochawesomeEntries(doc.results as unknown[]))
        add(entry, status);
    } else if (testList === null) {
      // passes/failures-only shape (sniff accepts it): each bucket entry IS a
      // test, and its bucket is its status
      for (const entry of passes) add(entry, 'pass');
      for (const entry of failures) add(entry, 'fail');
      for (const entry of pending) add(entry, 'skip');
    } else {
      const failBucket = bucket(failures);
      const pendingBucket = bucket(pending);
      const passBucket = bucket(passes);
      // how many tests share each key — duplicates need a tie-breaker
      const shared = new Map<string, number>();
      for (const entry of testList) {
        if (isObj(entry)) shared.set(keyOf(entry), (shared.get(keyOf(entry)) ?? 0) + 1);
      }
      for (const entry of testList) {
        if (!isObj(entry)) {
          add(entry, null);
          continue;
        }
        const key = keyOf(entry);
        // Same-keyed duplicates: the one carrying an err takes the failure;
        // an err-less one prefers pass/pending. Unique keys keep fail-first.
        const errLess = (shared.get(key) ?? 0) > 1 && !hasErr(entry.err);
        const order: Array<[Map<string, Record<string, unknown>[]>, TestStatus]> = errLess
          ? [
              [passBucket, 'pass'],
              [pendingBucket, 'skip'],
              [failBucket, 'fail'],
            ]
          : [
              [failBucket, 'fail'],
              [pendingBucket, 'skip'],
              [passBucket, 'pass'],
            ];
        const hit = order.find(([b]) => consume(b, key));
        if (hit !== undefined) add(entry, hit[1]);
        else if (entry.state === 'failed') add(entry, 'fail');
        else if (entry.state === 'pending') add(entry, 'skip');
        else add(entry, null);
      }
      // failures no test consumed: hook failures (the tests they guard never ran)
      for (const queue of failBucket.values()) for (const leftover of queue) add(leftover, 'fail');
    }

    const hooks: string[] = [];
    const flaky: string[] = [];
    for (let n = 0; n < entries.length; n++) {
      const entry = entries[n]!;
      const fullTitle = typeof entry.fullTitle === 'string' ? entry.fullTitle.trim() : '';
      const title =
        typeof entry.title === 'string' && entry.title.trim() !== ''
          ? entry.title.trim()
          : fullTitle !== ''
            ? fullTitle
            : '(unnamed)';

      const finalStatus: TestStatus = statuses[n] ?? 'pass';

      const suite = deriveSuite(entry, title, fullTitle);
      const isHook = HOOK_TITLE.test(title);
      const name = isHook ? hookName(title) : title;
      if (isHook && finalStatus === 'fail') hooks.push(`${suite} ${name}`);
      const durationMs = msOf(entry.duration);

      const result: TestCaseResult = {
        testId: makeTestId(suite, name),
        suite,
        name,
        status: finalStatus,
        durationMs,
      };

      const err = entry.err;
      if (typeof err === 'string') {
        const message = trimTo(err, 2000);
        if (message !== undefined) result.message = message;
      } else if (isObj(err) && Object.keys(err).length > 0) {
        const message = trimTo(err.message, 2000);
        const stack = trimTo(err.stack, 1000);
        if (message !== undefined) result.message = message;
        if (stack !== undefined) result.stack = stack;
      }
      const retries =
        typeof entry.currentRetry === 'number' &&
        Number.isInteger(entry.currentRetry) &&
        entry.currentRetry > 0
          ? entry.currentRetry
          : 0;
      if (retries > 0 && finalStatus === 'pass') {
        result.message = flakyRetryMessage(retries, 'mocha retry', result.message, 2000);
        result.attempts = retryAttempts(retries, 'pass');
        flaky.push(`${suite} ${name}`);
      } else if (retries > 0 && finalStatus === 'fail' && !isHook) {
        // failed on the first try and on every one of its `currentRetry` retries
        const note = `(failed all ${retries + 1} attempts)`;
        result.message = trimTo(
          result.message !== undefined ? `${result.message}\n${note}` : note,
          2000,
        );
        result.attempts = retryAttempts(retries, 'fail');
      }
      results.push(result);
    }
    if (flaky.length > 0)
      warnings.push(flakyRetryWarning('mocha', sourcePath, 'mocha retry', flaky));
    if (hooks.length > 0) {
      warnings.push(
        `mocha: ${sourcePath}: ${hooks.length} hook failure(s) — the tests they guard did not run; recorded as failures: ${hooks.join(', ')}`,
      );
    }
    return { results, warnings };
  },
};
