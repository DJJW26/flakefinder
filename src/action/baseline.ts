import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { snapshotPath } from '../store/history-store.js';
import type { TestVerdict } from '../types.js';
import type { GithubContext } from './github.js';

export const CACHE_KEY_PREFIX = 'flakefinder-history-';

/** What distinguishes one history stream from another within a repository. */
export interface CacheScope {
  /** Working directory relative to the workspace (posix separators). */
  workingDirectory: string;
  /** The `history-key` input — e.g. `${{ matrix.node }}` for matrix legs. */
  historyKey: string;
}

/**
 * Short, stable id of one history stream: job + working directory +
 * history-key. Two flakefinder steps (monorepo packages) or matrix legs
 * with distinct history-keys get separate caches instead of overwriting or
 * inheriting each other's history.
 */
export function cacheLeg(job: string, scope: CacheScope): string {
  return createHash('sha256')
    .update(`${job}\0${scope.workingDirectory}\0${scope.historyKey}`)
    .digest('hex')
    .slice(0, 8);
}

/**
 * Cache keys for the history store.
 *
 * Saves are keyed per stream and run ATTEMPT: cache entries are immutable,
 * so a re-run that reused the first attempt's key could never save, and its
 * history was silently dropped. Restores go by prefix — this stream's most
 * recent entry on this branch (falling back to the base/default branch),
 * then, for a stream's very first run or caches from before 1.2, any
 * flakefinder history (warm start).
 */
export function cacheKeys(
  gh: Pick<GithubContext, 'sha' | 'runId' | 'runAttempt' | 'job'>,
  scope: CacheScope = { workingDirectory: '.', historyKey: '' },
): {
  saveKey: string;
  restoreKeys: string[];
} {
  const leg = cacheLeg(gh.job, scope);
  const parts = [gh.sha, gh.runId, gh.runAttempt].filter((p) => p !== '');
  return {
    saveKey: `${CACHE_KEY_PREFIX}${leg}-${parts.join('-')}`,
    restoreKeys: [`${CACHE_KEY_PREFIX}${leg}-`, CACHE_KEY_PREFIX],
  };
}

/** Where the action records which baseline a workflow run compared against. */
export function baselinePath(storeDir: string): string {
  return path.join(storeDir, 'action-baseline.json');
}

interface BaselineFile {
  runId: string;
  previous: TestVerdict[] | null;
}

export interface Baseline {
  /** Verdicts to diff against for "new flakes" (null = first run). */
  previous: TestVerdict[] | null;
  /** Where `previous` came from — for logs. */
  source: 'snapshot' | 'earlier-attempt' | 'none';
  warnings: string[];
}

function readJson(file: string): { ok: true; value: unknown } | { ok: false } | null {
  if (!existsSync(file)) return null;
  try {
    return { ok: true, value: JSON.parse(readFileSync(file, 'utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Pick the "previous verdicts" baseline for this run (record it with recordBaseline).
 *
 * The restored cache normally holds the snapshot written by an EARLIER
 * workflow run (previous push on this branch, or the base branch) — that is
 * the baseline. But on a re-run (same GITHUB_RUN_ID, higher attempt), or for
 * a second job of the same run, the newest cache was saved by THIS run: its
 * snapshot already contains this run's flakes, so `fail-on-new-flakes`
 * would pass on a simple re-run. Each run therefore records the baseline it
 * used (with its run id) next to the snapshot; when the restored record
 * belongs to the current run, that recorded baseline is reused instead of
 * the snapshot.
 */
export function resolveBaseline(storeDir: string, runId: string): Baseline {
  const warnings: string[] = [];
  let previous: TestVerdict[] | null = null;
  let source: Baseline['source'] = 'none';

  const recorded = readJson(baselinePath(storeDir));
  const rec = recorded?.ok ? (recorded.value as Partial<BaselineFile> | null) : null;
  if (
    runId !== '' &&
    rec !== null &&
    typeof rec === 'object' &&
    rec.runId === runId &&
    (rec.previous === null || Array.isArray(rec.previous))
  ) {
    previous = rec.previous ?? null;
    source = 'earlier-attempt';
  } else {
    const snap = readJson(snapshotPath(storeDir));
    if (snap?.ok && Array.isArray(snap.value)) {
      previous = snap.value as TestVerdict[];
      source = 'snapshot';
    } else if (snap !== null) {
      warnings.push('previous verdict snapshot unreadable — treating this as a first run');
    }
  }
  return { previous, source, warnings };
}

/**
 * Persist the baseline this run compared against, next to the snapshot, so
 * later attempts / jobs of the same run reuse it (see resolveBaseline). Call
 * when writing the fresh snapshot, before the cache is saved.
 */
export function recordBaseline(
  storeDir: string,
  runId: string,
  previous: TestVerdict[] | null,
): void {
  if (runId === '') return;
  mkdirSync(storeDir, { recursive: true });
  const file: BaselineFile = { runId, previous };
  writeFileSync(baselinePath(storeDir), JSON.stringify(file), 'utf8');
}
