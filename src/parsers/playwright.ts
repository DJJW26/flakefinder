/**
 * Playwright JSON reporter parser (`--reporter=json`, or `merge-reports --reporter json`).
 *
 * Shape: `{ config, suites: [fileSuite], errors: [], stats }` where a file suite is
 * `{ title: <file relative to testDir>, file, specs: [spec], suites?: [describeSuite] }`,
 * a spec is `{ title, ok, tests: [test] }` with one test per project (and per
 * `--repeat-each` repetition), a test is `{ projectName, expectedStatus, status, annotations,
 * results: [result] }` and a result (one per attempt, `retry` 0, 1, …) is
 * `{ status: 'passed'|'failed'|'timedOut'|'skipped'|'interrupted', duration (ms), error?,
 * errors[] }`.
 *
 * Identity — the same as Playwright's JUnit reporter, so switching reporters keeps history:
 * - suite = the file suite title (JUnit `classname`)
 * - name  = describe titles + spec title joined with ' › ' (JUnit `name`)
 * The project is NOT part of the id (JUnit's hostname only). Unlike JUnit, whose per-project
 * rows share that id and mask each other (last one wins), the projects of one spec are folded
 * into ONE row here: the most severe project wins (error/fail, then a pass that needed a
 * retry, then pass, then skip), and its message is prefixed with `[<project>]` when the spec
 * ran in several projects.
 *
 * Attempts: every result is an attempt. A result's status maps to 'skip' (skipped), 'pass'
 * (status equals `expectedStatus` — so a passing `test.fail()` is a pass) or 'fail'
 * (otherwise, including timedOut). 'interrupted' results are ignored, as Playwright's own
 * outcome() does; a test with no remaining result did not run → 'skip'. The final attempt is
 * the result's status; `attempts` lists them all (oldest first) when there was more than one.
 * A test that passed on a retry stays 'pass' with the usual "flaky: failed k of n attempts
 * before passing on Playwright retry" message and one warning per file; one that failed every
 * attempt notes "(failed all n attempts)". `--repeat-each` repetitions of a project are
 * appended to its attempts; a failure in any of them makes the row 'fail' (listed last).
 *
 * message = the failing attempt's `error.message` (ANSI stripped, 2000 chars), stack =
 * `error.stack` (1000 chars); a skip carries its `skip` annotation's description.
 * durationMs = the final attempt's duration, rounded.
 *
 * Top-level `errors` (config errors, a spec file that failed to load, global setup) make the
 * run fail without any test failing: they become one synthetic error row (suite 'playwright',
 * name '(global)') plus a warning, so the run is not recorded as green.
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
  stripAnsi,
  trimTo,
} from './internal.js';

const MESSAGE_MAX_CHARS = 2000;
const STACK_MAX_CHARS = 1000;
const TITLE_SEPARATOR = ' › ';

interface Attempt {
  status: TestStatus;
  durationMs: number | null;
  error?: Record<string, unknown>;
}

/** One project's outcome for a spec. */
interface ProjectRow {
  project: string;
  status: TestStatus;
  attempts: Attempt[];
  skipReason?: string;
}

function attemptStatus(status: unknown, expected: unknown): TestStatus | null {
  switch (status) {
    case 'skipped':
      return 'skip';
    case 'passed':
    case 'failed':
    case 'timedOut':
      return status === (typeof expected === 'string' ? expected : 'passed') ? 'pass' : 'fail';
    default:
      return null; // 'interrupted' / missing: the run was stopped, not a verdict
  }
}

/** The result's first error object (`error`, else `errors[0]`). */
function errorOf(result: Record<string, unknown>): Record<string, unknown> | undefined {
  if (isObj(result.error)) return result.error;
  if (Array.isArray(result.errors)) return result.errors.find(isObj);
  return undefined;
}

function textOf(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? trimTo(stripAnsi(value), max) : undefined;
}

function isFailFamily(status: TestStatus): boolean {
  return status === 'fail' || status === 'error';
}

