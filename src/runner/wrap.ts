import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { detectRunner } from '../config.js';
import { classifyAll } from '../engine/classify.js';
import { detectParser } from '../parsers/index.js';
import { exclusionArgs, QuarantineManager } from '../quarantine/manager.js';
import { HistoryStore } from '../store/history-store.js';
import type { ResolvedConfig, RunRecord, TestVerdict } from '../types.js';
import { matchGlobs } from '../util/glob.js';
import { failedNamesOf, failedOnlyArgs } from './adapters.js';

export interface LiveRunResult {
  attempts: RunRecord[];
  finalExitCode: number;
  verdicts: TestVerdict[];
  usedReportFiles: string[];
  suiteFlake: boolean;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  sha: string | null;
}

function statOf(file: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null; // gone
  }
}

function shaOf(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Report-change detection, stat-first: size+mtime identify unchanged files
 * without re-reading them; sha256 runs only when the stat differs. Walking
 * the globs on EVERY attempt is deliberate — that is how newly created
 * report files are caught.
 */
function snapshotReports(
  cwd: string,
  cfg: ResolvedConfig,
  previous?: Map<string, FileStamp>,
): Map<string, FileStamp> {
  const snapshot = new Map<string, FileStamp>();
  for (const file of matchGlobs(cwd, cfg.reports)) {
    const stat = statOf(file);
    if (!stat) continue; // vanished between walk and stat
    const prev = previous?.get(file);
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs && prev.sha !== null) {
      snapshot.set(file, prev); // unchanged: reuse the hash, skip the read
      continue;
    }
    snapshot.set(file, { ...stat, sha: shaOf(file) });
  }
  return snapshot;
}

/** Tokens that only a shell can interpret (redirects, pipes, command chaining). */
function needsShell(command: string[]): boolean {
  return command.some((t) => /[<>|&]/.test(t));
}

/** A token that IS a shell operator (must stay unquoted in shell mode). */
function isShellOperator(token: string): boolean {
  return /^[<>|&\d]+$/.test(token);
}

/**
 * Insert runner args (flag/value pairs) into the command: package-manager
 * wrappers get a `--` separator first, and shell operators split the command
 * into segments — the args must join the RUNNER's segment (the first one),
 * not the last shell word. Injection matches whole operator tokens only, so
 * an argument VALUE like `w1&&w2` is never mistaken for a segment boundary.
 */
function insertRunnerArgs(command: string[], args: string[]): string[] {
  if (args.length === 0) return [...command];
  const separator = isPackageManagerWrapper(command) ? ['--'] : [];
  const opIdx = command.findIndex((t) => isShellOperator(t));
  const insertAt = opIdx === -1 ? command.length : opIdx;
  return [...command.slice(0, insertAt), ...separator, ...args, ...command.slice(insertAt)];
}

/**
 * Spawn the test command. Prefer NO shell (argv passes verbatim — no quoting
 * hazards); fall back to shell mode when the command contains shell operators
 * OR the spawn is refused (Windows blocks .cmd shims like npm/yarn without a
 * shell — EINVAL since the CVE-2024-27980 fix). In shell mode every token is
 * shell-quoted EXCEPT operator tokens — so user values with metacharacters
 * (e.g. `w1&&w2`) and injected regex patterns (with `^!()`) survive cmd.exe.
 */
/** Kill a child and its whole process tree, cross-platform. */
function killTree(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    // child.kill() only reaches the direct process — cmd chains survive it
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
    const escalated = setTimeout(() => child.kill('SIGKILL'), 3000);
    escalated.unref();
  }
}

