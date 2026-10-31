import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunRecord } from '../types.js';
import {
  breakStaleLock,
  HistoryStore,
  lastRuns,
  snapshotPath,
  subscribeStoreWarnings,
} from './history-store.js';

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
    expect(onDisk).toHaveLength(5); // header + 4 records
    expect(JSON.parse(onDisk[0]!)).toEqual({ version: 1 });
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
      .map((l) => (JSON.parse(l) as { runId?: string }).runId)
      .filter((id): id is string => id !== undefined); // skip the schema header line
    expect(onDisk).toEqual(['r2', 'r3', 'r4']); // r4 survived (was deleted before the fix)
    // and A's in-memory view resynced
    expect(a.runs().map((r) => r.runId)).toEqual(['r2', 'r3', 'r4']);
  });
});

describe('read paths do not create directories (QA A4)', () => {
  it('constructing + runs() on a missing storeDir creates nothing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-nomkdir-'));
    dirs.push(dir);
    const storeDir = path.join(dir, 'does-not-exist');
    const s = new HistoryStore(storeDir);
    expect(s.runs()).toEqual([]);
    expect(existsSync(storeDir)).toBe(false);
  });
  it('append creates the directory on demand', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-nomkdir-'));
    dirs.push(dir);
    const storeDir = path.join(dir, 'created-on-write');
    const s = new HistoryStore(storeDir);
    s.append(record('r1', 'pass'));
    expect(existsSync(storeDir)).toBe(true);
    expect(s.runs()).toHaveLength(1);
  });
});