/** Lower = more severe; picks which project a folded row reports. */
function severity(row: ProjectRow): number {
  if (isFailFamily(row.status)) return 0;
  if (row.status === 'pass' && row.attempts.some((a) => isFailFamily(a.status))) return 1;
  if (row.status === 'pass') return 2;
  return 3;
}

/** Fold one project's tests (several with --repeat-each) into its attempts and status. */
function projectRow(project: string, tests: Record<string, unknown>[]): ProjectRow {
  const attempts: Attempt[] = [];
  let failedFinal = false;
  let lastFinal: TestStatus = 'skip';
  let skipReason: string | undefined;
  for (const test of tests) {
    const own: Attempt[] = [];
    for (const result of Array.isArray(test.results) ? test.results : []) {
      if (!isObj(result)) continue;
      const status = attemptStatus(result.status, test.expectedStatus);
      if (status === null) continue;
      const attempt: Attempt = { status, durationMs: msOf(result.duration) };
      const error = errorOf(result);
      if (error !== undefined) attempt.error = error;
      own.push(attempt);
    }
    const final = own[own.length - 1]?.status ?? 'skip';
    if (isFailFamily(final)) failedFinal = true;
    lastFinal = final;
    if (final === 'skip' && skipReason === undefined && Array.isArray(test.annotations)) {
      const note = test.annotations.find((a) => isObj(a) && a.type === 'skip');
      if (isObj(note)) skipReason = textOf(note.description, MESSAGE_MAX_CHARS);
    }
    attempts.push(...own);
  }
  const status: TestStatus = failedFinal ? 'fail' : lastFinal;
  if (attempts.length > 0 && attempts[attempts.length - 1]!.status !== status) {
    // a --repeat-each repetition failed but a later one did not: the row is a
    // failure, so its failing attempts go last (the last attempt = status)
    const fails = attempts.filter((a) => a.status === status);
    const rest = attempts.filter((a) => a.status !== status);
    attempts.splice(0, attempts.length, ...rest, ...fails);
  }
  const row: ProjectRow = { project, status, attempts };
  if (skipReason !== undefined) row.skipReason = skipReason;
  return row;
}

interface Ctx {
  sourcePath: string;
  results: TestCaseResult[];
  warnings: string[];
  flaky: string[];
}

function mapSpec(spec: Record<string, unknown>, file: string, titles: string[], ctx: Ctx): void {
  const title = typeof spec.title === 'string' ? spec.title : '';
  const name = [...titles, title].join(TITLE_SEPARATOR);
  if (name.trim() === '') {
    ctx.warnings.push(`playwright: ${ctx.sourcePath}: skipping a spec without a title in ${file}`);
    return;
  }
  const byProject = new Map<string, Record<string, unknown>[]>();
  for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
    if (!isObj(test)) continue;
    const project = typeof test.projectName === 'string' ? test.projectName : '';
    const list = byProject.get(project);
    if (list) list.push(test);
    else byProject.set(project, [test]);
  }
  if (byProject.size === 0) return; // a spec with no tests did not run anywhere
  const rows = [...byProject].map(([project, tests]) => projectRow(project, tests));
  // most severe project wins; ties keep report order
  const row = rows.reduce((best, r) => (severity(r) < severity(best) ? r : best));

  const result: TestCaseResult = {
    testId: makeTestId(file, name),
    suite: file,
    name,
    status: row.status,
    durationMs: row.attempts[row.attempts.length - 1]?.durationMs ?? null,
  };
  const failures = row.attempts.filter((a) => isFailFamily(a.status));
  const firstError = failures.find((a) => a.error !== undefined)?.error;
  let message: string | undefined;
  if (row.status === 'pass' && failures.length > 0) {
    message = flakyRetryMessage(
      failures.length,
      'Playwright retry',
      textOf(firstError?.message, MESSAGE_MAX_CHARS),
      MESSAGE_MAX_CHARS,
    );
    ctx.flaky.push(`${file} > ${name}`);
  } else if (isFailFamily(row.status)) {
    // the failure the row reports: the last failing attempt's error
    const error = [...failures].reverse().find((a) => a.error !== undefined)?.error;
    message = textOf(error?.message, MESSAGE_MAX_CHARS) ?? textOf(error?.value, MESSAGE_MAX_CHARS);
    if (row.attempts.length > 1 && failures.length === row.attempts.length) {
      const note = `(failed all ${row.attempts.length} attempts)`;
      message = trimTo(message !== undefined ? `${message}\n${note}` : note, MESSAGE_MAX_CHARS);
    }
    const stack = textOf(error?.stack, STACK_MAX_CHARS);
    if (stack !== undefined) result.stack = stack;
  } else if (row.status === 'skip') {
    message = row.skipReason;
  }
  if (message !== undefined && rows.length > 1 && row.status !== 'skip' && row.project !== '') {
    message = trimTo(`[${row.project}] ${message}`, MESSAGE_MAX_CHARS);
  }
  if (message !== undefined) result.message = message;
  if (row.attempts.length > 1) result.attempts = row.attempts.map((a) => a.status);
  ctx.results.push(result);
}

