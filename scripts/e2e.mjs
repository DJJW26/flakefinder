#!/usr/bin/env node
/**
 * flakefinder end-to-end harness (Agent F).
 *
 * Exercises the built CLI against three real fixture projects:
 *
 *   - jest   (REQUIRED)  — npx jest via `run -R 2`, report, html, quarantine roundtrip
 *   - pytest (skippable) — python -m pytest via `run -R 2`, report, html
 *   - go     (skippable) — `go test -json` with a shell redirect via `run -R 1`
 *
 * Every fixture flake is deterministic (counter-file parity protocol), so the
 * assertions below are exact — nothing depends on timing or randomness.
 *
 * Env:
 *   FF_E2E_SKIP=pytest,go   comma-separated section names to skip
 *   FF_E2E_NOBUILD=1        skip `npm run build` when dist/cli.js already exists
 *
 * Plain Node ESM on purpose: node:assert + child_process.spawnSync, no test
 * framework. Exit code 1 when any required step fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');

const SKIP = new Set(
  (process.env.FF_E2E_SKIP ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

let passed = 0;
let failed = 0;
let skipped = 0;

/* ------------------------------------------------------------------ helpers */

const line = (mark, name) => console.log(`  ${mark.padEnd(4)} ${name}`);

/** One step. `fn` may return 'skip' to record a skip without failing. */
function step(name, fn) {
  try {
    const r = fn();
    if (r === 'skip') {
      skipped++;
      line('SKIP', name);
      return 'skip';
    }
    passed++;
    line('PASS', name);
    return 'pass';
  } catch (err) {
    failed++;
    line('FAIL', name);
    const msg = String(err && err.message ? err.message : err).split('\n')[0];
    console.log(`       ${msg}`);
    return 'fail';
  }
}

