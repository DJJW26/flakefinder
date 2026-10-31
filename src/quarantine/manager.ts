import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { titleAlternation } from '../runner/adapters.js';
import type { QuarantineEntry, RunnerKind, TestVerdict } from '../types.js';

interface QuarantineFile {
  version: 1;
  entries: QuarantineEntry[];
  /** Unknown top-level fields are preserved on save. */
  [key: string]: unknown;
}

const EMPTY: QuarantineFile = { version: 1, entries: [] };

/** A mutation made through this manager, replayed onto the fresh file at save time. */
type QuarantineOp = { kind: 'add'; entry: QuarantineEntry } | { kind: 'remove'; testId: string };

function applyOp(entries: QuarantineEntry[], op: QuarantineOp): QuarantineEntry[] {
  if (op.kind === 'remove') return entries.filter((e) => e.testId !== op.testId);
  // re-adding refreshes reason/score but keeps the ORIGINAL quarantine date:
  // the 90-day age-out and "since quarantine" logic must not be reset
  const prior = entries.find((e) => e.testId === op.entry.testId);
  const entry = prior?.quarantinedAt
    ? { ...op.entry, quarantinedAt: prior.quarantinedAt }
    : op.entry;
  return [...entries.filter((e) => e.testId !== op.entry.testId), entry];
}

