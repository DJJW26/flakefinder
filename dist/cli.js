#!/usr/bin/env node

// src/cli/index.ts
import { spawnSync as spawnSync4 } from "child_process";
import { randomUUID as randomUUID2 } from "crypto";
import { existsSync as existsSync6, mkdirSync as mkdirSync2, readFileSync as readFileSync7, statSync as statSync7, writeFileSync as writeFileSync4 } from "fs";
import path8 from "path";
import { Command } from "commander";

// src/action/diff.ts
var FLAKY = /* @__PURE__ */ new Set(["flaky-confirmed", "flaky-retry", "flaky-suspected"]);
function computeNewFlakes(current, previous) {
  const prevFlaky = new Set(
    (previous ?? []).filter((v) => FLAKY.has(v.classification)).map((v) => v.testId)
  );
  return current.filter((v) => FLAKY.has(v.classification) && !prevFlaky.has(v.testId));
}

// src/config.ts
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
var CONFIG_FILE_NAME = "flakefinder.config.json";
function stripJsonComments(text2) {
  let out = "";
  let i = 0;
  let inString = false;
  let quote = "";
  while (i < text2.length) {
    const c = text2[i];
    const next = text2[i + 1];
    if (inString) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text2.length && text2[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < text2.length && !(text2[i] === "*" && text2[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return stripTrailingCommas(out);
}
function stripTrailingCommas(text2) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text2.length; i++) {
    const c = text2[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text2[i + 1] ?? "";
        i++;
      } else if (c === quote) {
        inString = false;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
    } else if (c === ",") {
      let j = i + 1;
      while (j < text2.length && /\s/.test(text2[j])) j++;
      if (text2[j] === "}" || text2[j] === "]") continue;
    }
    out += c;
  }
  return out;
}
var ConfigValidationError = class extends Error {
};
var KNOWN_KEYS = /* @__PURE__ */ new Set([
  "reports",
  "storeDir",
  "maxRuns",
  "minRuns",
  "liveRetries",
  "flakeScoreThreshold",
  "slowThresholdMs",
  "slowMultiplier",
  "quarantineFile",
  "runner",
  "failOnFlakes",
  "retryMode",
  "timeoutSeconds"
]);
var VALID_RUNNERS = ["auto", "pytest", "jest", "mocha", "go", "generic"];
function describe(v) {
  if (typeof v === "string") return `"${v}" (string)`;
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return `${String(v)} (${typeof v})`;
}
var TIMEOUT_MAX_SECONDS = 2147483;
function checkInt(problems, key, v, min, max) {
  if (v === void 0) return;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    problems.push(`${key}: expected integer ${min}\u2013${max}, got ${describe(v)}`);
  }
}
function validateConfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new ConfigValidationError(
      `invalid flakefinder config: config must be a JSON object, got ${describe(config)}`
    );
  }
  const problems = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      problems.push(`${key}: unknown key (valid keys: ${[...KNOWN_KEYS].sort().join(", ")})`);
    }
  }
  const c = config;
  if (c.reports !== void 0) {
    const ok = Array.isArray(c.reports) && c.reports.every((x) => typeof x === "string" && x.trim() !== "");
    if (!ok)
      problems.push(
        `reports: expected array of non-empty glob strings, got ${describe(c.reports)}`
      );
  }
  if (c.storeDir !== void 0 && (typeof c.storeDir !== "string" || c.storeDir.trim() === "")) {
    problems.push(`storeDir: expected non-empty string, got ${describe(c.storeDir)}`);
  }
  checkInt(problems, "maxRuns", c.maxRuns, 1, 1e5);
  checkInt(problems, "minRuns", c.minRuns, 1, 1e3);
  checkInt(problems, "liveRetries", c.liveRetries, 0, 10);
  checkInt(problems, "flakeScoreThreshold", c.flakeScoreThreshold, 0, 100);
  if (c.slowThresholdMs !== void 0 && c.slowThresholdMs !== null && (typeof c.slowThresholdMs !== "number" || !Number.isFinite(c.slowThresholdMs) || c.slowThresholdMs <= 0)) {
    problems.push(
      `slowThresholdMs: expected positive number or null, got ${describe(c.slowThresholdMs)}`
    );
  }
  if (c.slowMultiplier !== void 0 && (typeof c.slowMultiplier !== "number" || !Number.isFinite(c.slowMultiplier) || c.slowMultiplier <= 0)) {
    problems.push(`slowMultiplier: expected positive number, got ${describe(c.slowMultiplier)}`);
  }
  if (c.quarantineFile !== void 0 && (typeof c.quarantineFile !== "string" || c.quarantineFile.trim() === "")) {
    problems.push(`quarantineFile: expected non-empty string, got ${describe(c.quarantineFile)}`);
  }
  if (c.runner !== void 0) {
    if (typeof c.runner !== "string" || !VALID_RUNNERS.includes(c.runner)) {
      const guess = VALID_RUNNERS.find(
        (r) => typeof c.runner === "string" && r.toLowerCase() === c.runner.toLowerCase()
      );
      problems.push(
        `runner: expected one of ${VALID_RUNNERS.join("|")}, got ${describe(c.runner)}` + (guess ? ` (did you mean "${guess}"?)` : "")
      );
    }
  }
  if (c.failOnFlakes !== void 0 && typeof c.failOnFlakes !== "boolean") {
    problems.push(`failOnFlakes: expected boolean, got ${describe(c.failOnFlakes)}`);
  }
  if (c.retryMode !== void 0) {
    const modes = ["auto", "failed", "full"];
    if (typeof c.retryMode !== "string" || !modes.includes(c.retryMode)) {
      problems.push(`retryMode: expected one of ${modes.join("|")}, got ${describe(c.retryMode)}`);
    }
  }
  if (c.timeoutSeconds !== null) {
    checkInt(problems, "timeoutSeconds", c.timeoutSeconds, 1, TIMEOUT_MAX_SECONDS);
  }
  if (problems.length > 0) {
    throw new ConfigValidationError(`invalid flakefinder config:
  - ${problems.join("\n  - ")}`);
  }
}
function resolveConfig(config = {}, overrides = {}) {
  validateConfig(config);
  validateConfig(overrides);
  return {
    reports: [],
    storeDir: ".flakefinder",
    maxRuns: 300,
    minRuns: 3,
    liveRetries: 2,
    flakeScoreThreshold: 30,
    slowThresholdMs: 1e4,
    slowMultiplier: 5,
    quarantineFile: "flakefinder.quarantine.json",
    runner: "auto",
    failOnFlakes: false,
    retryMode: "auto",
    timeoutSeconds: null,
    ...config,
    ...overrides
  };
}
function anchorConfigPaths(config, configDir) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return config;
  const out = { ...config };
  for (const key of ["storeDir", "quarantineFile"]) {
    const v = out[key];
    if (typeof v === "string" && v.trim() !== "" && !path.isAbsolute(v)) {
      out[key] = path.resolve(configDir, v);
    }
  }
  return out;
}
function readConfigFile(file) {
  const abs = path.resolve(file);
  let raw;
  try {
    raw = readFileSync(abs, "utf8");
  } catch (err) {
    throw new Error(`cannot read config ${abs}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(raw.replace(/^\uFEFF/, "")));
  } catch (err) {
    throw new Error(`invalid config in ${abs}: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `invalid config in ${abs}: config must be a JSON object, got ${describe(parsed)}`
    );
  }
  return anchorConfigPaths(parsed, path.dirname(abs));
}
function loadConfig(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth <= 3; depth++) {
    const candidate = path.join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) {
      return { config: readConfigFile(candidate), path: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { config: {}, path: null };
}
function detectRunner(cwd) {
  const has = (f) => {
    try {
      statSync(path.join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = JSON.stringify(pkg.scripts ?? {});
      if (deps.jest || deps.vitest || /\b(jest|vitest)\b/.test(scripts)) return "jest";
      if (deps.mocha || /\bmocha\b/.test(scripts)) return "mocha";
    } catch {
    }
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py") || has("setup.cfg"))
    return "pytest";
  if (has(".mocharc.yml") || has(".mocharc.json") || has(".mocharc.js") || has(".mocharc.cjs"))
    return "mocha";
  if (has("go.mod")) return "go";
  return "generic";
}

// src/doctor.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync4, statSync as statSync4 } from "fs";
import path5 from "path";

// src/quarantine/manager.ts
import {
  closeSync,
  existsSync as existsSync2,
  openSync,
  readFileSync as readFileSync2,
  renameSync,
  rmSync,
  statSync as statSync2,
  writeFileSync,
  writeSync
} from "fs";
import path2 from "path";

// src/runner/adapters.ts
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function titleAlternation(names) {
  const alts = names.map((n) => escapeRegExp(n.trim()).replace(/ > /g, "(?: > | )"));
  return [...new Set(alts)].join("|");
}
function failedNamesOf(records) {
  const names = /* @__PURE__ */ new Set();
  for (const r of records) {
    for (const t of r.results) {
      if (t.status === "fail" || t.status === "error") names.add(t.name);
    }
  }
  return [...names];
}
function failedOnlyArgs(runner, failedNames, quarantinedNames = []) {
  if (failedNames.length === 0) return null;
  switch (runner) {
    case "jest":
    case "mocha": {
      const include = titleAlternation(failedNames);
      const exclude = titleAlternation(quarantinedNames);
      const pattern = exclude !== "" ? `^(?=(?:.* )?(?:${include})\\s*$)(?!(?:.* )?(?:${exclude})\\s*$)` : `^(?:.* )?(?:${include})\\s*$`;
      return runner === "jest" ? ["-t", pattern] : ["--grep", pattern];
    }
    case "go": {
      const parents = new Set(failedNames.map((n) => n.includes("/") ? n.split("/")[0] : n));
      const pattern = `^(${[...parents].map(escapeRegExp).join("|")})$`;
      return ["-run", pattern];
    }
    case "pytest":
      return ["--lf"];
    default:
      return null;
  }
}

// src/quarantine/manager.ts
var EMPTY = { version: 1, entries: [] };
function applyOp(entries, op) {
  if (op.kind === "remove") return entries.filter((e) => e.testId !== op.testId);
  const prior = entries.find((e) => e.testId === op.entry.testId);
  const entry = prior?.quarantinedAt ? { ...op.entry, quarantinedAt: prior.quarantinedAt } : op.entry;
  return [...entries.filter((e) => e.testId !== op.entry.testId), entry];
}
var LOCK_TIMEOUT_MS = 1e4;
var LOCK_STALE_MS = 3e4;
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function lockIsStale(lockPath) {
  let pid;
  let mtimeMs;
  try {
    pid = Number.parseInt(readFileSync2(lockPath, "utf8"), 10);
    mtimeMs = statSync2(lockPath).mtimeMs;
  } catch {
    return true;
  }
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === "ESRCH") return true;
    }
  }
  return Date.now() - mtimeMs > LOCK_STALE_MS;
}
function withFileLock(target, fn) {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (; ; ) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (lockIsStale(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `quarantine file is locked by another flakefinder process (${lockPath}) \u2014 delete the lock if no other flakefinder is running`
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
var QuarantineManager = class {
  filePath;
  file;
  pending = [];
  constructor(filePath) {
    this.filePath = filePath;
    this.file = this.load();
  }
  load() {
    if (!existsSync2(this.filePath)) return { ...EMPTY, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync2(this.filePath, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("expected a JSON object");
      }
      const obj = parsed;
      if (!Array.isArray(obj.entries)) throw new Error('missing "entries" array');
      obj.entries.forEach((e, i) => {
        if (typeof e !== "object" || e === null || Array.isArray(e)) {
          throw new Error(`entry #${i + 1} is not an object`);
        }
        for (const field of ["testId", "suite", "name"]) {
          const value = e[field];
          if (typeof value !== "string" || value === "") {
            throw new Error(`entry #${i + 1} has no string "${field}"`);
          }
        }
      });
      return { ...obj, version: 1, entries: obj.entries };
    } catch (err) {
      throw new Error(`invalid quarantine file ${this.filePath}: ${err.message}`);
    }
  }
  apply(op) {
    this.pending.push(op);
    this.file.entries = applyOp(this.file.entries, op);
  }
  list() {
    return [...this.file.entries];
  }
  /** Add or replace an entry (same testId); a re-add keeps the original quarantinedAt. */
  add(entry) {
    this.apply({ kind: "add", entry });
  }
  remove(testId) {
    const existed = this.file.entries.some((e) => e.testId === testId);
    if (existed) this.apply({ kind: "remove", testId });
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
  prune(verdicts, maxAgeDays = 90) {
    if (verdicts.length === 0) return [];
    const byId = new Map(verdicts.map((v) => [v.testId, v]));
    const removed = [];
    for (const entry of this.file.entries) {
      const v = byId.get(entry.testId);
      const quarantinedMs = Date.parse(entry.quarantinedAt);
      const seenSince = v !== void 0 && (Number.isNaN(quarantinedMs) || Date.parse(v.lastSeen) >= quarantinedMs);
      const healthy = v !== void 0 && seenSince && v.classification === "passing" && v.runsObserved >= 10;
      const agedOut = v?.classification === "gone" && !Number.isNaN(quarantinedMs) && Date.now() - quarantinedMs > maxAgeDays * 864e5;
      if (healthy || agedOut) removed.push(entry);
    }
    for (const entry of removed) this.apply({ kind: "remove", testId: entry.testId });
    return removed;
  }
  /**
   * Persist this manager's changes. Under the lockfile: re-read the file
   * (another process may have saved since our constructor ran), replay our
   * pending operations onto it, then write atomically — a temp file in the
   * same directory renamed over the target, so neither a crash nor a
   * concurrent reader ever sees a torn file.
   */
  save() {
    withFileLock(this.filePath, () => {
      const fresh = this.load();
      for (const op of this.pending) fresh.entries = applyOp(fresh.entries, op);
      const tmp = `${this.filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify(fresh, null, 2)}
`, "utf8");
        renameSync(tmp, this.filePath);
      } catch (err) {
        rmSync(tmp, { force: true });
        throw err;
      }
      this.file = fresh;
      this.pending = [];
    });
  }
};
var ROOT_MARKERS = ["pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg", "setup.py", ".git"];
function existsUpward(cwd, rel) {
  let dir = path2.resolve(cwd);
  for (; ; ) {
    if (existsSync2(path2.join(dir, rel))) return true;
    const parent = path2.dirname(dir);
    if (parent === dir || ROOT_MARKERS.some((m) => existsSync2(path2.join(dir, m)))) return false;
    dir = parent;
  }
}
function pytestNodeId(suite, name, cwd) {
  if (/[\\/]|::|\.py$/.test(suite)) return `${suite.replace(/\\/g, "/")}::${name}`;
  const parts = suite.split(".").filter((p) => p !== "");
  if (parts.length === 0) return name;
  let moduleEnd = 0;
  if (cwd !== void 0) {
    for (let i = parts.length; i >= 1; i--) {
      if (existsUpward(cwd, `${parts.slice(0, i).join("/")}.py`)) {
        moduleEnd = i;
        break;
      }
    }
  }
  if (moduleEnd === 0) {
    moduleEnd = 1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (!/^[A-Z]/.test(parts[i])) {
        moduleEnd = i + 1;
        break;
      }
    }
  }
  const file = `${parts.slice(0, moduleEnd).join("/")}.py`;
  return [file, ...parts.slice(moduleEnd), name].join("::");
}
function exclusionArgs(runner, entries, cwd) {
  if (entries.length === 0) return [];
  switch (runner) {
    case "pytest": {
      const args = [];
      for (const e of entries) args.push("--deselect", pytestNodeId(e.suite, e.name, cwd));
      return args;
    }
    case "jest":
    case "mocha": {
      const flag = runner === "jest" ? "-t" : "--grep";
      return [flag, `^(?!(?:.* )?(?:${titleAlternation(entries.map((e) => e.name))})\\s*$)`];
    }
    // go / generic: no per-test exclusion — callers must warn
    default:
      return [];
  }
}
var PYTEST_EXACT_PLUGIN_MODULE = "flakefinder_exact_deselect";
var PYTEST_EXACT_ENV = "FLAKEFINDER_EXACT_DESELECT";
var PYTEST_EXACT_PLUGIN_SOURCE = `# Generated by flakefinder: exact quarantine deselection (temporary file).
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
function pytestExactDeselectEnv(nodeIds, pluginDir, env = process.env) {
  const plugins = (env.PYTEST_PLUGINS ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "" && p !== PYTEST_EXACT_PLUGIN_MODULE);
  const pythonPath = env.PYTHONPATH ? `${pluginDir}${path2.delimiter}${env.PYTHONPATH}` : pluginDir;
  return {
    ...env,
    PYTEST_PLUGINS: [...plugins, PYTEST_EXACT_PLUGIN_MODULE].join(","),
    PYTHONPATH: pythonPath,
    [PYTEST_EXACT_ENV]: JSON.stringify(nodeIds)
  };
}
function deselectedNodeIds(args) {
  const ids = [];
  for (let i = 0; i < args.length - 1; i++) if (args[i] === "--deselect") ids.push(args[i + 1]);
  return ids;
}

// src/store/history-store.ts
import { randomBytes } from "crypto";
import {
  appendFileSync,
  closeSync as closeSync2,
  existsSync as existsSync3,
  linkSync,
  mkdirSync,
  openSync as openSync2,
  readFileSync as readFileSync3,
  renameSync as renameSync2,
  rmSync as rmSync2,
  statSync as statSync3,
  writeFileSync as writeFileSync2,
  writeSync as writeSync2
} from "fs";
import path3 from "path";
function snapshotPath(storeDir) {
  return path3.join(storeDir, "verdicts-snapshot.json");
}
var STORE_FORMAT_VERSION = 1;
var StoreBusyError = class extends Error {
};
var LOCK_STALE_MS2 = 3e4;
function uniqueSuffix() {
  return `${process.pid}-${randomBytes(6).toString("hex")}`;
}
function lockAgeMs(lockPath, content) {
  if (content) {
    try {
      const holder = JSON.parse(content);
      if (typeof holder.epoch === "number" && Number.isFinite(holder.epoch)) {
        return Date.now() - holder.epoch;
      }
    } catch {
    }
  }
  try {
    return Date.now() - statSync3(lockPath).mtimeMs;
  } catch {
    return null;
  }
}
function breakStaleLock(lockPath, observed) {
  const aside = `${lockPath}.stale-${uniqueSuffix()}`;
  try {
    renameSync2(lockPath, aside);
  } catch {
    return false;
  }
  let moved = null;
  try {
    moved = readFileSync3(aside, "utf8");
  } catch {
  }
  const age = lockAgeMs(aside, moved);
  if (moved === observed && age !== null && age > LOCK_STALE_MS2) {
    rmSync2(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, lockPath);
  } catch {
  }
  rmSync2(aside, { force: true });
  return false;
}
var warningListeners = /* @__PURE__ */ new Set();
function subscribeStoreWarnings(listener) {
  warningListeners.add(listener);
  return () => {
    warningListeners.delete(listener);
  };
}
function lastRuns(records, maxRuns) {
  if (records.length <= maxRuns) return records;
  const kept = /* @__PURE__ */ new Set();
  for (let i = records.length - 1; i >= 0 && kept.size < maxRuns; i--) {
    kept.add(records[i].runId);
  }
  if (kept.size === new Set(records.map((r) => r.runId)).size) return records;
  return records.filter((r) => kept.has(r.runId));
}
var HistoryStore = class _HistoryStore {
  path;
  warnings = [];
  /** Schema version read from the file header; null for legacy header-less stores. */
  formatVersion = null;
  /**
   * Set when `history.jsonl` exists but could not be read at all (EISDIR,
   * EACCES, …): the store then behaves as empty, but callers that diagnose
   * setup (doctor) must treat it as a hard failure, not as "0 runs".
   * Holds `<errno>: <message>`; null when the file was read or is absent.
   */
  unreadable = null;
  loaded = false;
  records = [];
  /** Content of the lock file this instance wrote; release only removes a lock that still matches. */
  lockToken = null;
  constructor(storeDir) {
    this.path = path3.join(storeDir, "history.jsonl");
  }
  /**
   * Record a warning on this instance and tell any subscribers. Callers that
   * never see the instance — `run` goes through runLive, which keeps its
   * store private — subscribe instead of losing e.g. "prune skipped".
   */
  warn(message, first = false) {
    if (first) this.warnings.unshift(message);
    else this.warnings.push(message);
    for (const listener of warningListeners) listener(message);
  }
  ensureStoreDir() {
    mkdirSync(path3.dirname(this.path), { recursive: true });
  }
  ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync3(this.path)) return;
    let raw;
    try {
      raw = readFileSync3(this.path, "utf8");
    } catch (err) {
      const e = err;
      const code = e.code ?? "error";
      this.unreadable = e.message.startsWith(code) ? e.message : `${code}: ${e.message}`;
      this.warn(`history store unreadable (${code}): ${this.path}`);
      return;
    }
    let start = 0;
    let lineNo = 0;
    while (start < raw.length) {
      let end = raw.indexOf("\n", start);
      if (end === -1) end = raw.length;
      const line = raw.slice(start, end).trim();
      lineNo++;
      this.processLine(line, lineNo);
      start = end + 1;
    }
    if (this.formatVersion !== null && this.formatVersion > STORE_FORMAT_VERSION) {
      this.warn(
        `store format v${this.formatVersion} is newer than this flakefinder (v${STORE_FORMAT_VERSION}) \u2014 unknown fields will be preserved`,
        true
      );
    }
  }
  processLine(line, i) {
    if (!line) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      if (this.warnings.length < 10) {
        this.warn(`skipping corrupt line ${i} in ${this.path}`);
      }
      return;
    }
    if (parsed.runId === void 0 && parsed.results === void 0) {
      if (typeof parsed.version === "number") {
        if (i === 1) this.formatVersion = parsed.version;
        else if (this.warnings.length < 10) {
          this.warn(`unexpected schema marker at line ${i} \u2014 skipped`);
        }
        return;
      }
      if (this.warnings.length < 10) {
        this.warn(`skipping record-shaped garbage at line ${i} in ${this.path}`);
      }
      return;
    }
    if (typeof parsed.runId !== "string" || !Array.isArray(parsed.results)) {
      if (this.warnings.length < 10) {
        this.warn(`skipping invalid record at line ${i} in ${this.path}`);
      }
      return;
    }
    this.records.push(parsed);
  }
  ensureHeader() {
    if (existsSync3(this.path) && statSync3(this.path).size > 0) return;
    appendFileSync(this.path, `${JSON.stringify({ version: STORE_FORMAT_VERSION })}
`, "utf8");
    this.formatVersion = STORE_FORMAT_VERSION;
  }
  get lockPath() {
    return `${this.path}.lock`;
  }
  /**
   * Advisory lock around writes (append/prune). Two CI matrix shards writing
   * multi-KB records can interleave in one append and corrupt a line — the
   * lock serializes them. Busy-waits in ≤50 ms slices (Atomics.wait) up to 2 s
   * before giving up with an actionable error; a lock older than 30 s is
   * treated as abandoned by a dead process and stolen.
   *
   * The lock file is created atomically WITH its content (write a private
   * temp file, then link() it into place — link fails if the lock exists), so
   * competitors never see a half-written lock. Empty/unparseable locks (older
   * flakefinder versions, torn writes) are aged by mtime, and stale locks are
   * broken by rename-then-verify (breakStaleLock), so two waiters can never
   * delete each other's freshly acquired lock.
   */
  acquireLock() {
    const deadline = Date.now() + 2e3;
    for (; ; ) {
      if (this.tryCreateLock()) return;
      if (Date.now() >= deadline) {
        throw new StoreBusyError(
          `history store is busy (held by another flakefinder process for >2s): ${this.lockPath}. Run ingest steps serially, or give each CI shard its own storeDir.`
        );
      }
      let content;
      try {
        content = readFileSync3(this.lockPath, "utf8");
      } catch (err) {
        const code = err.code;
        if (code === "ENOENT") continue;
        throw this.lockError(code, "exists but cannot be read as a lock file");
      }
      const ageMs = lockAgeMs(this.lockPath, content);
      if (ageMs === null) continue;
      if (ageMs > LOCK_STALE_MS2 && breakStaleLock(this.lockPath, content)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  lockError(code, what) {
    return new Error(
      `history store lock ${this.lockPath} ${what} (${code ?? "error"}) \u2014 check that the store directory is writable and that the lock path is not a directory`
    );
  }
  /**
   * One attempt to take the lock: true on success, false ONLY when another
   * process holds it (EEXIST). Anything else — read-only directory (EACCES,
   * EROFS), missing dir, … — throws: retrying cannot fix it, and treating it
   * as "held" used to spin forever.
   */
  tryCreateLock() {
    const token = JSON.stringify({
      pid: process.pid,
      epoch: Date.now(),
      nonce: randomBytes(6).toString("hex")
    });
    const tmp = `${this.lockPath}.${uniqueSuffix()}.tmp`;
    try {
      writeFileSync2(tmp, token, "utf8");
    } catch (err) {
      throw this.lockError(err.code, "cannot be created");
    }
    try {
      linkSync(tmp, this.lockPath);
      this.lockToken = token;
      return true;
    } catch (err) {
      const code = err.code;
      if (code === "EEXIST") return false;
      try {
        writeFileSync2(this.lockPath, token, { flag: "wx" });
        this.lockToken = token;
        return true;
      } catch (err2) {
        const code2 = err2.code;
        if (code2 === "EEXIST") return false;
        throw this.lockError(code2, "cannot be created");
      }
    } finally {
      rmSync2(tmp, { force: true });
    }
  }
  releaseLock() {
    const token = this.lockToken;
    this.lockToken = null;
    try {
      if (readFileSync3(this.lockPath, "utf8") === token) rmSync2(this.lockPath, { force: true });
    } catch {
    }
  }
  loadAll() {
    this.ensureLoaded();
    return [...this.records];
  }
  runs() {
    this.ensureLoaded();
    return [...this.records];
  }
  /**
   * Write paths must not surface raw EISDIR/EACCES: a directory (or other
   * non-file) at the store path would otherwise slip past ensureHeader()
   * (a directory's stat size is non-zero) and crash in appendFileSync.
   */
  assertWritableFile() {
    if (existsSync3(this.path) && !statSync3(this.path).isFile()) {
      throw new Error(
        `history store ${this.path} exists but is not a regular file \u2014 delete or rename it (flakefinder recreates it on the next write)`
      );
    }
  }
  /**
   * Appends without reading the store: when this instance has not loaded the
   * file yet, the record simply becomes part of the next (lazy) read.
   */
  append(run) {
    this.ensureStoreDir();
    this.assertWritableFile();
    this.acquireLock();
    try {
      try {
        this.ensureHeader();
        appendFileSync(this.path, `${JSON.stringify(run)}
`, "utf8");
      } catch (err) {
        const e = err;
        throw new Error(
          `cannot write history store ${this.path} (${e.code ?? "error"}) \u2014 check it is a writable regular file`
        );
      }
      if (this.loaded) this.records.push(run);
    } finally {
      this.releaseLock();
    }
  }
  /**
   * Keep only the last `maxRuns` RUNS (distinct runIds — one `run` with
   * retries writes one record per attempt, all sharing a runId, and they are
   * kept or dropped together); rewrite the file atomically.
   * Re-reads the file FRESH inside the lock: a stale in-memory snapshot
   * would silently delete records another process appended between our load
   * and this prune (verified 10/10 with two concurrent ingests before the
   * fix). In-memory records are resynced to the fresh state — including an
   * empty one: the stale view is only kept when the fresh read FAILED, and
   * then nothing is rewritten.
   */
  prune(maxRuns) {
    if (this.unreadable) return;
    if (!existsSync3(this.path)) return;
    this.ensureStoreDir();
    try {
      this.acquireLock();
    } catch (err) {
      if (!(err instanceof StoreBusyError)) throw err;
      this.warn(`history store busy \u2014 prune skipped this time: ${this.path}`);
      return;
    }
    try {
      const fresh = new _HistoryStore(path3.dirname(this.path));
      const source = fresh.runs();
      if (fresh.unreadable !== null) {
        if (this.loaded) {
          this.warn(`history store unreadable during prune \u2014 not pruned: ${this.path}`);
        } else {
          this.adopt(fresh);
        }
        return;
      }
      const keep = lastRuns(source, maxRuns);
      if (keep.length === source.length) {
        this.adopt(fresh);
        return;
      }
      const version = Math.max(fresh.formatVersion ?? STORE_FORMAT_VERSION, STORE_FORMAT_VERSION);
      const tmp = `${this.path}.tmp`;
      const fd = openSync2(tmp, "w");
      try {
        writeSync2(fd, `${JSON.stringify({ version })}
`, null, "utf8");
        for (const r of keep) writeSync2(fd, `${JSON.stringify(r)}
`, null, "utf8");
      } finally {
        closeSync2(fd);
      }
      renameSync2(tmp, this.path);
      this.adopt(fresh);
      this.records = keep;
      this.formatVersion = version;
    } finally {
      this.releaseLock();
    }
  }
  /** Resync this instance's view to a fresh read of the same store. */
  adopt(fresh) {
    if (!this.loaded) this.warnings.push(...fresh.warnings);
    this.loaded = true;
    this.records = fresh.runs();
    this.formatVersion = fresh.formatVersion;
    this.unreadable = fresh.unreadable;
  }
};

// src/util/glob.ts
import { readdirSync } from "fs";
import path4 from "path";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "coverage"]);
function globToRegExp(pattern, caseInsensitive) {
  const parts = pattern.split("/").filter((p) => p.length > 0);
  let re = "^";
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "**") {
      re += "(?:[^/]+/)*";
      if (i === parts.length - 1) re += "[^/]*";
      continue;
    }
    let seg = "";
    for (const ch of part) {
      if (ch === "*") seg += "[^/]*";
      else if (ch === "?") seg += "[^/]";
      else seg += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    re += seg;
    if (i < parts.length - 1) re += "/";
  }
  if (!re.endsWith("$")) re += "$";
  return new RegExp(re, caseInsensitive ? "i" : void 0);
}
function matchGlobs(cwd, patterns) {
  if (patterns.length === 0) return [];
  const caseInsensitive = process.platform === "win32";
  const normalized = patterns.map((p) => {
    const posix = p.replace(/\\/g, "/").replace(/^\.\//, "");
    return posix.includes("/") ? posix : `**/${posix}`;
  });
  const regexps = normalized.map((p) => globToRegExp(p, caseInsensitive));
  const matches = /* @__PURE__ */ new Set();
  const walk3 = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        walk3(path4.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (regexps.some((re) => re.test(relPath))) matches.add(path4.join(dir, entry.name));
      }
    }
  };
  walk3(cwd, "");
  return [...matches].sort();
}

// src/doctor.ts
var DAY_MS = 864e5;
function runDoctor(cwd, opts = {}) {
  const lines = [];
  let ok = true;
  let config;
  const explicit = opts.configPath ? path5.resolve(cwd, opts.configPath) : null;
  try {
    let configPath;
    if (explicit) {
      config = resolveConfig(readConfigFile(explicit));
      configPath = explicit;
    } else {
      const found = loadConfig(cwd);
      config = resolveConfig(found.config);
      configPath = found.path;
    }
    lines.push({
      status: configPath ? "ok" : "info",
      message: configPath ? `config: ${configPath}${explicit ? " (--config)" : ""}` : `config: none found (defaults in effect) \u2014 create one with flakefinder init`
    });
  } catch (err) {
    ok = false;
    lines.push({
      status: "fail",
      message: `config: invalid \u2014 ${err.message}`,
      hint: `fix ${explicit ?? "flakefinder.config.json"} (every problem is listed above)`
    });
    return { lines, ok };
  }
  const detected = detectRunner(cwd);
  const runner = config.runner === "auto" ? detected : config.runner;
  lines.push({
    status: "info",
    message: `runner: detected "${detected}"${config.runner !== "auto" ? ` (config pins "${config.runner}")` : ""}`
  });
  const reportFiles = matchGlobs(cwd, config.reports);
  if (reportFiles.length === 0) {
    lines.push({
      status: "warn",
      message: `reports: no files match ${config.reports.length > 0 ? config.reports.join(", ") : "(no globs configured)"}`,
      hint: 'make the test runner emit machine-readable reports, then set "reports" globs \u2014 run: flakefinder init'
    });
  } else {
    lines.push({
      status: "ok",
      message: `reports: ${reportFiles.length} file(s) match (${reportFiles.slice(0, 3).map((f) => path5.basename(f)).join(", ")}${reportFiles.length > 3 ? ", \u2026" : ""})`
    });
  }
  const store = new HistoryStore(path5.resolve(cwd, config.storeDir));
  if (existsSync4(store.path)) {
    try {
      const runs = store.runs();
      if (store.unreadable !== null) {
        ok = false;
        lines.push({
          status: "fail",
          message: `history: unreadable \u2014 ${store.unreadable}`,
          hint: `check that ${store.path} is a readable regular file (delete or rename it if it is a directory)`
        });
      } else {
        const sizeKb = Math.round(statSync4(store.path).size / 1024);
        lines.push({
          status: "ok",
          message: `history: ${runs.length} run(s), ${sizeKb} KB${store.formatVersion ? `, format v${store.formatVersion}` : " (legacy, no header)"}`
        });
        if (store.warnings.length > 0) {
          lines.push({
            status: "warn",
            message: `history: ${store.warnings.length}+ skipped/corrupt line(s)`,
            hint: "history is tolerant, but repeated corruption suggests parallel writers \u2014 give each CI shard its own storeDir"
          });
        }
        if (runs.length > 0) {
          const last = runs[runs.length - 1].timestamp;
          const ageDays = (Date.now() - Date.parse(last)) / DAY_MS;
          if (Number.isFinite(ageDays) && ageDays > 7) {
            lines.push({
              status: "warn",
              message: `history: last run ${Math.round(ageDays)} days ago`,
              hint: "flakefinder only knows what it ingests \u2014 is CI actually calling it?"
            });
          }
        }
      }
    } catch (err) {
      ok = false;
      lines.push({
        status: "fail",
        message: `history: unreadable \u2014 ${err.message}`,
        hint: `check that ${store.path} is a readable regular file`
      });
    }
  } else {
    lines.push({
      status: "warn",
      message: `history: empty (${config.storeDir}/history.jsonl does not exist yet)`,
      hint: "run: flakefinder run -- <test command>  (or flakefinder ingest <report files>)"
    });
  }
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 5e3 });
    if (r.status === 0) {
      lines.push({
        status: "ok",
        message: "git: commit SHAs available (same-commit flip detection works)"
      });
    } else {
      lines.push({
        status: "warn",
        message: "git: no commit SHA (not a repo or git missing)",
        hint: "same-commit flip detection is disabled \u2014 flip-flop stats fall back to per-run buckets"
      });
    }
  } catch {
    lines.push({ status: "warn", message: "git: could not check" });
  }
  const qPath = path5.resolve(cwd, config.quarantineFile);
  if (existsSync4(qPath)) {
    let entries;
    try {
      entries = new QuarantineManager(qPath).list();
    } catch (err) {
      ok = false;
      lines.push({
        status: "fail",
        message: `quarantine: unreadable \u2014 ${err.message}`,
        hint: `fix or delete ${qPath} \u2014 until then \`run\` only warns and excludes nothing, and \`quarantine add/remove\` refuse to touch it`
      });
      return { lines, ok };
    }
    const unsupported = runner === "go" || runner === "generic";
    lines.push({
      status: unsupported ? "warn" : "ok",
      message: `quarantine: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${unsupported ? ` \u2014 runner "${runner}" cannot auto-exclude them` : ""}`
    });
  } else {
    lines.push({
      status: "info",
      message: `quarantine: none (${qPath} absent)`
    });
  }
  return { lines, ok };
}

