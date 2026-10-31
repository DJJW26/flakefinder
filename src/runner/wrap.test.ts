import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(shellQuote('^(?!(?:.* )?(?:annoying flake)\\s*$)', { platform: 'linux' })).toBe(
      "'^(?!(?:.* )?(?:annoying flake)\\s*$)'",
    );
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
    expect(received).toContain('^(?!(?:.* )?(?:annoying flake)\\s*$)'); // one intact arg, not split
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
    expect(argv).toContain('^(?!(?:.* )?(?:test_x)\\s*$)');
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

describe('retry re-record semantics (QA A1)', () => {
  it('fail-fail-pass with byte-identical failure reports still detects the rescue', async () => {
    const cwd = tmpCwd();
    // attempts 1 and 2 write a FAILING report with IDENTICAL bytes and exit 1;
    // attempt 3 writes a passing one. Before the fix, the byte-identical
    // attempt 2 was hash-skipped → no attempt-2 observation → no rescue.
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c7.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c7.txt', String(n));
const mk = (title, status) => ({ title, fullName: title, status, ancestorTitles: [], duration: 3, failureMessages: status === 'failed' ? ['deterministic failure text'] : [] });
let results;
if (n <= 2) results = [mk('flaky test', 'failed')];
else results = [mk('flaky test', 'passed')];
const failed = results.some((r) => r.status === 'failed');
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.js', status: failed ? 'failed' : 'passed', assertionResults: results }] }));
process.exit(failed ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ minRuns: 1 }), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    const attemptsForTest = result.attempts.filter((r) =>
      r.results.some((t) => t.name === 'flaky test'),
    );
    expect(attemptsForTest.map((r) => r.attempt)).toEqual([1, 2, 3]); // all three recorded
    const flaky = result.verdicts.find((v) => v.name === 'flaky test')!;
    expect(flaky.retryRescues).toBeGreaterThanOrEqual(1);
    expect(flaky.classification.startsWith('flaky-')).toBe(true);
    expect(result.finalExitCode).toBe(0);
  }, 60_000);
});

describe('unstartable commands (QA A11)', () => {
  it('a command that does not exist exits 2 (usage error), records nothing', async () => {
    const cwd = tmpCwd();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runLive(['definitely-not-a-cmd-xyz'], cfg(), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    expect(result.finalExitCode).toBe(2);
    expect(result.attempts).toEqual([]);
    expect(result.verdicts).toEqual([]);
    expect(err.mock.calls.flat().join('\n')).toContain(
      'command not found: definitely-not-a-cmd-xyz',
    );
    // no retries were attempted and no store was created
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat();
    expect(logged.filter((l) => String(l).includes('attempt ')).length).toBe(1);
    expect(existsSync(path.join(cwd, '.ffstore'))).toBe(false);
  });

  it('a real command exiting 2 is still a test failure (exit 1), not "could not start"', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'two.js'), 'process.exit(2);', 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'two.js'], cfg({ reports: [] }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    expect(result.finalExitCode).toBe(1);
  });

  it('a script exiting 127 from a command that DOES exist is not treated as unstartable', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'nf.js'), 'process.exit(127);', 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runLive(['node', 'nf.js'], cfg({ reports: [] }), {
      retries: 0,
      cwd,
      applyQuarantine: false,
    });
    expect(result.finalExitCode).toBe(1);
  });
});

