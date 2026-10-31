/**
 * pytest-json-report parser (`pytest --json-report`, plugin pytest-json-report).
 *
 * Shape: `{ created, duration, exitcode, root, summary, collectors: [ { nodeid, outcome,
 * longrepr? } ], tests: [ { nodeid, outcome, setup?, call?, teardown? } ] }`, where each
 * stage is `{ duration (s), outcome, crash?: { message }, longrepr? }`.
 *
 * Identity — the same as pytest's own JUnit XML (`--junitxml`, default settings), so
 * switching reports keeps history: the nodeid is split like pytest's mangle_test_address —
 * `tests/test_x.py::TestC::test_m[p]` → suite (classname) `tests.test_x.TestC`, name
 * `test_m[p]`. A module-level test gets suite `tests.test_x`.
 *
 * Status: passed / xpassed → 'pass'; failed → 'fail'; error (setup/teardown failure) →
 * 'error'; skipped / xfailed → 'skip' (pytest's JUnit writes both as <skipped>).
 * `rerun` (pytest-rerunfailures: the test failed, was re-run, and its last outcome was a
 * pass, which does not overwrite the outcome) → 'pass' with a flaky message, a warning and
 * attempts ['fail', 'pass'] — the report does not say how many reruns there were.
 *
 * durationMs = setup + call + teardown durations (pytest's JUnit "total"), rounded.
 * message = the first failing stage's `crash.message`, else the first line of its
 * `longrepr`; stack = that `longrepr` (1000 chars). A skip carries its reason.
 *
 * Collection errors (`collectors[]` with outcome 'failed': an import error, a syntax error)
 * become an error row named after the module, as pytest's JUnit names them (suite
 * 'pytest', name `tests.test_x`), so a module that never ran is not recorded as green.
 *
 * Never throws: malformed input produces warnings.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { flakyRetryWarning, isObj, parseJson, stripAnsi, trimTo } from './internal.js';

const MESSAGE_MAX_CHARS = 2000;
const STACK_MAX_CHARS = 1000;
const STAGES = ['setup', 'call', 'teardown'] as const;

const OUTCOMES: Record<string, TestStatus> = {
  passed: 'pass',
  xpassed: 'pass',
  failed: 'fail',
  error: 'error',
  skipped: 'skip',
  xfailed: 'skip',
  rerun: 'pass',
};

/** pytest's mangle_test_address: nodeid → [classname, name] as its JUnit XML writes them. */
export function junitAddress(nodeid: string): { classname: string; name: string } {
  const bracket = nodeid.indexOf('[');
  const path = bracket === -1 ? nodeid : nodeid.slice(0, bracket);
  const params = bracket === -1 ? '' : nodeid.slice(bracket);
  const names = path.split('::');
  names[0] = names[0]!.replace(/\//g, '.').replace(/\.py$/, '');
  names[names.length - 1] += params;
  return { classname: names.slice(0, -1).join('.'), name: names[names.length - 1]! };
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? trimTo(stripAnsi(value), max) : undefined;
}

/** First line of a longrepr string. */
function firstLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.split(/\r?\n/).find((l) => l.trim() !== '');
  return text(line, MESSAGE_MAX_CHARS);
}