// src/engine/stats.ts
function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function p95(values) {
  return percentile(values, 95);
}
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1));
  return sorted[idx];
}
function durationStats(obs) {
  const vals = obs.map((o) => o.durationMs).filter((v) => typeof v === "number");
  return { medianMs: median(vals), p95Ms: p95(vals) };
}

// src/engine/classify.ts
var GONE_AFTER_RUNS = 30;
var RECENT_WINDOW = 5;
var FAIL_FAMILY = /* @__PURE__ */ new Set(["fail", "error"]);
function isFail(status) {
  return FAIL_FAMILY.has(status);
}
function sortRuns(runs) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of runs) {
    const g = groups.get(r.runId);
    if (g) g.push(r);
    else groups.set(r.runId, [r]);
  }
  const minTs = (g) => {
    let min = g[0].timestamp;
    for (const r of g) if (r.timestamp < min) min = r.timestamp;
    return min;
  };
  const ordered = [];
  for (const g of [...groups.values()].sort((a, b) => {
    const am = minTs(a);
    const bm = minTs(b);
    if (am !== bm) return am < bm ? -1 : 1;
    return 0;
  })) {
    g.sort((a, b) => a.attempt - b.attempt);
    ordered.push(...g);
  }
  return ordered;
}
var STATUSES = /* @__PURE__ */ new Set(["pass", "fail", "skip", "error"]);
function executionStatuses(r) {
  if (!Array.isArray(r.attempts)) return [r.status];
  const statuses = r.attempts.filter((s) => STATUSES.has(s));
  if (statuses[statuses.length - 1] !== r.status) statuses.push(r.status);
  return statuses.length < 2 ? [r.status] : statuses;
}
function collectHistories(sortedRuns) {
  const byId = /* @__PURE__ */ new Map();
  for (const run of sortedRuns) {
    for (const r of run.results) {
      let h = byId.get(r.testId);
      if (!h) {
        h = { testId: r.testId, suite: r.suite, name: r.name, observations: [] };
        byId.set(r.testId, h);
      }
      h.suite = r.suite;
      h.name = r.name;
      const statuses = executionStatuses(r);
      statuses.forEach((status, sub) => {
        h.observations.push({
          runId: run.runId,
          timestamp: run.timestamp,
          status,
          attempt: run.attempt,
          sub,
          commitSha: run.commitSha,
          message: r.message,
          // the reported duration belongs to the final execution only
          durationMs: sub === statuses.length - 1 ? r.durationMs ?? void 0 : void 0
        });
      });
    }
  }
  return [...byId.values()];
}
function collapsePerAttempt(nonSkip) {
  const perAttempt = /* @__PURE__ */ new Map();
  for (const o of nonSkip) {
    perAttempt.set(`${o.runId}\0${o.attempt}\0${o.sub}`, o);
  }
  return [...perAttempt.values()];
}
function collapsePerRun(collapsed) {
  const perRun = /* @__PURE__ */ new Map();
  for (const o of collapsed) perRun.set(o.runId, o);
  return [...perRun.values()];
}
function countSameShaFlips(collapsed) {
  const perSha = /* @__PURE__ */ new Map();
  for (const o of collapsed) {
    if (!o.commitSha) continue;
    const entry = perSha.get(o.commitSha) ?? { hasPass: false, hasFail: false };
    if (isFail(o.status)) entry.hasFail = true;
    else entry.hasPass = true;
    perSha.set(o.commitSha, entry);
  }
  let flips = 0;
  for (const e of perSha.values()) {
    if (e.hasPass && e.hasFail) flips++;
  }
  return flips;
}
function countRetryRescues(collapsed) {
  let rescues = 0;
  for (let i = 1; i < collapsed.length; i++) {
    const prev = collapsed[i - 1];
    const cur = collapsed[i];
    const consecutive = cur.attempt === prev.attempt && cur.sub === prev.sub + 1 || cur.attempt === prev.attempt + 1 && cur.sub === 0;
    if (prev.runId === cur.runId && consecutive && isFail(prev.status) && !isFail(cur.status)) {
      rescues++;
    }
  }
  return rescues;
}
function directionChanges(collapsed) {
  const visits = [];
  for (const o of collapsed) {
    const state = o.commitSha !== void 0 ? `sha:${o.commitSha}` : `run:${o.runId}`;
    const fail = isFail(o.status);
    const last = visits[visits.length - 1];
    if (!last || last.state !== state) visits.push({ state, fail, since: o.timestamp });
    else if (last.fail !== fail) {
      last.fail = fail;
      last.since = o.timestamp;
    }
  }
  let changes = 0;
  let lastChangeAt;
  for (let i = 1; i < visits.length; i++) {
    if (visits[i].fail !== visits[i - 1].fail) {
      changes++;
      lastChangeAt = visits[i].since;
    }
  }
  return { changes, lastChangeAt };
}
function trailingConsecutiveFails(perRun) {
  let n = 0;
  for (let i = perRun.length - 1; i >= 0; i--) {
    if (isFail(perRun[i].status)) n++;
    else break;
  }
  return n;
}
function recencyMultiplier(lastChangeAt) {
  if (lastChangeAt === void 0) return 0.3;
  const ts = Date.parse(lastChangeAt);
  if (Number.isNaN(ts)) return 1;
  const ageDays = (Date.now() - ts) / 864e5;
  if (ageDays <= 14) return 1;
  if (ageDays <= 30) return 0.6;
  return 0.3;
}
function flakeScore(opts) {
  let score = Math.min(50, opts.sameShaFlips * 50);
  score += Math.min(40, opts.retryRescues * 40);
  score += Math.min(24, opts.directionChanges * 8 * recencyMultiplier(opts.lastChangeAt));
  if (opts.runsObserved >= 10) score += 10;
  return Math.min(100, Math.round(score));
}
function classify(opts) {
  const { perRun, cfg } = opts;
  if (!opts.seenRecently) return "gone";
  if (perRun.length === 0) return "skipped";
  if (opts.sameShaFlips > 0) return "flaky-confirmed";
  if (opts.retryRescues > 0) return "flaky-retry";
  if (opts.directionChanges >= 2 && perRun.length >= cfg.minRuns && opts.bothFamilies)
    return "flaky-suspected";
  const lastWindow = perRun.slice(-RECENT_WINDOW);
  if (lastWindow.every((o) => isFail(o.status)) && perRun.length >= cfg.minRuns) return "failing";
  const last = perRun[perRun.length - 1];
  if (isFail(last.status)) return "new-failure";
  return "passing";
}
function confidenceFor(classification, perRun, executions, cfg) {
  switch (classification) {
    case "flaky-confirmed":
    case "flaky-retry":
      return 100;
    case "flaky-suspected":
      return Math.min(70, Math.round(35 * perRun.length / Math.max(1, cfg.minRuns)));
    case "failing":
      return Math.min(95, 25 + 5 * trailingConsecutiveFails(perRun));
    case "new-failure":
      return Math.min(50, 10 + 5 * executions.filter((o) => isFail(o.status)).length);
    default:
      return 100;
  }
}
var SLOW_RELATIVE_FLOOR_MS = 100;
function classifyAll(runs, cfg) {
  if (runs.length === 0) return [];
  const sorted = sortRuns(runs);
  const runOrder = [];
  for (const r of sorted) if (runOrder[runOrder.length - 1] !== r.runId) runOrder.push(r.runId);
  const recentRunIds = new Set(runOrder.slice(-GONE_AFTER_RUNS));
  const histories = collectHistories(sorted);
  const verdicts = histories.map((h) => {
    const nonSkip = h.observations.filter((o) => o.status !== "skip");
    const collapsed = collapsePerAttempt(nonSkip);
    const perRun = collapsePerRun(collapsed);
    const lastObs = h.observations[h.observations.length - 1];
    const sameShaFlips = countSameShaFlips(collapsed);
    const retryRescues = countRetryRescues(collapsed);
    const dc = directionChanges(collapsed);
    const seenRecently = h.observations.some((o) => recentRunIds.has(o.runId));
    const bothFamilies = collapsed.some((o) => isFail(o.status)) && collapsed.some((o) => !isFail(o.status));
    const classification = classify({
      seenRecently,
      perRun,
      bothFamilies,
      sameShaFlips,
      retryRescues,
      directionChanges: dc.changes,
      cfg
    });
    const lastFail = [...collapsed].reverse().find((o) => isFail(o.status));
    const score = bothFamilies ? flakeScore({
      sameShaFlips,
      retryRescues,
      directionChanges: dc.changes,
      runsObserved: perRun.length,
      lastChangeAt: dc.lastChangeAt
    }) : 0;
    const { medianMs, p95Ms } = durationStats(collapsed);
    const passes = collapsed.filter((o) => !isFail(o.status)).length;
    const tags = [];
    if (!seenRecently) tags.push("long-unseen");
    const firstHalf = perRun.slice(0, Math.floor(perRun.length / 2));
    const lastWindow = perRun.slice(-RECENT_WINDOW);
    if (firstHalf.some((o) => isFail(o.status)) && lastWindow.length > 0 && lastWindow.every((o) => !isFail(o.status))) {
      tags.push("recently-fixed");
    }
    return {
      testId: h.testId,
      suite: h.suite,
      name: h.name,
      classification,
      tags,
      flakeScore: score,
      confidence: confidenceFor(classification, perRun, collapsed, cfg),
      // over executions (retry attempts included), so a rescued run reads 50%
      passRate: collapsed.length === 0 ? 0 : passes / collapsed.length,
      runsObserved: perRun.length,
      lastStatus: lastObs.status,
      lastSeen: lastObs.timestamp,
      lastMessage: lastFail?.message,
      medianDurationMs: medianMs,
      p95DurationMs: p95Ms,
      sameShaFlips,
      retryRescues,
      directionChanges: dc.changes
    };
  });
  const perSuite = /* @__PURE__ */ new Map();
  for (const v of verdicts) {
    if (v.medianDurationMs != null) {
      const list = perSuite.get(v.suite) ?? [];
      list.push(v.medianDurationMs);
      perSuite.set(v.suite, list);
    }
  }
  const suiteMedians = /* @__PURE__ */ new Map();
  for (const [suite, values] of perSuite) {
    const m = median(values);
    if (m != null) suiteMedians.set(suite, m);
  }
  for (const v of verdicts) {
    const suiteMedianMs = suiteMedians.get(v.suite);
    const slowAbsolute = v.medianDurationMs != null && cfg.slowThresholdMs != null && v.medianDurationMs > cfg.slowThresholdMs;
    const slowRelative = v.p95DurationMs != null && suiteMedianMs != null && v.p95DurationMs >= SLOW_RELATIVE_FLOOR_MS && v.p95DurationMs > cfg.slowMultiplier * suiteMedianMs;
    if (slowAbsolute || slowRelative) v.tags.push("slow");
  }
  return verdicts;
}

// src/util/test-id.ts
import { createHash } from "crypto";
function makeTestId(suite, name) {
  const norm = (s) => s.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(`${norm(suite)}\0${norm(name)}`).digest("hex").slice(0, 16);
}

// src/parsers/internal.ts
var XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true
};
function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function toArray(v) {
  if (v === void 0 || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
function trimTo(value, max) {
  if (typeof value !== "string") return void 0;
  const t = value.trim();
  if (t === "") return void 0;
  return t.length > max ? t.slice(0, max) : t;
}
function stripAnsi(text2) {
  return text2.replace(/\u001b\[[0-9;]*m/g, "");
}
function stripBom(content) {
  return content.charCodeAt(0) === 65279 ? content.slice(1) : content;
}
function msOf(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}
function retryAttempts(failed, final, failStatus = "fail") {
  if (!Number.isInteger(failed) || failed <= 0) return void 0;
  return [...Array(failed).fill(failStatus), final];
}
var jsonCache;
function parseJson(content) {
  if (jsonCache !== void 0 && jsonCache.content === content) return jsonCache.parsed;
  let parsed;
  try {
    parsed = { doc: JSON.parse(stripBom(content)) };
  } catch (err) {
    parsed = { error: errorMessage(err) };
  }
  jsonCache = { content, parsed };
  return parsed;
}
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
var MAX_FLAKY_NAMES = 10;
function flakyRetryMessage(failedAttempts, how, firstFailure, max) {
  const header = `flaky: failed ${failedAttempts} of ${failedAttempts + 1} attempts before passing on ${how}`;
  const first = trimTo(firstFailure, max);
  return trimTo(first !== void 0 ? `${header} \u2014 first failure: ${first}` : header, max);
}
function flakyRetryWarning(format, sourcePath, how, names) {
  const shown = names.slice(0, MAX_FLAKY_NAMES).join(", ");
  const more = names.length > MAX_FLAKY_NAMES ? ` \u2026and ${names.length - MAX_FLAKY_NAMES} more` : "";
  return `${format}: ${sourcePath}: ${names.length} test(s) FLAKY \u2014 failed, then passed on ${how} (recorded as pass with the failure in the message): ${shown}${more}`;
}

// src/parsers/gotest.ts
var MAX_MALFORMED_DETAILS = 5;
var SNIFF_MAX_LINES = 50;
var WARNING_EXCERPT_LINES = 5;
var MESSAGE_MAX_CHARS = 2e3;
var MAX_FLAKY_NAMES2 = 10;
function excerptOf(lines) {
  const kept = lines.map((l) => stripAnsi(l).trim()).filter((l) => l !== "");
  const head = kept.slice(0, WARNING_EXCERPT_LINES).join(" | ");
  return kept.length > WARNING_EXCERPT_LINES ? `${head} | \u2026` : head;
}
function isBenchmark(test) {
  return /^Benchmark/.test(test);
}
function hasBenchResult(outputs) {
  return /^Benchmark\S*\s+\d+\s+[\d.]+ \S+\/op\b/m.test(outputs.join(""));
}
function runAttempts(runs, status) {
  const statuses = runs.map((r) => r.status);
  if (statuses[statuses.length - 1] === status) return statuses;
  return [...statuses.filter((s) => s !== status), ...statuses.filter((s) => s === status)];
}
function isFailFamily(status) {
  return status === "fail" || status === "error";
}
function newRun() {
  return { durationMs: null, outputs: [] };
}
function elapsedToMs(ev) {
  const raw = ev.elapsed !== void 0 ? ev.elapsed : ev.Elapsed;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.round(raw * 1e3);
}
var FRAMING_LINE = /^\s*(?:=== (?:RUN|PAUSE|CONT|NAME)\b|--- (?:PASS|FAIL|SKIP|BENCH): )/;
function messageFromOutputs(outputs) {
  if (outputs.length === 0) return void 0;
  const text2 = stripAnsi(outputs.join("")).split(/\r?\n/).filter((line) => line.trim() !== "" && !FRAMING_LINE.test(line)).join("\n");
  if (text2 === "") return void 0;
  return text2.length > MESSAGE_MAX_CHARS ? text2.slice(-MESSAGE_MAX_CHARS) : text2;
}
var goTestParser = {
  name: "go",
  sniff(content) {
    let seen = 0;
    for (const raw of stripBom(content).split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "") continue;
      if (++seen > SNIFF_MAX_LINES) return false;
      if (!line.startsWith("{")) continue;
      try {
        const ev = JSON.parse(line);
        if (isObj(ev) && "Action" in ev && ("Package" in ev || "ImportPath" in ev)) return true;
      } catch {
      }
    }
    return false;
  },
  parse(content, sourcePath) {
    const results = [];
    const warnings = [];
    const tests = /* @__PURE__ */ new Map();
    const failedPackages = /* @__PURE__ */ new Map();
    const builds = /* @__PURE__ */ new Map();
    const strayText = [];
    const passedPackages = /* @__PURE__ */ new Set();
    let malformed = 0;
    const lines = stripBom(content).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === void 0 || line.trim() === "") continue;
      if (!line.trimStart().startsWith("{")) {
        strayText.push(line.trim());
        continue;
      }
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (err) {
        malformed++;
        if (malformed <= MAX_MALFORMED_DETAILS) {
          warnings.push(`go: ${sourcePath}: line ${i + 1}: invalid JSON (${errorMessage(err)})`);
        }
        continue;
      }
      if (!isObj(ev)) continue;
      if (ev.Action === "build-output" || ev.Action === "build-fail") {
        const importPath = typeof ev.ImportPath === "string" ? ev.ImportPath : "(unknown)";
        const build = builds.get(importPath) ?? { failed: false, outputs: [] };
        if (ev.Action === "build-fail") build.failed = true;
        else if (typeof ev.Output === "string") build.outputs.push(ev.Output);
        builds.set(importPath, build);
        continue;
      }
      const pkg = typeof ev.Package === "string" ? ev.Package : "";
      const test = typeof ev.Test === "string" && ev.Test.trim() !== "" ? ev.Test : null;
      if (pkg === "") continue;
      const action = ev.Action;
      const out = ev.Output !== void 0 ? ev.Output : ev.output;
      if (test === null) {
        if (action === "pass") passedPackages.add(pkg);
        if (action === "fail") {
          const entry = failedPackages.get(pkg) ?? { failed: false, outputs: [] };
          entry.failed = true;
          if (typeof ev.FailedBuild === "string") entry.failedBuild = ev.FailedBuild;
          failedPackages.set(pkg, entry);
        } else if (action === "output" && typeof out === "string") {
          const entry = failedPackages.get(pkg) ?? { failed: false, outputs: [] };
          entry.outputs.push(out);
          failedPackages.set(pkg, entry);
        }
        continue;
      }
      const key = `${pkg}\0${test}`;
      let acc = tests.get(key);
      if (acc === void 0) {
        if (action !== "run" && action !== "pass" && action !== "fail" && action !== "skip") {
          continue;
        }
        acc = { pkg, test, runs: [newRun()] };
        tests.set(key, acc);
      } else if ((action === "run" || action === "pass" || action === "fail" || action === "skip") && acc.runs[acc.runs.length - 1].status !== void 0) {
        acc.runs.push(newRun());
      }
      const run = acc.runs[acc.runs.length - 1];
      if (action === "pass" || action === "fail" || action === "skip") {
        run.status = action;
        run.durationMs = elapsedToMs(ev);
      } else if (action === "output") {
        if (typeof out === "string") run.outputs.push(out);
      }
    }
    if (malformed > MAX_MALFORMED_DETAILS) {
      warnings.push(`\u2026and ${malformed - MAX_MALFORMED_DETAILS} more malformed lines`);
    }
    const rows = [];
    for (const acc of tests.values()) {
      const last = acc.runs[acc.runs.length - 1];
      if (last.status === void 0 && isBenchmark(acc.test)) {
        const prefix = `${acc.test}/`;
        const ran = hasBenchResult(last.outputs) || passedPackages.has(acc.pkg) || [...tests.values()].some(
          (o) => o.pkg === acc.pkg && o.test.startsWith(prefix) && hasBenchResult(o.runs[o.runs.length - 1].outputs)
        );
        if (ran) last.status = "pass";
      }
      if (last.status === void 0) {
        const result2 = {
          testId: makeTestId(acc.pkg, acc.test),
          suite: acc.pkg,
          name: acc.test,
          status: "error",
          durationMs: null,
          message: "test started but never reported a result (test binary crashed mid-run?)"
        };
        const output = messageFromOutputs(last.outputs);
        if (output !== void 0) result2.message = `${result2.message}
${output}`;
        if (acc.runs.length > 1) {
          result2.attempts = [...acc.runs.slice(0, -1).map((r) => r.status), "error"];
        }
        rows.push({ acc, result: result2, dangling: true, flaky: false });
        continue;
      }
      const failed = acc.runs.filter((r) => r.status === "fail");
      const reported = failed[0] ?? last;
      const result = {
        testId: makeTestId(acc.pkg, acc.test),
        suite: acc.pkg,
        name: acc.test,
        status: reported.status,
        durationMs: reported.durationMs
      };
      let message = reported.status === "pass" ? void 0 : messageFromOutputs(reported.outputs);
      const isFlaky2 = failed.length > 0 && failed.length < acc.runs.length;
      if (isFlaky2) {
        const note = `flaky: failed ${failed.length} of ${acc.runs.length} runs in this report`;
        message = message !== void 0 ? `${note}
${message}` : note;
      }
      if (message !== void 0) result.message = message;
      if (acc.runs.length > 1) result.attempts = runAttempts(acc.runs, result.status);
      rows.push({ acc, result, dangling: false, flaky: isFlaky2 });
    }
    const hasChildren = /* @__PURE__ */ new Set();
    const hasFailingChild = /* @__PURE__ */ new Set();
    for (const { acc, result } of rows) {
      const parts = acc.test.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const ancestor = `${acc.pkg}\0${parts.slice(0, depth).join("/")}`;
        hasChildren.add(ancestor);
        if (isFailFamily(result.status)) hasFailingChild.add(ancestor);
      }
    }
    let dangling = 0;
    const flaky = [];
    for (const row of rows) {
      const key = `${row.acc.pkg}\0${row.acc.test}`;
      if (hasChildren.has(key) && (hasFailingChild.has(key) || !isFailFamily(row.result.status))) {
        continue;
      }
      if (row.dangling) dangling++;
      if (row.flaky) flaky.push(`${row.acc.pkg} ${row.acc.test}`);
      results.push(row.result);
    }
    if (flaky.length > 0) {
      const shown = flaky.slice(0, MAX_FLAKY_NAMES2).join(", ");
      const more = flaky.length > MAX_FLAKY_NAMES2 ? ` \u2026and ${flaky.length - MAX_FLAKY_NAMES2} more` : "";
      warnings.push(
        `go: ${sourcePath}: ${flaky.length} test(s) failed in some but not all repeated runs (-count) \u2014 reported as fail: ${shown}${more}`
      );
    }
    if (dangling > 0) {
      warnings.push(
        `go: ${sourcePath}: ${dangling} test(s) started but never reported a result \u2014 synthesized as error (package crash?)`
      );
    }
    for (const [importPath, build] of builds) {
      if (!build.failed) continue;
      const excerpt = excerptOf(build.outputs.join("").split(/\r?\n/));
      warnings.push(
        `go: ${sourcePath}: build failed for ${importPath}${excerpt ? `: ${excerpt}` : ""}`
      );
    }
    const pkgsWithTests = new Set([...tests.values()].map((a) => a.pkg));
    for (const [pkg, entry] of failedPackages) {
      if (!entry.failed || pkgsWithTests.has(pkg)) continue;
      const build = entry.failedBuild !== void 0 ? builds.get(entry.failedBuild) : void 0;
      const output = messageFromOutputs([...build?.outputs ?? [], ...entry.outputs]);
      const reason = build !== void 0 ? "package failed to build" : "package failed before any test completed (build or init crash?)";
      results.push({
        testId: makeTestId(pkg, "(package)"),
        suite: pkg,
        name: "(package)",
        status: "error",
        durationMs: null,
        message: output !== void 0 ? `${reason}
${output}` : reason
      });
      if (build === void 0 || !build.failed) {
        warnings.push(
          `go: ${sourcePath}: package ${pkg} failed with no test results \u2014 synthesized as error`
        );
      }
    }
    if (strayText.length > 0) {
      warnings.push(
        `go: ${sourcePath}: ${strayText.length} non-JSON line(s) ignored (stderr merged into the stream? build errors?): ${excerptOf(strayText)}`
      );
    }
    return { results, warnings };
  }
};

