import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../types.js';
import { HistoryStore, snapshotPath } from './history-store.js';

let dirs: string[] = [];

function tmpStore(): HistoryStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-store-'));
  dirs.push(dir);
  return new HistoryStore(dir);
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function record(runId: string, status: string): RunRecord {
  return {
    runId,
    timestamp: new Date().toISOString(),
    source: 'report',
    parsedFrom: 'junit',
    attempt: 1,
    results: [
      {
        testId: `id-${runId}`,
        suite: 's.ts',
        name: `n-${runId}`,
        status: status as RunRecord['results'][number]['status'],
        durationMs: null,
      },
    ],
  };
}

describe('HistoryStore', () => {
  it('append → new instance loadAll round-trip', () => {
    const a = tmpStore();
    const first = record('r1', 'pass');
    const second = record('r2', 'fail');
    a.append(first);
    a.append(second);
    const b = new HistoryStore(path.dirname(a.path));
    const loaded = b.loadAll();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]).toEqual(first);
    expect(loaded[1]).toEqual(second);
  });

  it('skips corrupt lines, records warnings, keeps good lines', () => {
    const a = tmpStore();
    const good = record('good1', 'pass');
    a.append(good);
    appendFileSync(a.path, '{ this is not json\n', 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    const loaded = b.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toEqual(good);
    expect(b.warnings.length).toBeGreaterThan(0);
    expect(b.warnings[0]).toContain('corrupt');
  });

  it('prune keeps only the last N records and rewrites the file atomically', () => {
    const a = tmpStore();
    for (let i = 1; i <= 10; i++) a.append(record(`r${i}`, 'pass'));
    a.prune(4);
    const runs = a.runs();
    expect(runs.map((r) => r.runId)).toEqual(['r7', 'r8', 'r9', 'r10']);
    const onDisk = readFileSync(a.path, 'utf8').trim().split('\n');
    expect(onDisk).toHaveLength(4);
    // no leftover tmp file
    expect(() => readFileSync(`${a.path}.tmp`, 'utf8')).toThrow();
  });

  it('prune is a no-op when under the limit', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    a.prune(300);
    expect(a.runs()).toHaveLength(1);
  });

  it('append after prune continues from the pruned state', () => {
    const a = tmpStore();
    for (let i = 1; i <= 5; i++) a.append(record(`r${i}`, 'pass'));
    a.prune(2); // keeps r4, r5
    a.append(record('r6', 'pass'));
    const fresh = new HistoryStore(path.dirname(a.path));
    expect(fresh.loadAll().map((r) => r.runId)).toEqual(['r4', 'r5', 'r6']);
  });

  it('warnings cap at 10 entries', () => {
    const a = tmpStore();
    for (let i = 0; i < 25; i++) appendFileSync(a.path, `garbage-${i}\n`, 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    b.loadAll();
    expect(b.warnings).toHaveLength(10);
  });

  it('snapshotPath lives inside the store dir', () => {
    expect(snapshotPath(path.join('x', 'y'))).toBe(path.join('x', 'y', 'verdicts-snapshot.json'));
  });
});

describe('store format header (v0.2.0)', () => {
  it('writes a {"version":1} header when creating the file', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    const lines = readFileSync(a.path, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]!)).toEqual({ version: 1 });
    expect(JSON.parse(lines[1]!).runId).toBe('r1');
    expect(a.formatVersion).toBe(1);
  });

  it('loads legacy header-less stores (formatVersion null, records intact)', () => {
    const a = tmpStore();
    a.append(record('legacy', 'pass'));
    // strip the header to simulate a v0.1.x store
    const body = `${readFileSync(a.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(1)
      .join('\n')}\n`;
    writeFileSync(a.path, body, 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    expect(b.formatVersion).toBeNull();
    expect(b.loadAll()).toHaveLength(1);
    expect(b.loadAll()[0]!.runId).toBe('legacy');
  });

  it('prune inserts the header on rewrite of a legacy store', () => {
    const a = tmpStore();
    for (let i = 1; i <= 6; i++) a.append(record(`r${i}`, 'pass'));
    const body = `${readFileSync(a.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(1)
      .join('\n')}\n`;
    writeFileSync(a.path, body, 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    b.prune(2);
    const lines = readFileSync(b.path, 'utf8').trim().split('\n');
    expect(JSON.parse(lines[0]!)).toEqual({ version: 1 });
    expect(lines).toHaveLength(3);
  });
});