/** `('/x/test_a.py', 3, 'Skipped: no db')` → `no db`. */
function skipReason(longrepr: unknown): string | undefined {
  if (typeof longrepr !== 'string') return undefined;
  const m = /,\s*['"](?:Skipped: )?(.*)['"]\)\s*$/s.exec(longrepr);
  return text(m ? m[1] : longrepr, MESSAGE_MAX_CHARS);
}

export const pytestJsonParser: ReportParser = {
  name: 'pytest-json',

  sniff(content: string): boolean {
    const parsed = parseJson(content);
    if (!('doc' in parsed)) return false;
    const doc = parsed.doc;
    return (
      isObj(doc) &&
      isObj(doc.summary) &&
      typeof doc.exitcode === 'number' &&
      (Array.isArray(doc.tests) || Array.isArray(doc.collectors))
    );
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const parsed = parseJson(content);
    if (!('doc' in parsed)) {
      return { results, warnings: [`pytest-json: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc)) {
      return { results, warnings: [`pytest-json: ${sourcePath}: not a JSON object`] };
    }

    const flaky: string[] = [];
    for (const test of Array.isArray(doc.tests) ? doc.tests : []) {
      if (!isObj(test)) continue;
      const nodeid = typeof test.nodeid === 'string' ? test.nodeid.trim() : '';
      if (nodeid === '') {
        warnings.push(`pytest-json: ${sourcePath}: skipping a test without a nodeid`);
        continue;
      }
      const outcome = typeof test.outcome === 'string' ? test.outcome : '';
      const status = OUTCOMES[outcome];
      if (status === undefined) {
        warnings.push(
          `pytest-json: ${sourcePath}: unknown outcome ${JSON.stringify(test.outcome)} for ${nodeid}`,
        );
        continue;
      }
      const { classname, name } = junitAddress(nodeid);
      // pytest's JUnit puts a classname-less test under the testsuite name
      const suite = classname !== '' ? classname : 'pytest';

      let seconds = 0;
      let timed = false;
      for (const stage of STAGES) {
        const s = test[stage];
        if (isObj(s) && typeof s.duration === 'number' && Number.isFinite(s.duration)) {
          seconds += s.duration;
          timed = true;
        }
      }
      const result: TestCaseResult = {
        testId: makeTestId(suite, name),
        suite,
        name,
        status,
        durationMs: timed && seconds >= 0 ? Math.round(seconds * 1000) : null,
      };

      if (status === 'fail' || status === 'error') {
        const failed = STAGES.map((st) => test[st]).find(
          (s): s is Record<string, unknown> => isObj(s) && s.outcome === 'failed',
        );
        const crash = isObj(failed?.crash) ? failed.crash : undefined;
        const message = text(crash?.message, MESSAGE_MAX_CHARS) ?? firstLine(failed?.longrepr);
        const stack = text(failed?.longrepr, STACK_MAX_CHARS);
        if (message !== undefined) result.message = message;
        if (stack !== undefined) result.stack = stack;
      } else if (status === 'skip') {
        const skipped = STAGES.map((st) => test[st]).find(
          (s): s is Record<string, unknown> => isObj(s) && s.outcome === 'skipped',
        );
        const reason = skipReason(skipped?.longrepr);
        if (reason !== undefined) result.message = reason;
      } else if (outcome === 'rerun') {
        result.message = 'flaky: failed, then passed on pytest-rerunfailures rerun';
        result.attempts = ['fail', 'pass'];
        flaky.push(nodeid);
      }
      results.push(result);
    }

    for (const collector of Array.isArray(doc.collectors) ? doc.collectors : []) {
      if (!isObj(collector) || collector.outcome !== 'failed') continue;
      const nodeid = typeof collector.nodeid === 'string' ? collector.nodeid.trim() : '';
      const address = nodeid !== '' ? junitAddress(nodeid) : { classname: '', name: '(session)' };
      const suite = address.classname !== '' ? address.classname : 'pytest';
      const result: TestCaseResult = {
        testId: makeTestId(suite, address.name),
        suite,
        name: address.name,
        status: 'error',
        durationMs: null,
        message: firstLine(collector.longrepr) ?? 'collection failure',
      };
      const stack = text(collector.longrepr, STACK_MAX_CHARS);
      if (stack !== undefined) result.stack = stack;
      results.push(result);
      warnings.push(
        `pytest-json: ${sourcePath}: ${nodeid || 'session'} failed to collect — recorded as an error`,
      );
    }

    if (flaky.length > 0) {
      warnings.push(
        flakyRetryWarning('pytest-json', sourcePath, 'pytest-rerunfailures rerun', flaky),
      );
    }
    return { results, warnings };
  },
};
