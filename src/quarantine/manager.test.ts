import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuarantineEntry, TestVerdict } from '../types.js';
import { exclusionArgs, pytestNodeId, QuarantineManager } from './manager.js';

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

  it('re-adding keeps the original quarantinedAt (QA CLI-23)', () => {
    const file = tmpFile();
    const qm = new QuarantineManager(file);
    qm.add(entry('a', 'n', { quarantinedAt: '2026-01-01T00:00:00.000Z', reason: 'old' }));
    qm.save();
    const again = new QuarantineManager(file);
    again.add(entry('a', 'n', { quarantinedAt: '2026-10-28T00:00:00.000Z', reason: 'new' }));
    again.save();
    const [e] = new QuarantineManager(file).list();
    expect(e!.quarantinedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(e!.reason).toBe('new');
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

  it('prune ignores health evidence from before the quarantine (QA CLI-24)', () => {
    const qm = new QuarantineManager(tmpFile());
    qm.add(entry('just-quarantined', 'n', { quarantinedAt: new Date().toISOString() }));
    const removed = qm.prune([
      verdict('just-quarantined', {
        classification: 'passing',
        runsObserved: 12,
        lastSeen: new Date(Date.now() - 3_600_000).toISOString(), // last ran an hour BEFORE
      }),
    ]);
    expect(removed).toEqual([]);
    expect(qm.list()).toHaveLength(1);
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

  it('save is atomic: temp file + rename, no leftovers (R5 bug 9)', () => {
    const file = tmpFile();
    const qm = new QuarantineManager(file);
    qm.add(entry('a'));
    qm.save();
    const before = statSync(file).ino;
    const oldContent = readFileSync(file, 'utf8');
    qm.add(entry('b'));
    qm.save();
    // rename swaps in a NEW inode; an in-place writeFileSync would truncate
    // and rewrite the same one (a reader could see it torn)
    if (process.platform !== 'win32') expect(statSync(file).ino).not.toBe(before);
    expect(readFileSync(file, 'utf8')).not.toBe(oldContent);
    expect(new QuarantineManager(file).list().map((e) => e.testId)).toEqual(['a', 'b']);
    expect(readdirSync(path.dirname(file))).toEqual(['flakefinder.quarantine.json']);
  });

  it('invalid entries are rejected with a precise message (QA CLI-21)', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ version: 1, entries: [null] }), 'utf8');
    expect(() => new QuarantineManager(file)).toThrow('entry #1 is not an object');
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ testId: 'a' }] }), 'utf8');
    expect(() => new QuarantineManager(file)).toThrow('entry #1 has no string "suite"');
    writeFileSync(file, '[]', 'utf8');
    expect(() => new QuarantineManager(file)).toThrow('expected a JSON object');
  });

  it('unknown top-level fields survive a save (QA CLI-21)', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ version: 1, owner: 'team-x', entries: [] }), 'utf8');
    const qm = new QuarantineManager(file);
    qm.add(entry('a'));
    qm.save();
    expect(JSON.parse(readFileSync(file, 'utf8')).owner).toBe('team-x');
  });

  it('corrupt file throws with the path', () => {
    const file = tmpFile();
    writeFileSync(file, '{ nope', 'utf8');
    expect(() => new QuarantineManager(file)).toThrow(file);
  });
});

describe('exclusionArgs', () => {
  it('pytest: --deselect per entry, junit classname converted to a node id', () => {
    const args = exclusionArgs('pytest', [
      entry('a', 'test_one', { suite: 'test_sample' }),
      entry('b', 'test_two', { suite: 'tests.test_x.TestCls' }),
    ]);
    expect(args).toEqual([
      '--deselect',
      'test_sample.py::test_one',
      '--deselect',
      'tests/test_x.py::TestCls::test_two',
    ]);
  });
  it('jest: single -t negative-lookahead pattern, names regex-escaped and deduped', () => {
    const args = exclusionArgs('jest', [
      entry('a', 'does (x)'),
      entry('b', 'does (x)'),
      entry('c', 'plain'),
    ]);
    expect(args[0]).toBe('-t');
    expect(args[1]).toBe('^(?!(?:.* )?(?:does \\(x\\)|plain)\\s*$)');
  });
  it('mocha: --grep with the same construction', () => {
    const args = exclusionArgs('mocha', [entry('a', 'one')]);
    expect(args).toEqual(['--grep', '^(?!(?:.* )?(?:one)\\s*$)']);
  });
  it('jest/mocha: excludes the quarantined title only, not names that merely contain it (R5 bug 7)', () => {
    const re = new RegExp(exclusionArgs('jest', [entry('a', 'login')])[1]!);
    // full names as jest -t / mocha --grep see them: describe chain + title, space-joined
    expect(re.test('login')).toBe(false); // excluded
    expect(re.test('ui login')).toBe(false); // excluded (same title under a describe)
    expect(re.test('login ok works')).toBe(true); // kept
    expect(re.test('relogin')).toBe(true); // kept
    expect(re.test('ui relogin')).toBe(true); // kept
  });
  it('jest/mocha exclusion: vitest " > " names and trailing spaces (QA RUN-1)', () => {
    const re = new RegExp(exclusionArgs('jest', [entry('a', 'suite V > flaky')])[1]!);
    expect(re.test('suite V flaky')).toBe(false); // excluded
    expect(re.test('suite V flaky ')).toBe(false); // excluded despite trailing space
    expect(re.test('suite V other')).toBe(true);
  });
  it('go and generic: no exclusion support', () => {
    expect(exclusionArgs('go', [entry('a')])).toEqual([]);
    expect(exclusionArgs('generic', [entry('a')])).toEqual([]);
  });
  it('no entries → no args', () => {
    expect(exclusionArgs('pytest', [])).toEqual([]);
  });
});

