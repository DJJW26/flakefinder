/**
 * `go test -json` NDJSON parser.
 *
 * Each line is an event: `{ Action: 'run'|'pause'|'pass'|'fail'|'skip'|'output'|…, Package,
 * Test?, Elapsed?, Time, Output? }`. (Field casing varies across Go versions: `Elapsed`/
 * `elapsed` and `Output`/`output` are both accepted.)
 *
 * Repeated runs (`-count=N`, or several streams concatenated): a 'run' event (or a second
 * terminal action) for a test that already finished starts a new run, and each run keeps its
 * own status, elapsed and output. One result per (Package, Test) is emitted, aggregated over
 * its runs, because the engine collapses same-testId rows within a report (last one wins):
 * - any run failed → 'fail', from the FIRST failing run (its output and duration). When other
 *   runs passed, the message starts with "flaky: failed k of n runs in this report" and one
 *   warning per file lists those tests. A failure is never erased by a later pass.
 * - otherwise the LAST run decides ('pass', or 'skip').
 * durationMs = round(elapsed * 1000) from the reported run's terminal event when present,
 * else null (older Go versions only put elapsed on package-level events).
 *
 * `attempts` (when a test ran more than once) lists every run's status; because the reported
 * status is 'fail' if any run failed, the failing runs are listed last when the final run
 * passed (see runAttempts), so the last attempt always equals the status.
 *
 * Messages are built from the reported run's 'output' events: ANSI SGR codes, blank lines and
 * go's framing lines (`=== RUN`, `=== PAUSE`/`CONT`/`NAME`, `--- PASS:`/`FAIL:`/`SKIP:`)
 * are dropped, and the LAST 2000 characters of the joined text are kept (failure details
 * come at the end, after t.Log noise). A passing test gets no message.
 *
 * Subtests: `TestA/sub` is emitted with its full name. A parent (`TestA`) that has subtests is
 * NOT emitted — its status only mirrors its children and would double-count their failures —
 * unless the parent itself failed while none of its descendants did (t.Error after t.Run, a
 * panic in the parent body); that failure exists nowhere else, so the parent row is kept.
 *
 * Benchmarks: test2json emits no terminal `pass` for a passing benchmark, only its result
 * line. A Benchmark* test left without a terminal action is a pass when it printed a
 * result line (`… ns/op`) or its package passed; otherwise it is a crash like any test.
 *
 * Package-level events (no Test) produce no rows, except that a package which FAILED without
 * any test result (build error, init panic) becomes one synthetic `(package)` error.
 *
 * Build failures: go 1.24+ emits `build-output`/`build-fail` events keyed by `ImportPath`
 * (no `Package`); each build-fail becomes one warning with the compiler output, and that
 * output is folded into the `(package)` error of the package whose `fail` event names it in
 * `FailedBuild`. Older Go prints build errors as plain text on stderr; when stderr is merged
 * into the file those non-JSON lines become one summary warning (with an excerpt).
 *
 * Lines that look like JSON (`{…`) but fail JSON.parse produce warnings — at most 5
 * individually, then a single '…and N more' summary.
 *
 * Sniff: the first 50 non-empty lines are scanned for an event object carrying `Action` plus
 * `Package` or `ImportPath`, so leading stderr text or build events do not hide the format.
 *
 * Never throws.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, isObj, stripAnsi, stripBom } from './internal.js';

const MAX_MALFORMED_DETAILS = 5;
/** Non-empty lines sniff inspects before giving up. */
const SNIFF_MAX_LINES = 50;
/** Lines of compiler/stderr output quoted in a warning. */
const WARNING_EXCERPT_LINES = 5;
const MESSAGE_MAX_CHARS = 2000;

/** How many flaky test names one -count warning lists before summarising. */
const MAX_FLAKY_NAMES = 10;

/** One execution of a test (a `-count=N` stream holds N of these per test). */
interface RunState {
  status?: TestStatus;
  durationMs: number | null;
  outputs: string[];
}

interface TestAccumulator {
  pkg: string;
  test: string;
  /** Chronological runs; the last one is the run currently receiving events. */
  runs: RunState[];
}

/** First few non-blank lines joined with ' | ' — compact enough for a one-line warning. */
function excerptOf(lines: string[]): string {
  const kept = lines.map((l) => stripAnsi(l).trim()).filter((l) => l !== '');
  const head = kept.slice(0, WARNING_EXCERPT_LINES).join(' | ');
  return kept.length > WARNING_EXCERPT_LINES ? `${head} | …` : head;
}