/** Walk a describe suite: its specs, then its child suites, accumulating describe titles. */
function walk(suite: Record<string, unknown>, file: string, titles: string[], ctx: Ctx): void {
  for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
    if (isObj(spec)) mapSpec(spec, file, titles, ctx);
  }
  for (const child of Array.isArray(suite.suites) ? suite.suites : []) {
    if (!isObj(child)) continue;
    const title = typeof child.title === 'string' ? child.title : '';
    walk(child, file, [...titles, title], ctx);
  }
}

export const playwrightParser: ReportParser = {
  name: 'playwright',

  sniff(content: string): boolean {
    const parsed = parseJson(content);
    if (!('doc' in parsed)) return false;
    const doc = parsed.doc;
    return isObj(doc) && Array.isArray(doc.suites) && isObj(doc.config);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const ctx: Ctx = { sourcePath, results: [], warnings: [], flaky: [] };
    const parsed = parseJson(content);
    if (!('doc' in parsed)) {
      return {
        results: [],
        warnings: [`playwright: ${sourcePath}: invalid JSON: ${parsed.error}`],
      };
    }
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.suites)) {
      return { results: [], warnings: [`playwright: ${sourcePath}: missing suites[] array`] };
    }
    for (const fileSuite of doc.suites) {
      if (!isObj(fileSuite)) continue;
      const file =
        typeof fileSuite.title === 'string' && fileSuite.title.trim() !== ''
          ? fileSuite.title
          : typeof fileSuite.file === 'string' && fileSuite.file.trim() !== ''
            ? fileSuite.file
            : '(unknown file)';
      walk(fileSuite, file, [], ctx);
    }

    const globalErrors = (Array.isArray(doc.errors) ? doc.errors : []).filter(isObj);
    if (globalErrors.length > 0) {
      const first = globalErrors[0]!;
      const firstMessage =
        textOf(first.message, MESSAGE_MAX_CHARS) ??
        textOf(first.value, MESSAGE_MAX_CHARS) ??
        'error outside any test';
      const more = globalErrors.length > 1 ? `\n(+${globalErrors.length - 1} more)` : '';
      const result: TestCaseResult = {
        testId: makeTestId('playwright', '(global)'),
        suite: 'playwright',
        name: '(global)',
        status: 'error',
        durationMs: null,
        message: trimTo(`${firstMessage}${more}`, MESSAGE_MAX_CHARS) ?? firstMessage,
      };
      const stack = textOf(first.stack, STACK_MAX_CHARS);
      if (stack !== undefined) result.stack = stack;
      ctx.results.push(result);
      ctx.warnings.push(
        `playwright: ${sourcePath}: ${globalErrors.length} error(s) outside any test (config, global setup or a spec file that failed to load) — recorded as playwright :: (global): ${firstMessage.split('\n')[0]}`,
      );
    }
    if (ctx.flaky.length > 0) {
      ctx.warnings.push(flakyRetryWarning('playwright', sourcePath, 'Playwright retry', ctx.flaky));
    }
    return { results: ctx.results, warnings: ctx.warnings };
  },
};