function sh(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** Run the flakefinder CLI. NOTE: only add `shell: true` when no argv token
 *  contains shell metacharacters that must survive into the CLI (see go). */
function cli(args, opts = {}) {
  return sh('node', [CLI, ...args], opts);
}

const output = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const tail = (r, n = 400) => output(r).slice(-n).replace(/\s+/g, ' ').trim();

function cleanDir(dir, names) {
  for (const name of names) rmSync(path.join(dir, name), { recursive: true, force: true });
}

function assertDashboard(cwd, file, label) {
  const r = cli(['html', '-o', file], { cwd });
  assert.equal(r.status, 0, `html exited ${r.status}: ${tail(r)}`);
  const full = path.join(cwd, file);
  assert.ok(existsSync(full), `${full} not written`);
  const size = statSync(full).size;
  assert.ok(size > 5000, `${label} dashboard too small: ${size} bytes`);
  return size;
}

/* ------------------------------------------------------------- jest section */

function jestSection() {
  console.log('\n=== jest fixture (REQUIRED) ===');
  const cwd = path.join(ROOT, 'fixtures', 'jest-project');

  if (existsSync(path.join(cwd, 'node_modules'))) {
    line('note', 'jest: node_modules present — skipping npm install');
  } else {
    step('jest: npm install', () => {
      const r = sh('npm', ['install', '--no-audit', '--no-fund'], {
        cwd,
        shell: true,
        timeout: 600_000,
      });
      assert.equal(r.status, 0, `npm install failed: ${tail(r)}`);
    });
  }

  // Deterministic starting state: no history, no report, counter at zero.
  cleanDir(cwd, [
    '.flakefinder',
    'junit.xml',
    'counter.txt',
    'flakefinder.quarantine.json',
    'dash.html',
    'flakefinder-report.html',
  ]);

  // A) run -R 2 → attempts: fail(counter 1), pass(counter 2), fail(counter 3)
  //    → flaky-counter = flaky-retry (rescued on attempt 2), always-fail = failing.
  step('jest: run -R 2 exits 1 and separates flake from real failure', () => {
    const r = cli(['run', '-R', '2', '--', 'npx', 'jest', '--ci', '--runInBand'], {
      cwd,
      shell: true,
      timeout: 300_000,
    });
    assert.equal(r.status, 1, `expected exit 1 (deterministic failure persists), got ${r.status}`);
    const out = output(r);
    assert.match(out, /FLAKY \(/i, 'no FLAKY section in report');
    assert.match(out, /counter/i, 'flaky-counter not flagged');
    assert.match(out, /FAILING|NEW FAILURE/, 'no FAILING/NEW FAILURE section');
    assert.match(out, /always-?fail/i, 'always-fail not listed as failing');
  });

  // B) report --flakes-only
  step('jest: report --flakes-only lists flaky-counter', () => {
    const r = cli(['report', '--flakes-only', '--no-color'], { cwd });
    assert.equal(r.status, 0, `report exited ${r.status}: ${tail(r)}`);
    assert.match(r.stdout, /flaky-counter/, 'flaky-counter missing from flakes-only report');
  });

  // C) html dashboard
  step('jest: html dashboard > 5 KB', () => {
    assertDashboard(cwd, 'dash.html', 'jest');
  });

  // D) quarantine roundtrip via JSON report testId
  step('jest: quarantine add/remove roundtrip', () => {
    const rj = cli(['report', '--format', 'json'], { cwd });
    assert.equal(rj.status, 0, `json report exited ${rj.status}`);
    const payload = JSON.parse(rj.stdout);
    const v = payload.verdicts.find(
      (x) => x.name.includes('flaky-counter') || x.suite.includes('flaky-counter'),
    );
    assert.ok(v, 'no verdict whose name/suite includes "flaky-counter"');
    const { testId } = v;

    const ra = cli(['quarantine', 'add', testId], { cwd });
    assert.equal(ra.status, 0, `quarantine add exited ${ra.status}: ${tail(ra)}`);
    const qPath = path.join(cwd, 'flakefinder.quarantine.json');
    assert.ok(existsSync(qPath), 'flakefinder.quarantine.json not written');
    assert.ok(
      readFileSync(qPath, 'utf8').includes(testId),
      'quarantine file does not contain the testId',
    );

    const rr = cli(['quarantine', 'remove', testId], { cwd });
    assert.equal(rr.status, 0, `quarantine remove exited ${rr.status}: ${tail(rr)}`);
  });
}

/* ----------------------------------------------------------- pytest section */

function pytestSection() {
  console.log('\n=== pytest fixture ===');
  if (SKIP.has('pytest')) {
    skipped++;
    line('SKIP', 'pytest section (FF_E2E_SKIP)');
    return;
  }

  const probe = () => sh('python', ['-m', 'pytest', '--version'], { shell: true }).status === 0;
  if (!probe()) {
    console.log('  note  pytest missing — attempting `python -m pip install --user -q pytest`');
    sh('python', ['-m', 'pip', 'install', '--user', '-q', 'pytest'], {
      shell: true,
      timeout: 300_000,
    });
  }
  if (!probe()) {
    skipped++;
    line('SKIP', 'pytest section (python/pytest unavailable)');
    return;
  }

  const cwd = path.join(ROOT, 'fixtures', 'pytest-project');
  cleanDir(cwd, [
    '.flakefinder',
    'junit.xml',
    'counter.txt',
    '__pycache__',
    '.pytest_cache',
    'flakefinder.quarantine.json',
    'flakefinder-report.html',
  ]);

  // A) run -R 2 → fail(1), pass(2), fail(3) → test_flaky_counter = flaky-retry.
  step('pytest: run -R 2 exits 1 and separates flake from real failure', () => {
    const r = cli(['run', '-R', '2', '--', 'python', '-m', 'pytest'], {
      cwd,
      shell: true,
      timeout: 300_000,
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    const out = output(r);
    assert.match(out, /FLAKY \(/i, 'no FLAKY section in report');
    assert.match(out, /counter/i, 'flaky counter not flagged');
    assert.match(out, /FAILING|NEW FAILURE/, 'no FAILING/NEW FAILURE section');
    assert.match(out, /always_fail/i, 'test_always_fail not listed as failing');
  });

  // B) report --flakes-only (pytest junit names: test_flaky_counter)
  step('pytest: report --flakes-only lists test_flaky_counter', () => {
    const r = cli(['report', '--flakes-only', '--no-color'], { cwd });
    assert.equal(r.status, 0, `report exited ${r.status}: ${tail(r)}`);
    assert.match(r.stdout, /flaky_counter/, 'test_flaky_counter missing from report');
  });

  // C) html dashboard
  step('pytest: html dashboard > 5 KB', () => {
    assertDashboard(cwd, 'flakefinder-report.html', 'pytest');
  });
}

/* --------------------------------------------------------------- go section */

function goSection() {
  console.log('\n=== go fixture ===');
  if (SKIP.has('go')) {
    skipped++;
    line('SKIP', 'go section (FF_E2E_SKIP)');
    return;
  }
  if (sh('go', ['version'], { shell: true }).status !== 0) {
    skipped++;
    line('SKIP', 'go section (go unavailable)');
    return;
  }

  const cwd = path.join(ROOT, 'fixtures', 'go-project');
  const report = path.join(cwd, 'test-output.jsonl');

  // Primary path — `run` mode with the shell redirect passed as literal argv
  // tokens. This outer spawn deliberately has NO shell: cmd.exe would eat the
  // `>` itself. The CLI joins the tokens and spawns them through its own
  // shell, where the redirect takes effect:
  //   go test -count=1 -json ./... > test-output.jsonl
  // (-count=1 disables go's result cache; a flake hunter must re-execute.)
  cleanDir(cwd, [
    '.flakefinder',
    'test-output.jsonl',
    'counter.txt',
    'flakefinder.quarantine.json',
    'flakefinder-report.html',
  ]);

  let runModeOk = false;
  step('go: run -R 1 with shell redirect classifies TestFlakyCounter flaky', () => {
    const r = cli(
      ['run', '-R', '1', '--', 'go', 'test', '-count=1', '-json', './...', '>', 'test-output.jsonl'],
      { cwd, timeout: 300_000 }, // no shell — '>' must survive as an argv token
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}`);
    assert.ok(existsSync(report), 'redirect produced no test-output.jsonl');
    const out = output(r);
    assert.match(out, /FLAKY \(/i, 'no FLAKY section in report');
    assert.match(out, /TestFlakyCounter/, 'TestFlakyCounter not flagged');
    assert.match(out, /FAILING|NEW FAILURE/, 'no FAILING/NEW FAILURE section');
    assert.match(out, /TestAlwaysFail/, 'TestAlwaysFail not listed as failing');

    const rj = cli(['report', '--format', 'json'], { cwd });
    const verdicts = JSON.parse(rj.stdout).verdicts;
    const v = verdicts.find((x) => x.name === 'TestFlakyCounter');
    assert.ok(v, 'TestFlakyCounter verdict missing');
    // PLAN §5 precedence: sameShaFlips (flaky-confirmed) outranks retryRescues
    // (flaky-retry). Inside a git repo both attempts share one commitSha, so a
    // rescued retry satisfies BOTH → flaky-confirmed. Without git (no
    // commitSha) the same rescue yields flaky-retry. Assert the mechanism and
    // accept the two flaky classes the frozen algorithm can produce.
    assert.ok(
      v.retryRescues >= 1,
      `retry rescue did not fire (retryRescues=${v.retryRescues}, sameShaFlips=${v.sameShaFlips})`,
    );
    assert.ok(
      v.classification === 'flaky-confirmed' || v.classification === 'flaky-retry',
      `expected flaky-confirmed/flaky-retry, got ${v.classification}`,
    );
    console.log(`       (TestFlakyCounter: ${v.classification}, retryRescues=${v.retryRescues}, sameShaFlips=${v.sameShaFlips})`);
    const a = verdicts.find((x) => x.name === 'TestAlwaysFail');
    assert.equal(a && a.classification, 'failing', `TestAlwaysFail: expected failing, got ${a && a.classification}`);
    runModeOk = true;
  });

  // Fallback — if run-mode redirect routing failed, drive the redirect
  // ourselves and ingest twice. NOTE the semantics: each `ingest` invocation
  // mints its OWN runId, so attempt 1 → 2 cannot form a retryRescue pair.
  // Detection still works through sameShaFlips (both attempts observed both
  // families on the same commit) → the counter classifies as flaky-confirmed
  // instead of flaky-retry. Recorded here, not silently weakened.
  if (!runModeOk) {
    console.log('  note  go run-mode redirect unusable — falling back to manual redirect + double ingest');
    cleanDir(cwd, ['.flakefinder', 'test-output.jsonl', 'counter.txt']);
    step('go: fallback double-ingest classifies TestFlakyCounter flaky', () => {
      for (const attempt of [1, 2]) {
        // go test exits 1 (TestAlwaysFail fails) — fine, the redirect still writes.
        sh('go test -count=1 -json ./... > test-output.jsonl', {
          cwd,
          shell: true,
          timeout: 300_000,
        });
        assert.ok(existsSync(report), `attempt ${attempt}: go test produced no report`);
        const ri = cli(['ingest', 'test-output.jsonl', '--attempt', String(attempt)], { cwd });
        assert.equal(ri.status, 0, `ingest ${attempt} exited ${ri.status}: ${tail(ri)}`);
      }
      const rj = cli(['report', '--format', 'json'], { cwd });
      const verdicts = JSON.parse(rj.stdout).verdicts;
      const v = verdicts.find((x) => x.name === 'TestFlakyCounter');
      assert.ok(v, 'TestFlakyCounter verdict missing');
      assert.ok(
        v.classification.startsWith('flaky-'),
        `expected flaky-* via same-commit flip, got ${v.classification}`,
      );
      console.log(`       (double-ingest classification: ${v.classification}; separate ingest runIds preclude flaky-retry)`);
      const a = verdicts.find((x) => x.name === 'TestAlwaysFail');
      assert.equal(a && a.classification, 'failing', `TestAlwaysFail: expected failing, got ${a && a.classification}`);
    });
  }

  step('go: report --flakes-only lists TestFlakyCounter', () => {
    const r = cli(['report', '--flakes-only', '--no-color'], { cwd });
    assert.equal(r.status, 0, `report exited ${r.status}: ${tail(r)}`);
    assert.match(r.stdout, /TestFlakyCounter/, 'TestFlakyCounter missing from report');
    assert.match(r.stdout, /TestAlwaysFail/, 'TestAlwaysFail missing from report');
  });

  step('go: html dashboard > 5 KB', () => {
    assertDashboard(cwd, 'flakefinder-report.html', 'go');
  });
}

/* --------------------------------------------------------------------- main */

console.log(`flakefinder e2e — ${new Date().toISOString()}`);
console.log(`root: ${ROOT}`);
console.log(`cli:  ${CLI}`);
if (SKIP.size > 0) console.log(`skip list: ${[...SKIP].join(', ')}`);

const needBuild = !(existsSync(CLI) && process.env.FF_E2E_NOBUILD === '1');
if (needBuild) {
  step('build: npm run build', () => {
    const r = sh('npm', ['run', 'build'], { cwd: ROOT, shell: true, timeout: 600_000 });
    assert.equal(r.status, 0, `build failed: ${tail(r)}`);
  });
} else {
  line('note', 'build skipped (dist/cli.js present + FF_E2E_NOBUILD=1)');
}

if (!existsSync(CLI)) {
  console.error('\nE2E: dist/cli.js missing — aborting');
  process.exitCode = 1;
} else {
  jestSection();
  pytestSection();
  goSection();
  console.log(`\nE2E: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log('failed steps are marked FAIL above');
    process.exitCode = 1;
  }
}