/** How long save() waits for another process's lock before giving up. */
const LOCK_TIMEOUT_MS = 10_000;
/** A lock older than this is treated as abandoned even if its pid looks alive. */
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock left behind by a crashed process: owner pid gone, or simply too old. */
function lockIsStale(lockPath: string): boolean {
  let pid: number;
  let mtimeMs: number;
  try {
    pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch {
    return true; // vanished meanwhile: just retry the create
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
  }
  return Date.now() - mtimeMs > LOCK_STALE_MS;
}

/**
 * Run `fn` holding `<target>.lock` — an O_EXCL lockfile holding our pid, so
 * concurrent flakefinder processes serialize their read-modify-write of the
 * quarantine file. Kept local to this module on purpose (independent of the
 * history store's locking).
 */
function withFileLock<T>(target: string, fn: () => T): T {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (lockIsStale(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `quarantine file is locked by another flakefinder process (${lockPath}) — delete the lock if no other flakefinder is running`,
        );
      }
      sleepSync(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

/**
 * Manages flakefinder.quarantine.json — the list of tests excluded from runs.
 * Quarantine never edits test source files; exclusion happens via runner
 * flags (see exclusionArgs).
 *
 * Concurrency: the constructor's read is only a snapshot. Mutations are
 * recorded as operations and save() replays them, under a lockfile, onto a
 * FRESH read of the file — so parallel `quarantine add`s never lose each
 * other's entries.
 */
export class QuarantineManager {
  private filePath: string;
  private file: QuarantineFile;
  private pending: QuarantineOp[] = [];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.file = this.load();
  }

  private load(): QuarantineFile {
    if (!existsSync(this.filePath)) return { ...EMPTY, entries: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected a JSON object');
      }
      const obj = parsed as Record<string, unknown>;
      if (!Array.isArray(obj.entries)) throw new Error('missing "entries" array');
      obj.entries.forEach((e, i) => {
        if (typeof e !== 'object' || e === null || Array.isArray(e)) {
          throw new Error(`entry #${i + 1} is not an object`);
        }
        for (const field of ['testId', 'suite', 'name'] as const) {
          const value = (e as Record<string, unknown>)[field];
          if (typeof value !== 'string' || value === '') {
            throw new Error(`entry #${i + 1} has no string "${field}"`);
          }
        }
      });
      return { ...obj, version: 1, entries: obj.entries as QuarantineEntry[] };
    } catch (err) {
      throw new Error(`invalid quarantine file ${this.filePath}: ${(err as Error).message}`);
    }
  }

  private apply(op: QuarantineOp): void {
    this.pending.push(op);
    this.file.entries = applyOp(this.file.entries, op);
  }

  list(): QuarantineEntry[] {
    return [...this.file.entries];
  }

  /** Add or replace an entry (same testId); a re-add keeps the original quarantinedAt. */
  add(entry: QuarantineEntry): void {
    this.apply({ kind: 'add', entry });
  }

  remove(testId: string): boolean {
    const existed = this.file.entries.some((e) => e.testId === testId);
    if (existed) this.apply({ kind: 'remove', testId });
    return existed;
  }

  /**
   * Drop entries that no longer deserve quarantine. Deliberately
   * conservative: quarantined tests are excluded from runs, so "not seen
   * lately" is NOT evidence of health (that would silently un-quarantine
   * everything). An entry leaves quarantine only on positive evidence —
   * the test ran (quarantine disabled or full-suite run) since it was
   * quarantined and passed stably — or when the entry is older than 90 days and the test is gone from
   * history. Returns the removed entries.
   */
  prune(verdicts: TestVerdict[], maxAgeDays = 90): QuarantineEntry[] {
    if (verdicts.length === 0) return [];
    const byId = new Map(verdicts.map((v) => [v.testId, v]));
    const removed: QuarantineEntry[] = [];
    for (const entry of this.file.entries) {
      const v = byId.get(entry.testId);
      const quarantinedMs = Date.parse(entry.quarantinedAt);
      // health evidence must include a run AFTER the quarantine: passes from
      // before it are exactly the history that got the test quarantined
      const seenSince =
        v !== undefined && (Number.isNaN(quarantinedMs) || Date.parse(v.lastSeen) >= quarantinedMs);
      const healthy =
        v !== undefined && seenSince && v.classification === 'passing' && v.runsObserved >= 10;
      const agedOut =
        v?.classification === 'gone' &&
        !Number.isNaN(quarantinedMs) &&
        Date.now() - quarantinedMs > maxAgeDays * 86_400_000;
      if (healthy || agedOut) removed.push(entry);
    }
    for (const entry of removed) this.apply({ kind: 'remove', testId: entry.testId });
    return removed;
  }

  /**
   * Persist this manager's changes. Under the lockfile: re-read the file
   * (another process may have saved since our constructor ran), replay our
   * pending operations onto it, then write atomically — a temp file in the
   * same directory renamed over the target, so neither a crash nor a
   * concurrent reader ever sees a torn file.
   */
  save(): void {
    withFileLock(this.filePath, () => {
      const fresh = this.load();
      for (const op of this.pending) fresh.entries = applyOp(fresh.entries, op);
      const tmp = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify(fresh, null, 2)}\n`, 'utf8');
        renameSync(tmp, this.filePath);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      this.file = fresh;
      this.pending = [];
    });
  }
}

/** Files that mark a pytest rootdir candidate / project root: stop looking upward there. */
const ROOT_MARKERS = ['pytest.ini', 'pyproject.toml', 'tox.ini', 'setup.cfg', 'setup.py', '.git'];

/**
 * Does `rel` exist under `cwd` or an ancestor up to the project root?
 * (pytest's rootdir — what node ids are relative to — may sit above cwd.)
 */
function existsUpward(cwd: string, rel: string): boolean {
  let dir = path.resolve(cwd);
  for (;;) {
    if (existsSync(path.join(dir, rel))) return true;
    const parent = path.dirname(dir);
    if (parent === dir || ROOT_MARKERS.some((m) => existsSync(path.join(dir, m)))) return false;
    dir = parent;
  }
}

/**
 * pytest node id for a quarantined test. `suite` is normally the JUnit
 * classname pytest writes — the rootdir-relative node id with `/` and `::`
 * flattened to dots and `.py` dropped (`tests/test_x.py::TestCls::test_y` →
 * classname `tests.test_x.TestCls`) — so it is un-flattened here: the module
 * is the longest dotted prefix that exists as a `.py` file (from `cwd` up),
 * else everything up to the last non-Capitalized component; the remaining
 * Capitalized components are (nested) classes. A suite that already looks
 * like a node id or path is used verbatim.
 */
export function pytestNodeId(suite: string, name: string, cwd?: string): string {
  if (/[\\/]|::|\.py$/.test(suite)) return `${suite.replace(/\\/g, '/')}::${name}`;
  const parts = suite.split('.').filter((p) => p !== '');
  if (parts.length === 0) return name;
  let moduleEnd = 0;
  if (cwd !== undefined) {
    for (let i = parts.length; i >= 1; i--) {
      if (existsUpward(cwd, `${parts.slice(0, i).join('/')}.py`)) {
        moduleEnd = i;
        break;
      }
    }
  }
  if (moduleEnd === 0) {
    moduleEnd = 1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (!/^[A-Z]/.test(parts[i]!)) {
        moduleEnd = i + 1;
        break;
      }
    }
  }
  const file = `${parts.slice(0, moduleEnd).join('/')}.py`;
  return [file, ...parts.slice(moduleEnd), name].join('::');
}

/**
 * Runner flags that exclude the quarantined tests from the next run.
 * `cwd` (optional) lets pytest node ids be resolved against the files on
 * disk. go/generic have no per-test exclusion — callers must warn.
 */
export function exclusionArgs(
  runner: Exclude<RunnerKind, 'auto'>,
  entries: QuarantineEntry[],
  cwd?: string,
): string[] {
  if (entries.length === 0) return [];
  switch (runner) {
    case 'pytest': {
      // --deselect takes a rootdir-relative node id (a PREFIX — `run`
      // makes it exact with PYTEST_EXACT_PLUGIN_SOURCE):
      // <path/to/file.py>::[<Class>::]<test>
      const args: string[] = [];
      for (const e of entries) args.push('--deselect', pytestNodeId(e.suite, e.name, cwd));
      return args;
    }
    case 'jest':
    case 'mocha': {
      // jest -t / mocha --grep match against the FULL test name (describe
      // chain + title, space-joined). Anchor each quarantined title as a
      // space-delimited FINAL segment — the same anchoring adapters.ts uses
      // for targeted re-runs — so quarantining "login" excludes "login" and
      // "ui login", but not "login ok works" or "relogin".
      const flag = runner === 'jest' ? '-t' : '--grep';
      return [flag, `^(?!(?:.* )?(?:${titleAlternation(entries.map((e) => e.name))})\\s*$)`];
    }
    // go / generic: no per-test exclusion — callers must warn
    default:
      return [];
  }
}

/**
 * pytest matches `--deselect` as a node-id PREFIX, so `--deselect
 * t.py::test_mod` also drops `t.py::test_mod2`. This plugin (loaded through
 * PYTEST_PLUGINS, see pytestExactDeselect) makes flakefinder's exclusions
 * exact: it deselects items whose node id equals a quarantined id (or is a
 * parametrization of it, `id[...]`), then removes flakefinder's ids from
 * `--deselect` so pytest's own prefix pass only sees the user's. When the
 * plugin cannot load (an env-filtering wrapper such as tox), the plain
 * `--deselect` flags still apply — prefix semantics, never worse than that.
 */
export const PYTEST_EXACT_PLUGIN_MODULE = 'flakefinder_exact_deselect';
export const PYTEST_EXACT_ENV = 'FLAKEFINDER_EXACT_DESELECT';
export const PYTEST_EXACT_PLUGIN_SOURCE = `# Generated by flakefinder: exact quarantine deselection (temporary file).
import json
import os

import pytest


@pytest.hookimpl(tryfirst=True)
def pytest_collection_modifyitems(config, items):
    try:
        ours = json.loads(os.environ.get("${PYTEST_EXACT_ENV}", "[]"))
    except ValueError:
        return
    if not isinstance(ours, list) or not ours:
        return
    remaining = list(config.getoption("deselect") or [])
    for node_id in ours:
        if node_id in remaining:
            remaining.remove(node_id)
    config.option.deselect = remaining
    exact = set(ours)
    keep, drop = [], []
    for item in items:
        nid = item.nodeid
        base = nid.split("[", 1)[0]
        (drop if nid in exact or base in exact else keep).append(item)
    if drop:
        config.hook.pytest_deselected(items=drop)
        items[:] = keep
`;

/**
 * Environment that loads the exact-deselect plugin from `pluginDir` (which
 * must contain `${PYTEST_EXACT_PLUGIN_MODULE}.py`) for the given node ids.
 * Keeps any PYTEST_PLUGINS / PYTHONPATH the user already set.
 */
export function pytestExactDeselectEnv(
  nodeIds: string[],
  pluginDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const plugins = (env.PYTEST_PLUGINS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== PYTEST_EXACT_PLUGIN_MODULE);
  const pythonPath = env.PYTHONPATH ? `${pluginDir}${path.delimiter}${env.PYTHONPATH}` : pluginDir;
  return {
    ...env,
    PYTEST_PLUGINS: [...plugins, PYTEST_EXACT_PLUGIN_MODULE].join(','),
    PYTHONPATH: pythonPath,
    [PYTEST_EXACT_ENV]: JSON.stringify(nodeIds),
  };
}

/** The node ids `exclusionArgs('pytest', …)` passes to `--deselect`. */
export function deselectedNodeIds(args: string[]): string[] {
  const ids: string[] = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === '--deselect') ids.push(args[i + 1]!);
  return ids;
}

export function quarantinePathFor(cwd: string, quarantineFile: string): string {
  return path.resolve(cwd, quarantineFile);
}
