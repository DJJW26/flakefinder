import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import type { FlakefinderConfig } from '../types.js';
import { runLive } from './wrap.js';

let dirs: string[] = [];
function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-run-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

function cfg(over: Partial<FlakefinderConfig> = {}) {
  return resolveConfig({ reports: ['out.json'], storeDir: '.ffstore', minRuns: 1, ...over });
}

// Emits a Jest-shaped report: `flaky test` fails on odd counter values,
// `broken test` always fails. Also records the argv it received (for the
// quarantine wiring test).
const SCRIPT_FLAKY = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('counter.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('counter.txt', String(n));
const flakyStatus = n % 2 === 1 ? 'failed' : 'passed';
const report = { testResults: [{ name: 'suite.test.js', status: flakyStatus === 'failed' ? 'failed' : 'passed', assertionResults: [
  { title: 'flaky test', fullName: 'flaky test', status: flakyStatus, ancestorTitles: [], duration: 3, failureMessages: flakyStatus === 'failed' ? ['odd count ' + n] : [] },
  { title: 'broken test', fullName: 'broken test', status: 'failed', ancestorTitles: [], duration: 3, failureMessages: ['always broken'] },
] }] };
fs.writeFileSync('out.json', JSON.stringify(report));
fs.writeFileSync('args.txt', JSON.stringify(process.argv.slice(2)));
process.exit(1);
`;

const SCRIPT_ALL_PASS = `
const fs = require('fs');
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 'ok.test.js', status: 'passed', assertionResults: [
  { title: 'stable test', fullName: 'stable test', status: 'passed', ancestorTitles: [], duration: 2, failureMessages: [] },
] }] }));
`;

// No report files — only exit codes vary (suite-level flake fallback).
const SCRIPT_EXIT_FLIP = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c2.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c2.txt', String(n));
process.exit(n === 1 ? 1 : 0);
`;

