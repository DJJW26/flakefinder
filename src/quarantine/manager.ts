import { existsSync, linkSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { titleAlternation } from '../runner/adapters.js';
import type { QuarantineEntry, RunnerKind, TestVerdict } from '../types.js';
import { renameOverSync } from '../util/atomic-rename.js';

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
/** Unparseable/legacy lock older than this is abandoned (live pids never age out). */
const LOCK_STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** The pid in a lock token; accepts this version's JSON and legacy bare pids. */
function lockPid(content: string): number {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === 'number'
    ) {
      return (parsed as { pid: number }).pid;
    }
  } catch {
    // legacy lock: a bare pid
  }
  return Number.parseInt(content, 10);
}

/** Remove a temp file without letting a sharing violation escape. */
function removeQuietly(target: string): boolean {
  try {
    rmSync(target, { force: true });
    return true;
  } catch {
    // a scanner may still hold it; the caller may retry
    return false;
  }
}

/** Remove a partially written fallback lock, but only if it is still ours. */
function removePartialLock(lockPath: string, token: string): void {
  try {
    const content = readFileSync(lockPath, 'utf8');
    if (content !== '' && !token.startsWith(content)) return; // foreign owner
  } catch {
    return; // gone or unreadable: leave it alone
  }
  removeQuietly(lockPath);
}

