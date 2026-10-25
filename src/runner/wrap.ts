import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyAll } from '../engine/classify.js';
import { detectRunner } from '../config.js';
import { detectParser } from '../parsers/index.js';
import { exclusionArgs, QuarantineManager } from '../quarantine/manager.js';
import { HistoryStore } from '../store/history-store.js';
import type { ResolvedConfig, RunRecord, TestVerdict } from '../types.js';
import { matchGlobs } from '../util/glob.js';

export interface LiveRunResult {
  attempts: RunRecord[];
  finalExitCode: number;
  verdicts: TestVerdict[];
  usedReportFiles: string[];
  suiteFlake: boolean;
}

function hashFile(file: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

function snapshotReports(cwd: string, cfg: ResolvedConfig): Map<string, string | null> {
  const snapshot = new Map<string, string | null>();
  for (const file of matchGlobs(cwd, cfg.reports)) snapshot.set(file, hashFile(file));
  return snapshot;
}

function spawnCommand(command: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command[0]!, command.slice(1), { shell: true, cwd, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`flakefinder: failed to start command: ${err.message}`);
      resolve(2);
    });
    child.on('close', (code) => resolve(code ?? 1));
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

  let effectiveCommand = command;
  const runner = cfg.runner === 'auto' ? detectRunner(cwd) : cfg.runner;
  if (opts.applyQuarantine) {
    if (runner === 'pytest' || runner === 'jest' || runner === 'mocha') {
      const qm = new QuarantineManager(path.resolve(cwd, cfg.quarantineFile));
      const entries = qm.list();
      if (entries.length > 0) {
        effectiveCommand = [...command, ...exclusionArgs(runner, entries)];
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

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(dim(`flakefinder: attempt ${attempt}/${maxAttempts} → ${effectiveCommand.join(' ')}`));
    const code = await spawnCommand(effectiveCommand, cwd);
    exitCodes.push(code);

    const after = snapshotReports(cwd, cfg);
    for (const [file, hash] of after) {
      if (snapshot.get(file) === hash) continue;
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
    if (code === 0) break;
  }

  const store = new HistoryStore(path.resolve(cwd, cfg.storeDir));
  for (const record of attempts) store.append(record);
  store.prune(cfg.maxRuns);

  const all = classifyAll(store.runs(), cfg);
  const invocationIds = new Set(attempts.flatMap((r) => r.results.map((t) => t.testId)));
  const verdicts = all.filter((v) => invocationIds.has(v.testId));

  const suiteFlake =
    usedReportFiles.size === 0 &&
    exitCodes.some((c) => c === 0) &&
    exitCodes.some((c) => c !== 0);
  if (suiteFlake) {
    console.warn(
      'flakefinder: no report files matched — suite-level verdict only (exits varied across attempts).',
    );
  }

  const finalAttempt = exitCodes.length;
  const finalAttemptIds = new Set(
    attempts.filter((r) => r.attempt === finalAttempt).flatMap((r) => r.results.map((t) => t.testId)),
  );
  const lastExit = exitCodes[exitCodes.length - 1] ?? 1;
  const deterministicFail = verdicts.some(
    (v) =>
      finalAttemptIds.has(v.testId) &&
      (v.classification === 'failing' || v.classification === 'new-failure') &&
      (v.lastStatus === 'fail' || v.lastStatus === 'error'),
  );
  let finalExitCode = deterministicFail || lastExit !== 0 ? 1 : 0;
  if (cfg.failOnFlakes && verdicts.some((v) => v.classification.startsWith('flaky-'))) {
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