describe('shell operator detection (R5 bug 1)', () => {
  it('plain numbers are arguments, not operators', async () => {
    const { isShellOperator } = await import('./wrap.js');
    for (const t of ['2', '4', '1', '0', '42']) expect(isShellOperator(t)).toBe(false);
    for (const t of [
      '>',
      '>>',
      '<',
      '2>',
      '2>>',
      '2>&1',
      '>&2',
      '&>',
      '&>>',
      '|',
      '||',
      '|&',
      '&',
      '&&',
      ';',
    ]) {
      expect(isShellOperator(t)).toBe(true);
    }
    for (const t of ['w1&&w2', '-t', 'a|b', '>out.txt']) expect(isShellOperator(t)).toBe(false);
  });

  it('flags are appended AFTER numeric option values', async () => {
    const { insertRunnerArgs } = await import('./wrap.js');
    expect(insertRunnerArgs(['jest', '--maxWorkers', '2'], ['-t', 'p'])).toEqual([
      'jest',
      '--maxWorkers',
      '2',
      '-t',
      'p',
    ]);
    expect(insertRunnerArgs(['pytest', '-n', '4'], ['--lf'])).toEqual([
      'pytest',
      '-n',
      '4',
      '--lf',
    ]);
    expect(insertRunnerArgs(['go', 'test', '-p', '1', './...'], ['-run', '^(A)$'])).toEqual([
      'go',
      'test',
      '-p',
      '1',
      './...',
      '-run',
      '^(A)$',
    ]);
    // real fd redirects still split the command
    expect(
      insertRunnerArgs(['go', 'test', '-p', '1', '2>&1', '|', 'tee', 'x'], ['-run', 'A']),
    ).toEqual(['go', 'test', '-p', '1', '-run', 'A', '2>&1', '|', 'tee', 'x']);
  });
});

describe('shell-mode quoting (R5 bug 2)', () => {
  const NASTY = [
    '$(touch pwned)',
    '`touch pwned`',
    'a; touch pwned',
    '*',
    'test?[ab]',
    '~',
    '~/x',
    '$HOME',
    "it's",
    'line1\nline2',
    'a\\b',
    '',
    '!event',
    '{a,b}',
    '#comment',
    '^(?!(?:.* )?(?:a|b)$)',
  ];

  it('POSIX: every token round-trips through /bin/sh verbatim', async () => {
    if (process.platform === 'win32') return;
    const { shellQuote } = await import('./wrap.js');
    const { spawnSync } = await import('node:child_process');
    const cwd = tmpCwd();
    const line = `printf '%s\\0' ${NASTY.map((t) => shellQuote(t)).join(' ')}`;
    const out = spawnSync('/bin/sh', ['-c', line], { cwd, encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout.split('\0').slice(0, -1)).toEqual(NASTY);
    expect(existsSync(path.join(cwd, 'pwned'))).toBe(false);
  });

  it('POSIX: inert tokens stay bare, everything else is single-quoted', async () => {
    const { shellQuote } = await import('./wrap.js');
    const opts = { platform: 'linux' as const };
    expect(shellQuote('--maxWorkers=2', opts)).toBe('--maxWorkers=2');
    expect(shellQuote('./src/a.test.ts', opts)).toBe('./src/a.test.ts');
    expect(shellQuote('$x', opts)).toBe("'$x'");
    expect(shellQuote("it's", opts)).toBe("'it'\\''s'");
    expect(shellQuote('', opts)).toBe("''");
  });

  it('win32: cmd metacharacters (incl. quotes and %) are caret-escaped', async () => {
    const { shellQuote } = await import('./wrap.js');
    const w = { platform: 'win32' as const };
    expect(shellQuote('jest', w)).toBe('jest');
    expect(shellQuote('a b', w)).toBe('^"a^ b^"');
    expect(shellQuote('a&calc', w)).toBe('^"a^&calc^"');
    expect(shellQuote('%PATH%', w)).toBe('^"^%PATH^%^"');
    expect(shellQuote('say "hi"', w)).toBe('^"say^ \\^"hi\\^"^"');
    expect(shellQuote('dir\\', w)).toBe('^"dir\\\\^"');
    expect(shellQuote('a|b', { ...w, doubleEscape: true })).toBe('^^^"a^^^|b^^^"');
  });

  it('win32: batch shims get double escaping, redirect targets single', async () => {
    const { shellArgvFor } = await import('./wrap.js');
    const argv = shellArgvFor(
      ['x.cmd', '-t', 'a b', '>', 'o u t.txt', '&&', 'x.exe', 'c&d'],
      '.',
      'win32',
    );
    expect(argv).toEqual([
      'x.cmd',
      '-t',
      '^^^"a^^^ b^^^"',
      '>',
      '^"o^ u^ t.txt^"',
      '&&',
      'x.exe',
      '^"c^&d^"',
    ]);
  });

  it('end-to-end: a malicious quarantined name cannot execute in shell mode', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    writeFileSync(
      path.join(cwd, 'echo-args.js'),
      "require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
      'utf8',
    );
    const evil = '$(touch pwned1)`touch pwned2`; touch pwned3 *';
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'x',
            suite: 's.test.js',
            name: evil,
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
    await runLive(['node', 'echo-args.js', '|', 'cat'], cfg({ reports: [], runner: 'jest' }), {
      retries: 0,
      cwd,
      applyQuarantine: true,
    });
    for (const f of ['pwned1', 'pwned2', 'pwned3'])
      expect(existsSync(path.join(cwd, f))).toBe(false);
    const argv = JSON.parse(readFileSync(path.join(cwd, 'argv.json'), 'utf8')) as string[];
    expect(argv[0]).toBe('-t');
    expect(argv[1]).toContain(evil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }, 60_000);
});

describe('package-manager separator (R5 bug 3)', () => {
  it('does not add a second -- when the wrapper command already has one', async () => {
    const { insertRunnerArgs } = await import('./wrap.js');
    expect(insertRunnerArgs(['npm', 'test', '--', '--ci'], ['-t', 'p'])).toEqual([
      'npm',
      'test',
      '--',
      '--ci',
      '-t',
      'p',
    ]);
    expect(insertRunnerArgs(['npm', 'test'], ['-t', 'p'])).toEqual([
      'npm',
      'test',
      '--',
      '-t',
      'p',
    ]);
    // a `--` in a LATER shell segment does not count for the runner's segment
    expect(insertRunnerArgs(['npm', 'test', '&&', 'x', '--'], ['-t', 'p'])).toEqual([
      'npm',
      'test',
      '--',
      '-t',
      'p',
      '&&',
      'x',
      '--',
    ]);
  });
});

describe('targeted re-runs use the previous attempt only (R5 bug 4)', () => {
  it('attempt 3 does not re-run a test that already recovered on attempt 2', async () => {
    const cwd = tmpCwd();
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c7.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c7.txt', String(n));
fs.writeFileSync('argv' + n + '.json', JSON.stringify(process.argv.slice(2)));
const mk = (title, status) => ({ title, fullName: title, status, ancestorTitles: [], duration: 3, failureMessages: [] });
const results = n === 1
  ? [mk('recovers', 'failed'), mk('stuck', 'failed')]
  : n === 2
    ? [mk('recovers', 'passed'), mk('stuck', 'failed')]
    : [mk('stuck', 'failed')];
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: 'failed', assertionResults: results }] }));
process.exit(1);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runLive(['node', 'script.js'], cfg({ runner: 'jest' }), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    const argv2 = JSON.parse(readFileSync(path.join(cwd, 'argv2.json'), 'utf8')) as string[];
    const argv3 = JSON.parse(readFileSync(path.join(cwd, 'argv3.json'), 'utf8')) as string[];
    expect(argv2[0]).toBe('-t');
    expect(argv2[1]).toContain('recovers');
    expect(argv2[1]).toContain('stuck');
    expect(argv3[0]).toBe('-t');
    expect(argv3[1]).toContain('stuck');
    expect(argv3[1]).not.toContain('recovers');
  }, 60_000);
});

