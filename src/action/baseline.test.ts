import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotPath } from '../store/history-store.js';
import type { TestVerdict } from '../types.js';
import { baselinePath, cacheKeys, recordBaseline, resolveBaseline } from './baseline.js';
import { computeNewFlakes } from './diff.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function storeDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ff-baseline-'));
  dirs.push(d);
  return path.join(d, '.flakefinder');
}

function v(testId: string, classification: TestVerdict['classification']): TestVerdict {
  return {
    testId,
    suite: 's',
    name: testId,
    classification,
    tags: [],
    flakeScore: classification.startsWith('flaky') ? 70 : 0,
    confidence: 100,
    passRate: 0.5,
    runsObserved: 5,
    lastStatus: 'pass',
    lastSeen: new Date().toISOString(),
    medianDurationMs: null,
    p95DurationMs: null,
    sameShaFlips: 0,
    retryRescues: 0,
    directionChanges: 0,
  };
}

/** One action execution against a (restored) store dir — mirrors action/index.ts steps 2 + 4. */
function actionRun(dir: string, runId: string, verdicts: TestVerdict[]): TestVerdict[] {
  const { previous } = resolveBaseline(dir, runId);
  const newFlakes = computeNewFlakes(verdicts, previous);
  mkdirSync(dir, { recursive: true });
  writeFileSync(snapshotPath(dir), JSON.stringify(verdicts), 'utf8');
  recordBaseline(dir, runId, previous);
  return newFlakes;
}

describe('cache keys (R5 #11)', () => {
  it('save key is unique per run attempt and job; restore is by prefix', () => {
    const a1 = cacheKeys({ sha: 'abc', runId: '100', runAttempt: '1', job: 'test' });
    const a2 = cacheKeys({ sha: 'abc', runId: '100', runAttempt: '2', job: 'test' });
    expect(a1.saveKey).toMatch(/^flakefinder-history-[0-9a-f]{8}-abc-100-1$/);
    expect(a2.saveKey).not.toBe(a1.saveKey);
    expect(a1.restoreKeys).toEqual([a1.saveKey.slice(0, 29), 'flakefinder-history-']);
    expect(a1.saveKey.startsWith(a1.restoreKeys[0]!)).toBe(true);
  });
});

describe('cache key scope (QA ACT-4)', () => {
  const gh = { sha: 'abc', runId: '100', runAttempt: '1', job: 'test' };
  it('matrix legs with distinct history-keys get distinct save keys AND restore prefixes', () => {
    const a = cacheKeys(gh, { workingDirectory: '.', historyKey: 'node18' });
    const b = cacheKeys(gh, { workingDirectory: '.', historyKey: 'node20' });
    expect(a.saveKey).not.toBe(b.saveKey);
    expect(a.restoreKeys[0]).not.toBe(b.restoreKeys[0]);
    expect(b.saveKey.startsWith(a.restoreKeys[0]!)).toBe(false); // A never restores B first
  });
  it('two steps on different working directories do not collide', () => {
    const a = cacheKeys(gh, { workingDirectory: 'packages/a', historyKey: '' });
    const b = cacheKeys(gh, { workingDirectory: 'packages/b', historyKey: '' });
    expect(a.saveKey).not.toBe(b.saveKey);
  });
  it('the stream id is stable across runs, branches and attempts', () => {
    const s = { workingDirectory: '.', historyKey: '' };
    const k1 = cacheKeys(gh, s);
    const k2 = cacheKeys({ ...gh, sha: 'def', runId: '200', runAttempt: '3' }, s);
    expect(k1.restoreKeys).toEqual(k2.restoreKeys);
    expect(k2.saveKey.startsWith(k1.restoreKeys[0]!)).toBe(true);
  });
});

describe('re-running a failed job does not bypass fail-on-new-flakes (R5 #11)', () => {
  it('attempt 2 restores attempt 1’s cache but still diffs against the pre-run baseline', () => {
    const dir = storeDir();
    // state from the base branch's last run: nothing flaky
    actionRun(dir, 'base-run', [v('a', 'passing'), v('b', 'passing')]);

    // PR run 500, attempt 1: `a` became flaky → gate fails
    const attempt1 = actionRun(dir, '500', [v('a', 'flaky-confirmed'), v('b', 'passing')]);
    expect(attempt1.map((x) => x.testId)).toEqual(['a']);

    // attempt 2 (same run id) restores the cache attempt 1 saved — whose
    // snapshot already says `a` is flaky. It must still be NEW.
    const attempt2 = actionRun(dir, '500', [v('a', 'flaky-confirmed'), v('b', 'passing')]);
    expect(attempt2.map((x) => x.testId)).toEqual(['a']);
    const attempt3 = actionRun(dir, '500', [v('a', 'flaky-confirmed'), v('b', 'passing')]);
    expect(attempt3.map((x) => x.testId)).toEqual(['a']);
  });

  it('a later, different run diffs against the previous run’s snapshot as before', () => {
    const dir = storeDir();
    actionRun(dir, '500', [v('a', 'flaky-confirmed')]);
    expect(actionRun(dir, '501', [v('a', 'flaky-confirmed')])).toEqual([]); // known flake
    expect(resolveBaseline(dir, '502').source).toBe('snapshot');
  });

  it('first run: no snapshot → null baseline; corrupt snapshot → warning', () => {
    const dir = storeDir();
    expect(resolveBaseline(dir, '1')).toEqual({ previous: null, source: 'none', warnings: [] });
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath(dir), '{nope', 'utf8');
    expect(resolveBaseline(dir, '1').warnings[0]).toContain('unreadable');
  });

  it('a first-run baseline (null) is reused on re-run: everything flaky stays new', () => {
    const dir = storeDir();
    expect(actionRun(dir, '7', [v('a', 'flaky-retry')])).toHaveLength(1);
    expect(actionRun(dir, '7', [v('a', 'flaky-retry')])).toHaveLength(1);
  });

  it('resolveBaseline does not create the store dir (read-only until recordBaseline)', () => {
    const dir = storeDir();
    resolveBaseline(dir, '1');
    expect(existsSync(dir)).toBe(false);
    recordBaseline(dir, '1', null);
    expect(existsSync(baselinePath(dir))).toBe(true);
  });
});