describe('pytestNodeId (R5 bug 6)', () => {
  it('heuristic: dots → path segments + .py, trailing Capitalized components → ::Class', () => {
    expect(pytestNodeId('test_sample', 'test_a')).toBe('test_sample.py::test_a');
    expect(pytestNodeId('tests.test_x', 'test_mod')).toBe('tests/test_x.py::test_mod');
    expect(pytestNodeId('tests.test_x.TestCls', 'test_y')).toBe('tests/test_x.py::TestCls::test_y');
    expect(pytestNodeId('tests.test_x.TestCls.TestInner', 'test_z')).toBe(
      'tests/test_x.py::TestCls::TestInner::test_z',
    );
    expect(pytestNodeId('tests.pkg.sub.test_deep.TestDeep', 'test_d')).toBe(
      'tests/pkg/sub/test_deep.py::TestDeep::test_d',
    );
    expect(pytestNodeId('tests.test_x', 'test_param[1-a]')).toBe(
      'tests/test_x.py::test_param[1-a]',
    );
  });

  it('paths and node ids pass through verbatim', () => {
    expect(pytestNodeId('tests/test_x.py', 't')).toBe('tests/test_x.py::t');
    expect(pytestNodeId('tests/test_x.py::TestCls', 't')).toBe('tests/test_x.py::TestCls::t');
  });

  it('the file system wins over the capitalization heuristic', () => {
    const dir = path.dirname(tmpFile());
    mkdirSync(path.join(dir, 'Tests', 'Unit'), { recursive: true });
    writeFileSync(path.join(dir, 'Tests', 'Unit', 'TestApi.py'), '', 'utf8');
    writeFileSync(path.join(dir, 'pytest.ini'), '[pytest]\n', 'utf8');
    expect(pytestNodeId('Tests.Unit.TestApi.TestGet', 'test_ok', dir)).toBe(
      'Tests/Unit/TestApi.py::TestGet::test_ok',
    );
    // run from a subdirectory: node ids stay rootdir-relative
    const sub = path.join(dir, 'Tests');
    expect(pytestNodeId('Tests.Unit.TestApi.TestGet', 'test_ok', sub)).toBe(
      'Tests/Unit/TestApi.py::TestGet::test_ok',
    );
  });
});

describe('concurrent writers (QA CLI-2)', () => {
  it('two managers loaded from the same file both keep their changes', () => {
    const file = tmpFile();
    const seed = new QuarantineManager(file);
    seed.add(entry('old'));
    seed.add(entry('gone-soon'));
    seed.save();
    const a = new QuarantineManager(file);
    const b = new QuarantineManager(file);
    a.add(entry('a'));
    b.add(entry('b'));
    b.remove('gone-soon');
    a.save();
    b.save(); // must not overwrite a's add with its stale snapshot
    const ids = new QuarantineManager(file)
      .list()
      .map((e) => e.testId)
      .sort();
    expect(ids).toEqual(['a', 'b', 'old']);
    expect(b.list().map((e) => e.testId)).toContain('a'); // save refreshes the view
  });

  it('a stale lock from a dead process is taken over', async () => {
    const file = tmpFile();
    const { spawnSync } = await import('node:child_process');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeFileSync(`${file}.lock`, String(dead), 'utf8');
    const qm = new QuarantineManager(file);
    qm.add(entry('a'));
    qm.save();
    expect(new QuarantineManager(file).list()).toHaveLength(1);
    expect(readdirSync(path.dirname(file))).toEqual(['flakefinder.quarantine.json']);
  });

  it('8 parallel processes adding distinct ids lose nothing', async () => {
    const { buildSync } = await import('esbuild');
    const { spawn } = await import('node:child_process');
    const file = tmpFile();
    const dir = path.dirname(file);
    const bundle = path.join(dir, 'manager.cjs');
    buildSync({
      entryPoints: [path.join(__dirname, 'manager.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      logLevel: 'silent',
    });
    // each worker snapshots the file (constructor), signals ready, waits for
    // the barrier, then adds + saves — every save races on the same snapshot
    const worker = `
const fs = require('fs');
const { QuarantineManager } = require(${JSON.stringify(bundle)});
const [file, id, dir] = process.argv.slice(1);
const qm = new QuarantineManager(file);
fs.writeFileSync(dir + '/ready-' + id, '');
const until = Date.now() + 20000;
while (!fs.existsSync(dir + '/go')) {
  if (Date.now() > until) process.exit(3);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}
qm.add({ testId: id, suite: 's', name: id, reason: 'r', quarantinedAt: new Date().toISOString(), flakeScore: 1 });
qm.save();
`;
    const ids = Array.from({ length: 8 }, (_, i) => `id${i}`);
    const exits = ids.map(
      (id) =>
        new Promise<number | null>((resolve) => {
          spawn(process.execPath, ['-e', worker, file, id, dir], { stdio: 'inherit' }).on(
            'close',
            resolve,
          );
        }),
    );
    for (let i = 0; i < 400; i++) {
      if (ids.every((id) => existsSync(path.join(dir, `ready-${id}`)))) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    writeFileSync(path.join(dir, 'go'), '', 'utf8');
    expect(await Promise.all(exits)).toEqual(ids.map(() => 0));
    const got = new QuarantineManager(file)
      .list()
      .map((e) => e.testId)
      .sort();
    expect(got).toEqual(ids);
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 60_000);
});