describe('runLive', () => {
  it('separates retry-rescued flakes from deterministic failures', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'script.js'), SCRIPT_FLAKY, 'utf8');
    const result = await runLive(['node', 'script.js'], cfg(), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });

    expect(result.finalExitCode).toBe(1); // broken test keeps failing
    expect(result.attempts).toHaveLength(3); // flakiness prevented early exit

    const flaky = result.verdicts.find((v) => v.name === 'flaky test')!;
    const broken = result.verdicts.find((v) => v.name === 'broken test')!;
    expect(flaky.classification).toBe('flaky-retry'); // fail@1 → pass@2
    expect(flaky.flakeScore).toBeGreaterThanOrEqual(40);
    expect(broken.classification).toBe('failing');
    expect(result.usedReportFiles).toHaveLength(1);
  }, 60_000);

  it('stops after a clean first attempt', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'script.js'), SCRIPT_ALL_PASS, 'utf8');
    const result = await runLive(['node', 'script.js'], cfg(), {
      retries: 3,
      cwd,
      applyQuarantine: false,
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.finalExitCode).toBe(0);
    const stable = result.verdicts.find((v) => v.name === 'stable test')!;
    expect(stable.classification).toBe('passing');
  }, 30_000);

  it('falls back to suite-level verdict when no reports match', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'script.js'), SCRIPT_EXIT_FLIP, 'utf8');
    const result = await runLive(['node', 'script.js'], cfg({ reports: ['nothing*.xml'] }), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    expect(result.usedReportFiles).toEqual([]);
    expect(result.attempts).toEqual([]);
    expect(result.suiteFlake).toBe(true); // exit 1 then exit 0
    expect(result.finalExitCode).toBe(0);
  }, 30_000);

  it('applies quarantine exclusion flags for jest projects', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'script.js'), SCRIPT_FLAKY, 'utf8');
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29' } }),
      'utf8',
    );
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'deadbeef',
            suite: 'suite.test.js',
            name: 'broken test',
            reason: 'flaky',
            quarantinedAt: new Date().toISOString(),
            flakeScore: 90,
          },
        ],
      }),
      'utf8',
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg(), {
      retries: 1,
      cwd,
      applyQuarantine: true,
    });

    expect(log.mock.calls.some((c) => String(c[0]).includes('quarantine active'))).toBe(true);
    const argv = JSON.parse(readFileSync(path.join(cwd, 'args.txt'), 'utf8')) as string[];
    expect(argv).toContain('-t');
    expect(argv.join(' ')).toContain('broken');
    // sanity: behavior unchanged otherwise
    expect(result.verdicts.length).toBeGreaterThan(0);
    void warn;
  }, 60_000);

  it('failOnFlakes makes a rescued flake exit non-zero', async () => {
    const cwd = tmpCwd();
    writeFileSync(
      path.join(cwd, 'script.js'),
      SCRIPT_FLAKY.replace(
        'process.exit(1);',
        `
const fs2 = require('fs');
const rep = JSON.parse(fs2.readFileSync('out.json', 'utf8'));
process.exit(rep.testResults[0].assertionResults.some(a => a.status === 'failed') ? 1 : 0);
`,
      ),
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // attempt 1: counter 1 → flaky fails → exit 1. attempt 2: counter 2 → both pass? broken still failed → exit 1...
    // broken test always fails, so the command never exits 0; flaky is still rescued (retryRescue).
    const result = await runLive(['node', 'script.js'], cfg({ failOnFlakes: true }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    expect(result.verdicts.some((v) => v.classification.startsWith('flaky'))).toBe(true);
    expect(result.finalExitCode).toBe(1);
  }, 60_000);
});

describe('quarantine forwarding mechanics', () => {
  it('shellQuote wraps arguments containing spaces/metacharacters', async () => {
    const { shellQuote, isPackageManagerWrapper } = await import('./wrap.js');
    expect(shellQuote('safe-token_1.txt')).toBe('safe-token_1.txt');
    const quoted = shellQuote('^(?!.*(?:annoying flake))');
    expect(
      quoted === '"^(?!.*(?:annoying flake))"' || quoted === "'^(?!.*(?:annoying flake))'",
    ).toBe(true);
    expect(isPackageManagerWrapper(['npm', 'test'])).toBe(true);
    expect(isPackageManagerWrapper(['npm.cmd', 'test'])).toBe(true);
    expect(isPackageManagerWrapper(['yarn', 'jest'])).toBe(true);
    expect(isPackageManagerWrapper(['npx', 'jest'])).toBe(false);
    expect(isPackageManagerWrapper(['node', 'script.js'])).toBe(false);
  });

  it('npm-style wrappers receive exclusion flags after -- (end-to-end)', async () => {
    const cwd = tmpCwd();
    // fake package: npm test -> node runner.js, which records its argv
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'x', private: true, scripts: { test: 'node runner.js' } }),
      'utf8',
    );
    writeFileSync(
      path.join(cwd, 'runner.js'),
      "require('fs').writeFileSync('received.json', JSON.stringify(require('process').argv.slice(2)));",
      'utf8',
    );
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'abc',
            suite: 's.test.js',
            name: 'annoying flake',
            reason: 'flaky',
            quarantinedAt: new Date().toISOString(),
            flakeScore: 90,
          },
        ],
      }),
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runLive(['npm', 'test'], cfg({ reports: [], runner: 'jest' }), {
      retries: 0,
      cwd,
      applyQuarantine: true,
    });
    const received = JSON.parse(readFileSync(path.join(cwd, 'received.json'), 'utf8')) as string[];
    expect(received).toContain('-t');
    expect(received).toContain('^(?!.*(?:annoying flake))'); // one intact arg, not split
  }, 60_000);
});

describe('QA round 2 fixes', () => {
  it('stale report + rescued exit code still exits 1 (failure evidence is not erased)', async () => {
    const cwd = tmpCwd();
    // attempt 1: writes a report with one failing test, exits 1.
    // attempt 2: exits 0 WITHOUT rewriting the report (stale).
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c3.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c3.txt', String(n));
if (n === 1) {
  fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: 'failed', assertionResults: [
    { title: 'failA', fullName: 'failA', status: 'failed', ancestorTitles: [], duration: 5, failureMessages: ['boom'] },
  ] }] }));
  process.exit(1);
}
process.exit(0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ minRuns: 1 }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    expect(result.finalExitCode).toBe(1); // nothing proved the failure flaky
  }, 60_000);

  it('--fail-on-flake fires on a suite-level flake (no reports, exits varied)', async () => {
    const cwd = tmpCwd();
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c4.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c4.txt', String(n));
process.exit(n === 1 ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ reports: [], failOnFlakes: true }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    expect(result.suiteFlake).toBe(true);
    expect(result.finalExitCode).toBe(1);
  }, 60_000);

  it('quarantine flags join the runner segment when shell operators are present', async () => {
    const cwd = tmpCwd();
    // runner echoes argv to a file, then a second segment runs; the -t flag must land on the FIRST segment
    writeFileSync(
      path.join(cwd, 'echo-args.js'),
      "require('fs').writeFileSync('argv.json', JSON.stringify(require('process').argv.slice(1)));",
      'utf8',
    );
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'x',
            suite: 's.test.js',
            name: 'test_x',
            reason: 'flaky',
            quarantinedAt: new Date().toISOString(),
            flakeScore: 90,
          },
        ],
      }),
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runLive(
      ['node', 'echo-args.js', '||', 'echo', 'hi'],
      cfg({ reports: [], runner: 'jest' }),
      {
        retries: 0,
        cwd,
        applyQuarantine: true,
      },
    );
    const argv = JSON.parse(readFileSync(path.join(cwd, 'argv.json'), 'utf8')) as string[];
    expect(argv).toContain('-t');
    expect(argv).toContain('^(?!.*(?:test_x))');
  }, 60_000);
});