// src/parsers/jest.ts
var SUITE_PLACEHOLDER = "(suite)";
function statusOf(status, failureMessages) {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "error":
      return "error";
    case "focused":
      return failureMessages.length > 0 ? "fail" : "pass";
    case "pending":
    case "skipped":
    // vitest's json reporter emits "skipped" (jest: "pending")
    case "todo":
    case "disabled":
      return "skip";
    default:
      return null;
  }
}
var jestParser = {
  name: "jest",
  sniff(content) {
    const parsed = parseJson(content);
    if (!("doc" in parsed)) return false;
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.testResults)) return false;
    if (doc.testResults.length === 0) return true;
    return doc.testResults.some((file) => isObj(file) && Array.isArray(file.assertionResults));
  },
  parse(content, sourcePath) {
    const results = [];
    const warnings = [];
    const parsed = parseJson(content);
    if (!("doc" in parsed)) {
      return { results, warnings: [`jest: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.testResults)) {
      return { results, warnings: [`jest: ${sourcePath}: missing testResults[] array`] };
    }
    const flaky = [];
    const flakyHow = /* @__PURE__ */ new Set();
    for (const file of doc.testResults) {
      if (!isObj(file)) {
        warnings.push(`jest: ${sourcePath}: skipping non-object entry in testResults[]`);
        continue;
      }
      const filePath = typeof file.name === "string" && file.name.trim() !== "" ? file.name.replace(/\\/g, "/") : "(unknown file)";
      const assertions = toArray(file.assertionResults);
      let anyAssertionFailed = false;
      for (const assertion of assertions) {
        if (!isObj(assertion)) {
          warnings.push(`jest: ${sourcePath}: skipping non-object entry in assertionResults[]`);
          continue;
        }
        const failureMessages = toArray(assertion.failureMessages);
        const status = statusOf(assertion.status, failureMessages);
        if (status === null) {
          warnings.push(
            `jest: ${sourcePath}: unknown assertion status ${JSON.stringify(assertion.status)}`
          );
          continue;
        }
        const ancestors = Array.isArray(assertion.ancestorTitles) ? assertion.ancestorTitles.filter(
          (title) => typeof title === "string" && title.trim() !== ""
        ) : [];
        const suite = ancestors.length > 0 ? ancestors.join(" > ") : filePath;
        const name = typeof assertion.title === "string" && assertion.title.trim() !== "" ? assertion.title : typeof assertion.fullName === "string" && assertion.fullName.trim() !== "" ? assertion.fullName : status === "error" ? SUITE_PLACEHOLDER : "(unnamed)";
        const durationMs2 = msOf(assertion.duration);
        let message = trimTo(failureMessages[0], 2e3);
        if (status === "fail" || status === "error") anyAssertionFailed = true;
        const invocations = typeof assertion.invocations === "number" && Number.isInteger(assertion.invocations) && assertion.invocations > 1 ? assertion.invocations : void 0;
        let attempts;
        if (status === "pass" && (invocations !== void 0 || failureMessages.length > 0)) {
          const reasons = [
            ...toArray(assertion.retryReasons),
            ...toArray(assertion.retryMessages),
            ...failureMessages
          ];
          const how = invocations !== void 0 ? "jest retry" : "vitest retry";
          const failedAttempts = invocations !== void 0 ? invocations - 1 : failureMessages.length;
          message = flakyRetryMessage(
            failedAttempts,
            how,
            reasons.find((r) => typeof r === "string"),
            2e3
          );
          attempts = retryAttempts(failedAttempts, "pass");
          flaky.push(`${suite} > ${name}`);
          flakyHow.add(how);
        } else if (status === "fail" && invocations !== void 0) {
          attempts = retryAttempts(invocations - 1, "fail");
          const note = `(failed all ${invocations} attempts)`;
          message = trimTo(message !== void 0 ? `${message}
${note}` : note, 2e3);
        }
        const result = {
          testId: makeTestId(suite, name),
          suite,
          name,
          status,
          durationMs: durationMs2
        };
        if (message !== void 0) result.message = message;
        if (attempts !== void 0) result.attempts = attempts;
        results.push(result);
      }
      const execError = isObj(file.testExecError) ? file.testExecError : void 0;
      if ((file.status === "failed" || execError !== void 0) && !anyAssertionFailed) {
        const message = trimTo(file.message, 2e3) ?? trimTo(file.failureMessage, 2e3) ?? trimTo(execError?.message, 2e3) ?? // vitest leaves the message empty when e.g. beforeAll threw
        "test file failed outside any test (beforeAll/afterAll hook, import or collection error) \u2014 no test carried the failure";
        const result = {
          testId: makeTestId(filePath, SUITE_PLACEHOLDER),
          suite: filePath,
          name: SUITE_PLACEHOLDER,
          status: "fail",
          durationMs: null
        };
        result.message = message;
        results.push(result);
      }
    }
    if (flaky.length > 0) {
      warnings.push(flakyRetryWarning("jest", sourcePath, [...flakyHow].join("/"), flaky));
    }
    return { results, warnings };
  }
};

// src/parsers/junit.ts
import { XMLParser } from "fast-xml-parser";
var xml = new XMLParser(XML_OPTIONS);
var MESSAGE_MAX_CHARS2 = 2e3;
var STACK_MAX_CHARS = 1e3;
function attr(node, name) {
  const v = node[name];
  return typeof v === "string" && v.trim() !== "" ? v : void 0;
}
function textOf(node) {
  if (typeof node === "string") return node;
  if (isObj(node)) {
    const t = node["#text"];
    if (typeof t === "string") return t;
    if (Array.isArray(t)) return t.filter((part) => typeof part === "string").join("");
  }
  return void 0;
}
function durationOf(timeAttr) {
  if (timeAttr === void 0) return null;
  const raw = timeAttr.trim();
  const normalized = raw.includes(".") ? raw.replace(/,/g, "") : raw.replace(/^(\d*),(\d+)$/, "$1.$2");
  const seconds = Number.parseFloat(normalized);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1e3) : null;
}
function detailMessage(detail) {
  let fromAttr = isObj(detail) ? attr(detail, "@_message") : void 0;
  if (fromAttr !== void 0 && /^\s*(?:failed|failure|error)\s*$/i.test(fromAttr)) {
    fromAttr = void 0;
  }
  return trimTo(fromAttr, MESSAGE_MAX_CHARS2) ?? trimTo(detailStack(detail), MESSAGE_MAX_CHARS2) ?? // `<error type="java.lang.NPE"/>`: the type is all there is
  (isObj(detail) ? trimTo(attr(detail, "@_type"), MESSAGE_MAX_CHARS2) : void 0);
}
function detailStack(detail) {
  const text2 = textOf(detail);
  if (text2 !== void 0 && text2.trim() !== "") return text2;
  if (isObj(detail)) {
    const nested = children(detail, "stackTrace")[0];
    return textOf(nested);
  }
  return void 0;
}
function mapTestCase(tc, suiteName, ctx) {
  if (!isObj(tc)) return;
  const name = attr(tc, "@_name");
  if (name === void 0) {
    ctx.warnings.push(`junit: ${ctx.sourcePath}: skipping <testcase> without a name attribute`);
    return;
  }
  const suite = attr(tc, "@_classname") ?? suiteName;
  const failures = children(tc, "failure");
  const errors = children(tc, "error");
  const skipped = children(tc, "skipped").length > 0;
  let status = "pass";
  let details = [];
  if (skipped && errors.length === 0) {
    status = "skip";
  } else if (failures.length > 0) {
    status = "fail";
    details = failures;
  } else if (errors.length > 0) {
    status = "error";
    details = errors;
  } else if (skipped) {
    status = "skip";
  }
  const detail = details[0];
  const result = {
    testId: makeTestId(suite, name),
    suite,
    name,
    status,
    durationMs: durationOf(attr(tc, "@_time"))
  };
  if (detail !== void 0) {
    let message = detailMessage(detail);
    if (details.length > 1) {
      const kind = status === "fail" ? "failure" : "error";
      const more = `(+${details.length - 1} more ${kind}${details.length > 2 ? "s" : ""})`;
      message = trimTo(message !== void 0 ? `${message}
${more}` : more, MESSAGE_MAX_CHARS2);
    }
    const stack = trimTo(textOf(detail), STACK_MAX_CHARS);
    if (message !== void 0) result.message = message;
    if (stack !== void 0) result.stack = stack;
  }
  const reruns = [...children(tc, "rerunFailure"), ...children(tc, "rerunError")];
  const flakes = [...children(tc, "flakyFailure"), ...children(tc, "flakyError")];
  if ((status === "fail" || status === "error") && reruns.length > 0) {
    const note = `(Surefire: failed all ${reruns.length + 1} attempts)`;
    result.message = trimTo(
      result.message !== void 0 ? `${result.message}
${note}` : note,
      MESSAGE_MAX_CHARS2
    );
    result.attempts = retryAttempts(reruns.length, status, status);
  } else if (status === "pass" && flakes.length > 0) {
    const first = flakes[0];
    result.message = flakyRetryMessage(
      flakes.length,
      "Surefire rerun",
      detailMessage(first),
      MESSAGE_MAX_CHARS2
    );
    const stack = trimTo(detailStack(first), STACK_MAX_CHARS);
    if (stack !== void 0) result.stack = stack;
    const failedKinds = [
      ...children(tc, "flakyFailure").map(() => "fail"),
      ...children(tc, "flakyError").map(() => "error")
    ];
    result.attempts = [...failedKinds, "pass"];
    ctx.flaky.push(`${suite}.${name}`);
  }
  ctx.results.push(result);
}
function collapsePytestReruns(ctx) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of ctx.results) {
    const g = groups.get(r.testId);
    if (g) g.push(r);
    else groups.set(r.testId, [r]);
  }
  const out = [];
  for (const group of groups.values()) {
    const final = group[group.length - 1];
    const earlier = group.slice(0, -1);
    const reruns = earlier.length > 0 && earlier.every((r) => r.status === "pass" && r.message === void 0 && r.stack === void 0);
    if (!reruns) {
      out.push(...group);
      continue;
    }
    const how = "pytest-rerunfailures rerun";
    if (final.status === "pass") {
      final.message = flakyRetryMessage(earlier.length, how, void 0, MESSAGE_MAX_CHARS2);
      final.attempts = retryAttempts(earlier.length, "pass");
      ctx.flaky.push(`${final.suite}.${final.name}`);
    } else if (final.status === "fail" || final.status === "error") {
      const note = `(failed all ${group.length} attempts)`;
      final.message = trimTo(
        final.message !== void 0 ? `${final.message}
${note}` : note,
        MESSAGE_MAX_CHARS2
      );
      final.attempts = retryAttempts(earlier.length, final.status, final.status);
    }
    out.push(final);
  }
  ctx.results = out;
}
function children(el, localName) {
  const out = [];
  for (const [key, value] of Object.entries(el)) {
    if (key === localName || key.endsWith(`:${localName}`)) {
      if (Array.isArray(value)) out.push(...value);
      else out.push(value);
    }
  }
  return out;
}
function walk(el, inheritedSuite, ctx) {
  if (!isObj(el)) return;
  const ownSuite = attr(el, "@_name") ?? inheritedSuite;
  if (ownSuite === "pytest") ctx.pytest = true;
  for (const tc of children(el, "testcase")) mapTestCase(tc, ownSuite, ctx);
  for (const ts of children(el, "testsuite")) walk(ts, ownSuite, ctx);
}
var junitParser = {
  name: "junit",
  sniff(content) {
    const trimmed = stripBom(content).trimStart();
    return trimmed.startsWith("<") && /<(?:[\w.-]+:)?testsuit/.test(trimmed);
  },
  parse(content, sourcePath) {
    const ctx = { sourcePath, results: [], warnings: [], flaky: [], pytest: false };
    const body = stripBom(content);
    if (body.trim() === "") {
      ctx.warnings.push(`junit: ${sourcePath}: file is empty`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!body.trimEnd().endsWith(">")) {
      ctx.warnings.push(`junit: ${sourcePath}: content appears truncated (does not end with '>')`);
    }
    let doc;
    try {
      doc = xml.parse(body);
    } catch (err) {
      ctx.warnings.push(`junit: ${sourcePath}: failed to parse XML: ${errorMessage(err)}`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!isObj(doc)) {
      ctx.warnings.push(`junit: ${sourcePath}: XML did not parse to a document object`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    const rootKey = Object.keys(doc).find((k) => /(?:^|:)testsuites?$/.test(k));
    let root = rootKey !== void 0 ? doc[rootKey] : void 0;
    if (Array.isArray(root)) {
      ctx.warnings.push(
        `junit: ${sourcePath}: multiple <testsuites> roots found \u2014 using the first`
      );
      root = root[0];
    }
    if (root === void 0) {
      ctx.warnings.push(`junit: ${sourcePath}: no <testsuites> or <testsuite> root element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    walk(root, "unknown", ctx);
    if (ctx.pytest) collapsePytestReruns(ctx);
    if (ctx.flaky.length > 0) {
      const how = ctx.pytest ? "pytest-rerunfailures rerun" : "Surefire rerun";
      ctx.warnings.push(flakyRetryWarning("junit", sourcePath, how, ctx.flaky));
    }
    return { results: ctx.results, warnings: ctx.warnings };
  }
};

// src/parsers/mocha.ts
function keyOf(entry) {
  const fullTitle = typeof entry.fullTitle === "string" ? entry.fullTitle.trim() : "";
  if (fullTitle === "") return "";
  const file = typeof entry.file === "string" ? entry.file.trim() : "";
  return `${file}\0${fullTitle}`;
}
function bucket(arr) {
  const map = /* @__PURE__ */ new Map();
  for (const entry of arr) {
    if (!isObj(entry)) continue;
    const key = keyOf(entry);
    if (key === "") continue;
    const queue = map.get(key);
    if (queue) queue.push(entry);
    else map.set(key, [entry]);
  }
  return map;
}
function consume(b, key) {
  if (key === "") return false;
  const queue = b.get(key);
  if (queue === void 0 || queue.length === 0) return false;
  queue.shift();
  return true;
}
function isMochawesome(doc) {
  if (!Array.isArray(doc.results) || doc.results.length === 0) return false;
  const first = doc.results[0];
  return isObj(first) && Array.isArray(first.tests) && Array.isArray(first.suites);
}
var AWESOME_STATE = {
  passed: "pass",
  failed: "fail",
  pending: "skip"
};
function mochawesomeEntries(roots) {
  const files = /* @__PURE__ */ new Set();
  const collectFiles = (suite) => {
    if (!isObj(suite)) return;
    if (typeof suite.fullFile === "string" && suite.fullFile !== "") files.add(suite.fullFile);
    for (const child2 of Array.isArray(suite.suites) ? suite.suites : []) collectFiles(child2);
  };
  for (const root of roots) collectFiles(root);
  const onlyFile = files.size === 1 ? [...files][0] : void 0;
  const out = [];
  const walk3 = (suite) => {
    if (!isObj(suite)) return;
    const file = typeof suite.fullFile === "string" && suite.fullFile !== "" ? suite.fullFile : onlyFile;
    const toEntry = (t) => {
      const err = isObj(t.err) ? { message: t.err.message, stack: t.err.estack } : t.err;
      return { ...t, file, err };
    };
    const hooks = [
      ...Array.isArray(suite.beforeHooks) ? suite.beforeHooks : [],
      ...Array.isArray(suite.afterHooks) ? suite.afterHooks : []
    ];
    for (const t of Array.isArray(suite.tests) ? suite.tests : []) {
      if (!isObj(t)) continue;
      const state = typeof t.state === "string" ? AWESOME_STATE[t.state] : void 0;
      out.push([toEntry(t), state ?? "skip"]);
    }
    for (const h of hooks) {
      if (isObj(h) && h.state === "failed") out.push([toEntry(h), "fail"]);
    }
    for (const child2 of Array.isArray(suite.suites) ? suite.suites : []) walk3(child2);
  };
  for (const root of roots) walk3(root);
  return out;
}
function hasErr(err) {
  return typeof err === "string" && err !== "" || isObj(err) && Object.keys(err).length > 0;
}
var HOOK_TITLE = /^"(?:before|after) (?:all|each)" hook\b/;
function hookName(title) {
  return title.replace(/ (?:for|in) ".*"$/, "");
}
function deriveSuite(entry, title, fullTitle) {
  if (fullTitle !== "" && fullTitle !== title && fullTitle.endsWith(title)) {
    const chain = fullTitle.slice(0, fullTitle.length - title.length).trim();
    if (chain !== "") return chain;
  }
  if (typeof entry.file === "string" && entry.file.trim() !== "") {
    return entry.file.trim().replace(/\\/g, "/");
  }
  return fullTitle !== "" ? fullTitle : "unknown";
}
var mochaParser = {
  name: "mocha",
  sniff(content) {
    const parsed = parseJson(content);
    if (!("doc" in parsed)) return false;
    const doc = parsed.doc;
    if (!isObj(doc)) return false;
    const hasTestList = Array.isArray(doc.results) || Array.isArray(doc.tests);
    if (hasTestList && doc.stats !== void 0) return true;
    return Array.isArray(doc.passes) && Array.isArray(doc.failures);
  },
  parse(content, sourcePath) {
    const results = [];
    const warnings = [];
    const parsed = parseJson(content);
    if (!("doc" in parsed)) {
      return { results, warnings: [`mocha: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc)) {
      return { results, warnings: [`mocha: ${sourcePath}: not a JSON object`] };
    }
    const passes = Array.isArray(doc.passes) ? doc.passes : [];
    const failures = Array.isArray(doc.failures) ? doc.failures : [];
    const pending = Array.isArray(doc.pending) ? doc.pending : [];
    const testList = Array.isArray(doc.results) ? doc.results : Array.isArray(doc.tests) ? doc.tests : null;
    if (testList === null && !Array.isArray(doc.passes) && !Array.isArray(doc.failures)) {
      return { results, warnings: [`mocha: ${sourcePath}: missing "tests"/"results" array`] };
    }
    const entries = [];
    const statuses = [];
    const add = (entry, status) => {
      if (!isObj(entry)) {
        warnings.push(`mocha: ${sourcePath}: skipping non-object test entry`);
        return;
      }
      entries.push(entry);
      statuses.push(status);
    };
    if (isMochawesome(doc)) {
      for (const [entry, status] of mochawesomeEntries(doc.results))
        add(entry, status);
    } else if (testList === null) {
      for (const entry of passes) add(entry, "pass");
      for (const entry of failures) add(entry, "fail");
      for (const entry of pending) add(entry, "skip");
    } else {
      const failBucket = bucket(failures);
      const pendingBucket = bucket(pending);
      const passBucket = bucket(passes);
      const shared = /* @__PURE__ */ new Map();
      for (const entry of testList) {
        if (isObj(entry)) shared.set(keyOf(entry), (shared.get(keyOf(entry)) ?? 0) + 1);
      }
      for (const entry of testList) {
        if (!isObj(entry)) {
          add(entry, null);
          continue;
        }
        const key = keyOf(entry);
        const errLess = (shared.get(key) ?? 0) > 1 && !hasErr(entry.err);
        const order = errLess ? [
          [passBucket, "pass"],
          [pendingBucket, "skip"],
          [failBucket, "fail"]
        ] : [
          [failBucket, "fail"],
          [pendingBucket, "skip"],
          [passBucket, "pass"]
        ];
        const hit = order.find(([b]) => consume(b, key));
        if (hit !== void 0) add(entry, hit[1]);
        else if (entry.state === "failed") add(entry, "fail");
        else if (entry.state === "pending") add(entry, "skip");
        else add(entry, null);
      }
      for (const queue of failBucket.values()) for (const leftover of queue) add(leftover, "fail");
    }
    const hooks = [];
    const flaky = [];
    for (let n = 0; n < entries.length; n++) {
      const entry = entries[n];
      const fullTitle = typeof entry.fullTitle === "string" ? entry.fullTitle.trim() : "";
      const title = typeof entry.title === "string" && entry.title.trim() !== "" ? entry.title.trim() : fullTitle !== "" ? fullTitle : "(unnamed)";
      const finalStatus = statuses[n] ?? "pass";
      const suite = deriveSuite(entry, title, fullTitle);
      const isHook = HOOK_TITLE.test(title);
      const name = isHook ? hookName(title) : title;
      if (isHook && finalStatus === "fail") hooks.push(`${suite} ${name}`);
      const durationMs2 = msOf(entry.duration);
      const result = {
        testId: makeTestId(suite, name),
        suite,
        name,
        status: finalStatus,
        durationMs: durationMs2
      };
      const err = entry.err;
      if (typeof err === "string") {
        const message = trimTo(err, 2e3);
        if (message !== void 0) result.message = message;
      } else if (isObj(err) && Object.keys(err).length > 0) {
        const message = trimTo(err.message, 2e3);
        const stack = trimTo(err.stack, 1e3);
        if (message !== void 0) result.message = message;
        if (stack !== void 0) result.stack = stack;
      }
      const retries = typeof entry.currentRetry === "number" && Number.isInteger(entry.currentRetry) && entry.currentRetry > 0 ? entry.currentRetry : 0;
      if (retries > 0 && finalStatus === "pass") {
        result.message = flakyRetryMessage(retries, "mocha retry", result.message, 2e3);
        result.attempts = retryAttempts(retries, "pass");
        flaky.push(`${suite} ${name}`);
      } else if (retries > 0 && finalStatus === "fail" && !isHook) {
        const note = `(failed all ${retries + 1} attempts)`;
        result.message = trimTo(
          result.message !== void 0 ? `${result.message}
${note}` : note,
          2e3
        );
        result.attempts = retryAttempts(retries, "fail");
      }
      results.push(result);
    }
    if (flaky.length > 0)
      warnings.push(flakyRetryWarning("mocha", sourcePath, "mocha retry", flaky));
    if (hooks.length > 0) {
      warnings.push(
        `mocha: ${sourcePath}: ${hooks.length} hook failure(s) \u2014 the tests they guard did not run; recorded as failures: ${hooks.join(", ")}`
      );
    }
    return { results, warnings };
  }
};

// src/parsers/playwright.ts
var MESSAGE_MAX_CHARS3 = 2e3;
var STACK_MAX_CHARS2 = 1e3;
var TITLE_SEPARATOR = " \u203A ";
function attemptStatus(status, expected) {
  switch (status) {
    case "skipped":
      return "skip";
    case "passed":
    case "failed":
    case "timedOut":
      return status === (typeof expected === "string" ? expected : "passed") ? "pass" : "fail";
    default:
      return null;
  }
}
function errorOf(result) {
  if (isObj(result.error)) return result.error;
  if (Array.isArray(result.errors)) return result.errors.find(isObj);
  return void 0;
}
function textOf2(value, max) {
  return typeof value === "string" ? trimTo(stripAnsi(value), max) : void 0;
}
function isFailFamily2(status) {
  return status === "fail" || status === "error";
}
function severity(row) {
  if (isFailFamily2(row.status)) return 0;
  if (row.status === "pass" && row.attempts.some((a) => isFailFamily2(a.status))) return 1;
  if (row.status === "pass") return 2;
  return 3;
}
function projectRow(project, tests) {
  const attempts = [];
  let failedFinal = false;
  let lastFinal = "skip";
  let skipReason2;
  for (const test of tests) {
    const own = [];
    for (const result of Array.isArray(test.results) ? test.results : []) {
      if (!isObj(result)) continue;
      const status2 = attemptStatus(result.status, test.expectedStatus);
      if (status2 === null) continue;
      const attempt = { status: status2, durationMs: msOf(result.duration) };
      const error = errorOf(result);
      if (error !== void 0) attempt.error = error;
      own.push(attempt);
    }
    const final = own[own.length - 1]?.status ?? "skip";
    if (isFailFamily2(final)) failedFinal = true;
    lastFinal = final;
    if (final === "skip" && skipReason2 === void 0 && Array.isArray(test.annotations)) {
      const note = test.annotations.find((a) => isObj(a) && a.type === "skip");
      if (isObj(note)) skipReason2 = textOf2(note.description, MESSAGE_MAX_CHARS3);
    }
    attempts.push(...own);
  }
  const status = failedFinal ? "fail" : lastFinal;
  if (attempts.length > 0 && attempts[attempts.length - 1].status !== status) {
    const fails = attempts.filter((a) => a.status === status);
    const rest = attempts.filter((a) => a.status !== status);
    attempts.splice(0, attempts.length, ...rest, ...fails);
  }
  const row = { project, status, attempts };
  if (skipReason2 !== void 0) row.skipReason = skipReason2;
  return row;
}
function mapSpec(spec, file, titles, ctx) {
  const title = typeof spec.title === "string" ? spec.title : "";
  const name = [...titles, title].join(TITLE_SEPARATOR);
  if (name.trim() === "") {
    ctx.warnings.push(`playwright: ${ctx.sourcePath}: skipping a spec without a title in ${file}`);
    return;
  }
  const byProject = /* @__PURE__ */ new Map();
  for (const test of Array.isArray(spec.tests) ? spec.tests : []) {
    if (!isObj(test)) continue;
    const project = typeof test.projectName === "string" ? test.projectName : "";
    const list = byProject.get(project);
    if (list) list.push(test);
    else byProject.set(project, [test]);
  }
  if (byProject.size === 0) return;
  const rows = [...byProject].map(([project, tests]) => projectRow(project, tests));
  const row = rows.reduce((best, r) => severity(r) < severity(best) ? r : best);
  const result = {
    testId: makeTestId(file, name),
    suite: file,
    name,
    status: row.status,
    durationMs: row.attempts[row.attempts.length - 1]?.durationMs ?? null
  };
  const failures = row.attempts.filter((a) => isFailFamily2(a.status));
  const firstError = failures.find((a) => a.error !== void 0)?.error;
  let message;
  if (row.status === "pass" && failures.length > 0) {
    message = flakyRetryMessage(
      failures.length,
      "Playwright retry",
      textOf2(firstError?.message, MESSAGE_MAX_CHARS3),
      MESSAGE_MAX_CHARS3
    );
    ctx.flaky.push(`${file} > ${name}`);
  } else if (isFailFamily2(row.status)) {
    const error = [...failures].reverse().find((a) => a.error !== void 0)?.error;
    message = textOf2(error?.message, MESSAGE_MAX_CHARS3) ?? textOf2(error?.value, MESSAGE_MAX_CHARS3);
    if (row.attempts.length > 1 && failures.length === row.attempts.length) {
      const note = `(failed all ${row.attempts.length} attempts)`;
      message = trimTo(message !== void 0 ? `${message}
${note}` : note, MESSAGE_MAX_CHARS3);
    }
    const stack = textOf2(error?.stack, STACK_MAX_CHARS2);
    if (stack !== void 0) result.stack = stack;
  } else if (row.status === "skip") {
    message = row.skipReason;
  }
  if (message !== void 0 && rows.length > 1 && row.status !== "skip" && row.project !== "") {
    message = trimTo(`[${row.project}] ${message}`, MESSAGE_MAX_CHARS3);
  }
  if (message !== void 0) result.message = message;
  if (row.attempts.length > 1) result.attempts = row.attempts.map((a) => a.status);
  ctx.results.push(result);
}
function walk2(suite, file, titles, ctx) {
  for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
    if (isObj(spec)) mapSpec(spec, file, titles, ctx);
  }
  for (const child2 of Array.isArray(suite.suites) ? suite.suites : []) {
    if (!isObj(child2)) continue;
    const title = typeof child2.title === "string" ? child2.title : "";
    walk2(child2, file, [...titles, title], ctx);
  }
}
var playwrightParser = {
  name: "playwright",
  sniff(content) {
    const parsed = parseJson(content);
    if (!("doc" in parsed)) return false;
    const doc = parsed.doc;
    return isObj(doc) && Array.isArray(doc.suites) && isObj(doc.config);
  },
  parse(content, sourcePath) {
    const ctx = { sourcePath, results: [], warnings: [], flaky: [] };
    const parsed = parseJson(content);
    if (!("doc" in parsed)) {
      return {
        results: [],
        warnings: [`playwright: ${sourcePath}: invalid JSON: ${parsed.error}`]
      };
    }
    const doc = parsed.doc;
    if (!isObj(doc) || !Array.isArray(doc.suites)) {
      return { results: [], warnings: [`playwright: ${sourcePath}: missing suites[] array`] };
    }
    for (const fileSuite of doc.suites) {
      if (!isObj(fileSuite)) continue;
      const file = typeof fileSuite.title === "string" && fileSuite.title.trim() !== "" ? fileSuite.title : typeof fileSuite.file === "string" && fileSuite.file.trim() !== "" ? fileSuite.file : "(unknown file)";
      walk2(fileSuite, file, [], ctx);
    }
    const globalErrors = (Array.isArray(doc.errors) ? doc.errors : []).filter(isObj);
    if (globalErrors.length > 0) {
      const first = globalErrors[0];
      const firstMessage = textOf2(first.message, MESSAGE_MAX_CHARS3) ?? textOf2(first.value, MESSAGE_MAX_CHARS3) ?? "error outside any test";
      const more = globalErrors.length > 1 ? `
(+${globalErrors.length - 1} more)` : "";
      const result = {
        testId: makeTestId("playwright", "(global)"),
        suite: "playwright",
        name: "(global)",
        status: "error",
        durationMs: null,
        message: trimTo(`${firstMessage}${more}`, MESSAGE_MAX_CHARS3) ?? firstMessage
      };
      const stack = textOf2(first.stack, STACK_MAX_CHARS2);
      if (stack !== void 0) result.stack = stack;
      ctx.results.push(result);
      ctx.warnings.push(
        `playwright: ${sourcePath}: ${globalErrors.length} error(s) outside any test (config, global setup or a spec file that failed to load) \u2014 recorded as playwright :: (global): ${firstMessage.split("\n")[0]}`
      );
    }
    if (ctx.flaky.length > 0) {
      ctx.warnings.push(flakyRetryWarning("playwright", sourcePath, "Playwright retry", ctx.flaky));
    }
    return { results: ctx.results, warnings: ctx.warnings };
  }
};

// src/parsers/pytest-json.ts
var MESSAGE_MAX_CHARS4 = 2e3;
var STACK_MAX_CHARS3 = 1e3;
var STAGES = ["setup", "call", "teardown"];
var OUTCOMES = {
  passed: "pass",
  xpassed: "pass",
  failed: "fail",
  error: "error",
  skipped: "skip",
  xfailed: "skip",
  rerun: "pass"
};
function junitAddress(nodeid) {
  const bracket = nodeid.indexOf("[");
  const path9 = bracket === -1 ? nodeid : nodeid.slice(0, bracket);
  const params = bracket === -1 ? "" : nodeid.slice(bracket);
  const names = path9.split("::");
  names[0] = names[0].replace(/\//g, ".").replace(/\.py$/, "");
  names[names.length - 1] += params;
  return { classname: names.slice(0, -1).join("."), name: names[names.length - 1] };
}
function text(value, max) {
  return typeof value === "string" ? trimTo(stripAnsi(value), max) : void 0;
}
function firstLine(value) {
  if (typeof value !== "string") return void 0;
  const line = value.split(/\r?\n/).find((l) => l.trim() !== "");
  return text(line, MESSAGE_MAX_CHARS4);
}
function skipReason(longrepr) {
  if (typeof longrepr !== "string") return void 0;
  const m = /,\s*['"](?:Skipped: )?(.*)['"]\)\s*$/s.exec(longrepr);
  return text(m ? m[1] : longrepr, MESSAGE_MAX_CHARS4);
}
var pytestJsonParser = {
  name: "pytest-json",
  sniff(content) {
    const parsed = parseJson(content);
    if (!("doc" in parsed)) return false;
    const doc = parsed.doc;
    return isObj(doc) && isObj(doc.summary) && typeof doc.exitcode === "number" && (Array.isArray(doc.tests) || Array.isArray(doc.collectors));
  },
  parse(content, sourcePath) {
    const results = [];
    const warnings = [];
    const parsed = parseJson(content);
    if (!("doc" in parsed)) {
      return { results, warnings: [`pytest-json: ${sourcePath}: invalid JSON: ${parsed.error}`] };
    }
    const doc = parsed.doc;
    if (!isObj(doc)) {
      return { results, warnings: [`pytest-json: ${sourcePath}: not a JSON object`] };
    }
    const flaky = [];
    for (const test of Array.isArray(doc.tests) ? doc.tests : []) {
      if (!isObj(test)) continue;
      const nodeid = typeof test.nodeid === "string" ? test.nodeid.trim() : "";
      if (nodeid === "") {
        warnings.push(`pytest-json: ${sourcePath}: skipping a test without a nodeid`);
        continue;
      }
      const outcome = typeof test.outcome === "string" ? test.outcome : "";
      const status = OUTCOMES[outcome];
      if (status === void 0) {
        warnings.push(
          `pytest-json: ${sourcePath}: unknown outcome ${JSON.stringify(test.outcome)} for ${nodeid}`
        );
        continue;
      }
      const { classname, name } = junitAddress(nodeid);
      const suite = classname !== "" ? classname : "pytest";
      let seconds = 0;
      let timed = false;
      for (const stage of STAGES) {
        const s = test[stage];
        if (isObj(s) && typeof s.duration === "number" && Number.isFinite(s.duration)) {
          seconds += s.duration;
          timed = true;
        }
      }
      const result = {
        testId: makeTestId(suite, name),
        suite,
        name,
        status,
        durationMs: timed && seconds >= 0 ? Math.round(seconds * 1e3) : null
      };
      if (status === "fail" || status === "error") {
        const failed = STAGES.map((st) => test[st]).find(
          (s) => isObj(s) && s.outcome === "failed"
        );
        const crash = isObj(failed?.crash) ? failed.crash : void 0;
        const message = text(crash?.message, MESSAGE_MAX_CHARS4) ?? firstLine(failed?.longrepr);
        const stack = text(failed?.longrepr, STACK_MAX_CHARS3);
        if (message !== void 0) result.message = message;
        if (stack !== void 0) result.stack = stack;
      } else if (status === "skip") {
        const skipped = STAGES.map((st) => test[st]).find(
          (s) => isObj(s) && s.outcome === "skipped"
        );
        const reason = skipReason(skipped?.longrepr);
        if (reason !== void 0) result.message = reason;
      } else if (outcome === "rerun") {
        result.message = "flaky: failed, then passed on pytest-rerunfailures rerun";
        result.attempts = ["fail", "pass"];
        flaky.push(nodeid);
      }
      results.push(result);
    }
    for (const collector of Array.isArray(doc.collectors) ? doc.collectors : []) {
      if (!isObj(collector) || collector.outcome !== "failed") continue;
      const nodeid = typeof collector.nodeid === "string" ? collector.nodeid.trim() : "";
      const address = nodeid !== "" ? junitAddress(nodeid) : { classname: "", name: "(session)" };
      const suite = address.classname !== "" ? address.classname : "pytest";
      const result = {
        testId: makeTestId(suite, address.name),
        suite,
        name: address.name,
        status: "error",
        durationMs: null,
        message: firstLine(collector.longrepr) ?? "collection failure"
      };
      const stack = text(collector.longrepr, STACK_MAX_CHARS3);
      if (stack !== void 0) result.stack = stack;
      results.push(result);
      warnings.push(
        `pytest-json: ${sourcePath}: ${nodeid || "session"} failed to collect \u2014 recorded as an error`
      );
    }
    if (flaky.length > 0) {
      warnings.push(
        flakyRetryWarning("pytest-json", sourcePath, "pytest-rerunfailures rerun", flaky)
      );
    }
    return { results, warnings };
  }
};

// src/parsers/tap.ts
var ROOT_SUITE = "node:test";
var SNIFF_MAX_LINES2 = 50;
var TAP_LINE = /^(?:(?:not )?ok(?:\s|$)|1\.\.\d+(?:\s+#.*)?\s*$|#|Bail out!|pragma [+-]|TAP version \d+|\s)/;
var MESSAGE_MAX_CHARS5 = 2e3;
var tapParser = {
  name: "tap",
  sniff(content) {
    const lines = stripBom(content).split(/\r?\n/);
    const first = lines.map((l) => l.trim()).find((l) => l !== "");
    if (first === void 0) return false;
    if (/^TAP version \d+\s*$/i.test(first)) return true;
    if (!/^1\.\.\d+(?:\s+#.*)?$/.test(first) && !/^(?:not )?ok \d+(?:\s|$)/.test(first)) {
      return false;
    }
    let seen = 0;
    for (const line of lines) {
      if (line.trim() === "") continue;
      if (++seen > SNIFF_MAX_LINES2) break;
      if (!TAP_LINE.test(line)) return false;
    }
    return true;
  },
  parse(content, sourcePath) {
    const results = [];
    const warnings = [];
    const body = stripBom(content);
    if (body.trim() === "") {
      warnings.push(`tap: ${sourcePath}: file is empty`);
      return { results, warnings };
    }
    const lines = body.split(/\r?\n/);
    const pending = [];
    const headers = [];
    const counters = /* @__PURE__ */ new Map();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const indent = indentOf(line);
      const sub = line.match(/^\s*# Subtest: (.+?)\s*$/);
      if (sub) {
        while (headers.length > 0 && headers[headers.length - 1].indent >= indent) headers.pop();
        headers.push({ indent, name: unescapeName(sub[1]) });
        continue;
      }
      const assertion = line.match(
        /^\s*(not ok|ok)(?=\s|$)(?:\s+(\d+)(?=\s|$))?\s*(?:-(?=\s|$)\s*)?(.*)$/
      );
      if (!assertion) continue;
      const [, verdict, numberText, rest] = assertion;
      const [, rawName, directive, directiveText] = rest.match(
        /^(.*?)(?:(?:^|\s+)#\s*([A-Za-z]+)\b(.*))?$/
      );
      let num = numberText !== void 0 ? Number.parseInt(numberText, 10) : void 0;
      num ??= (counters.get(indent) ?? 0) + 1;
      counters.set(indent, num);
      for (const level of [...counters.keys()]) if (level > indent) counters.delete(level);
      const name = unescapeName(rawName.trim()) || `(test ${num})`;
      let yaml = { isSuite: false };
      const opener = lines[i + 1];
      if (opener !== void 0 && opener.trim() === "---") {
        const yamlIndent = indentOf(opener);
        let j = i + 2;
        while (j < lines.length && !(lines[j].trim() === "..." && indentOf(lines[j]) <= yamlIndent))
          j++;
        yaml = parseYamlBlock(lines.slice(i + 2, j), sourcePath, warnings);
        i = j;
      }
      while (headers.length > 0 && headers[headers.length - 1].indent >= indent) headers.pop();
      let status = verdict === "not ok" ? "fail" : "pass";
      let message = yaml.error;
      const directiveKind = directive?.toUpperCase();
      if (directiveKind === "SKIP" || directiveKind === "TODO") {
        status = "skip";
        const reason = directiveText?.replace(/^\s*-\s*/, "").trim();
        if (reason) message = reason;
      }
      const own = {
        chain: [],
        name,
        status,
        durationMs: yaml.durationMs ?? null,
        message: message !== void 0 && message !== "" ? trimTo(message, MESSAGE_MAX_CHARS5) : void 0,
        stack: status === "fail" && yaml.stack !== void 0 ? trimTo(yaml.stack, 1e3) : void 0
      };
      const children2 = [];
      while (pending.length > 0 && pending[pending.length - 1].indent > indent) {
        children2.unshift(pending.pop());
      }
      if (children2.length === 0 && !yaml.isSuite) {
        pending.push({ indent, entries: [own], failed: status === "fail" });
        continue;
      }
      const entries = children2.flatMap((c) => c.entries);
      for (const e of entries) e.chain.unshift(name);
      const childFailed = children2.some((c) => c.failed);
      const ownFailure = status === "fail" && !childFailed;
      if (ownFailure) entries.push(own);
      pending.push({ indent, entries, failed: childFailed || ownFailure });
    }
    for (let h = headers.length - 1; h >= 0; h--) {
      const header = headers[h];
      for (const subtree of pending) {
        if (subtree.indent > header.indent)
          for (const e of subtree.entries) e.chain.unshift(header.name);
      }
    }
    if (headers.length > 0) {
      warnings.push(
        `tap: ${sourcePath}: ${headers.length} subtest(s) never reported a result (truncated stream?)`
      );
    }
    for (const e of pending.flatMap((p) => p.entries)) {
      const suite = e.chain.length > 0 ? e.chain.join(" > ") : ROOT_SUITE;
      const result = {
        testId: makeTestId(suite, e.name),
        suite,
        name: e.name,
        status: e.status,
        durationMs: e.durationMs
      };
      if (e.message !== void 0) result.message = e.message;
      if (e.stack !== void 0) result.stack = e.stack;
      results.push(result);
    }
    return { results, warnings };
  }
};
function unescapeName(raw) {
  return raw.replace(/\\([\\#])/g, "$1");
}
function parseYamlBlock(block, sourcePath, warnings) {
  const out = { isSuite: false };
  try {
    const keyIndent = Math.min(
      ...block.filter((l) => l.trim() !== "").map((l) => indentOf(l)),
      Number.POSITIVE_INFINITY
    );
    for (let k = 0; k < block.length; k++) {
      const line = block[k];
      if (indentOf(line) !== keyIndent) continue;
      const keyMatch = line.match(/^\s*([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/);
      if (!keyMatch) continue;
      const [, key, rawValue = ""] = keyMatch;
      let m = k + 1;
      while (m < block.length && (block[m].trim() === "" || indentOf(block[m]) > keyIndent)) m++;
      const continuation = block.slice(k + 1, m);
      k = m - 1;
      let value;
      const scalar = rawValue.match(/^([|>])([-+]?)\d*$/);
      if (scalar) value = readBlockScalar(continuation, scalar[1] === ">");
      else if (rawValue !== "") value = unquote(rawValue);
      if (value === void 0) continue;
      if (key === "error" && out.error === void 0) out.error = value;
      else if (key === "stack" && out.stack === void 0) out.stack = value;
      else if (key === "type" && value === "suite") out.isSuite = true;
      else if (key === "duration_ms") {
        const ms = Number.parseFloat(value);
        if (Number.isFinite(ms) && ms >= 0) out.durationMs = Math.round(ms);
      }
    }
  } catch (err) {
    warnings.push(`tap: ${sourcePath}: diagnostic block parse skipped (${errorMessage(err)})`);
  }
  return out;
}
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function readBlockScalar(lines, folded) {
  const firstContent = lines.find((l) => l.trim() !== "");
  if (firstContent === void 0) return "";
  const base = indentOf(firstContent);
  const body = lines.map((l) => l.trim() === "" ? "" : l.slice(Math.min(base, indentOf(l))));
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  if (!folded) return body.join("\n");
  let text2 = "";
  for (let n = 0; n < body.length; n++) {
    const cur = body[n];
    if (n > 0) text2 += cur === "" || body[n - 1] === "" ? "\n" : " ";
    text2 += cur;
  }
  return text2.replace(/\n\n/g, "\n");
}
function unquote(s) {
  const m = s.match(/^(['"`])(.*)\1$/);
  if (m === null) return s;
  const [, quote, inner] = m;
  const text2 = quote === "'" ? inner.replace(/''/g, "'") : inner;
  return text2.replace(/\\(['"`\\])/g, "$1");
}

// src/parsers/trx.ts
import { XMLParser as XMLParser2 } from "fast-xml-parser";
var xml2 = new XMLParser2(XML_OPTIONS);
function attr2(node, name) {
  const v = node[name];
  return typeof v === "string" && v.trim() !== "" ? v : void 0;
}
function textOf3(node) {
  if (typeof node === "string") return node;
  if (isObj(node)) {
    const t = node["#text"];
    if (typeof t === "string") return t;
    if (Array.isArray(t)) return t.filter((p) => typeof p === "string").join("");
  }
  return void 0;
}
function durationMs(raw) {
  if (raw === void 0) return null;
  const m = raw.match(/^(?:(\d+)\.)?(?:(\d+)):([0-5]?\d):([0-5]?\d(?:\.\d+)?)$/);
  if (!m) return null;
  const days = m[1] !== void 0 ? Number.parseInt(m[1], 10) : 0;
  const h = Number.parseInt(m[2], 10);
  const min = Number.parseInt(m[3], 10);
  const sec = Number.parseFloat(m[4]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || !Number.isFinite(sec) || sec < 0) return null;
  return Math.round((((days * 24 + h) * 60 + min) * 60 + sec) * 1e3);
}
var OUTCOMES2 = {
  passed: "pass",
  passedbutrunaborted: "pass",
  completed: "pass",
  warning: "pass",
  failed: "fail",
  timeout: "fail",
  error: "error",
  aborted: "error",
  disconnected: "error",
  notrunnable: "error",
  inprogress: "error",
  notexecuted: "skip",
  inconclusive: "skip",
  pending: "skip"
};
function outcomeStatus(outcome) {
  return outcome !== void 0 ? OUTCOMES2[outcome.trim().toLowerCase()] ?? null : null;
}
function childList(el, localName) {
  const key = Object.keys(el).find((k) => k === localName || k.endsWith(`:${localName}`));
  return key !== void 0 ? toArray(el[key]) : [];
}
function child(el, localName) {
  const first = childList(el, localName)[0];
  return isObj(first) ? first : void 0;
}
function mapResult(r, suites, ctx) {
  if (!isObj(r)) return;
  const testName = attr2(r, "@_testName");
  if (testName === void 0) {
    ctx.warnings.push(`trx: ${ctx.sourcePath}: skipping <UnitTestResult> without testName`);
    return;
  }
  const outcome = attr2(r, "@_outcome");
  const status = outcomeStatus(outcome);
  if (status === null) {
    ctx.warnings.push(`trx: ${ctx.sourcePath}: unknown outcome "${outcome}" \u2014 skipped ${testName}`);
    return;
  }
  const inner = child(r, "InnerResults");
  const rows = inner !== void 0 ? childList(inner, "UnitTestResult") : [];
  let rowFailed = false;
  if (rows.length > 0) {
    const before = ctx.results.length;
    for (const row of rows) mapResult(row, suites, ctx);
    rowFailed = ctx.results.slice(before).some((x) => x.status === "fail" || x.status === "error");
    if (rowFailed || status !== "fail" && status !== "error") return;
  }
  const errorInfo = (() => {
    const output = child(r, "Output");
    return output !== void 0 ? child(output, "ErrorInfo") : void 0;
  })();
  let message;
  let stack;
  if (errorInfo !== void 0) {
    message = textOf3(childList(errorInfo, "Message")[0]);
    stack = textOf3(childList(errorInfo, "StackTrace")[0]);
  }
  const testId = attr2(r, "@_testId");
  const known = (testId !== void 0 ? suites.byId.get(testId.toLowerCase()) : void 0) ?? suites.byName.get(testName);
  if (known === void 0 && testId !== void 0) ctx.unresolvedIds++;
  const suite = known ?? "unknown";
  const result = {
    testId: makeTestId(suite, testName),
    suite,
    name: testName,
    status,
    durationMs: durationMs(attr2(r, "@_duration"))
  };
  const trimmedMessage = trimTo(message, 2e3) ?? (status === "fail" || status === "error" ? `outcome: ${outcome}` : void 0);
  if (trimmedMessage !== void 0) result.message = trimmedMessage;
  const trimmedStack = trimTo(stack, 1e3);
  if (trimmedStack !== void 0) result.stack = trimmedStack;
  ctx.results.push(result);
}
var trxParser = {
  name: "trx",
  sniff(content) {
    const trimmed = stripBom(content).trimStart();
    return trimmed.startsWith("<") && /<(?:[\w.-]+:)?TestRun[\s>]/.test(trimmed);
  },
  parse(content, sourcePath) {
    const ctx = { sourcePath, results: [], warnings: [], unresolvedIds: 0 };
    const body = stripBom(content);
    if (body.trim() === "") {
      ctx.warnings.push(`trx: ${sourcePath}: file is empty`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!/<\/(?:[\w.-]+:)?TestRun>\s*$/.test(body)) {
      ctx.warnings.push(`trx: ${sourcePath}: content appears truncated (no closing </TestRun>)`);
    }
    let doc;
    try {
      doc = xml2.parse(body);
    } catch (err) {
      ctx.warnings.push(`trx: ${sourcePath}: failed to parse XML: ${errorMessage(err)}`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    if (!isObj(doc)) {
      ctx.warnings.push(`trx: ${sourcePath}: XML did not parse to a document object`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    const rootKey = Object.keys(doc).find((k) => /(?:^|:)TestRun$/.test(k));
    if (rootKey === void 0) {
      ctx.warnings.push(`trx: ${sourcePath}: no <TestRun> root element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    let root = doc[rootKey];
    if (Array.isArray(root)) {
      ctx.warnings.push(`trx: ${sourcePath}: multiple <TestRun> roots found \u2014 using the first`);
      root = root[0];
    }
    if (!isObj(root)) return { results: ctx.results, warnings: ctx.warnings };
    const suites = { byId: /* @__PURE__ */ new Map(), byName: /* @__PURE__ */ new Map() };
    const definitions = child(root, "TestDefinitions");
    for (const unit of definitions !== void 0 ? childList(definitions, "UnitTest") : []) {
      if (!isObj(unit)) continue;
      const method = child(unit, "TestMethod");
      const className = method !== void 0 ? attr2(method, "@_className") : void 0;
      if (className === void 0) continue;
      const id = attr2(unit, "@_id");
      if (id !== void 0) suites.byId.set(id.toLowerCase(), className);
      const unitName = attr2(unit, "@_name");
      if (unitName !== void 0 && !suites.byName.has(unitName)) {
        suites.byName.set(unitName, className);
      }
    }
    const resultsEl = child(root, "Results");
    if (resultsEl === void 0 && !Object.keys(root).some((k) => /(?:^|:)Results$/.test(k))) {
      ctx.warnings.push(`trx: ${sourcePath}: no <Results> element found`);
      return { results: ctx.results, warnings: ctx.warnings };
    }
    for (const r of resultsEl !== void 0 ? childList(resultsEl, "UnitTestResult") : []) {
      mapResult(r, suites, ctx);
    }
    if (ctx.unresolvedIds > 0) {
      ctx.warnings.push(
        `trx: ${sourcePath}: ${ctx.unresolvedIds} result(s) have a testId with no matching <TestDefinitions> entry \u2014 recorded with suite 'unknown' (their ids differ from complete reports)`
      );
    }
    return { results: ctx.results, warnings: ctx.warnings };
  }
};

// src/parsers/index.ts
function bomTolerant(parser) {
  return {
    name: parser.name,
    sniff: (content) => parser.sniff(stripBom(content)),
    parse: (content, sourcePath) => parser.parse(stripBom(content), sourcePath)
  };
}
var parsers = [
  junitParser,
  jestParser,
  mochaParser,
  goTestParser,
  tapParser,
  trxParser,
  playwrightParser,
  pytestJsonParser
].map(bomTolerant);
function detectParser(content) {
  for (const parser of parsers) {
    try {
      if (parser.sniff(content)) return parser;
    } catch {
    }
  }
  return null;
}
function unrecognizedReason(content) {
  const body = stripBom(content);
  if (body.trim() === "") return "empty report file";
  if (body.charCodeAt(0) === 31 && (body.charCodeAt(1) === 65533 || body.charCodeAt(1) === 139)) {
    return "gzip-compressed report \u2014 decompress it first (e.g. gunzip)";
  }
  if (body.slice(0, 512).includes("\0")) {
    return "binary or undecoded UTF-16 content (NUL characters) \u2014 save the report as UTF-8";
  }
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJson(trimmed);
    if ("error" in parsed) {
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== "");
      const jsonLines = lines.length > 1 && lines.every((l) => l.trimStart().startsWith("{")) && "doc" in parseJson(lines[0]);
      if (!jsonLines) return `truncated/invalid JSON (${parsed.error})`;
      return "unrecognized report format (JSON lines, but not go test -json or node:test events)";
    }
    return "unrecognized report format (valid JSON, but no supported report shape)";
  }
  if (trimmed.startsWith("<")) {
    return "unrecognized report format (XML without <testsuite>/<testsuites> or <TestRun>)";
  }
  return "unrecognized report format";
}

// src/util/redact.ts
var PATTERNS = [
  // PEM private keys (RSA/EC/OPENSSH/PKCS#8/encrypted…) — the whole block, or
  // to the end of the text when a truncated message lost the END line.
  // Certificates and public keys are not secrets and are left alone.
  {
    name: "pem-private-key",
    re: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    replacement: "[REDACTED-PRIVATE-KEY]"
  },
  // Credentials embedded in URLs: scheme://user:password@host — the password
  // goes, the user and host stay for debugging.
  {
    name: "url-credentials",
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi,
    replacement: "$1[REDACTED]@"
  },
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server / GITHUB_TOKEN), ghr_ (refresh)
  { name: "github-token", re: /(gh[pousr])_[A-Za-z0-9]{30,}/g, replacement: "$1_[REDACTED]" },
  {
    name: "github-pat-fine",
    re: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: "github_pat_[REDACTED]"
  },
  // AKIA = long-lived access key id, ASIA = temporary (STS) key id. Exactly
  // 16 trailing chars: a longer all-caps run is a word, not a key id.
  {
    name: "aws-access-key",
    re: /(AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g,
    replacement: "$1[REDACTED]"
  },
  {
    name: "google-api-key",
    re: /AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    replacement: "AIza[REDACTED]"
  },
  {
    name: "stripe-key",
    // live keys only: sk_test_/rk_test_ are sandbox keys, and `…_test_…` is
    // far too common in test names to match safely
    re: /\b([sr]k)_live_[0-9A-Za-z]{10,}/g,
    replacement: "$1_live_[REDACTED]"
  },
  // Azure storage / service bus connection strings
  {
    name: "azure-account-key",
    re: /\b(AccountKey|SharedAccessKey)=[^;\s"']+/gi,
    replacement: "$1=[REDACTED]"
  },
  { name: "openai-key", re: /sk-[A-Za-z0-9_-]{20,}/g, replacement: "sk-[REDACTED]" },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox[REDACTED]" },
  { name: "gitlab-pat", re: /glpat-[A-Za-z0-9_-]{20,}/g, replacement: "glpat-[REDACTED]" },
  {
    name: "npm-token",
    re: /npm_[A-Za-z0-9]{30,}/g,
    replacement: "npm_[REDACTED]"
  },
  // JWT-shaped: three base64url segments
  {
    name: "jwt",
    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: "[REDACTED-JWT]"
  },
  // Authorization header schemes with raw tokens. `token` is deliberately
  // absent — "Unexpected token 1234567890123456789" is ordinary JSON-error prose.
  {
    name: "auth-header",
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{18,}/gi,
    replacement: "$1 [REDACTED]"
  },
  // Assignment forms: SECRET_KEY=... / "api_key": "..." (quoted or not). No
  // leading \b on purpose: compound names like AWS_SECRET_ACCESS_KEY have an
  // underscore before the matched fragment, which is a word char. Values must
  // reach 12+ chars so validation-error prose ("password: required") survives.
  {
    name: "secret-assignment",
    re: /((?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"']{12,})/gi,
    replacement: "$1[REDACTED]"
  },
  // Strict `=` assignments of token/secret/password (env dumps, query
  // strings, CLI flags) are redacted at ANY length — `password=hunter2` is a
  // real leak. Only the tight `key=value` form qualifies (no spaces, no
  // `==`), so prose and code like `token === undefined` survive.
  {
    name: "short-assignment",
    re: /((?:token|secret|password|passwd)["']?=["']?)(?!\[REDACTED\])[^\s"'=&;,()<>[\]][^\s"'&;,()<>]*/gi,
    replacement: "$1[REDACTED]"
  }
];
function redact(text2) {
  let out = text2;
  for (const p of PATTERNS) {
    out = out.replace(p.re, p.replacement);
  }
  return out;
}

// src/report/text.ts
var CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
function escapeControlChars(s) {
  return s.replace(CONTROL, visibleEscape);
}
function escapeControlCharsMultiline(s) {
  return s.replace(/\r\n/g, "\n").replace(CONTROL, (c) => c === "\n" || c === "	" ? c : visibleEscape(c));
}
function visibleEscape(c) {
  const code = c.charCodeAt(0);
  return code < 256 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
}
function truncateCodePoints(s, max) {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join("")}\u2026`;
}

// src/report/markdown.ts
var PR_COMMENT_MARKER = "<!-- flakefinder:report -->";
var FLAKY_CLASSES = ["flaky-confirmed", "flaky-retry", "flaky-suspected"];
function isFlaky(v) {
  return FLAKY_CLASSES.includes(v.classification);
}
function escapeMarkdownInline(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/[[\]]/g, "\\$&").replace(/@(?=[A-Za-z0-9_-])/g, "@\u200D").replace(/\|/g, "\\|");
}
function cell(s, max = 80) {
  if (!s) return "";
  const oneLine = escapeControlChars(redact(s).replace(/\r?\n/g, " "));
  return escapeMarkdownInline(truncateCodePoints(oneLine, max));
}
function fenceFor(content) {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}
function classLabel(v) {
  switch (v.classification) {
    case "flaky-confirmed":
      return "flaky \u2705\u274C";
    case "flaky-retry":
      return "flaky \u{1F501}";
    case "flaky-suspected":
      return "flaky \u2753";
    case "failing":
      return "failing";
    case "new-failure":
      return "new failure";
    case "passing":
      return "passing";
    case "skipped":
      return "skipped";
    case "gone":
      return "gone";
  }
}
function table(rows) {
  const lines = [
    "| Test | Suite | Class | Score | Conf | \u0394 |",
    "| --- | --- | --- | --- | --- | --- |"
  ];
  for (const { v, delta } of rows) {
    lines.push(
      `| ${cell(v.name, 60)} | ${cell(v.suite, 40)} | ${classLabel(v)} | ${v.flakeScore} | ${v.confidence}% | ${delta} |`
    );
  }
  return lines.join("\n");
}
function flakeRows(verdicts) {
  return verdicts.filter(isFlaky).sort((a, b) => b.flakeScore - a.flakeScore).map((v) => ({ v, delta: "" }));
}
function renderMarkdown(verdicts, opts) {
  const flaky = flakeRows(verdicts);
  const failing = verdicts.filter(
    (v) => v.classification === "failing" || v.classification === "new-failure"
  );
  const sections = ["## flakefinder report", ""];
  if (flaky.length > 0) {
    sections.push(`**Flaky tests: ${flaky.length}**`, "", table(flaky), "");
  } else {
    sections.push("\u2705 no flakes detected", "");
  }
  if (failing.length > 0) {
    sections.push(
      `**Deterministic failures: ${failing.length}**`,
      "",
      table(failing.map((v) => ({ v, delta: "" }))),
      ""
    );
  }
  if (!opts.flakesOnly) {
    const passing = verdicts.filter((v) => v.classification === "passing").length;
    sections.push(`_tracked: ${verdicts.length} tests \xB7 ${passing} passing_`, "");
  }
  return sections.join("\n");
}
var PR_COMMENT_MAX_ROWS = 50;
var PR_COMMENT_MAX_CHARS = 6e4;
function buildPrComment(verdicts, previous, opts = {}) {
  const maxRows = opts.maxRows ?? PR_COMMENT_MAX_ROWS;
  const maxChars = opts.maxChars ?? PR_COMMENT_MAX_CHARS;
  const prevFlaky = new Set((previous ?? []).filter(isFlaky).map((v) => v.testId));
  const prevScore = new Map((previous ?? []).map((v) => [v.testId, v.flakeScore]));
  const flaky = verdicts.filter(isFlaky).sort((a, b) => b.flakeScore - a.flakeScore);
  const newFlakes = flaky.filter((v) => !prevFlaky.has(v.testId));
  const failing = verdicts.filter(
    (v) => v.classification === "failing" || v.classification === "new-failure"
  );
  const deltaOf = (v) => {
    if (!previous) return "\u2014";
    if (!prevFlaky.has(v.testId)) return "**new**";
    const d = v.flakeScore - (prevScore.get(v.testId) ?? 0);
    return d === 0 ? "=" : d > 0 ? `\u2191${d}` : `\u2193${-d}`;
  };
  const head = [PR_COMMENT_MARKER, "## \u{1F40D} flakefinder", ""];
  const summary = flaky.length === 0 ? `\u2705 no flakes detected among ${verdicts.length} tracked tests` : `**${flaky.length} flaky** (${newFlakes.length} new \xB7 ${flaky.length - newFlakes.length} known) \xB7 ${failing.length} failing \xB7 ${verdicts.length} tracked`;
  head.push(summary);
  if (previous === null && flaky.length > 0) head.push("_first run \u2014 building history_");
  head.push("");
  const dashboard = opts.dashboardArtifact;
  const footer = [
    "---",
    dashboard ? `_\u{1F4CA} HTML dashboard uploaded as artifact \`${dashboard}\` \xB7 docs: \`docs/github-action.md\`_` : "_docs: `docs/github-action.md`_"
  ];
  const seeMore = dashboard ? " \u2014 see the dashboard artifact" : "";
  const size = (lines) => lines.reduce((n, l) => n + l.length + 1, 0);
  let budget = maxChars - size(head) - size(footer) - 400;
  const body = [];
  if (flaky.length > 0) {
    const tableLines = table([]).split("\n");
    budget -= size(tableLines);
    let shown = 0;
    for (const v of flaky) {
      if (shown >= maxRows) break;
      const row = table([{ v, delta: deltaOf(v) }]).split("\n")[2];
      if (row.length + 1 > budget) break;
      tableLines.push(row);
      budget -= row.length + 1;
      shown++;
    }
    body.push(...tableLines);
    if (flaky.length > shown) {
      body.push(
        "",
        `_\u2026and ${flaky.length - shown} more flaky test(s) not shown in this table${seeMore}._`
      );
    }
    body.push("");
  }
  let detailCount = 0;
  for (const v of newFlakes.slice(0, 5)) {
    const message = truncateCodePoints(
      redact(v.lastMessage ?? "(no failure message recorded)"),
      400
    );
    const fence = fenceFor(message);
    const block = [
      `<details><summary><code>${cell(v.name, 60)}</code> \u2014 score ${v.flakeScore}</summary>`,
      "",
      `${fence}text`,
      message,
      fence,
      "",
      "Quarantine it:",
      "",
      "```bash",
      `flakefinder quarantine add ${v.testId}`,
      "```",
      "",
      "</details>",
      ""
    ];
    if (size(block) > budget) break;
    body.push(...block);
    budget -= size(block);
    detailCount++;
  }
  if (newFlakes.length > detailCount) {
    body.push(
      `_\u2026and ${newFlakes.length - detailCount} more new flake(s)${seeMore || " without details here"}._`,
      ""
    );
  }
  return [...head, ...body, ...footer].join("\n");
}

// src/report/gitlab.ts
function gitlabEnvFromProcess(env = process.env) {
  if (env.GITLAB_CI !== "true") return null;
  const apiV4 = env.CI_API_V4_URL;
  const projectId = env.CI_PROJECT_ID;
  const mrIid = env.CI_MERGE_REQUEST_IID;
  const token = env.GITLAB_TOKEN;
  if (!apiV4 || !projectId || !mrIid || !token) return null;
  return { apiV4, projectId, mrIid, token };
}
async function upsertMrNote(gl, body, fetchImpl = fetch, warn = (m) => console.warn(`flakefinder: ${m}`), timeoutMs = 15e3) {
  const call = (url, init = {}) => fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const headers = {
    "PRIVATE-TOKEN": gl.token,
    "Content-Type": "application/json"
  };
  const mrUrl = `${gl.apiV4}/projects/${encodeURIComponent(gl.projectId)}/merge_requests/${encodeURIComponent(gl.mrIid)}`;
  const notesUrl = `${mrUrl}/notes`;
  try {
    const userRes = await call(`${gl.apiV4}/user`, { headers });
    if (!userRes.ok) {
      warn(`GitLab: resolving the token's user failed: HTTP ${userRes.status}`);
      return "unavailable";
    }
    const me = await userRes.json();
    if (typeof me.id !== "number") return "unavailable";
    const existing = await findOwnNote(call, headers, notesUrl, me.id, warn);
    if (existing === "unavailable") return "unavailable";
    if (existing) {
      const res2 = await call(`${mrUrl}/notes/${existing.id}`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ body })
      });
      if (res2.ok) return "updated";
      warn(`GitLab: updating MR note ${existing.id} failed: HTTP ${res2.status}`);
      return "unavailable";
    }
    const res = await call(notesUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ body })
    });
    if (res.ok) return "created";
    warn(`GitLab: creating MR note failed: HTTP ${res.status}`);
    return "unavailable";
  } catch (err) {
    const e = err;
    warn(`GitLab: MR note request failed (${e.name}: ${e.message})`);
    return "unavailable";
  }
}
var NOTES_PER_PAGE = 100;
var MAX_NOTE_PAGES = 50;
async function findOwnNote(call, headers, notesUrl, myId, warn) {
  for (let page = 1; page <= MAX_NOTE_PAGES; ) {
    const url = `${notesUrl}?order_by=created_at&sort=asc&per_page=${NOTES_PER_PAGE}&page=${page}`;
    const res = await call(url, { headers });
    if (!res.ok) {
      warn(`GitLab: listing MR notes failed: HTTP ${res.status}`);
      return "unavailable";
    }
    const notes = await res.json();
    if (!Array.isArray(notes)) return "unavailable";
    const hit = notes.find(
      (n) => n?.author?.id === myId && (n.body ?? "").includes(PR_COMMENT_MARKER)
    );
    if (hit) return hit;
    const nextHeader = res.headers.get("x-next-page");
    let next;
    if (nextHeader === null) {
      next = notes.length >= NOTES_PER_PAGE ? page + 1 : null;
    } else {
      const n = Number.parseInt(nextHeader, 10);
      next = Number.isInteger(n) && n > page ? n : null;
    }
    if (next === null) return void 0;
    page = next;
  }
  warn(
    `GitLab: no flakefinder note in the first ${MAX_NOTE_PAGES * NOTES_PER_PAGE} MR notes \u2014 posting a new one`
  );
  return void 0;
}

// src/report/html.ts
function redactData(data) {
  return {
    ...data,
    verdicts: data.verdicts.map((v) => {
      const name = escapeControlChars(redact(v.name));
      const suite = escapeControlChars(redact(v.suite));
      const lastMessage = v.lastMessage ? escapeControlCharsMultiline(redact(v.lastMessage)) : v.lastMessage;
      if (name === v.name && suite === v.suite && lastMessage === v.lastMessage) return v;
      return { ...v, name, suite, lastMessage };
    }),
    runs: data.runs.map(
      (r) => r.commitSha === void 0 ? r : { ...r, commitSha: escapeControlChars(r.commitSha) }
    )
  };
}
function embedJson(data) {
  return JSON.stringify(data).replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--").replace(
    /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`
  );
}
function renderDashboard(data) {
  const safeData = redactData(data);
  const json = embedJson(safeData);
  const hasVerdicts = safeData.verdicts.length > 0;
  const hasRuns = safeData.runs.length > 0;
  const lightTokens = String.raw`
    color-scheme: light;
    --bg: #f6f8fa;
    --bg-elev: #ffffff;
    --bg-inset: #f6f8fa;
    --border: #d0d7de;
    --border-soft: #eaeef2;
    --text: #1f2328;
    --text-dim: #59636e;
    --text-faint: #818b98;
    --brand: #cf4b36;
    --accent: #0969da;
    --pass: #1a7f37;
    --fail: #cf222e;
    --fail-deep: #a40e26;
    --error: #82071e;
    --skip: #57606a;
    --warn: #9a6700;
    --suspect: #bf8700;
    --info: #1b7c83;
    --fixed: #0f766e;
    --violet: #8250df;
    --pink: #bf3989;
    --shadow: 0 1px 3px rgba(31,35,40,.1), 0 8px 24px rgba(31,35,40,.07);
`;
  const css = String.raw`
  *, *::before, *::after { box-sizing: border-box; }
  :root, [data-theme='dark'] {
    color-scheme: dark;
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-inset: #010409;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --text-faint: #6e7681;
    --brand: #f78166;
    --accent: #4493f8;
    --pass: #3fb950;
    --fail: #f85149;
    --fail-deep: #da3633;
    --error: #b62324;
    --skip: #8b949e;
    --warn: #d29922;
    --suspect: #e3b341;
    --info: #39c5cf;
    --fixed: #2dd4bf;
    --violet: #a371f7;
    --pink: #db61a2;
    --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    --shadow: 0 1px 3px rgba(1,4,9,.45), 0 8px 24px rgba(1,4,9,.35);
  }
  [data-theme='light'] {
${lightTokens}  }
  /* no explicit choice: follow the OS (dark stays the default otherwise) */
  @media (prefers-color-scheme: light) {
    :root:not([data-theme='dark']) {
${lightTokens}    }
  }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
      radial-gradient(1100px 480px at 18% -8%, color-mix(in srgb, var(--brand) 7%, transparent), transparent 62%),
      radial-gradient(900px 420px at 92% -10%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 58%);
  }
  h1, h2, h3, p { margin: 0; }
  button { font: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  code, kbd {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 6px;
    color: var(--text);
  }
  kbd { font-size: 11px; border-bottom-width: 2px; color: var(--text-dim); padding: 0 5px; }
  .page { max-width: 1280px; margin: 0 auto; padding: 0 28px 56px; }

  /* ---------- header ---------- */
  .ff-header {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding: 14px 0 12px;
    margin-bottom: 4px;
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border-soft);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo {
    font-size: 22px;
    line-height: 1;
    color: var(--brand);
    text-shadow: 0 0 20px color-mix(in srgb, var(--brand) 55%, transparent);
  }
  .wordmark {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.03em;
    background: linear-gradient(115deg, var(--text) 30%, var(--brand));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .ver {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 9px;
  }
  .spacer { flex: 1 1 auto; }
  .meta { text-align: right; color: var(--text-dim); font-size: 12.5px; }
  .meta b { color: var(--text); font-weight: 600; }

  /* ---------- buttons ---------- */
  .btn {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color .15s, color .15s, background .15s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:active { transform: translateY(1px); }
  .btn.copied { color: var(--pass); border-color: var(--pass); }
  .btn.sm { padding: 4px 10px; font-size: 12px; }
  #ff-toggle { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 6px 14px; }
  .icon-btn {
    font-size: 15px;
    line-height: 1;
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .icon-btn:hover { color: var(--text); border-color: var(--text-dim); }

  /* ---------- cards & sections ---------- */
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
  }
  .section-head { display: flex; align-items: baseline; gap: 12px; margin: 26px 2px 10px; flex-wrap: wrap; }
  .section-title {
    font-size: 12.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .08em;
    color: var(--text-dim);
  }
  .section-sub { color: var(--text-faint); font-size: 12px; }
  .dim-note { color: var(--text-dim); font-size: 13px; margin: 4px 2px 0; }

  /* ---------- chips ---------- */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 14px; margin-top: 18px; }
  .chip {
    --bc: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 11px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .chip::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--bc);
    box-shadow: 0 0 8px color-mix(in srgb, var(--bc) 55%, transparent);
    flex: none;
  }
  .chip:hover { border-color: color-mix(in srgb, var(--bc) 55%, transparent); }
  .chip .cnt { font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
  .chip .lbl { color: var(--text-dim); font-size: 12.5px; }
  .chip.active { border-color: var(--bc); background: color-mix(in srgb, var(--bc) 13%, transparent); }
  .chip.active .lbl { color: var(--text); }
  .chip-sep { width: 1px; height: 22px; background: var(--border); margin: 0 4px; flex: none; }
  .k-total { --bc: var(--accent); }
  .k-confirmed { --bc: var(--fail); }
  .k-retry { --bc: var(--warn); }
  .k-suspected { --bc: var(--suspect); }
  .k-failing { --bc: var(--fail-deep); }
  .k-newfail { --bc: var(--pink); }
  .k-passing { --bc: var(--pass); }
  .k-skipped { --bc: var(--skip); }
  .k-gone { --bc: var(--text-faint); }
  .k-slow { --bc: var(--info); }
  .k-fixed { --bc: var(--fixed); }
  .k-long { --bc: var(--violet); }

  /* ---------- runs strip ---------- */
  .legend { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 12px; }
  .legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 6px; }
  .legend .dot:first-child { margin-left: 0; }
  .dot.pass { background: var(--pass); }
  .dot.fail { background: var(--fail); }
  .strip-card { padding: 18px 18px 12px; }
  .runs { display: flex; align-items: flex-end; gap: 3px; height: 148px; }
  .run-col {
    position: relative;
    flex: 1 1 0;
    min-width: 3px;
    max-width: 26px;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    border-radius: 4px;
    padding: 0 1px;
  }
  .run-col:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
  .run-bar {
    width: 100%;
    border-radius: 3px 3px 0 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 5px;
    transition: filter .12s;
  }
  .run-col:hover .run-bar { filter: brightness(1.3) saturate(1.1); }
  .seg { width: 100%; }
  .seg-pass { flex: 1 1 auto; background: var(--pass); }
  .seg-fail {
    background: var(--fail);
    min-height: 3px;
    box-shadow: 0 0 8px color-mix(in srgb, var(--fail) 55%, transparent);
  }
  .axis {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    color: var(--text-faint);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: .09em;
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 8px 10px;
    font-size: 12px;
    white-space: nowrap;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity .12s ease .04s;
    z-index: 40;
    text-align: left;
  }
  .run-col:hover .tip { opacity: 1; visibility: visible; }
  .run-col:first-child .tip { left: 0; transform: none; }
  .run-col:last-child .tip { left: auto; right: 0; transform: none; }
  .tip-ts { font-weight: 600; }
  .tip-sha { color: var(--text-dim); font-family: var(--mono); font-size: 11.5px; margin: 1px 0 2px; }
  .tip-counts { display: flex; gap: 8px; }
  .tc-pass { color: var(--pass); font-weight: 600; }
  .tc-fail { color: var(--fail); font-weight: 600; }
  .tc-ok { color: var(--text-dim); }

  /* ---------- table ---------- */
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .filter {
    flex: 1 1 220px;
    max-width: 380px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 12px;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    transition: border-color .15s, box-shadow .15s;
  }
  .filter::placeholder { color: var(--text-faint); }
  .filter:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .toolbar-hint { margin-left: auto; color: var(--text-faint); font-size: 12px; }
  .tbl-wrap { max-height: 620px; overflow: auto; border-radius: 0 0 11px 11px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; min-width: 940px; }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg-elev);
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .05em;
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    user-select: none;
  }
  thead th.sortable { cursor: pointer; }
  thead th.sortable:hover { color: var(--text); }
  thead th .arrow { display: inline-block; width: 14px; color: var(--accent); font-size: 11px; }
  th.num-h { text-align: right; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr { cursor: pointer; transition: background .1s; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  tbody tr.selected { background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .score-cell { display: inline-flex; align-items: center; gap: 8px; }
  .score-num { font-weight: 700; min-width: 22px; }
  .score-bar, .rate-bar {
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--text) 10%, transparent);
    overflow: hidden;
  }
  .score-bar { width: 52px; }
  .rate-bar { width: 56px; }
  .score-bar i, .rate-bar i, .hbar-fill { display: block; height: 100%; border-radius: 3px; }
  .s-hi { background: var(--fail); }
  .s-mid { background: var(--warn); }
  .s-lo { background: var(--pass); }
  .s-conf { background: var(--accent); }
  .rate-cell { display: inline-flex; align-items: center; gap: 8px; }
  .rate-num { color: var(--text-dim); min-width: 34px; }
  .td-name { max-width: 460px; }
  .tname { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; max-width: 460px; }
  .tname .suite { color: var(--text-dim); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .tname .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .td-tags { white-space: nowrap; }
  .tag {
    display: inline-block;
    font-size: 11px;
    line-height: 1.6;
    padding: 0 8px;
    margin: 1px 3px 1px 0;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .tag-slow { color: var(--info); border-color: color-mix(in srgb, var(--info) 40%, transparent); background: color-mix(in srgb, var(--info) 9%, transparent); }
  .tag-fixed { color: var(--fixed); border-color: color-mix(in srgb, var(--fixed) 40%, transparent); background: color-mix(in srgb, var(--fixed) 9%, transparent); }
  .tag-long { color: var(--violet); border-color: color-mix(in srgb, var(--violet) 40%, transparent); background: color-mix(in srgb, var(--violet) 9%, transparent); }
  .tag.none { border-color: transparent; color: var(--text-faint); }

  /* ---------- badges (classification / status lookups) ---------- */
  .badge {
    --bc: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 1px 9px 1px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.7;
    color: var(--bc);
    background: color-mix(in srgb, var(--bc) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--bc) 35%, transparent);
    white-space: nowrap;
  }
  .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--bc); flex: none; }
  .badge.ghost { background: transparent; border-color: var(--border); --bc: var(--text-dim); }
  .c-confirmed { --bc: var(--fail); }
  .c-retry { --bc: var(--warn); }
  .c-suspected { --bc: var(--suspect); }
  .c-failing { --bc: var(--fail-deep); }
  .c-newfail { --bc: var(--pink); }
  .c-passing { --bc: var(--pass); }
  .c-skipped { --bc: var(--skip); }
  .c-gone { --bc: var(--text-faint); }
  .st-pass { --bc: var(--pass); }
  .st-fail { --bc: var(--fail); }
  .st-error { --bc: var(--error); }
  .st-skip { --bc: var(--skip); }

  /* ---------- drawer ---------- */
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #010409 55%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity .2s ease;
    z-index: 60;
  }
  .backdrop.open { opacity: 1; pointer-events: auto; }
  #ff-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(460px, 92vw);
    z-index: 70;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    box-shadow: -16px 0 48px color-mix(in srgb, #010409 55%, transparent);
    transform: translateX(103%);
    transition: transform .28s cubic-bezier(.2, .8, .25, 1);
  }
  #ff-drawer.open { transform: translateX(0); }
  .dr-head {
    --bc: var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 16px 20px 13px;
    border-bottom: 1px solid var(--border);
    border-top: 3px solid var(--bc);
  }
  .dr-title { font-size: 15px; font-weight: 700; }
  .dr-hint { color: var(--text-faint); font-size: 11.5px; margin-top: 3px; }
  .dr-body { flex: 1 1 auto; overflow-y: auto; padding: 18px 20px 24px; }
  .dr-suite { color: var(--text-dim); font-size: 12px; font-family: var(--mono); word-break: break-all; }
  .dr-name { margin: 3px 0 12px; font-size: 16.5px; line-height: 1.35; word-break: break-word; }
  .dr-idrow { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  #ff-dr-id {
    flex: 1;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-dim);
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    word-break: break-all;
  }
  .dr-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; align-items: center; }
  .stats-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    background: color-mix(in srgb, var(--bg-inset) 55%, var(--bg-elev));
  }
  .stats-top { display: flex; align-items: center; gap: 18px; }
  .donut { flex: none; }
  .donut-bg { fill: none; stroke: color-mix(in srgb, var(--text) 10%, transparent); stroke-width: 5; }
  .donut-fg { fill: none; stroke: var(--pass); stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray .4s ease; }
  .donut-fg.warn { stroke: var(--suspect); }
  .donut-fg.bad { stroke: var(--fail); }
  .donut-num { fill: var(--text); font-size: 11px; font-weight: 700; text-anchor: middle; }
  .donut-lbl { fill: var(--text-faint); font-size: 6.5px; text-anchor: middle; letter-spacing: .08em; text-transform: uppercase; }
  .bars { flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .bar-row { display: grid; grid-template-columns: 84px 1fr 28px; align-items: center; gap: 8px; font-size: 12px; }
  .bar-lbl { color: var(--text-dim); }
  .hbar { height: 7px; border-radius: 4px; background: color-mix(in srgb, var(--text) 9%, transparent); overflow: hidden; }
  .hbar-fill { border-radius: 4px; transition: width .35s ease; }
  .bar-val { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px; }
  .tile { border: 1px solid var(--border-soft); border-radius: 10px; padding: 9px 10px 7px; background: var(--bg-elev); }
  .tile span { display: block; color: var(--text-faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
  .tile b { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile.hot { border-color: color-mix(in srgb, var(--hot, var(--fail)) 45%, transparent); }
  .tile.hot b { color: var(--hot, var(--fail)); }
  .tile.accent-red { --hot: var(--fail); }
  .tile.accent-orange { --hot: var(--warn); }
  .tile.accent-yellow { --hot: var(--suspect); }
  .dr-msg-block h3 { margin: 18px 0 8px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-dim); }
  #ff-dr-msg {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-left: 3px solid var(--fail);
    border-radius: 8px;
    padding: 12px 14px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-dim);
  }
  .dr-foot { border-top: 1px solid var(--border); padding: 14px 20px 16px; }
  .dr-foot-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); margin-bottom: 7px; }
  .dr-foot-row { display: flex; gap: 8px; align-items: stretch; }
  #ff-dr-cmd {
    flex: 1;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text);
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 10px;
    word-break: break-all;
    align-self: center;
  }

  /* ---------- empty state / footer ---------- */
  .empty-wrap { display: flex; justify-content: center; padding-top: 9vh; }
  .empty-card { max-width: 560px; text-align: center; padding: 52px 44px; }
  .empty-logo {
    font-size: 44px;
    color: var(--brand);
    text-shadow: 0 0 30px color-mix(in srgb, var(--brand) 50%, transparent);
    margin-bottom: 14px;
  }
  .empty-card h2 { margin-bottom: 10px; font-size: 21px; letter-spacing: -0.01em; }
  .empty-card p { color: var(--text-dim); margin-bottom: 10px; }
  .ff-foot {
    margin-top: 34px;
    padding-top: 14px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-faint);
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .tbl-wrap, .dr-body, #ff-dr-msg { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

  @media (max-width: 768px) {
    .page { padding: 0 14px 48px; }
    #ff-drawer { width: 100vw; border-left: none; }
    .stats-top { flex-direction: column; }
    .tbl-wrap { max-height: 65vh; }
    .meta { text-align: left; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; }
  }
