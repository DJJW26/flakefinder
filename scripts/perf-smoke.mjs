/**
 * Performance smoke (B5): regenerates a worst-case history store (300 runs ×
 * 500 tests = 150,000 observations, ~13 MB) and asserts the CLI's report and
 * dashboard paths stay well under their measured budgets (~270 ms locally;
 * ceilings are generous for CI variance). Failing this means a performance
 * regression shipped — fail loudly.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const RUNS = 300;
const TESTS = 500;
const BUDGET_REPORT_MS = 5_000;
const BUDGET_HTML_MS = 5_000;

function timed(label, fn) {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`  ${label}: ${ms.toFixed(0)} ms`);
  return ms;
}

const dir = mkdtempSync(path.join(tmpdir(), 'ff-perf-'));
let failed = false;
try {
  const storeDir = path.join(dir, '.ffperf');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(storeDir, { recursive: true });
  const records = [];
  for (let r = 1; r <= RUNS; r++) {
    const results = [];
    for (let t = 0; t < TESTS; t++) {
      const flaky = t % 11 === 0;
      const failing = t % 97 === 0 && r < 100;
      const failed = failing || (flaky && (t + r) % 3 === 0);
      results.push({
        testId: `id${t}`,
        suite: `suite-${t % 25}`,
        name: `test-${t}`,
        status: failed ? 'fail' : 'pass',
        durationMs: 5 + (t % 40),
        message: failed ? `boom ${t}` : undefined,
      });
    }
    records.push(
      JSON.stringify({
        runId: `run-${r}`,
        timestamp: new Date(Date.now() - (RUNS + 1 - r) * 3600e3).toISOString(),
        source: 'report',
        parsedFrom: 'junit',
        attempt: 1,
        commitSha: `sha${r}`,
        results,
      }),
    );
  }
  writeFileSync(path.join(storeDir, 'history.jsonl'), `${records.join('\n')}\n`, 'utf8');
  const mb = (statSync(path.join(storeDir, 'history.jsonl')).size / 1e6).toFixed(1);
  console.log(`perf-smoke: ${RUNS} runs × ${TESTS} tests (${mb} MB store)`);

  const reportMs = timed('report', () =>
    execFileSync('node', [CLI, '--cwd', dir, 'report', '--no-color'], { stdio: 'ignore' }),
  );
  const htmlMs = timed('html', () =>
    execFileSync('node', [CLI, '--cwd', dir, 'html'], { stdio: 'ignore' }),
  );

  if (reportMs > BUDGET_REPORT_MS) {
    console.error(`FAIL: report took ${reportMs.toFixed(0)} ms (budget ${BUDGET_REPORT_MS})`);
    failed = true;
  }
  if (htmlMs > BUDGET_HTML_MS) {
    console.error(`FAIL: html took ${htmlMs.toFixed(0)} ms (budget ${BUDGET_HTML_MS})`);
    failed = true;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