describe('store robustness (review round)', () => {
  it('skips a schema marker that appears mid-file (merged/partial writes) without crashing', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    appendFileSync(a.path, `${JSON.stringify({ version: 1 })}\n`, 'utf8');
    a.append(record('r2', 'fail'));
    const b = new HistoryStore(path.dirname(a.path));
    expect(b.loadAll().map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(b.warnings.some((w) => w.includes('schema marker'))).toBe(true);
  });

  it('skips garbage and invalid records instead of crashing the classifier', () => {
    const a = tmpStore();
    a.append(record('good', 'pass'));
    appendFileSync(a.path, `${JSON.stringify({ version: '1' })}\n`, 'utf8');
    appendFileSync(
      a.path,
      `${JSON.stringify({ runId: 'x', timestamp: 't', source: 'report' })}\n`,
      'utf8',
    );
    const b = new HistoryStore(path.dirname(a.path));
    expect(b.loadAll().map((r) => r.runId)).toEqual(['good']);
    expect(b.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('warns when the store format is newer than this build', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    const body = readFileSync(a.path, 'utf8').split('\n');
    body[0] = JSON.stringify({ version: 999 });
    writeFileSync(a.path, body.join('\n'), 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    b.loadAll();
    expect(b.warnings[0]).toContain('newer than this flakefinder');
  });
});

describe('store concurrency lock (C1)', () => {
  it('serializes appends and releases the lock afterwards', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    a.append(record('r2', 'pass'));
    expect(existsSync(`${a.path}.lock`)).toBe(false); // released
    const b = new HistoryStore(path.dirname(a.path));
    b.append(record('r3', 'fail')); // not blocked
    expect(b.loadAll().map((r) => r.runId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('errors with an actionable message when a fresh lock is held', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    writeFileSync(`${a.path}.lock`, JSON.stringify({ pid: 999999, epoch: Date.now() }), 'utf8');
    let msg = '';
    try {
      a.append(record('r2', 'pass'));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain('history store is busy');
    expect(msg).toContain('serially, or give each CI shard');
    // the failed append must NOT have been written
    expect(a.runs().map((r) => r.runId)).toEqual(['r1']);
  });

  it('steals a stale lock older than 30s (abandoned by a dead process)', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    const stale = Date.now() - 31_000;
    writeFileSync(`${a.path}.lock`, JSON.stringify({ pid: 123, epoch: stale }), 'utf8');
    a.append(record('r2', 'pass'));
    expect(a.runs().map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(existsSync(`${a.path}.lock`)).toBe(false);
  });
});

describe('prune fresh-read under lock (QA A2)', () => {
  it('stale instance prune does NOT delete records another instance appended', () => {
    // instance A seeds 3 records and stays loaded (stale view)
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    a.append(record('r2', 'pass'));
    a.append(record('r3', 'pass'));
    // instance B (fresh view of the same store) appends r4
    const b = new HistoryStore(path.dirname(a.path));
    b.append(record('r4', 'pass'));
    // stale instance A prunes to 3 — must keep the LAST 3 of the FRESH file
    a.prune(3);
    const onDisk = readFileSync(a.path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => (JSON.parse(l) as { runId: string }).runId);
    expect(onDisk).toEqual(['r2', 'r3', 'r4']); // r4 survived (was deleted before the fix)
    // and A's in-memory view resynced
    expect(a.runs().map((r) => r.runId)).toEqual(['r2', 'r3', 'r4']);
  });
});