function isBenchmark(test: string): boolean {
  return /^Benchmark/.test(test);
}

/** A benchmark result line: `BenchmarkX-8   \t 1000\t  21.0 ns/op …`. */
function hasBenchResult(outputs: string[]): boolean {
  // the result line may be split across output events — test the joined text
  return /^Benchmark\S*\s+\d+\s+[\d.]+ \S+\/op\b/m.test(outputs.join(''));
}

/**
 * `attempts` for a test run several times (`-count=N`): every run's status in
 * order. The runs are independent repeats, not retries, and the reported
 * status is 'fail' when ANY run failed — so when the last run did not fail,
 * the failing runs are moved to the end (otherwise in order) to keep the
 * contract that the last attempt equals the result's status.
 */
function runAttempts(runs: RunState[], status: TestStatus): TestStatus[] {
  const statuses = runs.map((r) => r.status!);
  if (statuses[statuses.length - 1] === status) return statuses;
  return [...statuses.filter((s) => s !== status), ...statuses.filter((s) => s === status)];
}

function isFailFamily(status: TestStatus): boolean {
  return status === 'fail' || status === 'error';
}

function newRun(): RunState {
  return { durationMs: null, outputs: [] };
}

/** Elapsed seconds → ms; accepts both `Elapsed` and `elapsed` spellings. */
function elapsedToMs(ev: Record<string, unknown>): number | null {
  const raw = ev.elapsed !== undefined ? ev.elapsed : ev.Elapsed;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw * 1000);
}

/**
 * go test's own framing lines (`=== RUN   TestX`, `=== PAUSE`, `=== CONT`,
 * `=== NAME`, `--- PASS: TestX (0.00s)`, `--- FAIL: …`, `--- SKIP: …`,
 * `--- BENCH: …`) — they restate the status and name, never the reason.
 */
const FRAMING_LINE = /^\s*(?:=== (?:RUN|PAUSE|CONT|NAME)\b|--- (?:PASS|FAIL|SKIP|BENCH): )/;

/** Last meaningful chunk of a test's output events, trimmed to MESSAGE_MAX_CHARS. */
function messageFromOutputs(outputs: string[]): string | undefined {
  if (outputs.length === 0) return undefined;
  // Blank and framing lines are dropped but per-line indentation is kept — a
  // line like "    file.go:12: detail" carries its t.Log prefix meaningfully.
  const text = stripAnsi(outputs.join(''))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !FRAMING_LINE.test(line))
    .join('\n');
  if (text === '') return undefined;
  return text.length > MESSAGE_MAX_CHARS ? text.slice(-MESSAGE_MAX_CHARS) : text;
}