describe('process-tree kill (R5 bug 5)', () => {
  // parent.js spawns a grandchild (stdio ignored, so the attempt can close
  // even if the grandchild survives) and records its pid, then hangs
  const PARENT = `
const { spawn } = require('child_process');
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync('gc.pid', String(gc.pid));
setInterval(() => {}, 1000);
`;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number): Promise<boolean> => {
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  };
  const waitFile = async (file: string): Promise<void> => {
    for (let i = 0; i < 200 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
  };

  it('a timeout kills grandchildren too, not just the direct child', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'parent.js'), PARENT, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let gcPid = 0;
    try {
      const result = await runLive(['node', 'parent.js'], cfg({ reports: [], timeoutSeconds: 1 }), {
        retries: 0,
        cwd,
        applyQuarantine: false,
      });
      gcPid = Number(readFileSync(path.join(cwd, 'gc.pid'), 'utf8'));
      expect(result.finalExitCode).toBe(1);
      expect(await waitDead(gcPid)).toBe(true);
    } finally {
      if (gcPid && alive(gcPid)) process.kill(gcPid, 'SIGKILL');
    }
  }, 30_000);

  it('SIGINT forwards to the whole tree, stops the loop and exits 130', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'parent.js'), PARENT, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let gcPid = 0;
    try {
      const pending = runLive(['node', 'parent.js'], cfg({ reports: [] }), {
        retries: 2,
        cwd,
        applyQuarantine: false,
      });
      await waitFile(path.join(cwd, 'gc.pid'));
      gcPid = Number(readFileSync(path.join(cwd, 'gc.pid'), 'utf8'));
      process.emit('SIGINT', 'SIGINT');
      const result = await pending;
      expect(result.finalExitCode).toBe(130);
      expect(await waitDead(gcPid)).toBe(true);
    } finally {
      if (gcPid && alive(gcPid)) process.kill(gcPid, 'SIGKILL');
    }
  }, 30_000);
});