describe('targeted failed-only re-runs (B1)', () => {
  it('attempt 2 re-runs ONLY the failed tests via runner selector, and a rescue is detected', async () => {
    const cwd = tmpCwd();
    // "runner": attempt 1 runs all 3 tests (flaky fails), writes report, exits 1.
    // attempt 2 (targeted): jest -t pattern arrives; run only flaky (now passing).
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c5.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c5.txt', String(n));
const mk = (title, status) => ({ title, fullName: title, status, ancestorTitles: [], duration: 3, failureMessages: status === 'failed' ? [title + ' broke'] : [] });
let results;
if (n === 1) {
  results = [mk('flaky test', 'failed'), mk('stable test', 'passed')];
} else {
  const argv = process.argv.slice(2);
  const hasTargeted = argv.includes('-t') && argv.some((a) => a.includes('flaky'));
  fs.writeFileSync('targeted.txt', hasTargeted ? 'yes' : 'no');
  if (!hasTargeted) { process.exit(9); } // targeted mode MUST be active on attempt 2
  results = [mk('flaky test', 'passed')];
}
const failed = results.some((r) => r.status === 'failed');
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: failed ? 'failed' : 'passed', assertionResults: results }] }));
process.exit(failed ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ devDependencies: { jest: '^29' } }),
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ minRuns: 1 }), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    expect(readFileSync(path.join(cwd, 'targeted.txt'), 'utf8')).toBe('yes');
    const flaky = result.verdicts.find((v) => v.name === 'flaky test')!;
    expect(flaky.retryRescues).toBeGreaterThanOrEqual(1);
    expect(flaky.classification.startsWith('flaky-')).toBe(true);
    expect(result.finalExitCode).toBe(0); // only failure was a rescued flake
  }, 60_000);

  it('retry-mode full never injects selector flags', async () => {
    const cwd = tmpCwd();
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c6.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c6.txt', String(n));
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
const mk = (title, status) => ({ title, fullName: title, status, ancestorTitles: [], duration: 3, failureMessages: [] });
const results = n === 1
  ? [mk('flaky test', 'failed'), mk('stable test', 'passed')]
  : [mk('flaky test', 'passed'), mk('stable test', 'passed')];
const failed = results.some((r) => r.status === 'failed');
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: failed ? 'failed' : 'passed', assertionResults: results }] }));
process.exit(failed ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runLive(['node', 'script.js'], cfg({ minRuns: 1, retryMode: 'full' }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    const argv = JSON.parse(readFileSync(path.join(cwd, 'argv.json'), 'utf8')) as string[];
    expect(argv).toEqual([]); // no -t/--grep/-run/--lf injection in full mode
  }, 60_000);
});

describe('attempt timeout (C2)', () => {
  it('kills an attempt that exceeds --timeout and records exit 124', async () => {
    const cwd = tmpCwd();
    // hangs forever; t sc spy keeps output quiet
    writeFileSync(path.join(cwd, 'hang.js'), 'setInterval(() => {}, 1000);', 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t0 = Date.now();
    const result = await runLive(['node', 'hang.js'], cfg({ reports: [], timeoutSeconds: 1 }), {
      retries: 0,
      cwd,
      applyQuarantine: false,
    });
    const elapsed = Date.now() - t0;
    expect(result.finalExitCode).toBe(1); // 124 → nonzero → contract exit 1
    expect(elapsed).toBeLessThan(8000); // killed at ~1s, not hanging forever
    expect(err.mock.calls.some((c) => String(c[0]).includes('timed out after 1s'))).toBe(true);
  }, 30_000);
});