function spawnCommand(
  command: string[],
  cwd: string,
  timeoutSeconds: number | null,
  currentChild: { ref: ReturnType<typeof spawn> | null },
): Promise<number> {
  const shellArgv = command.map((t) => (isShellOperator(t) ? t : shellQuote(t)));
  return new Promise((resolve) => {
    const done = (code: number): void => {
      if (currentChild.ref) currentChild.ref = null;
      resolve(code);
    };
    const start = (argv: string[], useShell: boolean): void => {
      let abandoned = false; // once we fall back to shell mode, ignore this attempt's events
      let timedOut = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(argv[0]!, argv.slice(1), { shell: useShell, cwd, stdio: 'inherit' });
      } catch (err) {
        // synchronous EINVAL for Windows batch shims without a shell
        if (!useShell) {
          start(shellArgv, true);
          return;
        }
        console.error(`flakefinder: failed to start command: ${(err as Error).message}`);
        done(2);
        return;
      }
      currentChild.ref = child;
      const timer =
        timeoutSeconds != null
          ? setTimeout(() => {
              timedOut = true;
              console.error(
                `flakefinder: attempt timed out after ${timeoutSeconds}s — killing the process tree`,
              );
              killTree(child);
            }, timeoutSeconds * 1000)
          : null;
      const finish = (code: number): void => {
        if (timer) clearTimeout(timer);
        done(timedOut ? 124 : code);
      };
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (!useShell && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
          abandoned = true;
          if (timer) clearTimeout(timer);
          start(shellArgv, true);
          return;
        }
        if (err.code === 'ENOENT') {
          console.error(
            `flakefinder: command not found: ${argv[0]!} — is it installed and on PATH?`,
          );
        } else {
          console.error(`flakefinder: failed to start command: ${err.message}`);
        }
        finish(2);
      });
      child.on('close', (code) => {
        if (abandoned) return; // superseded by the shell fallback
        finish(code ?? 1);
      });
    };
    const useShell = needsShell(command);
    start(useShell ? shellArgv : command, useShell);
  });
}

/**
 * Live flake detection (PLAN §8): run the command, re-run failing attempts up
 * to `retries` extra times, and ingest report files that changed between
 * attempts. Verdicts are restricted to tests observed in THIS invocation while
 * the full history is still persisted.
 */