describe('corrupt quarantine file (R5 bug 9)', () => {
  it('run warns and proceeds without exclusions instead of crashing', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'script.js'), SCRIPT_ALL_PASS, 'utf8');
    // torn write: truncated JSON
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      '{"version":1,"entries":[{"te',
      'utf8',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ runner: 'jest' }), {
      retries: 0,
      cwd,
      applyQuarantine: true,
    });
    expect(result.finalExitCode).toBe(0);
    expect(result.verdicts.map((v) => v.name)).toEqual(['stable test']);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('WITHOUT quarantine exclusions')),
    ).toBe(true);
  }, 60_000);
});

describe('user-supplied name selector (R5 optional)', () => {
  it('detects a selector the injected flag would override', async () => {
    const { userSelectorClash } = await import('./wrap.js');
    expect(userSelectorClash(['jest', '-t', 'foo'], ['-t', 'x'])).toBe(true);
    expect(userSelectorClash(['jest', '--testNamePattern=foo'], ['-t', 'x'])).toBe(true);
    expect(userSelectorClash(['mocha', '-g', 'foo'], ['--grep', 'x'])).toBe(true);
    expect(userSelectorClash(['go', 'test', '-run=TestA', './...'], ['-run', 'x'])).toBe(true);
    expect(userSelectorClash(['jest', '--ci'], ['-t', 'x'])).toBe(false);
    expect(userSelectorClash(['pytest', '-k', 'foo'], ['--lf'])).toBe(false);
    expect(userSelectorClash(['jest'], [])).toBe(false);
    // a -t in a later shell segment belongs to another command
    expect(userSelectorClash(['jest', '|', 'grep', '-t', 'x'], ['-t', 'x'])).toBe(false);
  });

  it('runLive merges (not warns about) a user -t, and says so once', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'script.js'), SCRIPT_ALL_PASS, 'utf8');
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'x',
            suite: 's.test.js',
            name: 'q',
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
    await runLive(['node', 'script.js', '-t', 'mine'], cfg({ runner: 'jest' }), {
      retries: 0,
      cwd,
      applyQuarantine: true,
    });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('name selector'))).toHaveLength(0);
    expect(
      log.mock.calls.filter((c) => String(c[0]).includes('combined your own -t')),
    ).toHaveLength(1);
  }, 60_000);
});

describe('exit gate uses the last REAL execution (QA RUN-2)', () => {
  it('a failure followed by a retry that only reports it as skipped still exits 1', async () => {
    const cwd = tmpCwd();
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c8.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c8.txt', String(n));
const mk = (title, status) => ({ title, fullName: title, status, ancestorTitles: [], duration: 3, failureMessages: [] });
// attempt 2: the selector missed, so the runner skipped everything and exited 0
const results = n === 1 ? [mk('broken', 'failed'), mk('ok', 'passed')] : [mk('broken', 'pending'), mk('ok', 'pending')];
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: n === 1 ? 'failed' : 'passed', assertionResults: results }] }));
process.exit(n === 1 ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ runner: 'jest' }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    expect(result.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(result.finalExitCode).toBe(1);
  }, 60_000);
});