`;
  const chips = String.raw`
<nav id="ff-chips" class="chips card" aria-label="Summary filters">
  <button type="button" class="chip k-total" data-clear="1" aria-pressed="false"><span class="cnt" id="cnt-total">0</span><span class="lbl">Tests tracked</span></button>
  <button type="button" class="chip k-confirmed" data-cls="flaky-confirmed" aria-pressed="false"><span class="cnt" id="cnt-flaky-confirmed">0</span><span class="lbl">Flaky (confirmed)</span></button>
  <button type="button" class="chip k-retry" data-cls="flaky-retry" aria-pressed="false"><span class="cnt" id="cnt-flaky-retry">0</span><span class="lbl">Flaky (retry-rescued)</span></button>
  <button type="button" class="chip k-suspected" data-cls="flaky-suspected" aria-pressed="false"><span class="cnt" id="cnt-flaky-suspected">0</span><span class="lbl">Flaky (suspected)</span></button>
  <button type="button" class="chip k-failing" data-cls="failing" aria-pressed="false"><span class="cnt" id="cnt-failing">0</span><span class="lbl">Failing</span></button>
  <button type="button" class="chip k-newfail" data-cls="new-failure" aria-pressed="false"><span class="cnt" id="cnt-new-failure">0</span><span class="lbl">New failure</span></button>
  <button type="button" class="chip k-passing" data-cls="passing" aria-pressed="false"><span class="cnt" id="cnt-passing">0</span><span class="lbl">Passing</span></button>
  <button type="button" class="chip k-skipped" data-cls="skipped" aria-pressed="false"><span class="cnt" id="cnt-skipped">0</span><span class="lbl">Skipped</span></button>
  <button type="button" class="chip k-gone" data-cls="gone" aria-pressed="false"><span class="cnt" id="cnt-gone">0</span><span class="lbl">Gone</span></button>
  <span class="chip-sep" aria-hidden="true"></span>
  <button type="button" class="chip k-slow" data-tag="slow" aria-pressed="false"><span class="cnt" id="cnt-slow">0</span><span class="lbl">Slow</span></button>
  <button type="button" class="chip k-fixed" data-tag="recently-fixed" aria-pressed="false"><span class="cnt" id="cnt-recently-fixed">0</span><span class="lbl">Recently fixed</span></button>
  <button type="button" class="chip k-long" data-tag="long-unseen" aria-pressed="false"><span class="cnt" id="cnt-long-unseen">0</span><span class="lbl">Long unseen</span></button>