export async function runLive(
  command: string[],
  cfg: ResolvedConfig,
  opts: { retries: number; cwd: string; applyQuarantine: boolean },
): Promise<LiveRunResult> {
  const cwd = path.resolve(opts.cwd);
  const runId = randomUUID();

  let commitSha: string | undefined;
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (git.status === 0) commitSha = git.stdout.trim();

  const runner = cfg.runner === 'auto' ? detectRunner(cwd) : cfg.runner;
  let quarantineFlags: string[] = [];
  let quarantinedNames: string[] = [];
  if (opts.applyQuarantine) {
    if (runner === 'pytest' || runner === 'jest' || runner === 'mocha') {
      const qm = new QuarantineManager(path.resolve(cwd, cfg.quarantineFile));
      const entries = qm.list();
      if (entries.length > 0) {
        quarantineFlags = exclusionArgs(runner, entries);
        quarantinedNames = entries.map((e) => e.name);
        console.log(
          `flakefinder: quarantine active — excluding ${entries.length} quarantined test(s) via runner flags`,
        );
      }
    } else if (runner === 'go' || runner === 'generic') {
      const qm = new QuarantineManager(path.resolve(cwd, cfg.quarantineFile));
      if (qm.list().length > 0) {
        console.log(
          `flakefinder: quarantine has entries but runner "${runner}" has no per-test exclusion — report only`,
        );
      }
    }
  }

  if (cfg.reports.length === 0) {
    console.warn(
      `flakefinder: no report globs configured — per-test detection disabled. Run ${'`flakefinder init`'} to set up report parsing.`,
    );
  }

  const attempts: RunRecord[] = [];
  const usedReportFiles = new Set<string>();
  const exitCodes: number[] = [];
  let snapshot = snapshotReports(cwd, cfg);
  const maxAttempts = Math.max(1, opts.retries + 1);
  const currentChild: { ref: ReturnType<typeof spawn> | null } = { ref: null };
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    if (currentChild.ref) killTree(currentChild.ref);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Attempt 1 runs the full suite (with quarantine exclusions). Attempts 2+
      // re-run ONLY the failed tests via runner-native selectors when an adapter
      // exists and retryMode allows it — otherwise the full command again.
      let extraArgs = quarantineFlags;
      let note = '';
      if (attempt > 1 && cfg.retryMode !== 'full') {
        const failed = failedNamesOf(attempts).filter((n) => !quarantinedNames.includes(n));
        const targeted = failedOnlyArgs(runner, failed, quarantinedNames);
        if (targeted) {
          extraArgs = targeted;
          note = `targeted: re-running ${failed.length} failed test(s)`;
        } else if (failed.length === 0) {
          note = 'full re-run (no failures recorded)';
        } else {
          if (cfg.retryMode === 'failed') {
            console.warn(
              `flakefinder: no targeted-rerun adapter for runner "${runner}" — falling back to a full re-run`,
            );
          }
          note = 'full re-run (no targeted adapter)';
        }
      }
      const built = insertRunnerArgs(command, extraArgs);
      console.log(
        dim(
          `flakefinder: attempt ${attempt}/${maxAttempts}${note ? ` (${note})` : ''} → ${built.join(' ')}`,
        ),
      );
      const code = await spawnCommand(built, cwd, cfg.timeoutSeconds, currentChild);
      if (code === 127 || code === 9009) {
        console.error(
          `flakefinder: exit ${code} usually means the command was not found — check spelling and PATH`,
        );
      }
      exitCodes.push(code);

      const after = snapshotReports(cwd, cfg, snapshot);
      for (const [file, stamp] of after) {
        if (snapshot.get(file)?.sha === stamp.sha) continue;
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch (err) {
          console.warn(`flakefinder: cannot read report ${file}: ${(err as Error).message}`);
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: unrecognized report format — skipped ${file}`);
          continue;
        }
        const { results, warnings } = parser.parse(content, file);
        for (const w of warnings) console.warn(`flakefinder: ${parser.name}: ${w}`);
        attempts.push({
          runId,
          timestamp: new Date().toISOString(),
          source: 'live',
          parsedFrom: parser.name,
          attempt,
          commitSha,
          results,
        });
        usedReportFiles.add(file);
      }
      snapshot = after;
      if (interrupted) break; // Ctrl-C: stop the retry loop, keep the evidence
      if (code === 0) break;
    }
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }

  const store = new HistoryStore(path.resolve(cwd, cfg.storeDir));
  for (const record of attempts) store.append(record);
  store.prune(cfg.maxRuns);

  const all = classifyAll(store.runs(), cfg);
  const invocationIds = new Set(attempts.flatMap((r) => r.results.map((t) => t.testId)));
  const verdicts = all.filter((v) => invocationIds.has(v.testId));

  const suiteFlake =
    usedReportFiles.size === 0 && exitCodes.some((c) => c === 0) && exitCodes.some((c) => c !== 0);
  if (suiteFlake) {
    console.warn(
      'flakefinder: no report files matched — suite-level verdict only (exits varied across attempts).',
    );
  }

  const lastExit = exitCodes[exitCodes.length - 1] ?? 1;
  // Deterministic failure = the test's LAST observed state (this invocation or
  // history) is fail-family and nothing proved it flaky. The final attempt
  // ingesting nothing (stale or deleted report) must NOT erase the failure
  // evidence: exit 0 is reserved for "clean run or all failures were flakes".
  const deterministicFail = verdicts.some(
    (v) =>
      (v.classification === 'failing' || v.classification === 'new-failure') &&
      (v.lastStatus === 'fail' || v.lastStatus === 'error'),
  );
  let finalExitCode = deterministicFail || lastExit !== 0 ? 1 : 0;
  if (interrupted) finalExitCode = 130; // SIGINT/SIGTERM: convention for user interrupts
  if (
    cfg.failOnFlakes &&
    (verdicts.some((v) => v.classification.startsWith('flaky-')) || suiteFlake)
  ) {
    finalExitCode = 1;
  }

  return {
    attempts,
    finalExitCode,
    verdicts,
    usedReportFiles: [...usedReportFiles],
    suiteFlake,
  };
}

function dim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}

/** Package-manager commands consume flags themselves; only `--` forwards args to the underlying test runner. */
export function isPackageManagerWrapper(command: string[]): boolean {
  const first = command[0]?.toLowerCase().replace(/\.(cmd|exe)$/, '');
  return first === 'npm' || first === 'yarn' || first === 'pnpm' || first === 'bun';
}

/** Quote a single argument for spawn({shell:true}) on the current platform. No-op for safe tokens. */
export function shellQuote(s: string): string {
  if (!/[\s"&|<>^()%!'"\\]/.test(s)) return s;
  if (process.platform === 'win32') {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
