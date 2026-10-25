/**
 * `go test -json` NDJSON parser.
 *
 * Each line is an event: `{ Action: 'run'|'pause'|'pass'|'fail'|'skip'|'output'|…, Package,
 * Test?, Elapsed?, Time, Output? }`. (Field casing varies across Go versions: `Elapsed`/
 * `elapsed` and `Output`/`output` are both accepted.)
 *
 * Per (Package, Test) the final terminal action (pass/fail/skip — last one wins) decides the
 * status. durationMs = round(elapsed * 1000) taken from that terminal event when present,
 * else null (older Go versions only put elapsed on package-level events).
 *
 * Messages are built from the test's 'output' events: ANSI SGR codes are stripped, blank
 * lines dropped, and the LAST 500 characters of the joined text are kept (failure details
 * come at the end, after t.Log noise).
 *
 * Package-level events (no Test) are ignored. Lines that fail JSON.parse produce warnings —
 * at most 5 individually, then a single '…and N more' summary.
 *
 * Never throws.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, firstNonEmptyLine, isObj, stripAnsi, stripBom } from './internal.js';

const MAX_MALFORMED_DETAILS = 5;
const MESSAGE_MAX_CHARS = 500;

interface TestAccumulator {
  pkg: string;
  test: string;
  status?: TestStatus;
  durationMs: number | null;
  outputs: string[];
}

/** Elapsed seconds → ms; accepts both `Elapsed` and `elapsed` spellings. */
function elapsedToMs(ev: Record<string, unknown>): number | null {
  const raw = ev.elapsed !== undefined ? ev.elapsed : ev.Elapsed;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw * 1000);
}

/** Last meaningful chunk of a test's output events, trimmed to MESSAGE_MAX_CHARS. */
function messageFromOutputs(outputs: string[]): string | undefined {
  if (outputs.length === 0) return undefined;
  // Blank lines are dropped but per-line indentation is kept — a line like
  // "    file.go:12: detail" carries its t.Log prefix meaningfully.
  const text = stripAnsi(outputs.join(''))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .join('\n');
  if (text === '') return undefined;
  return text.length > MESSAGE_MAX_CHARS ? text.slice(-MESSAGE_MAX_CHARS) : text;
}

export const goTestParser: ReportParser = {
  name: 'go',

  sniff(content: string): boolean {
    const first = firstNonEmptyLine(stripBom(content));
    if (first === null) return false;
    try {
      const ev: unknown = JSON.parse(first);
      return isObj(ev) && 'Action' in ev && 'Package' in ev;
    } catch {
      return false;
    }
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const tests = new Map<string, TestAccumulator>();
    let malformed = 0;

    const lines = stripBom(content).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.trim() === '') continue;

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

      const pkg = typeof ev.Package === 'string' ? ev.Package : '';
      const test = typeof ev.Test === 'string' && ev.Test.trim() !== '' ? ev.Test : null;
      if (pkg === '' || test === null) continue; // package-level or foreign event

      const key = `${pkg}\u0000${test}`;
      let acc = tests.get(key);
      if (acc === undefined) {
        acc = { pkg, test, durationMs: null, outputs: [] };
        tests.set(key, acc);
      }

      const action = ev.Action;
      if (action === 'pass' || action === 'fail' || action === 'skip') {
        acc.status = action;
        acc.durationMs = elapsedToMs(ev);
      } else if (action === 'output') {
        const out = ev.Output !== undefined ? ev.Output : ev.output;
        if (typeof out === 'string') acc.outputs.push(out);
      }
      // 'run' | 'pause' | 'cont' | 'bench' | … — no state change.
    }

    if (malformed > MAX_MALFORMED_DETAILS) {
      warnings.push(`…and ${malformed - MAX_MALFORMED_DETAILS} more malformed lines`);
    }

    for (const acc of tests.values()) {
      if (acc.status === undefined) continue; // never reached a terminal action
      const result: TestCaseResult = {
        testId: makeTestId(acc.pkg, acc.test),
        suite: acc.pkg,
        name: acc.test,
        status: acc.status,
        durationMs: acc.durationMs,
      };
      const message = messageFromOutputs(acc.outputs);
      if (message !== undefined) result.message = message;
      results.push(result);
    }
    return { results, warnings };
  },
};