</nav>
`;
  const stripCard = String.raw`
<div class="card strip-card">
  <div id="ff-runs" class="runs" role="img" aria-label="Pass and fail counts per run, oldest to newest"></div>
  <div class="axis"><span>oldest</span><span>latest</span></div>
</div>
`;
  const runsNote = String.raw`
<p class="dim-note">No runs recorded yet — the run history chart appears once flakefinder has ingested CI runs.</p>
`;
  const runsSection = String.raw`
<section class="ff-section" aria-label="Run history">
  <div class="section-head">
    <h2 class="section-title">Run history</h2>
    <span class="section-sub" id="ff-runs-sub"></span>
    <span class="legend"><i class="dot pass"></i>pass<i class="dot fail"></i>fail</span>
  </div>
  ${hasRuns ? stripCard : runsNote}
</section>
`;
  const tableSection = String.raw`
<section class="ff-section" aria-label="Tests">
  <div class="section-head">
    <h2 class="section-title">Tests</h2>
    <span class="section-sub" id="ff-showing"></span>
  </div>
  <div class="card">
    <div class="toolbar">
      <input id="ff-filter" class="filter" type="search" placeholder="Filter by suite or test name&hellip;" aria-label="Filter tests" autocomplete="off" spellcheck="false">
      <button type="button" id="ff-clear" class="btn sm" hidden>Clear filters</button>
      <span class="toolbar-hint">Click a row for details</span>
    </div>
    <div class="tbl-wrap">
      <table id="ff-table">
        <thead>
          <tr>
            <th class="sortable num-h" data-key="score" scope="col">Score<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="conf" scope="col">Conf %<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="runs" scope="col">Runs<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="pass" scope="col">Pass rate<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="median" scope="col">Median<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable" data-key="class" scope="col">Class<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable" data-key="name" scope="col">Test<span class="arrow" aria-hidden="true"></span></th>
            <th scope="col">Tags</th>
          </tr>
        </thead>
        <tbody id="ff-tbody"></tbody>
      </table>
    </div>
  </div>
</section>
`;
  const drawerMarkup = String.raw`