/** Create the lock atomically WITH its token: a reader can never see a partial lock. */
function tryCreateLock(lockPath: string): string | null {
  const token = JSON.stringify({
    pid: process.pid,
    epoch: Date.now(),
    nonce: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
  });
  const tmp = `${lockPath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
    .toString(36)
    .slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, token, 'utf8');
    try {
      linkSync(tmp, lockPath); // fails EEXIST when someone else holds it
      return token;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return null;
      // filesystems without hard links: exclusive create, then write
      try {
        writeFileSync(lockPath, token, { flag: 'wx' });
      } catch (fallbackErr) {
        if ((fallbackErr as NodeJS.ErrnoException).code === 'EEXIST') return null;
        removePartialLock(lockPath, token);
        throw fallbackErr;
      }
      // wx is create-then-write, so a reader can briefly see an empty lock.
      // If we were paused long enough for another process to age-break it,
      // the path may hold someone else's token: never report ownership we
      // cannot verify (the caller will re-classify and retry).
      try {
        if (readFileSync(lockPath, 'utf8') !== token) return null;
      } catch {
        return null;
      }
      return token;
    }
  } finally {
    removeQuietly(tmp);
  }
}

/** Is a pid still running? EPERM means it exists but we may not signal it. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ESRCH = gone. EINVAL/ERANGE/ERR_INVALID_ARG_TYPE/ERR_OUT_OF_RANGE =
    // not a pid this host can have (e.g. >2^31-1); age it out instead of
    // treating a corrupt token as a live owner forever.
    return (
      code !== 'ESRCH' &&
      code !== 'EINVAL' &&
      code !== 'ERANGE' &&
      code !== 'ERR_INVALID_ARG_TYPE' &&
      code !== 'ERR_OUT_OF_RANGE'
    );
  }
}

/** @internal exported for tests. */
export type LockState =
  | { state: 'missing' }
  | { state: 'live' }
  | { state: 'stale'; content: string };

/** Is this lock content abandoned? Only a dead/own pid or an unparseable old lock. */
function contentIsStale(content: string, ageMs: number): boolean {
  const pid = lockPid(content);
  if (Number.isInteger(pid) && pid > 0) {
    // Our own pid means an earlier release failed; no withFileLock call nests.
    return pid === process.pid || !processAlive(pid);
  }
  // Legacy/torn write with no usable pid: age is the only evidence.
  return ageMs > LOCK_STALE_MS;
}

/** Classify the current lock. 'missing' is NOT stale: retry create, never break. @internal exported for tests. */
export function lockState(lockPath: string): LockState {
  let content: string;
  let mtimeMs: number;
  try {
    content = readFileSync(lockPath, 'utf8');
    mtimeMs = statSync(lockPath).mtimeMs;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { state: 'missing' };
    // Windows reports a transient sharing violation while the owner is
    // creating/replacing the lock; treat it as "someone holds it" and retry.
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') return { state: 'live' };
    // A directory or another layout problem is not "another process holds
    // it": retrying would only hide it for 10s.
    throw new Error(
      `quarantine lock ${lockPath} exists but cannot be read as a lock file (${code ?? 'error'}) — ` +
        'check that the quarantine directory is writable and that the lock path is not a directory',
    );
  }
  return contentIsStale(content, Date.now() - mtimeMs)
    ? { state: 'stale', content }
    : { state: 'live' };
}

/**
 * One breaker at a time. The break file is created atomically with its
 * token; a crashed breaker (dead pid) is recovered, a live one is waited out.
 */
function tryTakeBreaker(breakPath: string): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = tryCreateLock(breakPath);
    if (token !== null) return token;
    try {
      const content = readFileSync(breakPath, 'utf8');
      const age = Date.now() - statSync(breakPath).mtimeMs;
      if (contentIsStale(content, age)) {
        if (!removeQuietly(breakPath)) return null;
        continue;
      }
    } catch {
      // vanished or transiently unreadable: try once more
    }
    return null;
  }
  return null;
}

/**
 * Remove a lock that is still exactly the abandoned one we observed.
 *
 * Holding `<lock>.break` serializes breakers. While that mutex is held the
 * lock file is NEVER moved aside: a live process cannot acquire it (it still
 * exists), and no other breaker can remove it, so deleting it in place cannot
 * capture a lock that someone just acquired. The content is re-read and must
 * match `observed`; a replaced lock is left untouched.
 * @internal exported for tests.
 */
export function breakStaleLock(lockPath: string, observed: string): boolean {
  const breakPath = `${lockPath}.break`;
  const breakerToken = tryTakeBreaker(breakPath);
  if (breakerToken === null) return false;
  try {
    let content: string;
    let mtimeMs: number;
    try {
      content = readFileSync(lockPath, 'utf8');
      mtimeMs = statSync(lockPath).mtimeMs;
    } catch {
      return false; // vanished or unreadable: just retry acquisition
    }
    if (content !== observed || !contentIsStale(content, Date.now() - mtimeMs)) return false;
    return removeQuietly(lockPath);
  } finally {
    try {
      if (readFileSync(breakPath, 'utf8') === breakerToken) removeQuietly(breakPath);
    } catch {
      // breaker token already recovered/removed
    }
  }
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
  let token: string;
  for (;;) {
    const acquired = tryCreateLock(lockPath);
    if (acquired !== null) {
      token = acquired;
      break;
    }
    // checked on EVERY iteration — breakStaleLock may fail forever on a
    // lock that cannot be removed (AV/indexer/read-only), so the stale
    // branch must not bypass the deadline
    if (Date.now() > deadline) {
      throw new Error(
        `quarantine file is locked by another flakefinder process (${lockPath}) — delete the lock if no other flakefinder is running`,
      );
    }
    const state = lockState(lockPath);
    if (state.state === 'missing') continue; // vanished: retry the create now
    if (state.state === 'stale') {
      // another waiter may be breaking it; back off briefly instead of spinning
      if (!breakStaleLock(lockPath, state.content)) {
        sleepSync(5 + Math.floor(Math.random() * 15));
      }
      continue;
    }
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
  try {
    return fn();
  } finally {
    try {
      // only remove the lock if it is still OURS: it may have been broken as
      // stale and re-acquired while we held it
      const current = readFileSync(lockPath, 'utf8');
      const ours = current === token;
      if (ours) {
        rmSync(lockPath, { force: true });
      }
    } catch {
      // already gone
    }
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
        renameOverSync(tmp, this.filePath);
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
