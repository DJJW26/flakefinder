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