<div id="ff-backdrop" class="backdrop" aria-hidden="true"></div>
<aside id="ff-drawer" role="dialog" aria-modal="true" aria-label="Test detail" aria-hidden="true">
  <div class="dr-head">
    <div>
      <div class="dr-title">Test detail</div>
      <div class="dr-hint"><kbd>Esc</kbd> close &middot; <kbd>&larr;</kbd><kbd>&rarr;</kbd> move between tests</div>
    </div>
    <button type="button" id="ff-dr-close" class="icon-btn" aria-label="Close details">&#10005;</button>
  </div>
  <div class="dr-body">
    <div class="dr-suite" id="ff-dr-suite"></div>
    <h2 class="dr-name" id="ff-dr-name"></h2>
    <div class="dr-idrow">
      <code id="ff-dr-id" title="test id"></code>
      <button type="button" class="btn sm" id="ff-dr-copy-id">Copy ID</button>
    </div>
    <div class="dr-badges">
      <span class="badge" id="ff-dr-cls"></span>
      <span class="badge" id="ff-dr-status"></span>
      <span class="badge ghost" id="ff-dr-seen"></span>
    </div>
    <div class="stats-card">
      <div class="stats-top">
        <svg class="donut" viewBox="0 0 48 48" width="84" height="84" aria-hidden="true">
          <circle class="donut-bg" cx="24" cy="24" r="19"></circle>
          <circle class="donut-fg" id="ff-dr-donut" cx="24" cy="24" r="19" transform="rotate(-90 24 24)"></circle>
          <text class="donut-num" id="ff-dr-donut-v" x="24" y="27">&ndash;</text>
          <text class="donut-lbl" x="24" y="37">pass rate</text>
        </svg>
        <div class="bars">
          <div class="bar-row">
            <span class="bar-lbl">Flake score</span>
            <div class="hbar"><i class="hbar-fill s-lo" id="ff-dr-score-bar"></i></div>
            <b class="bar-val" id="ff-dr-score-v">0</b>
          </div>
          <div class="bar-row">
            <span class="bar-lbl">Confidence</span>
            <div class="hbar"><i class="hbar-fill s-conf" id="ff-dr-conf-bar"></i></div>
            <b class="bar-val" id="ff-dr-conf-v">0</b>
          </div>
        </div>
      </div>
      <div class="tiles">
        <div class="tile"><span>Runs</span><b id="ff-dr-runs">0</b></div>
        <div class="tile"><span>Median</span><b id="ff-dr-med">&ndash;</b></div>
        <div class="tile"><span>P95</span><b id="ff-dr-p95">&ndash;</b></div>
        <div class="tile accent-red"><span>Same-SHA flips</span><b id="ff-dr-flips">0</b></div>
        <div class="tile accent-orange"><span>Retry rescues</span><b id="ff-dr-resc">0</b></div>
        <div class="tile accent-yellow"><span>Direction &Delta;</span><b id="ff-dr-dirs">0</b></div>
      </div>
    </div>
    <div class="dr-msg-block" id="ff-dr-msg-block">
      <h3>Last failure message</h3>
      <pre id="ff-dr-msg"></pre>
    </div>
  </div>
  <div class="dr-foot">
    <div class="dr-foot-lbl">Quarantine this test</div>
    <div class="dr-foot-row">
      <code id="ff-dr-cmd"></code>
      <button type="button" class="btn sm" id="ff-dr-copy-cmd">Copy</button>
    </div>
  </div>
</aside>
`;
  const emptyState = String.raw`
<div class="empty-wrap">
  <div class="card empty-card">
    <div class="empty-logo" aria-hidden="true">&#10052;</div>
    <h2>No test history yet</h2>
    <p>flakefinder learns your suite's health as runs accumulate — this dashboard fills in automatically.</p>
    <p class="empty-hint">Run <code>npx flakefinder run -- npm test</code> a few times locally or in CI, then regenerate with <code>npx flakefinder html</code>.</p>
  </div>
</div>
`;
  const appJs = String.raw`
(function () {
  'use strict';

  // ---------- embedded data ----------
  function readData() {
    var node = document.getElementById('ff-data');
    var text = node ? (node.textContent || '') : '{}';
    // Undo the safety escape applied by renderDashboard before parsing.
    // The escaped end-tag form is already valid JSON and needs no reversal.
    return JSON.parse(text.replace(/<\\!/g, '<!'));
  }

  var data = readData();
  var verdicts = Array.isArray(data.verdicts) ? data.verdicts : [];
  var runs = Array.isArray(data.runs) ? data.runs : [];

  // ---------- lookup maps ----------
  var CLS = {
    'flaky-confirmed': { label: 'Flaky (confirmed)', short: 'Flaky', color: 'confirmed' },
    'flaky-retry': { label: 'Flaky (retry-rescued)', short: 'Retry-rescued', color: 'retry' },
    'flaky-suspected': { label: 'Flaky (suspected)', short: 'Suspected', color: 'suspected' },
    'failing': { label: 'Failing', short: 'Failing', color: 'failing' },
    'new-failure': { label: 'New failure', short: 'New failure', color: 'newfail' },
    'passing': { label: 'Passing', short: 'Passing', color: 'passing' },
    'skipped': { label: 'Skipped', short: 'Skipped', color: 'skipped' },
    'gone': { label: 'Gone', short: 'Gone', color: 'gone' }
  };
  var RANK = { 'flaky-confirmed': 0, 'flaky-retry': 1, 'flaky-suspected': 2, 'failing': 3, 'new-failure': 4, 'passing': 5, 'skipped': 6, 'gone': 7 };
  var TAG_CLS = { slow: 'tag-slow', 'recently-fixed': 'tag-fixed', 'long-unseen': 'tag-long' };
  var STATUS_CLS = { pass: 'st-pass', fail: 'st-fail', error: 'st-error', skip: 'st-skip' };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  // control/bidi characters made visible, as in src/report/text.ts — for
  // testIds, which stay raw in the data so the copy buttons yield the real id
  function visible(s) {
    return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, function (c) {
      var code = c.charCodeAt(0);
      return code < 256 ? '\\x' + ('0' + code.toString(16)).slice(-2) : '\\u' + ('000' + code.toString(16)).slice(-4);
    });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtDur(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '\u2014';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) {
      var s = ms / 1000;
      var str = s >= 100 ? s.toFixed(0) : (s >= 10 ? s.toFixed(1) : s.toFixed(2));
      return str + ' s';
    }
    var m = Math.floor(ms / 60000);
    if (m >= 60) {
      var h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }
    return m + 'm ' + Math.round((ms - m * 60000) / 1000) + 's';
  }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function clamp01(x) { return Math.max(0, Math.min(1, isFinite(x) ? x : 0)); }
  function clamp100(x) { return Math.max(0, Math.min(100, isFinite(x) ? x : 0)); }
  function scoreCls(n) { return n >= 70 ? 's-hi' : (n >= 40 ? 's-mid' : 's-lo'); }
  function rateCls(r) { return r >= 0.9 ? 's-lo' : (r >= 0.5 ? 's-mid' : 's-hi'); }
  function confCls(n) { return n >= 70 ? 's-conf' : (n >= 40 ? 's-mid' : 's-hi'); }
  function midTrunc(s, max) {
    s = String(s);
    if (s.length <= max) return s;
    // by code point: slicing UTF-16 units would split surrogate pairs (emoji)
    var cps = Array.from(s);
    if (cps.length <= max) return s;
    var keep = max - 1;
    var head = Math.ceil(keep / 2);
    var tail = keep - head;
    return cps.slice(0, head).join('') + '\u2026' + cps.slice(cps.length - tail).join('');
  }
  function shortSha(s) { if (!s) return ''; s = String(s); var d = s.indexOf('-dirty'); return d >= 0 ? s.slice(0, 7) + ' (dirty)' : s.slice(0, 7); }

  // ---------- theme toggle ----------
  var themeBtn = $('ff-toggle');
  // an explicit choice (stored) wins; otherwise follow prefers-color-scheme,
  // dark when the OS has no preference
  var lightQuery = null;
  try { lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null; } catch (err) { lightQuery = null; }
  var stored = null;
  try {
    stored = window.localStorage && window.localStorage.getItem('ff-theme');
  } catch (err) { /* storage unavailable (private mode / file origin) */ }
  var explicitTheme = stored === 'light' || stored === 'dark';
  var theme = explicitTheme ? stored : (lightQuery && lightQuery.matches ? 'light' : 'dark');
  if (lightQuery && lightQuery.addEventListener) {
    lightQuery.addEventListener('change', function (e) {
      if (explicitTheme) return;
      theme = e.matches ? 'light' : 'dark';
      applyTheme();
    });
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
    if (!themeBtn) return;
    var ico = $('ff-toggle-ico');
    var lbl = $('ff-toggle-lbl');
    if (ico) ico.textContent = theme === 'dark' ? '\u2600' : '\u263E';
    if (lbl) lbl.textContent = theme === 'dark' ? 'Light' : 'Dark';
    themeBtn.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
  }
  applyTheme();
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      explicitTheme = true;
      try { window.localStorage.setItem('ff-theme', theme); } catch (err) { /* ignore */ }
      applyTheme();
    });
  }

  // ---------- header ----------
  var gen = $('ff-generated');
  if (gen) gen.textContent = fmtDateTime(data.generatedAt);
  var ver = $('ff-version');
  if (ver) ver.textContent = 'v' + (data.flakefinderVersion || '');

  // ---------- summary chip counts ----------
  var clsCounts = {};
  var tagCounts = {};
  var idx;
  for (idx = 0; idx < verdicts.length; idx++) {
    var item = verdicts[idx];
    clsCounts[item.classification] = (clsCounts[item.classification] || 0) + 1;
    var itemTags = item.tags || [];
    var t;
    for (t = 0; t < itemTags.length; t++) {
      tagCounts[itemTags[t]] = (tagCounts[itemTags[t]] || 0) + 1;
    }
  }
  function setCount(id, n) {
    var e = $(id);
    if (e) e.textContent = String(n);
  }
  setCount('cnt-total', verdicts.length);
  Object.keys(CLS).forEach(function (k) { setCount('cnt-' + k, clsCounts[k] || 0); });
  setCount('cnt-slow', tagCounts.slow || 0);
  setCount('cnt-recently-fixed', tagCounts['recently-fixed'] || 0);
  setCount('cnt-long-unseen', tagCounts['long-unseen'] || 0);

  // ---------- table state ----------
  var state = { q: '', cls: null, tag: null, sortKey: 'score', sortDir: 'desc' };
  var GETTERS = {
    score: function (x) { return x.flakeScore; },
    conf: function (x) { return x.confidence; },
    runs: function (x) { return x.runsObserved; },
    pass: function (x) { return clamp01(x.passRate); },
    median: function (x) { return x.medianDurationMs == null ? -1 : x.medianDurationMs; },
    'class': function (x) { return RANK[x.classification] !== undefined ? RANK[x.classification] : 99; },
    name: function (x) { return (x.suite + ' / ' + x.name).toLowerCase(); }
  };
  function currentRows() {
    var out = [];
    var j;
    for (j = 0; j < verdicts.length; j++) {
      var x = verdicts[j];
      if (state.cls && x.classification !== state.cls) continue;
      if (state.tag && (x.tags || []).indexOf(state.tag) === -1) continue;
      if (state.q) {
        var hay = (x.suite + ' ' + x.name).toLowerCase();
        if (hay.indexOf(state.q) === -1) continue;
      }
      out.push(x);
    }
    var getter = GETTERS[state.sortKey] || GETTERS.score;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      var va = getter(a);
      var vb = getter(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      var na = (a.suite + ' / ' + a.name).toLowerCase();
      var nb = (b.suite + ' / ' + b.name).toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
    return out;
  }

  // ---------- table rendering ----------
  var tbody = $('ff-tbody');
  var showingEl = $('ff-showing');
  var clearBtn = $('ff-clear');

  function rowEl(rows, v, rowIdx) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-idx', String(rowIdx));
    tr.tabIndex = 0;
    var td;

    td = el('td', 'num');
    var scoreCell = el('div', 'score-cell');
    scoreCell.appendChild(el('span', 'score-num', String(Math.round(v.flakeScore))));
    var scoreBar = el('div', 'score-bar');
    var scoreFill = el('i', scoreCls(v.flakeScore));
    scoreFill.style.width = clamp100(v.flakeScore) + '%';
    scoreBar.appendChild(scoreFill);
    scoreCell.appendChild(scoreBar);
    td.appendChild(scoreCell);
    tr.appendChild(td);

    tr.appendChild(el('td', 'num', Math.round(v.confidence) + '%'));

    tr.appendChild(el('td', 'num', String(v.runsObserved)));

    td = el('td', 'num');
    var rate = clamp01(v.passRate);
    var rateCell = el('div', 'rate-cell');
    var rateBar = el('div', 'rate-bar');
    var rateFill = el('i', rateCls(rate));
    rateFill.style.width = Math.round(rate * 100) + '%';
    rateBar.appendChild(rateFill);
    rateCell.appendChild(rateBar);
    rateCell.appendChild(el('span', 'rate-num', pct(rate)));
    td.appendChild(rateCell);
    tr.appendChild(td);

    tr.appendChild(el('td', 'num', fmtDur(v.medianDurationMs)));

    var meta = CLS[v.classification] || CLS.passing;
    tr.appendChild(el('td', null)).appendChild(el('span', 'badge c-' + meta.color, meta.short));

    td = el('td', 'td-name');
    var nameDiv = el('div', 'tname');
    nameDiv.title = v.suite + ' :: ' + v.name;
    nameDiv.appendChild(el('span', 'suite', midTrunc(v.suite, 46) + ' ::'));
    nameDiv.appendChild(el('span', 'nm', midTrunc(v.name, 56)));
    td.appendChild(nameDiv);
    tr.appendChild(td);

    td = el('td', 'td-tags');
    var tags = v.tags || [];
    var k;
    for (k = 0; k < tags.length; k++) {
      td.appendChild(el('span', 'tag ' + (TAG_CLS[tags[k]] || ''), tags[k]));
    }
    if (!tags.length) td.appendChild(el('span', 'tag none', '\u2014'));
    tr.appendChild(td);

    tr.addEventListener('click', function () { openDrawer(rows, rowIdx); });
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDrawer(rows, rowIdx);
      }
    });
    return tr;
  }

  function updateSortHeads() {
    var heads = document.querySelectorAll('#ff-table thead th[data-key]');
    Array.prototype.forEach.call(heads, function (th) {
      var key = th.getAttribute('data-key');
      var arrow = th.querySelector('.arrow');
      var active = key === state.sortKey;
      if (arrow) arrow.textContent = active ? (state.sortDir === 'asc' ? '\u2191' : '\u2193') : '';
      if (active) th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  var RENDER_CAP = 500;
  var showAll = false;

  if (showingEl) {
    showingEl.style.cursor = 'pointer';
    showingEl.title = 'Click to toggle the render cap';
    showingEl.addEventListener('click', function () {
      showAll = !showAll;
      renderTable();
    });
  }
  if (clearBtn) clearBtn.hidden = true;

  function renderTable() {
    var rows = currentRows();
    var frag = document.createDocumentFragment();
    var limit = showAll ? rows.length : Math.min(rows.length, RENDER_CAP);
    var j;
    for (j = 0; j < limit; j++) frag.appendChild(rowEl(rows, rows[j], j));
    if (tbody) tbody.replaceChildren(frag);
    var hidden = rows.length - limit;
    var label = 'Showing ' + limit + ' of ' + verdicts.length + ' tests';
    if (hidden > 0) label += ' (' + hidden + ' hidden for speed — show all)';
    if (showingEl) showingEl.textContent = label;
    if (clearBtn) clearBtn.hidden = !(state.q || state.cls || state.tag);
    updateSortHeads();
  }

  function wireSort() {
    var heads = document.querySelectorAll('#ff-table thead th[data-key]');
    Array.prototype.forEach.call(heads, function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDir = (key === 'name' || key === 'class') ? 'asc' : 'desc';
        }
        renderTable();
      });
    });
  }

  // ---------- filter input + chips ----------
  var filterInput = $('ff-filter');
  var debounceTimer = 0;
  if (filterInput) {
    filterInput.addEventListener('input', function () {
      window.clearTimeout(debounceTimer);
      var value = filterInput.value;
      debounceTimer = window.setTimeout(function () {
        state.q = value.trim().toLowerCase();
        renderTable();
      }, 150);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      state.q = '';
      state.cls = null;
      state.tag = null;
      if (filterInput) filterInput.value = '';
      syncChipActive();
      renderTable();
    });
  }

  function chipFilterOf(chip) {
    if (chip.getAttribute('data-clear') !== null) return { cls: null, tag: null };
    var c = chip.getAttribute('data-cls');
    if (c) return { cls: c, tag: null };
    var t = chip.getAttribute('data-tag');
    if (t) return { cls: null, tag: t };
    return null;
  }
  function syncChipActive() {
    var chips = document.querySelectorAll('#ff-chips .chip');
    Array.prototype.forEach.call(chips, function (chip) {
      var f = chipFilterOf(chip);
      var on = false;
      if (f) {
        if (f.cls) on = f.cls === state.cls && !state.tag;
        else if (f.tag) on = f.tag === state.tag && !state.cls;
        else on = !state.cls && !state.tag;
      }
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function wireChips() {
    var chips = document.querySelectorAll('#ff-chips .chip');
    Array.prototype.forEach.call(chips, function (chip) {
      chip.addEventListener('click', function () {
        var f = chipFilterOf(chip);
        if (!f) return;
        if (!f.cls && !f.tag) {
          state.cls = null;
          state.tag = null;
        } else if (f.cls && f.cls === state.cls && !state.tag) {
          state.cls = null;
        } else if (f.tag && f.tag === state.tag && !state.cls) {
          state.tag = null;
        } else {
          state.cls = f.cls;
          state.tag = f.tag;
        }
        syncChipActive();
        renderTable();
      });
    });
    syncChipActive();
  }

  // ---------- runs strip chart ----------
  function renderRuns() {
    var wrap = $('ff-runs');
    if (!wrap) return;
    var list = runs.slice().sort(function (a, b) {
      if (a.timestamp < b.timestamp) return -1;
      if (a.timestamp > b.timestamp) return 1;
      return 0;
    }).slice(-50);
    var sub = $('ff-runs-sub');
    if (sub) {
      sub.textContent = list.length + (list.length === 1 ? ' run' : ' runs') + (runs.length > 50 ? ' \u00B7 showing last 50' : '');
    }
    var max = 1;
    var j;
    for (j = 0; j < list.length; j++) {
      var total0 = list[j].passCount + list[j].failCount;
      if (total0 > max) max = total0;
    }
    for (j = 0; j < list.length; j++) {
      var r = list[j];
      var total = Math.max(1, r.passCount + r.failCount);
      var col = el('div', 'run-col');
      var bar = el('div', 'run-bar');
      bar.style.height = Math.max(6, Math.round((total / max) * 100)) + '%';
      if (r.failCount > 0) {
        var segFail = el('div', 'seg seg-fail');
        segFail.style.height = Math.max(6, Math.round((r.failCount / total) * 100)) + '%';
        bar.appendChild(segFail);
      }
      bar.appendChild(el('div', 'seg seg-pass'));
      col.appendChild(bar);

      var tip = el('div', 'tip');
      tip.appendChild(el('div', 'tip-ts', fmtDateTime(r.timestamp)));
      tip.appendChild(el('div', 'tip-sha', r.commitSha ? shortSha(r.commitSha) : 'no commit sha'));
      var counts = el('div', 'tip-counts');
      counts.appendChild(el('span', 'tc-pass', r.passCount + ' pass'));
      if (r.failCount > 0) counts.appendChild(el('span', 'tc-fail', r.failCount + ' fail'));
      else counts.appendChild(el('span', 'tc-ok', 'all green'));
      tip.appendChild(counts);
      col.appendChild(tip);
      wrap.appendChild(col);
    }
  }

  // ---------- detail drawer ----------
  var drawer = $('ff-drawer');
  var backdrop = $('ff-backdrop');
  var drawerRows = [];
  var drawerIdx = -1;
  var current = null;
  var DONUT_C = 2 * Math.PI * 19;

  function setHBar(barId, valId, n, cls) {
    var bar = $(barId);
    var val = $(valId);
    if (bar) {
      bar.style.width = clamp100(n) + '%';
      bar.className = 'hbar-fill ' + cls;
    }
    if (val) val.textContent = String(Math.round(n));
  }
  function tile(id, text, hot) {
    var e = $(id);
    if (e) {
      e.textContent = text;
      if (e.parentElement) e.parentElement.classList.toggle('hot', !!hot);
    }
  }

  function renderDrawer(v) {
    current = v;
    var meta = CLS[v.classification] || CLS.passing;

    var suiteEl = $('ff-dr-suite');
    if (suiteEl) { suiteEl.textContent = v.suite; suiteEl.title = v.suite; }
    var nameEl = $('ff-dr-name');
    if (nameEl) { nameEl.textContent = v.name; nameEl.title = v.name; }
    var idEl = $('ff-dr-id');
    if (idEl) idEl.textContent = visible(v.testId);

    var clsEl = $('ff-dr-cls');
    if (clsEl) { clsEl.textContent = meta.label; clsEl.className = 'badge c-' + meta.color; }
    var head = drawer ? drawer.querySelector('.dr-head') : null;
    if (head) head.className = 'dr-head c-' + meta.color;

    var stEl = $('ff-dr-status');
    if (stEl) {
      stEl.textContent = 'last: ' + v.lastStatus;
      stEl.className = 'badge ' + (STATUS_CLS[v.lastStatus] || 'st-pass');
    }
    var seenEl = $('ff-dr-seen');
    if (seenEl) seenEl.textContent = 'last seen ' + fmtDateTime(v.lastSeen);

    var rate = clamp01(v.passRate);
    var arc = $('ff-dr-donut');
    if (arc) {
      arc.setAttribute('stroke-dasharray', (rate * DONUT_C).toFixed(2) + ' ' + DONUT_C.toFixed(2));
      arc.setAttribute('class', 'donut-fg ' + (rate >= 0.9 ? 'ok' : (rate >= 0.5 ? 'warn' : 'bad')));
    }
    var donutVal = $('ff-dr-donut-v');
    if (donutVal) donutVal.textContent = pct(rate);

    setHBar('ff-dr-score-bar', 'ff-dr-score-v', v.flakeScore, scoreCls(v.flakeScore));
    setHBar('ff-dr-conf-bar', 'ff-dr-conf-v', v.confidence, confCls(v.confidence));

    tile('ff-dr-runs', String(v.runsObserved), false);
    tile('ff-dr-med', fmtDur(v.medianDurationMs), false);
    tile('ff-dr-p95', fmtDur(v.p95DurationMs), false);
    tile('ff-dr-flips', String(v.sameShaFlips || 0), (v.sameShaFlips || 0) > 0);
    tile('ff-dr-resc', String(v.retryRescues || 0), (v.retryRescues || 0) > 0);
    tile('ff-dr-dirs', String(v.directionChanges || 0), (v.directionChanges || 0) > 0);

    var msgBlock = $('ff-dr-msg-block');
    var msgPre = $('ff-dr-msg');
    if (msgBlock && msgPre) {
      if (v.lastMessage) {
        msgBlock.style.display = '';
        msgPre.textContent = v.lastMessage;
      } else {
        msgBlock.style.display = 'none';
      }
    }
    var cmd = $('ff-dr-cmd');
    if (cmd) cmd.textContent = 'flakefinder quarantine add ' + visible(v.testId);
  }

  function highlightDrawerRow() {
    if (!tbody) return;
    var prev = tbody.querySelector('tr.selected');
    if (prev) prev.classList.remove('selected');
    var cur = tbody.querySelector('tr[data-idx="' + drawerIdx + '"]');
    if (cur) cur.classList.add('selected');
  }
  function openDrawer(rows, rowIdx) {
    if (!drawer || !rows.length) return;
    drawerRows = rows;
    drawerIdx = rowIdx;
    renderDrawer(rows[rowIdx]);
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.add('open');
    highlightDrawerRow();
    var closeBtn = $('ff-dr-close');
    if (closeBtn) closeBtn.focus();
  }
  function closeDrawer() {
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) backdrop.classList.remove('open');
    if (tbody) {
      var prev = tbody.querySelector('tr.selected');
      if (prev) prev.classList.remove('selected');
    }
  }
  function stepDrawer(delta) {
    if (!drawerRows.length) return;
    drawerIdx = (drawerIdx + delta + drawerRows.length) % drawerRows.length;
    renderDrawer(drawerRows[drawerIdx]);
    highlightDrawerRow();
  }
  function isTypingTarget(e) {
    var t = e.target;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
  }
  document.addEventListener('keydown', function (e) {
    var open = drawer && drawer.classList.contains('open');
    if (e.key === 'Escape') {
      if (open) closeDrawer();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowRight' && !isTypingTarget(e)) { e.preventDefault(); stepDrawer(1); }
    else if (e.key === 'ArrowLeft' && !isTypingTarget(e)) { e.preventDefault(); stepDrawer(-1); }
  });

  // ---------- clipboard ----------
  function flashCopied(btn) {
    if (!btn) return;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    window.setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1400);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      document.body.removeChild(ta);
      flashCopied(btn);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flashCopied(btn); }, fallback);
    } else {
      fallback();
    }
  }
  function wireCopy(btnId, getText) {
    var btn = $(btnId);
    if (btn) btn.addEventListener('click', function () { copyText(getText(), btn); });
  }
  wireCopy('ff-dr-copy-id', function () { return current ? current.testId : ''; });
  wireCopy('ff-dr-copy-cmd', function () { return current ? 'flakefinder quarantine add ' + current.testId : ''; });
  var drClose = $('ff-dr-close');
  if (drClose) drClose.addEventListener('click', closeDrawer);
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  // ---------- init ----------
  if ($('ff-table')) {
    wireChips();
    wireSort();
    renderRuns();
    renderTable();
  }
})();
`;
  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="flakefinder">
<title>flakefinder dashboard</title>
<style>${css}</style>
</head>
<body>
<div class="page">
  <header class="ff-header">
    <div class="brand">
      <span class="logo" aria-hidden="true">&#10052;</span>
      <span class="wordmark">flakefinder</span>
      <span class="ver" id="ff-version"></span>
    </div>
    <div class="spacer"></div>
    <div class="meta">Generated <b id="ff-generated"></b></div>
    <button type="button" id="ff-toggle" class="btn" aria-label="Toggle color theme"><span id="ff-toggle-ico" aria-hidden="true"></span><span id="ff-toggle-lbl"></span></button>
  </header>
  ${hasVerdicts ? chips : ""}
  ${hasVerdicts ? runsSection : ""}
  ${hasVerdicts ? tableSection : ""}
  ${hasVerdicts ? "" : emptyState}
  <footer class="ff-foot">
    <span>Self-contained offline dashboard &mdash; data embedded at generation time, no network requests.</span>
    <span>flakefinder</span>
  </footer>
</div>
${hasVerdicts ? drawerMarkup : ""}
<script id="ff-data" type="application/json">${json}</script>
<script>${appJs}</script>
</body>
</html>`;
}

// src/types.ts
var FLAKEFINDER_VERSION = "1.2.0";

// src/report/json.ts
var JSON_SCHEMA_VERSION = 1;
function renderJson(verdicts, cfg) {
  const payload = {
    schemaVersion: JSON_SCHEMA_VERSION,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    flakefinderVersion: FLAKEFINDER_VERSION,
    config: cfg,
    verdicts: verdicts.map((v) => {
      const name = redact(v.name);
      const suite = redact(v.suite);
      const lastMessage = v.lastMessage ? redact(v.lastMessage) : v.lastMessage;
      if (name === v.name && suite === v.suite && lastMessage === v.lastMessage) return v;
      return { ...v, name, suite, lastMessage };
    })
  };
  return JSON.stringify(payload, null, 2);
}