describe('quarantined / skip-only tests stay out of the exit gates (QA RUN-5)', () => {
  it('a quarantined flake reported as skipped does not trip --fail-on-flake', async () => {
    const cwd = tmpCwd();
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c9.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c9.txt', String(n));
const mk = (title, status) => ({ title, fullName: title, status, ancestorTitles: [], duration: 3, failureMessages: [] });
// run 1: alpha fails then passes (retry rescue). Later: alpha is excluded → skipped.
const alpha = n === 1 ? 'failed' : n === 2 ? 'passed' : 'pending';
const results = [mk('alpha', alpha), mk('gamma', 'passed')];
const failed = alpha === 'failed';
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: failed ? 'failed' : 'passed', assertionResults: results }] }));
process.exit(failed ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await runLive(['node', 'script.js'], cfg({ runner: 'jest' }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    const alpha = first.verdicts.find((v) => v.name === 'alpha')!;
    expect(alpha.classification).toBe('flaky-retry');
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: alpha.testId,
            suite: alpha.suite,
            name: 'alpha',
            reason: 'flaky',
            quarantinedAt: new Date().toISOString(),
            flakeScore: 40,
          },
        ],
      }),
      'utf8',
    );
    const second = await runLive(
      ['node', 'script.js'],
      cfg({ runner: 'jest', failOnFlakes: true }),
      {
        retries: 1,
        cwd,
        applyQuarantine: true,
      },
    );
    expect(second.finalExitCode).toBe(0);
  }, 60_000);
});

describe("user's own name selector is merged, not overridden (QA RUN-3)", () => {
  it('folds jest -t / --testNamePattern= into the injected pattern as a lookahead', async () => {
    const { mergeUserSelector } = await import('./wrap.js');
    const q = '^(?!(?:.* )?(?:alpha)\\s*$)';
    const m = mergeUserSelector(['npx', 'jest', '-t', 'gamma', '--ci'], ['-t', q]);
    expect(m.command).toEqual(['npx', 'jest', '--ci']);
    expect(m.userPatterns).toEqual(['gamma']);
    const re = new RegExp(m.extraArgs[1]!, 'i'); // jest compiles -t case-insensitively
    expect(re.test('suite A gamma')).toBe(true); // user filter AND not quarantined
    expect(re.test('suite A alpha')).toBe(false); // quarantined
    expect(re.test('suite A delta')).toBe(false); // outside the user's filter
    const eq = mergeUserSelector(['jest', '--testNamePattern=gam'], ['-t', q]);
    expect(eq.command).toEqual(['jest']);
    expect(new RegExp(eq.extraArgs[1]!).test('x gamma')).toBe(true);
  });

  it('mocha: --grep "/re/" form and literal --fgrep; --invert is left alone', async () => {
    const { mergeUserSelector } = await import('./wrap.js');
    const ours = '^(?:.* )?(?:b)\\s*$';
    const g = mergeUserSelector(['mocha', '--grep', '/api/'], ['--grep', ours]);
    expect(g.command).toEqual(['mocha']);
    expect(new RegExp(g.extraArgs[1]!).test('api b')).toBe(true);
    expect(new RegExp(g.extraArgs[1]!).test('web b')).toBe(false);
    const f = mergeUserSelector(['mocha', '--fgrep', 'a.b'], ['--grep', ours]);
    expect(new RegExp(f.extraArgs[1]!).test('axb b')).toBe(false); // literal dot
    expect(new RegExp(f.extraArgs[1]!).test('a.b b')).toBe(true);
    const inv = mergeUserSelector(['mocha', '--grep', 'x', '--invert'], ['--grep', ours]);
    expect(inv.userPatterns).toEqual([]);
    expect(inv.command).toEqual(['mocha', '--grep', 'x', '--invert']);
  });

  it('go -run and later shell segments are not touched', async () => {
    const { mergeUserSelector } = await import('./wrap.js');
    const go = mergeUserSelector(['go', 'test', '-run', 'TestA'], ['-run', '^(TestB)$']);
    expect(go.userPatterns).toEqual([]);
    const seg = mergeUserSelector(['jest', '&&', 'other', '-t', 'x'], ['-t', '^a']);
    expect(seg.command).toEqual(['jest', '&&', 'other', '-t', 'x']);
  });

  it('runLive: a user -t plus quarantine runs the user-selected tests', async () => {
    const cwd = tmpCwd();
    writeFileSync(
      path.join(cwd, 'echo-args.js'),
      "require('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));",
      'utf8',
    );
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'x',
            suite: 's',
            name: 'alpha',
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
    await runLive(['node', 'echo-args.js', '-t', 'gamma'], cfg({ reports: [], runner: 'jest' }), {
      retries: 0,
      cwd,
      applyQuarantine: true,
    });
    const argv = JSON.parse(readFileSync(path.join(cwd, 'argv.json'), 'utf8')) as string[];
    expect(argv.filter((a) => a === '-t')).toHaveLength(1); // exactly one -t reaches jest
    const re = new RegExp(argv[argv.indexOf('-t') + 1]!, 'i');
    expect(re.test('suite gamma')).toBe(true);
    expect(re.test('suite alpha')).toBe(false);
  }, 60_000);
});