export const goTestParser: ReportParser = {
  name: 'go',

  sniff(content: string): boolean {
    let seen = 0;
    for (const raw of stripBom(content).split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '') continue;
      if (++seen > SNIFF_MAX_LINES) return false;
      if (!line.startsWith('{')) continue; // stderr text merged ahead of the stream
      try {
        const ev: unknown = JSON.parse(line);
        if (isObj(ev) && 'Action' in ev && ('Package' in ev || 'ImportPath' in ev)) return true;
      } catch {
        // keep scanning
      }
    }
    return false;
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const tests = new Map<string, TestAccumulator>();
    const failedPackages = new Map<
      string,
      { failed: boolean; outputs: string[]; failedBuild?: string }
    >();
    /** go 1.24+ build events, keyed by ImportPath. */
    const builds = new Map<string, { failed: boolean; outputs: string[] }>();
    const strayText: string[] = [];
    const passedPackages = new Set<string>();
    let malformed = 0;

    const lines = stripBom(content).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;

      if (!line.trimStart().startsWith('{')) {
        // plain text (compiler errors, `# pkg` headers, panics) — stderr merged into the file
        strayText.push(line.trim());
        continue;
      }
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch (err) {
        malformed++;
        if (malformed <= MAX_MALFORMED_DETAILS) {
          warnings.push(`go: ${sourcePath}: line ${i + 1}: invalid JSON (${errorMessage(err)})`);
        }
        continue;
      }
      if (!isObj(ev)) continue;

      if (ev.Action === 'build-output' || ev.Action === 'build-fail') {
        const importPath = typeof ev.ImportPath === 'string' ? ev.ImportPath : '(unknown)';
        const build = builds.get(importPath) ?? { failed: false, outputs: [] };
        if (ev.Action === 'build-fail') build.failed = true;
        else if (typeof ev.Output === 'string') build.outputs.push(ev.Output);
        builds.set(importPath, build);
        continue;
      }

      const pkg = typeof ev.Package === 'string' ? ev.Package : '';
      const test = typeof ev.Test === 'string' && ev.Test.trim() !== '' ? ev.Test : null;
      if (pkg === '') continue;

      const action = ev.Action;
      const out = ev.Output !== undefined ? ev.Output : ev.output;

      // Package-level events (no Test): track build/run failures so a package
      // that crashed before running any test still surfaces. Outputs are kept
      // for every package (they precede the fail event in real streams).
      if (test === null) {
        if (action === 'pass') passedPackages.add(pkg);
        if (action === 'fail') {
          const entry = failedPackages.get(pkg) ?? { failed: false, outputs: [] };
          entry.failed = true;
          if (typeof ev.FailedBuild === 'string') entry.failedBuild = ev.FailedBuild;
          failedPackages.set(pkg, entry);
        } else if (action === 'output' && typeof out === 'string') {
          const entry = failedPackages.get(pkg) ?? { failed: false, outputs: [] };
          entry.outputs.push(out);
          failedPackages.set(pkg, entry);
        }
        continue;
      }

      const key = `${pkg}\u0000${test}`;
      let acc = tests.get(key);
      if (acc === undefined) {
        // Only start a test on 'run' or a terminal action: output/pause events
        // for an unknown test (stream missing its head) must not invent a
        // phantom "crashed" test.
        if (action !== 'run' && action !== 'pass' && action !== 'fail' && action !== 'skip') {
          continue;
        }
        acc = { pkg, test, runs: [newRun()] };
        tests.set(key, acc);
      } else if (
        (action === 'run' || action === 'pass' || action === 'fail' || action === 'skip') &&
        acc.runs[acc.runs.length - 1]!.status !== undefined
      ) {
        // the current run already finished: this is a repeated run (-count=N)
        acc.runs.push(newRun());
      }
      const run = acc.runs[acc.runs.length - 1]!;

      if (action === 'pass' || action === 'fail' || action === 'skip') {
        run.status = action;
        run.durationMs = elapsedToMs(ev);
      } else if (action === 'output') {
        if (typeof out === 'string') run.outputs.push(out);
      }
      // 'pause' | 'cont' | 'bench' | … — no state change.
    }

    if (malformed > MAX_MALFORMED_DETAILS) {
      warnings.push(`…and ${malformed - MAX_MALFORMED_DETAILS} more malformed lines`);
    }

    // One aggregated row per test, in first-seen order.
    const rows: Array<{
      acc: TestAccumulator;
      result: TestCaseResult;
      dangling: boolean;
      flaky: boolean;
    }> = [];
    for (const acc of tests.values()) {
      const last = acc.runs[acc.runs.length - 1]!;
      if (last.status === undefined && isBenchmark(acc.test)) {
        // test2json never emits a terminal `pass` for a benchmark — only its
        // result line. A result line (or a package that passed) means it ran.
        // A parent benchmark's result lines belong to its sub-benchmarks.
        const prefix = `${acc.test}/`;
        const ran =
          hasBenchResult(last.outputs) ||
          passedPackages.has(acc.pkg) ||
          [...tests.values()].some(
            (o) =>
              o.pkg === acc.pkg &&
              o.test.startsWith(prefix) &&
              hasBenchResult(o.runs[o.runs.length - 1]!.outputs),
          );
        if (ran) last.status = 'pass';
      }
      if (last.status === undefined) {
        // Test started (run event) but never reported pass/fail/skip — the test
        // binary crashed mid-run (panic, OOM, killed). Synthesize an error so
        // the crash is visible in verdicts instead of silently vanishing.
        const result: TestCaseResult = {
          testId: makeTestId(acc.pkg, acc.test),
          suite: acc.pkg,
          name: acc.test,
          status: 'error',
          durationMs: null,
          message: 'test started but never reported a result (test binary crashed mid-run?)',
        };
        // Real crash output (panic trace etc.) is the evidence — keep it below
        // the synthetic explanation.
        const output = messageFromOutputs(last.outputs);
        if (output !== undefined) result.message = `${result.message}\n${output}`;
        if (acc.runs.length > 1) {
          // earlier -count runs finished; the crashed one is the last attempt
          result.attempts = [...acc.runs.slice(0, -1).map((r) => r.status!), 'error'];
        }
        rows.push({ acc, result, dangling: true, flaky: false });
        continue;
      }
      const failed = acc.runs.filter((r) => r.status === 'fail');
      const reported = failed[0] ?? last;
      const result: TestCaseResult = {
        testId: makeTestId(acc.pkg, acc.test),
        suite: acc.pkg,
        name: acc.test,
        status: reported.status!,
        durationMs: reported.durationMs,
      };
      // a pass carries no message: its output is t.Log noise, not a reason
      let message = reported.status === 'pass' ? undefined : messageFromOutputs(reported.outputs);
      const isFlaky = failed.length > 0 && failed.length < acc.runs.length;
      if (isFlaky) {
        const note = `flaky: failed ${failed.length} of ${acc.runs.length} runs in this report`;
        message = message !== undefined ? `${note}\n${message}` : note;
      }
      if (message !== undefined) result.message = message;
      if (acc.runs.length > 1) result.attempts = runAttempts(acc.runs, result.status);
      rows.push({ acc, result, dangling: false, flaky: isFlaky });
    }

    // Subtest parents (TestA for TestA/sub): their status just mirrors their
    // children, so emitting both double-counts a failure. Drop a parent unless
    // it failed with NO failing descendant (its own t.Error after t.Run, a
    // panic in the parent body…) — that failure exists nowhere else.
    const hasChildren = new Set<string>();
    const hasFailingChild = new Set<string>();
    for (const { acc, result } of rows) {
      const parts = acc.test.split('/');
      for (let depth = 1; depth < parts.length; depth++) {
        const ancestor = `${acc.pkg}\u0000${parts.slice(0, depth).join('/')}`;
        hasChildren.add(ancestor);
        if (isFailFamily(result.status)) hasFailingChild.add(ancestor);
      }
    }
    let dangling = 0;
    const flaky: string[] = [];
    for (const row of rows) {
      const key = `${row.acc.pkg}\u0000${row.acc.test}`;
      if (hasChildren.has(key) && (hasFailingChild.has(key) || !isFailFamily(row.result.status))) {
        continue;
      }
      if (row.dangling) dangling++;
      if (row.flaky) flaky.push(`${row.acc.pkg} ${row.acc.test}`);
      results.push(row.result);
    }
    if (flaky.length > 0) {
      const shown = flaky.slice(0, MAX_FLAKY_NAMES).join(', ');
      const more =
        flaky.length > MAX_FLAKY_NAMES ? ` …and ${flaky.length - MAX_FLAKY_NAMES} more` : '';
      warnings.push(
        `go: ${sourcePath}: ${flaky.length} test(s) failed in some but not all repeated runs (-count) — reported as fail: ${shown}${more}`,
      );
    }
    if (dangling > 0) {
      warnings.push(
        `go: ${sourcePath}: ${dangling} test(s) started but never reported a result — synthesized as error (package crash?)`,
      );
    }

    // go 1.24+ build failures: one warning each, quoting the compiler output.
    for (const [importPath, build] of builds) {
      if (!build.failed) continue;
      const excerpt = excerptOf(build.outputs.join('').split(/\r?\n/));
      warnings.push(
        `go: ${sourcePath}: build failed for ${importPath}${excerpt ? `: ${excerpt}` : ''}`,
      );
    }

    const pkgsWithTests = new Set([...tests.values()].map((a) => a.pkg));
    for (const [pkg, entry] of failedPackages) {
      if (!entry.failed || pkgsWithTests.has(pkg)) continue; // per-test results already reflect it
      const build = entry.failedBuild !== undefined ? builds.get(entry.failedBuild) : undefined;
      const output = messageFromOutputs([...(build?.outputs ?? []), ...entry.outputs]);
      const reason =
        build !== undefined
          ? 'package failed to build'
          : 'package failed before any test completed (build or init crash?)';
      results.push({
        testId: makeTestId(pkg, '(package)'),
        suite: pkg,
        name: '(package)',
        status: 'error',
        durationMs: null,
        message: output !== undefined ? `${reason}\n${output}` : reason,
      });
      // a build-fail warning above already reported this package
      if (build === undefined || !build.failed) {
        warnings.push(
          `go: ${sourcePath}: package ${pkg} failed with no test results — synthesized as error`,
        );
      }
    }

    if (strayText.length > 0) {
      warnings.push(
        `go: ${sourcePath}: ${strayText.length} non-JSON line(s) ignored (stderr merged into the stream? build errors?): ${excerptOf(strayText)}`,
      );
    }
    return { results, warnings };
  },
};
