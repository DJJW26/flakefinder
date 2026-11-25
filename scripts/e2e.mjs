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
 *   FF_E2E_STRICT=1         fail if any fixture is skipped
 *   FF_E2E_NOBUILD=1        skip `npm run build` when dist/cli.js already exists
 *
 * Plain Node ESM on purpose: node:assert + child_process.spawnSync, no test
 * framework. Exit code 1 when any required step fails.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const STRICT = process.env.FF_E2E_STRICT === '1';
const WINDOWS = process.platform === 'win32';

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

function step(name, fn) {
  try {
    fn();
    passed++;
    line('PASS', name);
    return true;
  } catch (err) {
    failed++;
    line('FAIL', name);
    const msg = String(err?.message ?? err).split('\n')[0];
    console.log(`       ${msg}`);
    return false;
  }
}

function skipFixture(name, reason) {
  const label = `${name} section (${reason})`;
  if (STRICT) {
    step(label, () => assert.fail(`${name} fixture is required by FF_E2E_STRICT=1`));
  } else {
    skipped++;
    line('SKIP', label);
  }
}

function sh(cmd, args = [], opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function npm(args, cwd) {
  const opts = { cwd, timeout: 600_000 };
  if (!WINDOWS) return sh('npm', args, opts);
  // The harness supplies only fixed flags. cmd.exe resolves npm.cmd on PATH.
  return sh(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', `npm ${args.join(' ')}`], {
    ...opts,
    windowsVerbatimArguments: true,
  });
}

/** Preserve literal shell tokens for flakefinder's runner (see the Go fixture). */
function cli(args, opts = {}) {
  return sh(process.execPath, [CLI, ...args], opts);
}

const output = (r) => `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
const tail = (r, n = 400) => output(r).slice(-n).replace(/\s+/g, ' ').trim();

function copyFixture(scratch, name, files) {
  const fixture = `${name}-project`;
  const source = path.join(ROOT, 'fixtures', fixture);
  const cwd = path.join(scratch, fixture);
  mkdirSync(cwd);
  for (const file of ['flakefinder.config.json', ...files]) {
    cpSync(path.join(source, file), path.join(cwd, file), { recursive: true });
  }
  return cwd;
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

function jestSection(scratch) {
  console.log('\n=== jest fixture (REQUIRED) ===');
  const cwd = copyFixture(scratch, 'jest', [
    'package.json',
    'package-lock.json',
    'jest.config.cjs',
    'tests',
  ]);

  const installed = step('jest: npm ci', () => {
    const r = npm(['ci', '--no-audit', '--no-fund'], cwd);
    assert.equal(r.status, 0, `npm ci failed: ${tail(r)}`);
  });
  if (!installed) return;

  // A) run -R 2 → attempts: fail(counter 1), pass(counter 2), fail(counter 3)
  //    → flaky-counter = flaky-retry (rescued on attempt 2), always-fail = failing.
  step('jest: run -R 2 exits 1 and separates flake from real failure', () => {
    const r = cli(['run', '-R', '2', '--', 'npx', 'jest', '--ci', '--runInBand'], {
      cwd,
      timeout: 300_000,
    });
    assert.equal(
      r.status,
      1,
      `expected exit 1 with persistent failure, got ${r.status}: ${tail(r)}`,
    );
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

function pytestSection(scratch) {
  console.log('\n=== pytest fixture ===');
  if (SKIP.has('pytest')) {
    skipFixture('pytest', 'FF_E2E_SKIP');
    return;
  }

  if (sh('python', ['-m', 'pytest', '--version']).status !== 0) {
    skipFixture('pytest', 'python/pytest unavailable');
    return;
  }

  const cwd = copyFixture(scratch, 'pytest', ['pytest.ini', 'test_sample.py']);

  // A) run -R 2 → fail(1), pass(2), fail(3) → test_flaky_counter = flaky-retry.
  step('pytest: run -R 2 exits 1 and separates flake from real failure', () => {
    const r = cli(['run', '-R', '2', '--', 'python', '-m', 'pytest'], {
      cwd,
      timeout: 300_000,
    });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${tail(r)}`);
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

function goSection(scratch) {
  console.log('\n=== go fixture ===');
  if (SKIP.has('go')) {
    skipFixture('go', 'FF_E2E_SKIP');
    return;
  }
  if (sh('go', ['version']).status !== 0) {
    skipFixture('go', 'go unavailable');
    return;
  }

  const cwd = copyFixture(scratch, 'go', [
    'go.mod',
    'alwayfail_test.go',
    'counter_test.go',
    'slow_test.go',
    'stable_test.go',
  ]);
  const report = path.join(cwd, 'test-output.jsonl');

  // `run` mode with the shell redirect passed as literal argv
  // tokens. This outer spawn deliberately has NO shell: cmd.exe would eat the
  // `>` itself. The CLI joins the tokens and spawns them through its own
  // shell, where the redirect takes effect:
  //   go test -count=1 -json ./... > test-output.jsonl
  // (-count=1 disables go's result cache; a flake hunter must re-execute.)
  step('go: run -R 1 with shell redirect classifies TestFlakyCounter flaky', () => {
    const r = cli(
      [
        'run',
        '-R',
        '1',
        '--',
        'go',
        'test',
        '-count=1',
        '-json',
        './...',
        '>',
        'test-output.jsonl',
      ],
      { cwd, timeout: 300_000 }, // no shell — '>' must survive as an argv token
    );
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${tail(r)}`);
    assert.ok(existsSync(report), 'redirect produced no test-output.jsonl');
    const out = output(r);
    assert.match(out, /FLAKY \(/i, 'no FLAKY section in report');
    assert.match(out, /TestFlakyCounter/, 'TestFlakyCounter not flagged');
    assert.match(out, /FAILING|NEW FAILURE/, 'no FAILING/NEW FAILURE section');
    assert.match(out, /TestAlwaysFail/, 'TestAlwaysFail not listed as failing');

    const rj = cli(['report', '--format', 'json'], { cwd });
    assert.equal(rj.status, 0, `json report exited ${rj.status}: ${tail(rj)}`);
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
    console.log(
      `       (TestFlakyCounter: ${v.classification}, retryRescues=${v.retryRescues}, sameShaFlips=${v.sameShaFlips})`,
    );
    const a = verdicts.find((x) => x.name === 'TestAlwaysFail');
    assert.equal(a?.classification, 'failing', 'TestAlwaysFail did not remain failing');
  });

  step('go: report --flakes-only lists TestFlakyCounter', () => {
    const r = cli(['report', '--flakes-only', '--no-color'], { cwd });
    assert.equal(r.status, 0, `report exited ${r.status}: ${tail(r)}`);
    assert.match(r.stdout, /TestFlakyCounter/, 'TestFlakyCounter missing from report');
    assert.match(r.stdout, /TestAlwaysFail/, 'TestAlwaysFail missing from problem report');
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
    const r = npm(['run', 'build'], ROOT);
    assert.equal(r.status, 0, `build failed: ${tail(r)}`);
  });
} else {
  line('note', 'build skipped (dist/cli.js present + FF_E2E_NOBUILD=1)');
}

if (!existsSync(CLI)) {
  console.error('\nE2E: dist/cli.js missing — aborting');
  process.exitCode = 1;
} else {
  const scratch = mkdtempSync(path.join(tmpdir(), 'ff-e2e-'));
  try {
    jestSection(scratch);
    pytestSection(scratch);
    goSection(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
  console.log(`\nE2E: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log('failed steps are marked FAIL above');
    process.exitCode = 1;
  }
}