describe('selector length budget (QA RUN-4)', () => {
  it('thousands of failures fall back to a full re-run instead of E2BIG', async () => {
    const cwd = tmpCwd();
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c10.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c10.txt', String(n));
fs.writeFileSync('argv' + n + '.json', JSON.stringify(process.argv.slice(2)));
const results = [];
for (let i = 0; i < 2000; i++) {
  const title = 'many failures case number ' + i + ' with a reasonably descriptive test title here';
  results.push({ title, fullName: title, status: n === 1 ? 'failed' : 'passed', ancestorTitles: [], duration: 1, failureMessages: [] });
}
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: n === 1 ? 'failed' : 'passed', assertionResults: results }] }));
process.exit(n === 1 ? 1 : 0);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await runLive(['node', 'script.js'], cfg({ runner: 'jest' }), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    const argv2 = JSON.parse(readFileSync(path.join(cwd, 'argv2.json'), 'utf8')) as string[];
    expect(argv2).toEqual([]); // full re-run: no giant -t
    expect(result.attempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(result.finalExitCode).toBe(0); // every failure was rescued
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('over the') && l.includes('budget'))).toBe(true);
    expect(Math.max(...lines.map((l) => l.length))).toBeLessThan(1000);
  }, 60_000);
});

describe('pytest retries (QA RUN-7)', () => {
  // fake pytest: test_flaky fails on the first call, passes after; records argv per call
  const FAKE_PYTEST = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c11.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c11.txt', String(n));
fs.writeFileSync('argv' + n + '.json', JSON.stringify(process.argv.slice(2)));
const fail = n === 1 ? '<failure message="boom"/>' : '';
fs.writeFileSync('junit.xml', '<?xml version="1.0"?><testsuites><testsuite name="pytest">' +
  '<testcase classname="tests.test_x" name="test_flaky">' + fail + '</testcase>' +
  '<testcase classname="tests.test_x" name="test_ok"/></testsuite></testsuites>');
process.exit(n === 1 ? 1 : 0);
`;
  const quarantine = (cwd: string) =>
    writeFileSync(
      path.join(cwd, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: 'q',
            suite: 'tests.test_x',
            name: 'test_quarantined',
            reason: 'flaky',
            quarantinedAt: new Date().toISOString(),
            flakeScore: 90,
          },
        ],
      }),
      'utf8',
    );

  it('targeted --lf retries keep the --deselect quarantine flags', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'fake-pytest.js'), FAKE_PYTEST, 'utf8');
    quarantine(cwd);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runLive(['node', 'fake-pytest.js'], cfg({ reports: ['junit.xml'], runner: 'pytest' }), {
      retries: 1,
      cwd,
      applyQuarantine: true,
    });
    const argv2 = JSON.parse(readFileSync(path.join(cwd, 'argv2.json'), 'utf8')) as string[];
    expect(argv2).toEqual(['--deselect', 'tests/test_x.py::test_quarantined', '--lf']);
  }, 60_000);

  it('-p no:cacheprovider → full re-run instead of an unusable --lf', async () => {
    const { pytestCacheDisabled } = await import('./wrap.js');
    expect(pytestCacheDisabled(['pytest', '-p', 'no:cacheprovider'])).toBe(true);
    expect(pytestCacheDisabled(['pytest', '-pno:cacheprovider'])).toBe(true);
    expect(pytestCacheDisabled(['pytest', '-p', 'xdist'])).toBe(false);
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'fake-pytest.js'), FAKE_PYTEST, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runLive(
      ['node', 'fake-pytest.js', '-p', 'no:cacheprovider'],
      cfg({ reports: ['junit.xml'], runner: 'pytest' }),
      { retries: 1, cwd, applyQuarantine: false },
    );
    const argv2 = JSON.parse(readFileSync(path.join(cwd, 'argv2.json'), 'utf8')) as string[];
    expect(argv2).toEqual(['-p', 'no:cacheprovider']);
  }, 60_000);
});

describe('injection targets the runner segment (QA RUN-10)', () => {
  it('runnerSegment skips setup segments and env assignments', async () => {
    const { runnerSegment } = await import('./wrap.js');
    expect(runnerSegment(['cd', '.', '&&', 'npx', 'jest'])).toEqual({ cmd: 3, end: 5 });
    expect(runnerSegment(['jest', '|', 'tee', 'log'])).toEqual({ cmd: 0, end: 1 });
    expect(runnerSegment(['go', 'test', './...', '>', 'o.jsonl'])).toEqual({ cmd: 0, end: 3 });
    expect(runnerSegment(['CI=1', 'jest', '--ci'])).toEqual({ cmd: 1, end: 3 });
    expect(runnerSegment(['echo', 'x', ';', 'python', '-m', 'pytest'])).toEqual({ cmd: 3, end: 6 });
    expect(runnerSegment(['make', 'prep', '&&', 'node', 'run.js'])).toEqual({ cmd: 3, end: 5 });
    expect(runnerSegment(['./run-tests.sh', 'a'])).toEqual({ cmd: 0, end: 2 }); // unknown: first
  });

  it('insertRunnerArgs lands in the runner segment (with npm separator logic per segment)', async () => {
    const { insertRunnerArgs } = await import('./wrap.js');
    expect(insertRunnerArgs(['cd', '.', '&&', 'npx', 'jest'], ['-t', 'p'])).toEqual([
      'cd',
      '.',
      '&&',
      'npx',
      'jest',
      '-t',
      'p',
    ]);
    expect(insertRunnerArgs(['cd', 'app', '&&', 'npm', 'test', '>', 'o'], ['-t', 'p'])).toEqual([
      'cd',
      'app',
      '&&',
      'npm',
      'test',
      '--',
      '-t',
      'p',
      '>',
      'o',
    ]);
  });
});

describe('retries ingest only reports the attempt wrote (QA RUN-6)', () => {
  it('an untouched stale report and a crashed attempt add no observations', async () => {
    const cwd = tmpCwd();
    // a stale report from another job, never rewritten during this run
    writeFileSync(
      path.join(cwd, 'old.json'),
      JSON.stringify({
        testResults: [
          {
            name: 'old.test.js',
            status: 'failed',
            assertionResults: [
              {
                title: 'legacy',
                fullName: 'legacy',
                status: 'failed',
                ancestorTitles: [],
                duration: 1,
                failureMessages: ['x'],
              },
            ],
          },
        ],
      }),
      'utf8',
    );
    // attempt 1 writes out.json (alpha fails); attempts 2+ crash before writing
    const script = `
const fs = require('fs');
let n = 0;
try { n = parseInt(fs.readFileSync('c12.txt', 'utf8'), 10) || 0; } catch {}
n++;
fs.writeFileSync('c12.txt', String(n));
if (n >= 2) process.exit(139);
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 's.test.js', status: 'failed', assertionResults: [
  { title: 'alpha', fullName: 'alpha', status: 'failed', ancestorTitles: [], duration: 1, failureMessages: ['boom'] } ] }] }));
process.exit(1);
`;
    writeFileSync(path.join(cwd, 'script.js'), script, 'utf8');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runLive(
      ['node', 'script.js'],
      cfg({ reports: ['*.json'], runner: 'generic', minRuns: 3 }),
      { retries: 2, cwd, applyQuarantine: false },
    );
    expect(result.attempts.map((a) => a.attempt)).toEqual([1]); // only attempt 1 wrote a report
    expect(result.verdicts.map((v) => v.name)).toEqual(['alpha']); // stale `legacy` never ingested
    expect(result.verdicts[0]!.runsObserved).toBe(1);
    expect(result.finalExitCode).toBe(1);
  }, 60_000);
});