// src/report/terminal.ts
var CLASS_META = {
  "flaky-confirmed": { label: "FLAKY (confirmed)", colorCode: "31" },
  "flaky-retry": { label: "FLAKY (retry-rescued)", colorCode: "33" },
  "flaky-suspected": { label: "FLAKY (suspected)", colorCode: "33" },
  failing: { label: "FAILING", colorCode: "31" },
  "new-failure": { label: "NEW FAILURE", colorCode: "35" },
  passing: { label: "PASSING", colorCode: "32" },
  skipped: { label: "SKIPPED", colorCode: "90" },
  gone: { label: "GONE", colorCode: "90" }
};
var PROBLEM_CLASSES = [
  "flaky-confirmed",
  "flaky-retry",
  "flaky-suspected",
  "failing",
  "new-failure"
];
function makeColor(enabled) {
  return (code, s) => enabled ? `\x1B[${code}m${s}\x1B[0m` : s;
}
function fmtMs(ms) {
  if (ms == null) return "\u2014";
  if (ms >= 6e4) return `${(ms / 6e4).toFixed(1)}m`;
  if (ms >= 1e3) return `${(ms / 1e3).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}
function truncateMiddle(s, max) {
  if (s.length <= max) return s;
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${cps.slice(0, half).join("")}\u2026${cps.slice(cps.length - half).join("")}`;
}
function renderTerminal(allVerdicts, opts) {
  const color = makeColor(opts.color);
  const bold = (s) => color("1", s);
  const dim2 = (s) => color("2", s);
  const lines = [];
  const beforeFilter = allVerdicts.length;
  const verdicts = opts.threshold == null ? allVerdicts : allVerdicts.filter(
    (v) => v.classification !== "flaky-suspected" || v.flakeScore >= opts.threshold
  );
  const hiddenBelowThreshold = beforeFilter - verdicts.length;
  const byClass = /* @__PURE__ */ new Map();
  for (const v of verdicts) {
    const list = byClass.get(v.classification) ?? [];
    list.push(v);
    byClass.set(v.classification, list);
  }
  const safe = (s) => escapeControlChars(redact(s));
  for (const [, list] of byClass) {
    list.sort((a, b) => b.flakeScore - a.flakeScore || a.name.localeCompare(b.name));
  }
  const problemCount = PROBLEM_CLASSES.reduce((n, c) => n + (byClass.get(c)?.length ?? 0), 0);
  if (allVerdicts.length === 0) {
    lines.push(
      `${bold("flakefinder")} \u2014 no test history yet.`,
      "",
      "Collect history first:",
      `  ${color("36", "flakefinder run -- <test command>")}    run with retry-based flake detection`,
      `  ${color("36", "flakefinder ingest <report files>")}    ingest existing report files`
    );
    return lines.join("\n");
  }
  lines.push(
    // "tracked" is the whole history — it must not change with --threshold;
    // only the "need attention" rows are filtered (and the hidden ones counted)
    bold(`flakefinder \u2014 ${allVerdicts.length} tracked test(s), ${problemCount} need attention`),
    ""
  );
  if (hiddenBelowThreshold > 0) {
    lines.push(
      dim2(
        `${hiddenBelowThreshold} flaky-suspected test(s) hidden below score ${opts.threshold} \u2014 show them with --all or a lower --threshold`
      ),
      ""
    );
  }
  for (const cls of PROBLEM_CLASSES) {
    const list = byClass.get(cls);
    if (!list || list.length === 0) continue;
    const meta = CLASS_META[cls];
    lines.push(color(meta.colorCode, bold(`${meta.label} \u2014 ${list.length}`)));
    for (const v of list) {
      const score = String(v.flakeScore).padStart(3);
      const conf = `${v.confidence}%`.padStart(4);
      const runs = String(v.runsObserved).padStart(3);
      const pass = `${Math.round(v.passRate * 100)}%`.padStart(4);
      const med = fmtMs(v.medianDurationMs).padStart(6);
      const tags = v.tags.length > 0 ? dim2(` [${safe(v.tags.join(", "))}]`) : "";
      lines.push(
        `  ${color(meta.colorCode, score)}  conf ${conf}  runs ${runs}  pass ${pass}  med ${med}  ${safe(v.suite)} ${dim2("::")} ${bold(truncateMiddle(safe(v.name), 48))}${tags}`
      );
    }
    lines.push("");
  }
  if (opts.allRows) {
    for (const cls of ["passing", "skipped", "gone"]) {
      const list = byClass.get(cls);
      if (!list || list.length === 0) continue;
      const meta = CLASS_META[cls];
      lines.push(dim2(`${meta.label} \u2014 ${list.length}`));
      const shown = cls === "passing" ? list.slice(0, 20) : list;
      for (const v of shown) {
        const med = fmtMs(v.medianDurationMs).padStart(6);
        const tags = v.tags.length > 0 ? dim2(` [${safe(v.tags.join(", "))}]`) : "";
        lines.push(
          `  ${dim2(String(v.flakeScore).padStart(3))}  runs ${String(v.runsObserved).padStart(3)}  med ${med}  ${safe(v.suite)} ${dim2("::")} ${truncateMiddle(safe(v.name), 48)}${tags}`
        );
      }
      if (cls === "passing" && list.length > 20) lines.push(dim2(`  \u2026and ${list.length - 20} more`));
      lines.push("");
    }
  }
  if (!opts.flakesOnly) {
    const passing = byClass.get("passing")?.length ?? 0;
    const skipped = byClass.get("skipped")?.length ?? 0;
    const gone = byClass.get("gone")?.length ?? 0;
    lines.push(
      dim2(`ok: ${passing} passing \xB7 ${skipped} skipped \xB7 ${gone} gone from recent runs`),
      ""
    );
  }
  const flaky = PROBLEM_CLASSES.slice(0, 3).reduce((n, c) => n + (byClass.get(c)?.length ?? 0), 0);
  if (flaky > 0) {
    const worst = [...byClass.entries()].flatMap(([c, vs]) => PROBLEM_CLASSES.slice(0, 3).includes(c) ? vs : []).sort((a, b) => b.flakeScore - a.flakeScore)[0];
    lines.push("next steps:");
    if (worst) {
      lines.push(`  ${dim2("\u2022")} quarantine the worst offender:`);
      lines.push(`      ${color("36", `flakefinder quarantine add ${safe(worst.testId)}`)}`);
    }
    lines.push(`  ${dim2("\u2022")} full interactive report: ${color("36", "flakefinder html")}`);
  }
  return lines.join("\n");
}

// src/runner/wrap.ts
import { spawn, spawnSync as spawnSync3 } from "child_process";
import { createHash as createHash3, randomUUID } from "crypto";
import { existsSync as existsSync5, mkdtempSync, readFileSync as readFileSync6, rmSync as rmSync3, statSync as statSync6, writeFileSync as writeFileSync3 } from "fs";
import { tmpdir } from "os";
import path7 from "path";

// src/util/read-text.ts
import { readFileSync as readFileSync4 } from "fs";
import { gunzipSync } from "zlib";
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 31 && buf[1] === 139) {
    try {
      return decodeText(gunzipSync(buf, { maxOutputLength: 512 * 1024 * 1024 }));
    } catch {
    }
  }
  if (buf.length >= 3 && buf[0] === 239 && buf[1] === 187 && buf[2] === 191) {
    return buf.subarray(3).toString("utf8");
  }
  if (buf.length >= 2 && buf[0] === 255 && buf[1] === 254) {
    return buf.subarray(2).toString("utf16le");
  }
  if (buf.length >= 2 && buf[0] === 254 && buf[1] === 255) {
    return swap16(buf.subarray(2)).toString("utf16le");
  }
  const probe = Math.min(buf.length, 512) & ~1;
  if (probe >= 4) {
    let evenNul = 0;
    let oddNul = 0;
    for (let i = 0; i < probe; i += 2) {
      if (buf[i] === 0) evenNul++;
      if (buf[i + 1] === 0) oddNul++;
    }
    const pairs = probe / 2;
    if (oddNul > pairs * 0.4 && evenNul === 0) return buf.toString("utf16le");
    if (evenNul > pairs * 0.4 && oddNul === 0) return swap16(buf).toString("utf16le");
  }
  return buf.toString("utf8");
}
function swap16(buf) {
  const out = Buffer.from(buf.subarray(0, buf.length & ~1));
  out.swap16();
  return out;
}
function readTextFile(file) {
  return decodeText(readFileSync4(file));
}

// src/runner/git-state.ts
import { spawnSync as spawnSync2 } from "child_process";
import { createHash as createHash2 } from "crypto";
import { readFileSync as readFileSync5, realpathSync, statSync as statSync5 } from "fs";
import path6 from "path";
var MAX_HASHED_BYTES = 8 * 1024 * 1024;
var GIT_TIMEOUT_MS = 15e3;
function git(cwd, args) {
  const r = spawnSync2("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024
  });
  return r.status === 0 && typeof r.stdout === "string" ? r.stdout : null;
}
function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    const parent = path6.dirname(p);
    return parent === p ? p : path6.join(real(parent), path6.basename(p));
  }
}
function parsePorcelainZ(out) {
  const files = [];
  const tokens = out.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    files.push(t.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++;
  }
  return files;
}
function detectCodeState(cwd, exclude = []) {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim();
  if (!head) return { commitSha: void 0, dirtyFiles: [] };
  const status = git(cwd, ["status", "--porcelain", "-z", "--untracked-files=no"]);
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (status === null || !top) return { commitSha: head, dirtyFiles: [] };
  const root = real(top);
  const excluded = exclude.map((p) => real(path6.resolve(cwd, p)));
  const isExcluded = (abs) => excluded.some((e) => abs === e || abs.startsWith(e + path6.sep));
  const dirtyFiles = parsePorcelainZ(status).filter((rel) => !isExcluded(path6.join(root, rel))).sort();
  if (dirtyFiles.length === 0) return { commitSha: head, dirtyFiles };
  const h = createHash2("sha256");
  for (const rel of dirtyFiles) {
    const abs = path6.join(root, rel);
    h.update(rel).update("\0");
    try {
      const st = statSync5(abs);
      if (!st.isFile()) h.update(`[${st.isDirectory() ? "dir" : "other"}]`);
      else if (st.size > MAX_HASHED_BYTES) h.update(`[${st.size}:${st.mtimeMs}]`);
      else h.update(readFileSync5(abs));
    } catch {
      h.update("[deleted]");
    }
    h.update("\0");
  }
  return { commitSha: `${head}-dirty-${h.digest("hex").slice(0, 12)}`, dirtyFiles };
}

