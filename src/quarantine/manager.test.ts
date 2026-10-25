import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuarantineEntry, TestVerdict } from '../types.js';
import { exclusionArgs, QuarantineManager } from './manager.js';

let dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-q-'));
  dirs.push(dir);
  return path.join(dir, 'flakefinder.quarantine.json');
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function entry(
  testId: string,
  name = `n-${testId}`,
  over: Partial<QuarantineEntry> = {},
): QuarantineEntry {
  return {
    testId,
    suite: 's.ts',
    name,
    reason: 'flaky',
    quarantinedAt: new Date().toISOString(),
    flakeScore: 80,
    ...over,
  };
}

function verdict(testId: string, over: Partial<TestVerdict> = {}): TestVerdict {
  return {
    testId,
    suite: 's.ts',
    name: `n-${testId}`,
    classification: 'flaky-confirmed',
    tags: [],
    flakeScore: 80,
    confidence: 100,
    passRate: 0.5,
    runsObserved: 6,
    lastStatus: 'fail',
    lastSeen: new Date().toISOString(),
    medianDurationMs: null,
    p95DurationMs: null,
    sameShaFlips: 2,
    retryRescues: 0,
    directionChanges: 1,
    ...over,
  };
}

describe('QuarantineManager', () => {
  it('starts empty without a file and round-trips through save/load', () => {
    const file = tmpFile();
    const qm = new QuarantineManager(file);
    expect(qm.list()).toEqual([]);
    qm.add(entry('t1'));
    qm.add(entry('t2'));
    qm.save();
    const reloaded = new QuarantineManager(file);
    expect(reloaded.list().map((e) => e.testId)).toEqual(['t1', 't2']);
  });

  it('add replaces same testId', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(entry('t1', 'old-name'));
    qm.add(entry('t1', 'new-name'));
    expect(qm.list()).toHaveLength(1);
    expect(qm.list()[0]!.name).toBe('new-name');
  });

  it('remove reports whether the id existed', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(entry('t1'));
    expect(qm.remove('nope')).toBe(false);
    expect(qm.remove('t1')).toBe(true);
    expect(qm.list()).toEqual([]);
  });

  it('prune removes entries with positive evidence of health (passing ≥ 10 runs)', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(entry('healthy'));
    qm.add(entry('still-flaky'));
    const removed = qm.prune([
      verdict('healthy', { classification: 'passing', runsObserved: 12 }),
      verdict('still-flaky', { classification: 'flaky-confirmed' }),
    ]);
    expect(removed.map((e) => e.testId)).toEqual(['healthy']);
    expect(qm.list().map((e) => e.testId)).toEqual(['still-flaky']);
  });

  it('prune does NOT remove unseen tests (quarantine excludes them from runs)', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(entry('excluded')); // never appears in verdicts because it is excluded
    const removed = qm.prune([verdict('other')]);
    expect(removed).toEqual([]);
    expect(qm.list()).toHaveLength(1);
  });

  it('prune removes gone entries older than 90 days, keeps fresh ones', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(
      entry('old-gone', 'x', {
        quarantinedAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
      }),
    );
    qm.add(
      entry('new-gone', 'y', {
        quarantinedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      }),
    );
    const removed = qm.prune([
      verdict('old-gone', { classification: 'gone' }),
      verdict('new-gone', { classification: 'gone' }),
    ]);
    expect(removed.map((e) => e.testId)).toEqual(['old-gone']);
    expect(qm.list().map((e) => e.testId)).toEqual(['new-gone']);
  });

  it('prune is a no-op with no verdicts (no history to reason about)', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(entry('t1'));
    expect(qm.prune([])).toEqual([]);
    expect(qm.list()).toHaveLength(1);
  });

  it('corrupt file throws with the path', () => {
    const file = tmpFile();
    writeFileSync(file, '{ nope', 'utf8');
    expect(() => new QuarantineManager(file)).toThrow(file);
  });
});

describe('exclusionArgs', () => {
  it('pytest: --deselect per entry', () => {
    const args = exclusionArgs('pytest', [entry('a', 'test_one'), entry('b', 'test_two')]);
    expect(args).toEqual(['--deselect', 's.ts::test_one', '--deselect', 's.ts::test_two']);
  });
  it('jest: single -t negative-lookahead pattern, names regex-escaped and deduped', () => {
    const args = exclusionArgs('jest', [
      entry('a', 'does (x)'),
      entry('b', 'does (x)'),
      entry('c', 'plain'),
    ]);
    expect(args[0]).toBe('-t');
    expect(args[1]).toBe('^(?!.*(?:does \\(x\\)|plain))');
  });
  it('mocha: --grep with the same construction', () => {
    const args = exclusionArgs('mocha', [entry('a', 'one')]);
    expect(args).toEqual(['--grep', '^(?!.*(?:one))']);
  });
  it('go and generic: no exclusion support', () => {
    expect(exclusionArgs('go', [entry('a')])).toEqual([]);
    expect(exclusionArgs('generic', [entry('a')])).toEqual([]);
  });
  it('no entries → no args', () => {
    expect(exclusionArgs('pytest', [])).toEqual([]);
  });
});