describe('history.jsonl as a directory degrades gracefully (QA A5)', () => {
  function dirShapedStore(): HistoryStore {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-eisdir-'));
    dirs.push(dir);
    const s = new HistoryStore(dir);
    // constructor no longer mkdirs; create the dir-shaped store file ourselves
    mkdirSync(s.path, { recursive: true });
    return s;
  }

  it('runs() returns [] with a warning and flags the store unreadable instead of throwing EISDIR', () => {
    const s = dirShapedStore();
    expect(s.runs()).toEqual([]);
    expect(s.warnings).toEqual([`history store unreadable (EISDIR): ${s.path}`]);
    expect(s.unreadable).toMatch(/^EISDIR: /);
  });

  it('append fails with an actionable message naming the path, not a raw EISDIR', () => {
    const s = dirShapedStore();
    let message = '';
    try {
      s.append(record('r1', 'pass'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(s.path);
    expect(message).toContain('is not a regular file');
    expect(message).toContain('delete or rename it');
    expect(message).not.toContain('EISDIR');
    // the lock was not left behind (nor even taken)
    expect(existsSync(`${s.path}.lock`)).toBe(false);
  });

  it('prune on a dir-shaped store is a no-op, not a crash', () => {
    const s = dirShapedStore();
    expect(() => s.prune(1)).not.toThrow();
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'an unreadable regular file (EACCES) is flagged unreadable; append names the path',
    () => {
      const s = tmpStore();
      s.append(record('r1', 'pass'));
      chmodSync(s.path, 0o000);
      try {
        const fresh = new HistoryStore(path.dirname(s.path));
        expect(fresh.runs()).toEqual([]);
        expect(fresh.unreadable).toMatch(/^EACCES: /);
        expect(() => fresh.append(record('r2', 'pass'))).toThrow(
          `cannot write history store ${s.path} (EACCES)`,
        );
        expect(existsSync(`${s.path}.lock`)).toBe(false);
      } finally {
        chmodSync(s.path, 0o644);
      }
    },
  );

  it('a readable store is not flagged unreadable', () => {
    const s = tmpStore();
    s.append(record('r1', 'pass'));
    const fresh = new HistoryStore(path.dirname(s.path));
    expect(fresh.runs()).toHaveLength(1);
    expect(fresh.unreadable).toBeNull();
  });
});

describe('prune keeps the format header (R5 #1)', () => {
  function headerOf(p: string): unknown {
    return JSON.parse(readFileSync(p, 'utf8').split('\n')[0]!);
  }

  it('a store WITH a header keeps it across repeated prunes (no flip-flop)', () => {
    const a = tmpStore();
    for (let i = 1; i <= 6; i++) a.append(record(`r${i}`, 'pass'));
    a.prune(4);
    expect(headerOf(a.path)).toEqual({ version: 1 });
    a.append(record('r7', 'pass'));
    a.prune(3);
    expect(headerOf(a.path)).toEqual({ version: 1 });
    const fresh = new HistoryStore(path.dirname(a.path));
    expect(fresh.loadAll().map((r) => r.runId)).toEqual(['r5', 'r6', 'r7']);
    expect(fresh.formatVersion).toBe(1);
    expect(fresh.warnings).toEqual([]);
  });

  it('a newer-version header is preserved, not downgraded', () => {
    const a = tmpStore();
    for (let i = 1; i <= 4; i++) a.append(record(`r${i}`, 'pass'));
    const lines = readFileSync(a.path, 'utf8').split('\n');
    lines[0] = JSON.stringify({ version: 7 });
    writeFileSync(a.path, lines.join('\n'), 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    b.prune(2);
    expect(headerOf(b.path)).toEqual({ version: 7 });
    expect(b.formatVersion).toBe(7);
  });
});

describe('prune never restores stale data (R5 #3)', () => {
  it('a store emptied by another process is not refilled from the stale in-memory view', () => {
    const a = tmpStore();
    for (let i = 1; i <= 5; i++) a.append(record(`r${i}`, 'pass'));
    expect(a.runs()).toHaveLength(5); // A is loaded (stale view from here on)
    // another process resets the store to header-only
    writeFileSync(a.path, `${JSON.stringify({ version: 1 })}\n`, 'utf8');
    a.prune(2);
    expect(a.runs()).toEqual([]);
    const fresh = new HistoryStore(path.dirname(a.path));
    expect(fresh.loadAll()).toEqual([]);
  });

  it('a store that became unreadable under the lock is not rewritten', () => {
    const a = tmpStore();
    for (let i = 1; i <= 5; i++) a.append(record(`r${i}`, 'pass'));
    expect(a.runs()).toHaveLength(5);
    rmSync(a.path);
    mkdirSync(a.path); // now a directory: fresh read fails with EISDIR
    expect(() => a.prune(2)).not.toThrow();
    expect(a.runs()).toHaveLength(5); // in-memory view kept, nothing invented on disk
    expect(a.warnings.some((w) => w.includes('unreadable'))).toBe(true);
  });

  it('prune on a never-loaded instance adopts the unreadable state of the fresh read', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-prune-eisdir-'));
    dirs.push(dir);
    const s = new HistoryStore(dir);
    mkdirSync(s.path);
    expect(() => s.prune(1)).not.toThrow();
    expect(s.unreadable).toMatch(/^EISDIR: /);
    expect(s.runs()).toEqual([]);
  });
});

describe('append does not load the whole store (R5 #4)', () => {
  it('append on a fresh instance writes without populating warnings from a full read', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    appendFileSync(a.path, 'garbage\n', 'utf8');
    const b = new HistoryStore(path.dirname(a.path));
    b.append(record('r2', 'pass'));
    // nothing was read yet: no corrupt-line warning collected by append itself
    expect(b.warnings).toEqual([]);
    // reads are still complete and include the appended record
    expect(b.runs().map((r) => r.runId)).toEqual(['r1', 'r2']);
    expect(b.warnings.some((w) => w.includes('corrupt'))).toBe(true);
  });

  it('append on a loaded instance keeps the in-memory view in sync', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    expect(a.runs()).toHaveLength(1);
    a.append(record('r2', 'pass'));
    expect(a.runs().map((r) => r.runId)).toEqual(['r1', 'r2']);
  });
});

describe('lock cannot be stolen from a live holder (R5 #2)', () => {
  it('an EMPTY lock file with a fresh mtime is treated as held, not stale', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    // a competitor between create (wx) and write: file exists but is empty
    writeFileSync(`${a.path}.lock`, '', 'utf8');
    expect(() => a.append(record('r2', 'pass'))).toThrow('history store is busy');
    expect(existsSync(`${a.path}.lock`)).toBe(true); // not stolen
    expect(new HistoryStore(path.dirname(a.path)).runs().map((r) => r.runId)).toEqual(['r1']);
  });

  it('an empty or unparseable lock is stolen once its mtime is older than 30s', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    const lock = `${a.path}.lock`;
    writeFileSync(lock, '{"pid":12', 'utf8');
    const old = new Date(Date.now() - 31_000);
    utimesSync(lock, old, old);
    a.append(record('r2', 'pass'));
    expect(existsSync(lock)).toBe(false);
    expect(a.runs().map((r) => r.runId)).toEqual(['r1', 'r2']);
  });

  it('breakStaleLock refuses to remove a lock that was re-acquired after the stale read', () => {
    const a = tmpStore();
    mkdirSync(path.dirname(a.path), { recursive: true });
    const lock = `${a.path}.lock`;
    // waiter 1 already broke the stale lock and re-acquired: fresh content
    const live = JSON.stringify({ pid: 1, epoch: Date.now() });
    writeFileSync(lock, live, 'utf8');
    // waiter 2 still believes it saw a stale lock
    const staleSeen = JSON.stringify({ pid: 2, epoch: Date.now() - 60_000 });
    expect(breakStaleLock(lock, staleSeen)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(live); // live holder's lock intact
    // even when the content matches, a lock whose own age is fresh is kept
    expect(breakStaleLock(lock, live)).toBe(false);
    expect(readFileSync(lock, 'utf8')).toBe(live);
  });

  it('breakStaleLock removes a genuinely stale lock and leaves no side files', () => {
    const a = tmpStore();
    const dir = path.dirname(a.path);
    const lock = `${a.path}.lock`;
    const stale = JSON.stringify({ pid: 2, epoch: Date.now() - 60_000 });
    writeFileSync(lock, stale, 'utf8');
    expect(breakStaleLock(lock, stale)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('release does not delete a lock that another process now holds', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    const lock = `${a.path}.lock`;
    // after a normal append, no lock and no temp files are left behind
    expect(readdirSync(path.dirname(a.path)).sort()).toEqual(['history.jsonl']);
    // a foreign lock must survive an unrelated instance's release path
    const foreign = JSON.stringify({ pid: 4242, epoch: Date.now() });
    writeFileSync(lock, foreign, 'utf8');
    expect(() => a.append(record('r2', 'pass'))).toThrow('busy');
    expect(readFileSync(lock, 'utf8')).toBe(foreign);
  });
});

describe('lock failures that retrying cannot fix (QA CLI-1/CLI-12)', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a read-only store dir fails fast with a clear error instead of spinning forever',
    () => {
      const a = tmpStore();
      a.append(record('r1', 'pass'));
      const dir = path.dirname(a.path);
      chmodSync(dir, 0o555);
      try {
        const t0 = Date.now();
        expect(() => new HistoryStore(dir).append(record('r2', 'pass'))).toThrow(
          /lock .* cannot be created \(EACCES\).*writable/,
        );
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(() => new HistoryStore(dir).prune(0)).not.toThrow(/busy/);
      } finally {
        chmodSync(dir, 0o755);
      }
    },
  );

  it('a DIRECTORY at the lock path is a clear error, not a raw EISDIR or a hang', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    mkdirSync(`${a.path}.lock`);
    const t0 = Date.now();
    expect(() => a.append(record('r2', 'pass'))).toThrow(
      /history store lock .*\.lock exists but cannot be read as a lock file \(EISDIR\)/,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('prune skips (with a warning) instead of throwing when the lock is busy', () => {
    const a = tmpStore();
    for (let i = 1; i <= 4; i++) a.append(record(`r${i}`, 'pass'));
    writeFileSync(`${a.path}.lock`, JSON.stringify({ pid: 1, epoch: Date.now() }), 'utf8');
    expect(() => a.prune(2)).not.toThrow();
    expect(a.warnings.some((w) => w.includes('prune skipped'))).toBe(true);
    rmSync(`${a.path}.lock`);
    expect(new HistoryStore(path.dirname(a.path)).runs()).toHaveLength(4); // untouched
  });
});

describe('maxRuns counts runs, not records (QA CLI-15)', () => {
  const attempt = (runId: string, n: number, status: string): RunRecord => ({
    ...record(runId, status),
    attempt: n,
  });

  it('never splits the attempts of one runId', () => {
    const a = tmpStore();
    a.append(attempt('old', 1, 'pass'));
    a.append(attempt('retried', 1, 'fail'));
    a.append(attempt('retried', 2, 'pass'));
    a.append(attempt('retried', 3, 'pass'));
    a.append(attempt('latest', 1, 'pass'));
    // 5 records but 3 runs: maxRuns 2 keeps BOTH runs whole (4 records)
    a.prune(2);
    expect(a.runs().map((r) => `${r.runId}#${r.attempt}`)).toEqual([
      'retried#1',
      'retried#2',
      'retried#3',
      'latest#1',
    ]);
    const fresh = new HistoryStore(path.dirname(a.path));
    expect(fresh.runs()).toHaveLength(4);
  });

  it('no rewrite when the record count exceeds maxRuns but the run count does not', () => {
    const a = tmpStore();
    for (let i = 1; i <= 4; i++) a.append(attempt('one-run', i, i === 4 ? 'pass' : 'fail'));
    a.prune(1);
    expect(a.runs()).toHaveLength(4);
  });

  it('lastRuns keeps every record of a runId that reappears after others (shared --run-id)', () => {
    const recs = [
      attempt('a', 1, 'fail'),
      attempt('b', 1, 'pass'),
      attempt('a', 2, 'pass'),
      attempt('c', 1, 'pass'),
    ];
    expect(lastRuns(recs, 2).map((r) => r.runId)).toEqual(['a', 'a', 'c']);
    expect(lastRuns(recs, 3)).toBe(recs);
    expect(lastRuns(recs, 1).map((r) => r.runId)).toEqual(['c']);
  });
});

describe('subscribeStoreWarnings (run surfaces store warnings)', () => {
  it('delivers each warning once, including a busy prune, until unsubscribed', () => {
    const a = tmpStore();
    a.append(record('r1', 'pass'));
    appendFileSync(a.path, '{ corrupt\n', 'utf8');
    a.append(record('r2', 'pass'));
    const seen: string[] = [];
    const off = subscribeStoreWarnings((w) => seen.push(w));
    try {
      // fresh instance, never loaded: prune's fresh re-read reports the corrupt
      // line; adopting it must not report it a second time
      const b = new HistoryStore(path.dirname(a.path));
      b.prune(1);
      expect(seen.filter((w) => w.includes('corrupt line'))).toHaveLength(1);
      expect(b.warnings.some((w) => w.includes('corrupt line'))).toBe(true);
      // a held lock: prune is skipped with a warning the subscriber sees
      writeFileSync(`${a.path}.lock`, JSON.stringify({ pid: 1, epoch: Date.now() }), 'utf8');
      new HistoryStore(path.dirname(a.path)).prune(1);
      expect(seen.some((w) => w.includes('prune skipped'))).toBe(true);
    } finally {
      off();
      rmSync(`${a.path}.lock`, { force: true });
    }
    const before = seen.length;
    const c = new HistoryStore(path.dirname(a.path));
    appendFileSync(a.path, '{ more corrupt\n', 'utf8');
    c.runs();
    expect(seen).toHaveLength(before);
  }, 10_000);
});