// src/runner/wrap.ts
function statOf(file) {
  try {
    const s = statSync6(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
function shaOf(file) {
  try {
    return createHash3("sha256").update(readFileSync6(file)).digest("hex");
  } catch {
    return null;
  }
}
function snapshotReports(cwd, cfg, previous) {
  const snapshot = /* @__PURE__ */ new Map();
  for (const file of matchGlobs(cwd, cfg.reports)) {
    const stat = statOf(file);
    if (!stat) continue;
    const prev = previous?.get(file);
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && prev.sha !== null) {
      snapshot.set(file, prev);
      continue;
    }
    snapshot.set(file, { ...stat, sha: shaOf(file) });
  }
  return snapshot;
}
function needsShell(command) {
  return command.some((t) => /[<>|&]/.test(t) || isShellOperator(t));
}
function isShellOperator(token) {
  return /^(?:\|\|?|\|&|&&?|;|&>>?|\d*(?:<<?|>>?|>\||<>)(?:&(?:\d+|-))?)$/.test(token);
}
var RUNNER_BINS = /^(?:jest|vitest|mocha|pytest|py\.test|go|npm|npx|yarn|pnpm|bun|bunx)$/;
var RUNNER_WORDS = /^(?:jest|vitest|mocha|pytest|py\.test)$/;
var SCRIPT_HOSTS = /^(?:node|python3?|deno)$/;
function commandBase(token) {
  return token.replace(/^.*[\\/]/, "").toLowerCase().replace(/\.(?:cmd|exe|bat)$/, "");
}
function shellSegments(command) {
  const segments = [];
  let start = 0;
  for (let i = 0; i <= command.length; i++) {
    if (i < command.length && !isControlOperator(command[i])) continue;
    let cmd = start;
    while (cmd < i && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[cmd])) cmd++;
    let end = cmd;
    while (end < i && !isShellOperator(command[end])) end++;
    if (cmd < end) segments.push({ cmd, end });
    start = i + 1;
  }
  return segments;
}
var SHELL_BUILTINS = /* @__PURE__ */ new Set([
  ...[".", ":", "[", "alias", "break", "cd", "command", "continue", "eval", "exec", "exit"],
  ...["export", "false", "getopts", "hash", "pwd", "read", "readonly", "return", "set"],
  ...["shift", "source", "test", "times", "trap", "true", "type", "ulimit", "umask"],
  ...["unalias", "unset", "wait", "echo", "printf", "if", "then", "else", "fi", "for"],
  ...["while", "do", "done", "case", "esac", "!", "{", "}", "(", ")", "call", "copy"],
  ...["del", "dir", "md", "mkdir", "move", "rd", "ren", "rmdir", "setlocal", "type", "ver"]
]);
function commandResolvable(word, cwd, env = process.env, platform = process.platform) {
  if (SHELL_BUILTINS.has(platform === "win32" ? word.toLowerCase() : word)) return true;
  if (/[$`*?~{(]/.test(word)) return true;
  const exts = platform === "win32" ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const isFile = (p) => {
    try {
      return statSync6(p).isFile();
    } catch {
      return false;
    }
  };
  if (/[\\/]/.test(word)) return exts.some((e) => isFile(path7.resolve(cwd, word + e)));
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":");
  if (platform === "win32") dirs.unshift(cwd);
  return dirs.some((d) => d !== "" && exts.some((e) => isFile(path7.join(d, word + e))));
}
function missingCommandWord(command, cwd) {
  for (const seg of shellSegments(command)) {
    const word = command[seg.cmd];
    if (!commandResolvable(word, cwd)) return word;
  }
  return void 0;
}
function runnerSegment(command) {
  const segments = shellSegments(command);
  const words = (seg) => command.slice(seg.cmd, seg.end).map(commandBase);
  return segments.find((seg) => {
    const w = words(seg);
    return RUNNER_BINS.test(w[0]) || w.some((t) => RUNNER_WORDS.test(t));
  }) ?? segments.find((seg) => SCRIPT_HOSTS.test(words(seg)[0])) ?? segments[0] ?? { cmd: 0, end: command.length };
}
function insertRunnerArgs(command, args) {
  if (args.length === 0) return [...command];
  const seg = runnerSegment(command);
  const hasSeparator = command.slice(seg.cmd + 1, seg.end).includes("--");
  const wrapper = isPackageManagerWrapper(command.slice(seg.cmd));
  const separator = wrapper && !hasSeparator ? ["--"] : [];
  return [...command.slice(0, seg.end), ...separator, ...args, ...command.slice(seg.end)];
}
var USE_PROCESS_GROUP = process.platform !== "win32";
var groupLeaders = /* @__PURE__ */ new WeakSet();
function interactiveStdin() {
  return USE_PROCESS_GROUP && process.stdin.isTTY === true;
}
function processTree(pid) {
  const r = spawnSync3("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
    encoding: "utf8",
    timeout: 5e3
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return [pid];
  const children2 = /* @__PURE__ */ new Map();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const [c, p] = [Number(m[1]), Number(m[2])];
    const list = children2.get(p);
    if (list) list.push(c);
    else children2.set(p, [c]);
  }
  const out = [pid];
  for (let i = 0; i < out.length; i++) {
    for (const c of children2.get(out[i]) ?? []) if (!out.includes(c)) out.push(c);
  }
  return out;
}
function signalTree(child2, signal, known = []) {
  if (child2.pid === void 0) return known;
  if (groupLeaders.has(child2)) {
    try {
      process.kill(-child2.pid, signal);
      return known;
    } catch {
    }
  }
  const alive = child2.exitCode === null && child2.signalCode === null;
  const pids = [
    .../* @__PURE__ */ new Set([...alive && USE_PROCESS_GROUP ? processTree(child2.pid) : [], ...known])
  ];
  for (const pid of pids) {
    if (pid === child2.pid) continue;
    try {
      process.kill(pid, signal);
    } catch {
    }
  }
  try {
    child2.kill(signal);
  } catch {
  }
  return pids;
}
function killTree(child2, signal = "SIGTERM") {
  if (child2.pid === void 0) return;
  if (process.platform === "win32") {
    const r = spawnSync3("taskkill", ["/pid", String(child2.pid), "/T", "/F"], { stdio: "ignore" });
    if (r.error || r.status !== 0) child2.kill();
    return;
  }
  const pids = signalTree(child2, signal);
  const escalated = setTimeout(() => signalTree(child2, "SIGKILL", pids), 3e3);
  escalated.unref();
}
function interruptTree(child2, signal) {
  if (signal !== "SIGINT" || groupLeaders.has(child2) || process.platform === "win32") {
    killTree(child2, signal);
    return;
  }
  const grace = setTimeout(() => {
    if (child2.exitCode === null && child2.signalCode === null) killTree(child2, "SIGTERM");
  }, INTERRUPT_GRACE_MS);
  grace.unref();
}
var INTERRUPT_GRACE_MS = 2e3;
var SPAWN_FAILED = -2;
var SHELL_NOT_FOUND = process.platform === "win32" ? 9009 : 127;
function spawnCommand(command, cwd, timeoutSeconds, currentChild, env = process.env) {
  const shellArgv = shellArgvFor(command, cwd);
  return new Promise((resolve) => {
    const done = (code) => {
      if (currentChild.ref) currentChild.ref = null;
      resolve(code);
    };
    let directNotFound = false;
    const start = (argv, useShell2) => {
      let abandoned = false;
      let timedOut = false;
      let child2;
      try {
        const ownGroup = USE_PROCESS_GROUP && !interactiveStdin();
        child2 = spawn(argv[0], argv.slice(1), {
          shell: useShell2,
          cwd,
          env,
          detached: ownGroup,
          stdio: "inherit"
        });
        if (ownGroup) groupLeaders.add(child2);
      } catch (err) {
        if (!useShell2) {
          start(shellArgv, true);
          return;
        }
        console.error(`flakefinder: failed to start command: ${err.message}`);
        done(SPAWN_FAILED);
        return;
      }
      currentChild.ref = child2;
      const timer = timeoutSeconds != null ? setTimeout(() => {
        timedOut = true;
        console.error(
          `flakefinder: attempt timed out after ${timeoutSeconds}s \u2014 killing the process tree`
        );
        killTree(child2);
      }, timeoutSeconds * 1e3) : null;
      const finish = (code) => {
        if (timer) clearTimeout(timer);
        done(timedOut ? 124 : code);
      };
      child2.on("error", (err) => {
        if (!useShell2 && (err.code === "ENOENT" || err.code === "EINVAL")) {
          abandoned = true;
          if (err.code === "ENOENT") directNotFound = true;
          if (timer) clearTimeout(timer);
          start(shellArgv, true);
          return;
        }
        if (err.code === "ENOENT") {
          console.error(
            `flakefinder: command not found: ${argv[0]} \u2014 is it installed and on PATH?`
          );
        } else {
          console.error(`flakefinder: failed to start command: ${err.message}`);
        }
        if (timer) clearTimeout(timer);
        done(SPAWN_FAILED);
      });
      child2.on("close", (code) => {
        if (abandoned) return;
        const missing = useShell2 && code === SHELL_NOT_FOUND && !timedOut ? directNotFound ? command[0] : missingCommandWord(command, cwd) : void 0;
        if (missing !== void 0) {
          if (timer) clearTimeout(timer);
          console.error(
            `flakefinder: command not found: ${missing} \u2014 is it installed and on PATH?`
          );
          done(SPAWN_FAILED);
          return;
        }
        finish(code ?? 1);
      });
    };
    const useShell = needsShell(command);
    start(useShell ? shellArgv : command, useShell);
  });
}
async function runLive(command, cfg, opts) {
  const cwd = path7.resolve(opts.cwd);
  const runId = randomUUID();
  const { commitSha, dirtyFiles } = detectCodeState(cwd, [
    cfg.storeDir,
    cfg.quarantineFile,
    "flakefinder.config.json",
    ...matchGlobs(cwd, cfg.reports)
  ]);
  if (dirtyFiles.length > 0 && commitSha) {
    console.log(
      `flakefinder: working tree has uncommitted changes (${dirtyFiles.length} file(s)) \u2014 recording code state ${commitSha.replace(/^([0-9a-f]{7})[0-9a-f]*/, "$1")}, distinct from HEAD`
    );
  }
  const runner = cfg.runner === "auto" ? detectRunner(cwd) : cfg.runner;
  let quarantineFlags = [];
  let quarantinedNames = [];
  let quarantinedIds = /* @__PURE__ */ new Set();
  let exactDeselect = null;
  if (opts.applyQuarantine) {
    const entries = loadQuarantine(path7.resolve(cwd, cfg.quarantineFile));
    quarantinedIds = new Set(entries.map((e) => e.testId));
    if (runner === "pytest" || runner === "jest" || runner === "mocha") {
      if (entries.length > 0) {
        quarantineFlags = exclusionArgs(runner, entries, cwd);
        if (runner === "pytest") exactDeselect = setUpExactDeselect(quarantineFlags);
        quarantinedNames = entries.map((e) => e.name);
        console.log(
          `flakefinder: quarantine active \u2014 excluding ${entries.length} quarantined test(s) via runner flags`
        );
      }
    } else if (runner === "go" || runner === "generic") {
      if (entries.length > 0) {
        console.log(
          `flakefinder: quarantine has entries but runner "${runner}" has no per-test exclusion \u2014 report only`
        );
      }
    }
  }
  if (cfg.reports.length === 0) {
    console.warn(
      `flakefinder: no report globs configured \u2014 per-test detection disabled. Run ${"`flakefinder init`"} to set up report parsing.`
    );
  }
  const attempts = [];
  const usedReportFiles = /* @__PURE__ */ new Set();
  const exitCodes = [];
  let snapshot = snapshotReports(cwd, cfg);
  const maxAttempts = Math.max(1, opts.retries + 1);
  const currentChild = { ref: null };
  let interrupted = false;
  let warnedSelectorClash = false;
  let notedSelectorMerge = false;
  const onInterrupt = (signal) => {
    interrupted = true;
    if (currentChild.ref) interruptTree(currentChild.ref, signal);
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let extraArgs = quarantineFlags;
      let note = "";
      if (attempt > 1 && cfg.retryMode !== "full") {
        const previous = attempts.filter((r) => r.attempt === attempt - 1);
        const failed = failedNamesOf(previous).filter((n) => !quarantinedNames.includes(n));
        let targeted = failedOnlyArgs(runner, failed, quarantinedNames);
        if (runner === "pytest" && targeted) {
          if (pytestCacheDisabled(command, cwd)) targeted = null;
          else targeted = [...quarantineFlags, ...targeted];
        }
        const targetedChars = targeted ? targeted.reduce((n, a) => n + a.length + 1, 0) : 0;
        if (targeted && targetedChars > SELECTOR_BUDGET_CHARS) {
          note = `full re-run (${failed.length} failures: selector would be ${targetedChars} chars, over the ${SELECTOR_BUDGET_CHARS}-char budget)`;
        } else if (targeted) {
          extraArgs = targeted;
          note = `targeted: re-running ${failed.length} failed test(s)`;
        } else if (failed.length === 0) {
          note = "full re-run (no failures recorded)";
        } else if (runner === "pytest" && pytestCacheDisabled(command, cwd)) {
          note = "full re-run (-p no:cacheprovider disables pytest --lf)";
        } else {
          if (cfg.retryMode === "failed") {
            console.warn(
              `flakefinder: no targeted-rerun adapter for runner "${runner}" \u2014 falling back to a full re-run`
            );
          }
          note = "full re-run (no targeted adapter)";
        }
      }
      const merged = mergeUserSelector(command, extraArgs);
      if (merged.userPatterns.length > 0 && !notedSelectorMerge) {
        notedSelectorMerge = true;
        console.log(
          `flakefinder: combined your own ${extraArgs[0]} filter with flakefinder's selector (both must match)`
        );
      }
      const runCommand = merged.command;
      extraArgs = merged.extraArgs;
      if (!warnedSelectorClash && userSelectorClash(runCommand, extraArgs)) {
        warnedSelectorClash = true;
        console.warn(
          `flakefinder: your command already passes a name selector; flakefinder's injected ${extraArgs[0]} (quarantine exclusion / targeted re-run) is appended after it and most runners keep only the LAST one \u2014 combine them yourself or use --no-quarantine / --retry-mode full`
        );
      }
      const built = insertRunnerArgs(runCommand, extraArgs);
      console.log(
        dim(
          `flakefinder: attempt ${attempt}/${maxAttempts}${note ? ` (${note})` : ""} \u2192 ${truncateForLog(built.join(" "))}`
        )
      );
      let code = await spawnCommand(
        built,
        cwd,
        cfg.timeoutSeconds,
        currentChild,
        exactDeselect?.env
      );
      if (code === SPAWN_FAILED) {
        if (attempt === 1) {
          return {
            attempts: [],
            finalExitCode: 2,
            verdicts: [],
            usedReportFiles: [],
            suiteFlake: false
          };
        }
        code = 1;
        exitCodes.push(code);
        break;
      }
      if (code === 127 || code === 9009) {
        console.error(
          `flakefinder: exit ${code} usually means the command was not found \u2014 check spelling and PATH`
        );
      }
      exitCodes.push(code);
      const after = snapshotReports(cwd, cfg, snapshot);
      for (const [file, stamp] of after) {
        const prev = snapshot.get(file);
        if (prev !== void 0 && prev.mtimeMs === stamp.mtimeMs && prev.size === stamp.size && prev.sha === stamp.sha) {
          continue;
        }
        let content;
        try {
          content = readTextFile(file);
        } catch (err) {
          console.warn(`flakefinder: cannot read report ${file}: ${err.message}`);
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: ${unrecognizedReason(content)} \u2014 skipped ${file}`);
          continue;
        }
        const { results, warnings } = parser.parse(content, file);
        for (const w of warnings) console.warn(`flakefinder: ${parser.name}: ${w}`);
        attempts.push({
          runId,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          source: "live",
          parsedFrom: parser.name,
          attempt,
          commitSha,
          results
        });
        usedReportFiles.add(file);
      }
      snapshot = after;
      if (interrupted) break;
      if (code === 0) break;
    }
  } finally {
    if (exactDeselect) rmSync3(exactDeselect.dir, { recursive: true, force: true });
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
  const store = new HistoryStore(path7.resolve(cwd, cfg.storeDir));
  for (const record of attempts) store.append(record);
  store.prune(cfg.maxRuns);
  const all = classifyAll(store.runs(), cfg);
  const invocationIds = new Set(attempts.flatMap((r) => r.results.map((t) => t.testId)));
  const verdicts = all.filter((v) => invocationIds.has(v.testId));
  const suiteFlake = usedReportFiles.size === 0 && exitCodes.some((c) => c === 0) && exitCodes.some((c) => c !== 0);
  if (suiteFlake) {
    console.warn(
      "flakefinder: no report files matched \u2014 suite-level verdict only (exits varied across attempts)."
    );
  }
  const lastExit = exitCodes[exitCodes.length - 1] ?? 1;
  const lastRealStatus = /* @__PURE__ */ new Map();
  for (const record of [...attempts].sort((a, b) => a.attempt - b.attempt)) {
    for (const t of record.results) if (t.status !== "skip") lastRealStatus.set(t.testId, t.status);
  }
  const gated = verdicts.filter(
    (v) => lastRealStatus.has(v.testId) && !quarantinedIds.has(v.testId)
  );
  const deterministicFail = gated.some((v) => {
    const last = lastRealStatus.get(v.testId);
    return (v.classification === "failing" || v.classification === "new-failure") && (last === "fail" || last === "error");
  });
  let finalExitCode = deterministicFail || lastExit !== 0 ? 1 : 0;
  if (interrupted) finalExitCode = 130;
  if (cfg.failOnFlakes && (gated.some((v) => v.classification.startsWith("flaky-")) || suiteFlake)) {
    finalExitCode = 1;
  }
  return {
    attempts,
    finalExitCode,
    verdicts,
    usedReportFiles: [...usedReportFiles],
    suiteFlake
  };
}
var SELECTOR_ALIASES = {
  "-t": ["-t", "--testNamePattern"],
  "--grep": ["--grep", "-g", "--fgrep", "-f"],
  "-run": ["-run", "--run"]
};
var LITERAL_SELECTORS = /* @__PURE__ */ new Set(["--fgrep", "-f"]);
function mergeUserSelector(command, extraArgs) {
  const unchanged = { command, extraArgs, userPatterns: [] };
  const flag = extraArgs[0];
  const ours = extraArgs[1];
  if (flag !== "-t" && flag !== "--grep" || ours === void 0 || !ours.startsWith("^")) {
    return unchanged;
  }
  const aliases = SELECTOR_ALIASES[flag];
  const { cmd, end } = runnerSegment(command);
  if (flag === "--grep" && command.slice(cmd + 1, end).some((t) => t === "--invert" || t === "-i")) {
    return unchanged;
  }
  const kept = command.slice(0, cmd + 1);
  const userPatterns = [];
  for (let i = cmd + 1; i < end; i++) {
    const t = command[i];
    const alias = aliases.find((a) => t === a || t.startsWith(`${a}=`));
    if (!alias) {
      kept.push(t);
      continue;
    }
    let value;
    if (t === alias) {
      value = command[i + 1];
      if (value === void 0 || i + 1 >= end) {
        kept.push(t);
        continue;
      }
      i++;
    } else {
      value = t.slice(alias.length + 1);
    }
    if (LITERAL_SELECTORS.has(alias)) value = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (flag === "--grep") value = value.replace(/^\/(.*)\/[a-z]*$/s, "$1");
    userPatterns.push(value);
  }
  if (userPatterns.length === 0) return unchanged;
  const lookaheads = userPatterns.map((p) => `(?=[\\s\\S]*?(?:${p}))`).join("");
  return {
    command: [...kept, ...command.slice(end)],
    extraArgs: [flag, `^${lookaheads}${ours.slice(1)}`, ...extraArgs.slice(2)],
    userPatterns
  };
}
function userSelectorClash(command, extraArgs) {
  const aliases = SELECTOR_ALIASES[extraArgs[0] ?? ""];
  if (!aliases) return false;
  const { cmd, end } = runnerSegment(command);
  const segment = command.slice(cmd + 1, end);
  return segment.some((t) => aliases.some((a) => t === a || t.startsWith(`${a}=`)));
}
function loadQuarantine(file) {
  try {
    return new QuarantineManager(file).list();
  } catch (err) {
    console.warn(
      `flakefinder: ${err.message} \u2014 running WITHOUT quarantine exclusions (see \`flakefinder doctor\`)`
    );
    return [];
  }
}
function setUpExactDeselect(flags) {
  const ids = deselectedNodeIds(flags);
  if (ids.length === 0) return null;
  try {
    const dir = mkdtempSync(path7.join(tmpdir(), "flakefinder-pytest-"));
    writeFileSync3(path7.join(dir, `${PYTEST_EXACT_PLUGIN_MODULE}.py`), PYTEST_EXACT_PLUGIN_SOURCE);
    return { env: pytestExactDeselectEnv(ids, dir), dir };
  } catch {
    return null;
  }
}
function argvDisablesCache(tokens) {
  return tokens.some(
    (t, i) => t === "-pno:cacheprovider" || t === "-p=no:cacheprovider" || t === "no:cacheprovider" && tokens[i - 1] === "-p"
  );
}
var PYTEST_CONFIGS = [
  { file: "pytest.ini", section: /^\[pytest\]\s*$/ },
  { file: ".pytest.ini", section: /^\[pytest\]\s*$/ },
  { file: "pyproject.toml", section: /^\[tool\.pytest(?:\.ini_options)?\]\s*$/ },
  { file: "tox.ini", section: /^\[pytest\]\s*$/ },
  { file: "setup.cfg", section: /^\[tool:pytest\]\s*$/ }
];
function pytestSection(text2, header) {
  const lines = text2.split(/\r?\n/);
  const start = lines.findIndex((l) => header.test(l.trim()));
  if (start < 0) return null;
  const body = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\[[^\]]+\]\s*$/.test(l)) break;
    if (/^\s*[#;]/.test(l)) continue;
    body.push(l);
  }
  return body.join("\n");
}
function readIfFile(file) {
  try {
    return statSync6(file).isFile() ? readTextFile(file) : null;
  } catch {
    return null;
  }
}
function sectionDisablesCache(section) {
  return /-p\s*["',\s]*=?\s*["']?no:cacheprovider/.test(section);
}
function pytestCacheDisabled(command, cwd, env = process.env) {
  if (argvDisablesCache(command)) return true;
  if (argvDisablesCache((env.PYTEST_ADDOPTS ?? "").split(/\s+/).filter(Boolean))) return true;
  if (cwd === void 0) return false;
  let explicit;
  command.forEach((t, i) => {
    if ((t === "-c" || t === "--config-file") && command[i + 1]) explicit = command[i + 1];
    else if (t.startsWith("--config-file=")) explicit = t.slice("--config-file=".length);
  });
  if (explicit !== void 0) {
    const text2 = readIfFile(path7.resolve(cwd, explicit));
    if (text2 === null) return false;
    const header = PYTEST_CONFIGS.find((c) => explicit.endsWith(c.file))?.section;
    const section = header ? pytestSection(text2, header) : null;
    return sectionDisablesCache(section ?? text2);
  }
  let dir = path7.resolve(cwd);
  for (; ; ) {
    for (const { file, section: header } of PYTEST_CONFIGS) {
      const text2 = readIfFile(path7.join(dir, file));
      if (text2 === null) continue;
      const section = pytestSection(text2, header);
      if (section !== null) return sectionDisablesCache(section);
      if (file === "pytest.ini" || file === ".pytest.ini") return false;
    }
    const parent = path7.dirname(dir);
    if (parent === dir || existsSync5(path7.join(dir, ".git"))) return false;
    dir = parent;
  }
}
var SELECTOR_BUDGET_CHARS = process.platform === "win32" ? 6e3 : 32768;
function truncateForLog(line, max = 400) {
  return line.length <= max ? line : `${line.slice(0, max)}\u2026 (+${line.length - max} chars)`;
}
function dim(s) {
  return process.stdout.isTTY ? `\x1B[2m${s}\x1B[0m` : s;
}
function isPackageManagerWrapper(command) {
  const first = command[0]?.toLowerCase().replace(/\.(cmd|exe)$/, "");
  return first === "npm" || first === "yarn" || first === "pnpm" || first === "bun";
}
var POSIX_SAFE = /^[A-Za-z0-9_\-+=.,/:@%]+$/;
var CMD_SAFE = /^[A-Za-z0-9_\-+./:@]+$/;
var CMD_META = /([()\][%!^"`<>&|;, *?])/g;
function shellQuote(s, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") {
    if (CMD_SAFE.test(s)) return s;
    let a = s.replace(/(\\*)"/g, '$1$1\\"');
    a = a.replace(/(\\*)$/, "$1$1");
    a = `"${a}"`.replace(CMD_META, "^$1");
    return opts.doubleEscape ? a.replace(CMD_META, "^$1") : a;
  }
  if (POSIX_SAFE.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
function isControlOperator(token) {
  return /^(?:\|\|?|\|&|&&?|;)$/.test(token);
}
function takesRedirectTarget(token) {
  return isShellOperator(token) && !isControlOperator(token) && !/&(?:\d+|-)$/.test(token);
}
function isBatchCommand(cmd, cwd, env = process.env) {
  if (/\.(?:cmd|bat)$/i.test(cmd)) return true;
  if (path7.extname(cmd) !== "") return false;
  const exts = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const hasDir = /[\\/]/.test(cmd);
  const dirs = hasDir ? [""] : [cwd, ...(env.PATH ?? env.Path ?? "").split(";").filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path7.join(dir, cmd + ext) : path7.resolve(cwd, cmd + ext);
      if (existsSync5(candidate)) return /^\.(?:cmd|bat)$/i.test(ext);
    }
  }
  return false;
}
function shellArgvFor(command, cwd, platform = process.platform) {
  if (platform !== "win32") {
    return command.map((t) => isShellOperator(t) ? t : shellQuote(t, { platform }));
  }
  const out = [];
  let expectCommand = true;
  let redirectTarget = false;
  let batch = false;
  for (const t of command) {
    if (isShellOperator(t)) {
      out.push(t);
      if (isControlOperator(t)) expectCommand = true;
      redirectTarget = takesRedirectTarget(t);
      continue;
    }
    if (redirectTarget) {
      out.push(shellQuote(t, { platform }));
      redirectTarget = false;
    } else if (expectCommand) {
      batch = isBatchCommand(t, cwd);
      out.push(t.replace(CMD_META, "^$1"));
      expectCommand = false;
    } else {
      out.push(shellQuote(t, { platform, doubleEscape: batch }));
    }
  }
  return out;
}

// src/util/strict-int.ts
function parseStrictInt(value, min, max) {
  if (!/^-?\d+$/.test(value)) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(n) || n < min || n > max) return null;
  return n;
}

// src/cli/color.ts
function shouldColor(flag, stream, env = process.env) {
  if (!flag) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== void 0 && noColor !== "") return false;
  return stream.isTTY === true;
}

// src/cli/open.ts
import { spawn as spawn2 } from "child_process";
var OPEN_PATH_ENV = "FLAKEFINDER_OPEN_PATH";
function browserCommand(file, platform) {
  const base = { detached: true, stdio: "ignore" };
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/v:off", "/c", `start "" "%${OPEN_PATH_ENV}%"`],
      options: {
        ...base,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: { ...process.env, [OPEN_PATH_ENV]: file }
      }
    };
  }
  if (platform === "darwin") return { command: "open", args: [file], options: base };
  return { command: "xdg-open", args: [file], options: base };
}
function openInBrowser(file, warn = (m) => console.warn(m), platform = process.platform) {
  const { command, args, options } = browserCommand(file, platform);
  const hint = `open ${file} manually`;
  try {
    const child2 = spawn2(command, args, options);
    child2.on("error", (err) => {
      warn(`flakefinder: could not open a browser (${command}: ${err.message}) \u2014 ${hint}`);
    });
    child2.unref();
  } catch (err) {
    warn(`flakefinder: could not open a browser (${err.message}) \u2014 ${hint}`);
  }
}

// src/cli/index.ts
var PROBLEM_ALWAYS = ["flaky-confirmed", "flaky-retry", "failing", "new-failure"];
function resolveCfg(g, overrides = {}) {
  if (g.config) {
    return resolveConfig(readConfigFile(path8.resolve(g.cwd, g.config)), overrides);
  }
  const { config } = loadConfig(g.cwd);
  return resolveConfig(config, overrides);
}
function checkCwd(dir) {
  let isDir = false;
  try {
    isDir = statSync7(dir).isDirectory();
  } catch {
    throw new Error(`--cwd ${dir} does not exist`);
  }
  if (!isDir) throw new Error(`--cwd ${dir} is not a directory`);
}
function gitSha(cwd) {
  const r = spawnSync4("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : void 0;
}
var SHA_RE = /^[0-9a-f]{7,64}$/i;
function ciCommitSha(cwd, env = process.env) {
  for (const key of ["GITHUB_SHA", "CI_COMMIT_SHA"]) {
    const v = env[key]?.trim();
    if (v && SHA_RE.test(v)) return v.toLowerCase();
  }
  return gitSha(cwd);
}
function readSnapshot(file) {
  if (!existsSync6(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync7(file, "utf8"));
  } catch (err) {
    console.warn(
      `flakefinder: ignoring unreadable verdict snapshot ${file} (${err.message}) \u2014 no baseline this run, every current flake counts as new; it is rewritten below`
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      `flakefinder: ignoring verdict snapshot ${file}: expected an array \u2014 no baseline this run, every current flake counts as new; it is rewritten below`
    );
    return null;
  }
  return parsed.filter(
    (v) => typeof v === "object" && v !== null && typeof v.testId === "string" && typeof v.classification === "string"
  );
}
function storeFor(g, cfg) {
  return new HistoryStore(path8.resolve(g.cwd, cfg.storeDir));
}
function printStoreWarnings(store) {
  for (const w of store.warnings) console.warn(`flakefinder: ${w}`);
}
function flagInt(flag, value, min, max, unit = "") {
  const n = parseStrictInt(value, min, max);
  if (n === null) {
    console.error(`flakefinder: ${flag} must be an integer ${min}\u2013${max}${unit} (got ${value})`);
  }
  return n;
}
var RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var RETRIES_MAX = 10;
function filterVerdicts(verdicts, opts, cfg) {
  if (opts.all) return verdicts;
  const threshold = opts.threshold ?? cfg.flakeScoreThreshold;
  return verdicts.filter((v) => {
    if (PROBLEM_ALWAYS.includes(v.classification)) return true;
    if (v.classification === "flaky-suspected") return v.flakeScore >= threshold;
    return false;
  });
}
function defaultReportsFor(runner) {
  switch (runner) {
    case "pytest":
      return ["junit*.xml"];
    case "jest":
      return ["junit.xml", "test-results/junit*.xml"];
    case "mocha":
      return ["test-results/report.json", "mocha-report.json"];
    case "go":
      return ["test-output.jsonl"];
    default:
      return [];
  }
}
function printSetupHints(runner) {
  const hint = {
    auto: '  configure "reports" globs in flakefinder.config.json',
    pytest: `  pytest: ensure reports are written, e.g. in pytest.ini:
    [pytest]
    addopts = --junitxml=junit.xml`,
    jest: `  jest: add the jest-junit reporter (npm i -D jest-junit), jest.config:
    reporters: ['default', ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }]]`,
    mocha: `  mocha: emit JSON reports:
    mocha --reporter json --reporter-options output=test-results/report.json`,
    go: `  go: write the JSON stream to the expected file:
    go test -json ./... > test-output.jsonl`,
    generic: '  configure "reports" globs in flakefinder.config.json'
  };
  console.log(
    `
next step \u2014 make your runner emit machine-readable reports:
${hint[runner] ?? hint.generic}`
  );
}
var esc = escapeControlChars;
function hasCommand(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" || a === "--cwd") {
      i++;
      continue;
    }
    if (a.startsWith("--config=") || a.startsWith("--cwd=") || a === "--no-color") continue;
    return true;
  }
  return false;
}
function ghEscape(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
async function main(argv) {
  let exitCode = 0;
  const program = new Command();
  program.name("flakefinder").description("Detect, track, and quarantine flaky tests \u2014 locally and in CI.").version(FLAKEFINDER_VERSION).option("--config <path>", "explicit path to flakefinder.config.json").option("--cwd <dir>", "working directory (where config/reports live; default: .)").option(
    "--no-color",
    "disable ANSI colors (also off with NO_COLOR or when output is not a terminal)"
  ).exitOverride().hook("preAction", () => {
    checkCwd(globals().cwd);
  });
  const globals = () => {
    const o = program.opts();
    return { config: o.config, cwd: path8.resolve(o.cwd ?? "."), color: o.color !== false };
  };
  program.command("init").description("detect your test runner and create flakefinder.config.json").option("--force", "overwrite an existing config").option(
    "--runner <runner>",
    "explicit runner: pytest|jest|mocha|go|generic (auto = detect, the default)"
  ).action((opts) => {
    const g = globals();
    const RUNNERS = ["auto", "pytest", "jest", "mocha", "go", "generic"];
    if (opts.runner != null && !RUNNERS.includes(opts.runner)) {
      console.error(
        `flakefinder: --runner must be one of ${RUNNERS.join("|")} (got "${opts.runner}")`
      );
      exitCode = 2;
      return;
    }
    const explicit = opts.runner === "auto" ? void 0 : opts.runner;
    const runner = explicit ?? detectRunner(g.cwd);
    if (runner === "generic" && !explicit) {
      console.error(
        "flakefinder: could not detect a test runner \u2014 re-run with --runner <pytest|jest|mocha|go|generic>"
      );
      exitCode = 2;
      return;
    }
    const configPath = path8.join(g.cwd, CONFIG_FILE_NAME);
    if (existsSync6(configPath) && !opts.force) {
      console.error(`flakefinder: ${configPath} already exists (use --force to overwrite)`);
      exitCode = 2;
      return;
    }
    const cfg = { reports: defaultReportsFor(runner), runner };
    writeFileSync4(configPath, `${JSON.stringify(cfg, null, 2)}
`, "utf8");
    console.log(`created ${configPath} (runner: ${runner})`);
    printSetupHints(runner);
  });
  program.command("run").description("run a test command with automatic retry-based flake detection").allowUnknownOption().option("-R, --retries <n>", "extra attempts after the first (default: config.liveRetries)").option("--fail-on-flake", "exit non-zero when flakes (not just failures) are detected").option("--no-quarantine", "run everything, ignoring the quarantine list").option(
    "--retry-mode <mode>",
    "auto (targeted re-runs when possible) | failed (force targeted) | full (always re-run everything)"
  ).option(
    "--timeout <seconds>",
    "kill the attempt after N seconds (default: config timeoutSeconds, itself unlimited)"
  ).argument("<command...>", "the test command, placed after --").action(
    async (command, opts) => {
      const g = globals();
      let retries;
      if (opts.retries != null) {
        const n = flagInt("run -R/--retries", opts.retries, 0, RETRIES_MAX);
        if (n === null) {
          exitCode = 2;
          return;
        }
        retries = n;
      }
      if (opts.retryMode != null && !["auto", "failed", "full"].includes(opts.retryMode)) {
        console.error(
          `flakefinder: --retry-mode must be auto|failed|full (got "${opts.retryMode}")`
        );
        exitCode = 2;
        return;
      }
      const overrides = {};
      if (opts.failOnFlake) overrides.failOnFlakes = true;
      if (retries != null) overrides.liveRetries = retries;
      if (opts.retryMode != null) {
        overrides.retryMode = opts.retryMode;
      }
      if (opts.timeout != null) {
        const seconds = flagInt(
          "run --timeout",
          opts.timeout,
          1,
          TIMEOUT_MAX_SECONDS,
          " (seconds)"
        );
        if (seconds === null) {
          exitCode = 2;
          return;
        }
        overrides.timeoutSeconds = seconds;
      }
      const cfg = resolveCfg(g, overrides);
      const storeWarnings = [];
      const unsubscribe = subscribeStoreWarnings((w) => storeWarnings.push(w));
      let result;
      try {
        result = await runLive(command, cfg, {
          retries: retries ?? cfg.liveRetries,
          cwd: g.cwd,
          applyQuarantine: opts.quarantine !== false
        });
      } finally {
        unsubscribe();
      }
      const printRunStoreWarnings = () => {
        for (const w of new Set(storeWarnings)) console.warn(`flakefinder: ${w}`);
      };
      if (result.finalExitCode === 2 && result.attempts.length === 0) {
        printRunStoreWarnings();
        exitCode = 2;
        return;
      }
      console.log(
        renderTerminal(result.verdicts, {
          color: shouldColor(g.color, process.stdout),
          flakesOnly: false
        })
      );
      printRunStoreWarnings();
      exitCode = result.finalExitCode;
    }
  );
  program.command("ingest").description("parse report files into the history store").argument("[files...]", "report files (omit to use configured globs)").option("--attempt <n>", "attempt number to record", "1").option("--source <source>", "live | report | action", "report").option(
    "--run-id <id>",
    "share a runId across ingests so fail\u2192pass counts as a retry rescue (e.g. per CI job)"
  ).action((files, opts) => {
    const g = globals();
    const attempt = flagInt("ingest --attempt", opts.attempt, 1, 1e6);
    if (attempt === null) {
      exitCode = 2;
      return;
    }
    const cfg = resolveCfg(g);
    if (!["live", "report", "action"].includes(opts.source)) {
      console.error(`flakefinder: --source must be live|report|action (got ${opts.source})`);
      exitCode = 2;
      return;
    }
    const targets = files.length > 0 ? [...new Set(files.map((f) => path8.resolve(g.cwd, f)))] : matchGlobs(g.cwd, cfg.reports);
    if (targets.length === 0) {
      console.error(
        'flakefinder: no report files matched \u2014 pass files explicitly or set "reports" globs (see flakefinder init)'
      );
      exitCode = 2;
      return;
    }
    let runId = randomUUID2();
    if (opts.runId != null) {
      if (!RUN_ID_RE.test(opts.runId)) {
        console.error(
          `flakefinder: --run-id must be 1\u2013128 characters of letters, digits, '.', '_' or '-', starting with a letter or digit \u2014 e.g. a UUID or "$GITHUB_RUN_ID" (got "${escapeControlChars(opts.runId)}")`
        );
        exitCode = 2;
        return;
      }
      runId = opts.runId;
    }
    const store = storeFor(g, cfg);
    let total = 0;
    let used = 0;
    let warnings = 0;
    for (const file of targets) {
      let content;
      try {
        content = readTextFile(file);
      } catch (err) {
        console.warn(`flakefinder: cannot read ${file}: ${err.message}`);
        warnings++;
        continue;
      }
      const parser = detectParser(content);
      if (!parser) {
        console.warn(`flakefinder: ${unrecognizedReason(content)} \u2014 skipped ${file}`);
        warnings++;
        continue;
      }
      const parsed = parser.parse(content, file);
      warnings += parsed.warnings.length;
      for (const w of parsed.warnings) console.warn(`flakefinder: ${w}`);
      const record = {
        runId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        source: opts.source,
        parsedFrom: parser.name,
        attempt,
        commitSha: gitSha(g.cwd),
        results: parsed.results
      };
      store.append(record);
      total += parsed.results.length;
      used++;
    }
    if (used === 0) {
      console.error(
        `flakefinder: none of the ${targets.length} report file(s) could be read and parsed \u2014 nothing ingested`
      );
      exitCode = 2;
      return;
    }
    store.prune(cfg.maxRuns);
    printStoreWarnings(store);
    console.log(
      `ingested ${total} test result(s) from ${used}/${targets.length} file(s) (${warnings} warning(s)) \u2192 ${store.path}`
    );
  });
  program.command("report").description("show flake verdicts from accumulated history").option("--format <fmt>", "table | json | md", "table").option("--flakes-only", "problem classes only").option("--all", "include passing/skipped/gone entries").option("--threshold <n>", "minimum score for suspected flakes", void 0).action((opts) => {
    const g = globals();
    let threshold;
    if (opts.threshold != null) {
      const n = flagInt("report --threshold", opts.threshold, 0, 100);
      if (n === null) {
        exitCode = 2;
        return;
      }
      threshold = n;
    }
    const cfg = resolveCfg(g);
    const store = storeFor(g, cfg);
    const verdicts = classifyAll(store.runs(), cfg);
    printStoreWarnings(store);
    if (opts.format === "json") {
      console.log(renderJson(verdicts, cfg));
      return;
    }
    if (opts.format === "md") {
      console.log(
        renderMarkdown(filterVerdicts(verdicts, { all: opts.all, threshold }, cfg), {
          flakesOnly: !opts.all
        })
      );
      return;
    }
    if (opts.format !== "table") {
      console.error(`flakefinder: unknown format "${opts.format}" (table|json|md)`);
      exitCode = 2;
      return;
    }
    console.log(
      renderTerminal(verdicts, {
        color: shouldColor(g.color, process.stdout),
        flakesOnly: opts.flakesOnly === true,
        allRows: opts.all === true,
        // table and md now agree: threshold gates suspected flakes; --all shows everything
        threshold: opts.all === true ? void 0 : threshold ?? cfg.flakeScoreThreshold
      })
    );
  });
  program.command("html").description("generate the self-contained HTML dashboard").option("-o, --out <file>", "output file", "flakefinder-report.html").option("--open", "open the dashboard in your browser").action((opts) => {
    const g = globals();
    if (opts.out.trim() === "") {
      console.error("flakefinder: html -o/--out needs a file path (got an empty string)");
      exitCode = 2;
      return;
    }
    const cfg = resolveCfg(g);
    const store = storeFor(g, cfg);
    const verdicts = classifyAll(store.runs(), cfg);
    printStoreWarnings(store);
    const runs = store.runs().slice(-50).map((r) => ({
      runId: r.runId,
      timestamp: r.timestamp,
      commitSha: r.commitSha,
      passCount: r.results.filter((t) => t.status === "pass").length,
      failCount: r.results.filter((t) => t.status === "fail" || t.status === "error").length
    }));
    const html = renderDashboard({
      generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
      flakefinderVersion: FLAKEFINDER_VERSION,
      verdicts,
      runs
    });
    const out = path8.resolve(g.cwd, opts.out);
    try {
      mkdirSync2(path8.dirname(out), { recursive: true });
      writeFileSync4(out, html, "utf8");
    } catch (err) {
      const e = err;
      console.error(
        `flakefinder: cannot write the dashboard to ${out}${e.code === "EISDIR" ? " \u2014 it is a directory" : ` (${e.code ?? e.message})`}`
      );
      exitCode = 2;
      return;
    }
    console.log(`dashboard written \u2192 ${out} (${verdicts.length} tests, ${runs.length} runs)`);
    if (opts.open) openInBrowser(out);
  });
  program.command("quarantine").description("manage the quarantine list (tests excluded from runs)").argument("<action>", "list | add | remove | prune").argument("[testId]", "testId for add/remove").option("--reason <text>", "reason recorded with the entry", "flaky").action((action, testId, opts) => {
    const g = globals();
    const cfg = resolveCfg(g);
    const qPath = path8.resolve(g.cwd, cfg.quarantineFile);
    const qm = new QuarantineManager(qPath);
    if (action === "list") {
      const entries = qm.list();
      if (entries.length === 0) {
        console.log("quarantine is empty");
        return;
      }
      console.log(`${entries.length} quarantined test(s):`);
      for (const e of entries) {
        console.log(
          `  ${esc(e.testId)}  ${esc(e.suite)} :: ${esc(e.name)}  (score ${e.flakeScore}, ${esc(String(e.reason))})`
        );
      }
      const runner = cfg.runner === "auto" ? detectRunner(g.cwd) : cfg.runner;
      if (runner === "go" || runner === "generic") {
        console.log(
          `note: runner "${runner}" has no per-test exclusion \u2014 entries are informational only`
        );
      } else {
        console.log(
          `next run will add: ${esc(exclusionArgs(runner, entries).join(" "))}`
        );
      }
      return;
    }
    if (action === "add") {
      if (!testId) {
        console.error("flakefinder: quarantine add requires a testId (see flakefinder report)");
        exitCode = 2;
        return;
      }
      const verdicts = classifyAll(storeFor(g, cfg).runs(), cfg);
      const v = verdicts.find((x) => x.testId === testId);
      if (!v) {
        console.error(
          `flakefinder: testId ${esc(testId)} not in history \u2014 run "flakefinder report --format json" to list testIds`
        );
        exitCode = 1;
        return;
      }
      qm.add({
        testId,
        suite: v.suite,
        name: v.name,
        reason: opts.reason,
        quarantinedAt: (/* @__PURE__ */ new Date()).toISOString(),
        flakeScore: v.flakeScore
      });
      qm.save();
      console.log(
        `quarantined ${esc(v.suite)} :: ${esc(v.name)} (${v.classification}, score ${v.flakeScore})`
      );
      console.log(`quarantine list: ${qPath}`);
      return;
    }
    if (action === "remove") {
      if (!testId) {
        console.error("flakefinder: quarantine remove requires a testId");
        exitCode = 2;
        return;
      }
      if (qm.remove(testId)) {
        qm.save();
        console.log(`removed ${esc(testId)} from quarantine`);
      } else {
        console.error(`flakefinder: ${esc(testId)} is not quarantined`);
        exitCode = 1;
      }
      return;
    }
    if (action === "prune") {
      const verdicts = classifyAll(storeFor(g, cfg).runs(), cfg);
      const removed = qm.prune(verdicts);
      if (removed.length === 0) {
        console.log("nothing to prune");
        return;
      }
      qm.save();
      console.log(`pruned ${removed.length} entr${removed.length === 1 ? "y" : "ies"}:`);
      for (const e of removed) console.log(`  ${esc(e.suite)} :: ${esc(e.name)}`);
      return;
    }
    console.error(
      `flakefinder: unknown quarantine action "${esc(action)}" (list|add|remove|prune)`
    );
    exitCode = 2;
  });
  program.command("ci").description(
    "CI one-shot: ingest configured reports, report, GitHub annotations, snapshot diff"
  ).option(
    "--fail-on-new-flakes",
    "exit 1 when flakes appear that were not flaky in the previous snapshot"
  ).action(async (opts) => {
    const g = globals();
    const cfg = resolveCfg(g);
    const targets = matchGlobs(g.cwd, cfg.reports);
    if (targets.length === 0) {
      console.error(
        'flakefinder ci: no report files matched \u2014 configure "reports" globs (flakefinder init)'
      );
      exitCode = 2;
      return;
    }
    const store = storeFor(g, cfg);
    const runId = randomUUID2();
    const commitSha = ciCommitSha(g.cwd);
    for (const file of targets) {
      let content;
      try {
        content = readTextFile(file);
      } catch (err) {
        console.warn(`flakefinder: cannot read ${file}: ${err.message}`);
        continue;
      }
      const parser = detectParser(content);
      if (!parser) {
        console.warn(`flakefinder: ${unrecognizedReason(content)} \u2014 skipped ${file}`);
        continue;
      }
      const parsed = parser.parse(content, file);
      for (const w of parsed.warnings) console.warn(`flakefinder: ${w}`);
      store.append({
        runId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        source: "action",
        parsedFrom: parser.name,
        attempt: 1,
        commitSha,
        results: parsed.results
      });
    }
    store.prune(cfg.maxRuns);
    const verdicts = classifyAll(store.runs(), cfg);
    printStoreWarnings(store);
    console.log(renderTerminal(verdicts, { color: false, flakesOnly: false }));
    for (const v of verdicts.filter((x) => x.classification.startsWith("flaky-"))) {
      console.log(
        `::warning title=flakefinder::${ghEscape(escapeControlChars(`${redact(v.suite)} :: ${redact(v.name)} (${v.classification}, score ${v.flakeScore})`))}`
      );
    }
    const reportPath = path8.resolve(g.cwd, "flakefinder-report.json");
    writeFileSync4(reportPath, renderJson(verdicts, cfg), "utf8");
    console.log(`json report \u2192 ${reportPath}`);
    const snap = snapshotPath(path8.resolve(g.cwd, cfg.storeDir));
    const previous = readSnapshot(snap);
    const newFlakes = computeNewFlakes(verdicts, previous);
    mkdirSync2(path8.dirname(snap), { recursive: true });
    writeFileSync4(snap, JSON.stringify(verdicts), "utf8");
    const gl = gitlabEnvFromProcess();
    if (gl) {
      try {
        const noteVerdict = await upsertMrNote(gl, buildPrComment(verdicts, previous));
        if (noteVerdict === "unavailable") {
          console.warn(
            "flakefinder: GitLab MR note could not be posted (check GITLAB_TOKEN scope)"
          );
        } else {
          console.log(`gitlab: MR note ${noteVerdict}`);
        }
      } catch (err) {
        console.warn(`flakefinder: GitLab MR note failed: ${err.message}`);
      }
    }
    if (opts.failOnNewFlakes && newFlakes.length > 0) {
      console.error(`flakefinder ci: ${newFlakes.length} NEW flake(s):`);
      for (const v of newFlakes)
        console.error(
          `  ${escapeControlChars(redact(v.suite))} :: ${escapeControlChars(redact(v.name))} (score ${v.flakeScore})`
        );
      exitCode = 1;
    }
  });
  program.command("doctor").description("check the setup: config, runner, reports, history, git, quarantine").action(() => {
    const g = globals();
    const { lines, ok } = runDoctor(g.cwd, { configPath: g.config });
    const tag = { ok: "[ok]  ", warn: "[warn]", fail: "[FAIL]", info: "[info]" };
    const color = shouldColor(g.color, process.stdout);
    for (const line of lines) {
      const code = line.status === "fail" ? "31" : line.status === "warn" ? "33" : null;
      const paint = (s) => color && code ? `\x1B[${code}m${s}\x1B[0m` : s;
      console.log(`${paint(tag[line.status])} ${line.message}`);
      if (line.hint) console.log(`        ${paint("\u2192")} ${line.hint}`);
    }
    console.log(ok ? "" : "doctor: problems found (see FAIL lines above)");
    exitCode = ok ? 0 : 1;
  });
  program.helpCommand(false);
  program.command("help").description("display help for a command (or for flakefinder)").argument("[command]", "the command to describe").action((name) => {
    if (name == null) {
      program.outputHelp();
      return;
    }
    const sub = program.commands.find((c) => c.name() === name || c.aliases().includes(name));
    if (!sub) {
      console.error(
        `flakefinder: unknown command "${escapeControlChars(name)}" \u2014 run "flakefinder help" for the list`
      );
      exitCode = 2;
      return;
    }
    sub.outputHelp();
  });
  program.command("version").description("print the flakefinder version").action(() => {
    console.log(FLAKEFINDER_VERSION);
  });
  if (!hasCommand(argv)) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    const e = err;
    if (e.code === "commander.help" || e.code === "commander.version" || e.code === "commander.helpDisplayed") {
      return 0;
    }
    if (e.code?.startsWith("commander.")) return 2;
    console.error(`flakefinder: ${e.message ?? "unknown error"}`);
    return 2;
  }
  return exitCode;
}
main(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
}).catch((err) => {
  console.error(`flakefinder: ${err.message}`);
  process.exitCode = 2;
});
export {
  main
};
//# sourceMappingURL=cli.js.map