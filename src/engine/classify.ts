import type {
  Classification,
  Observation,
  ResolvedConfig,
  RunRecord,
  TestCaseResult,
  TestHistory,
  TestStatus,
  TestTag,
  TestVerdict,
} from '../types.js';
import { durationStats, median } from './stats.js';

/** A test not seen for this many runs is classified `gone`. */
export const GONE_AFTER_RUNS = 30;
/** Window for "failing" (all recent observations fail) and "recently-fixed" checks. */
export const RECENT_WINDOW = 5;

const FAIL_FAMILY: ReadonlySet<TestStatus> = new Set(['fail', 'error'] as const);

function isFail(status: TestStatus): boolean {
  return FAIL_FAMILY.has(status);
}

/**
 * Order runs chronologically with retry groups kept CONTIGUOUS: all records
 * of one runId stay together, attempts ascending, groups ordered by their
 * earliest timestamp. The naive (timestamp, attempt) sort is wrong — with
 * same-second timestamps across different runIds it interleaves another
 * run's attempt-1 records between a retry pair, silently destroying
 * retryRescue detection.
 */
function sortRuns(runs: RunRecord[]): RunRecord[] {
  const groups = new Map<string, RunRecord[]>();
  for (const r of runs) {
    const g = groups.get(r.runId);
    if (g) g.push(r);
    else groups.set(r.runId, [r]);
  }
  const minTs = (g: RunRecord[]): string => {
    let min = g[0]!.timestamp;
    for (const r of g) if (r.timestamp < min) min = r.timestamp;
    return min;
  };
  const ordered: RunRecord[] = [];
  for (const g of [...groups.values()].sort((a, b) => {
    const am = minTs(a);
    const bm = minTs(b);
    if (am !== bm) return am < bm ? -1 : 1;
    return 0; // simultaneous groups: relative order is not observable
  })) {
    g.sort((a, b) => a.attempt - b.attempt);
    ordered.push(...g);
  }
  return ordered;
}

/**
 * One execution of a test: a live attempt, or one entry of a result's
 * in-report `attempts` (the reporter retried the test itself). `sub` orders
 * in-report attempts within one (runId, attempt); it is 0 for results without
 * `attempts`, so those behave exactly like a single observation.
 */
interface Execution extends Observation {
  sub: number;
}

interface ExecutionHistory {
  testId: string;
  suite: string;
  name: string;
  observations: Execution[];
}

const STATUSES: ReadonlySet<string> = new Set(['pass', 'fail', 'skip', 'error']);

/**
 * The executions a result stands for, oldest first. In-report retries
 * (`attempts`, PLAN §5) expand into one execution each; the final one is
 * always the result's `status` (appended if a parser left it out). Results
 * without (meaningful) attempts are a single execution.
 */
function executionStatuses(r: TestCaseResult): TestStatus[] {
  if (!Array.isArray(r.attempts)) return [r.status];
  const statuses = r.attempts.filter((s): s is TestStatus => STATUSES.has(s as string));
  if (statuses[statuses.length - 1] !== r.status) statuses.push(r.status);
  return statuses.length < 2 ? [r.status] : statuses;
}

function collectHistories(sortedRuns: RunRecord[]): ExecutionHistory[] {
  const byId = new Map<string, ExecutionHistory>();
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
          durationMs: sub === statuses.length - 1 ? (r.durationMs ?? undefined) : undefined,
        });
      });
    }
  }
  return [...byId.values()];
}

/**
 * Build one chronological TestHistory per testId. Suite/name taken from the
 * latest record. A result's in-report `attempts` become one observation each
 * (same runId and attempt, oldest first).
 */
export function buildHistories(runs: RunRecord[]): TestHistory[] {
  return collectHistories(sortRuns(runs)).map((h) => ({
    ...h,
    observations: h.observations.map(({ sub: _sub, ...o }) => o),
  }));
}

/**
 * Collapse non-skip executions to one per (runId, attempt, in-report attempt)
 * — the LAST one for that key wins, since later report lines supersede
 * earlier ones.
 */
function collapsePerAttempt(nonSkip: Execution[]): Execution[] {
  const perAttempt = new Map<string, Execution>();
  for (const o of nonSkip) {
    perAttempt.set(`${o.runId}\u0000${o.attempt}\u0000${o.sub}`, o);
  }
  return [...perAttempt.values()];
}

/**
 * One observation per RUN (invocation / runId): its final execution. Retry
 * attempts of one invocation are evidence for rescues and same-SHA flips, but
 * they are not independent runs — `runsObserved`, `minRuns`, the `failing`
 * window and the data bonus count runs (PLAN §5).
 */
function collapsePerRun(collapsed: Execution[]): Execution[] {
  const perRun = new Map<string, Execution>();
  for (const o of collapsed) perRun.set(o.runId, o); // groups are contiguous, attempts ascending
  return [...perRun.values()];
}

function countSameShaFlips(collapsed: Execution[]): number {
  const perSha = new Map<string, { hasPass: boolean; hasFail: boolean }>();
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

/**
 * Fail → pass between two CONSECUTIVE executions of one invocation: live
 * attempt k → k+1, or in-report attempt i → i+1 within one result. Both are
 * re-runs of the same code state.
 */
function countRetryRescues(collapsed: Execution[]): number {
  let rescues = 0;
  for (let i = 1; i < collapsed.length; i++) {
    const prev = collapsed[i - 1]!;
    const cur = collapsed[i]!;
    const consecutive =
      (cur.attempt === prev.attempt && cur.sub === prev.sub + 1) ||
      (cur.attempt === prev.attempt + 1 && cur.sub === 0);
    if (prev.runId === cur.runId && consecutive && isFail(prev.status) && !isFail(cur.status)) {
      rescues++;
    }
  }
  return rescues;
}

/**
 * Direction changes across code states, in chronological order. A state is a
 * commitSha; observations without one (runs outside a git repo) use their
 * runId instead, so SHA-less histories still get flip-flop detection while a
 * run's own retry attempts stay one state. Consecutive observations of the
 * same state form one VISIT whose family is its latest observation's;
 * returning to an earlier commit (a revert, A→B→A) is a new visit. Changes
 * are counted between consecutive visits. `lastChangeAt` is when the newest
 * change's family was first seen in its visit (the recency anchor).
 */
function directionChanges(collapsed: Execution[]): {
  changes: number;
  lastChangeAt: string | undefined;
} {
  const visits: Array<{ state: string; fail: boolean; since: string }> = [];
  for (const o of collapsed) {
    const state = o.commitSha !== undefined ? `sha:${o.commitSha}` : `run:${o.runId}`;
    const fail = isFail(o.status);
    const last = visits[visits.length - 1];
    if (!last || last.state !== state) visits.push({ state, fail, since: o.timestamp });
    else if (last.fail !== fail) {
      last.fail = fail;
      last.since = o.timestamp;
    }
  }
  let changes = 0;
  let lastChangeAt: string | undefined;
  for (let i = 1; i < visits.length; i++) {
    if (visits[i]!.fail !== visits[i - 1]!.fail) {
      changes++;
      lastChangeAt = visits[i]!.since;
    }
  }
  return { changes, lastChangeAt };
}

function trailingConsecutiveFails(perRun: Observation[]): number {
  let n = 0;
  for (let i = perRun.length - 1; i >= 0; i--) {
    if (isFail(perRun[i]!.status)) n++;
    else break;
  }
  return n;
}

/** Keyed on the most recent direction change (flip), not the last failure. */
function recencyMultiplier(lastChangeAt: string | undefined): number {
  if (lastChangeAt === undefined) return 0.3;
  const ts = Date.parse(lastChangeAt);
  if (Number.isNaN(ts)) return 1.0; // unparseable timestamp: don't punish the score
  const ageDays = (Date.now() - ts) / 86_400_000;
  if (ageDays <= 14) return 1.0;
  if (ageDays <= 30) return 0.6;
  return 0.3;
}

function flakeScore(opts: {
  sameShaFlips: number;
  retryRescues: number;
  directionChanges: number;
  runsObserved: number;
  lastChangeAt: string | undefined;
}): number {
  let score = Math.min(50, opts.sameShaFlips * 50);
  score += Math.min(40, opts.retryRescues * 40);
  score += Math.min(24, opts.directionChanges * 8 * recencyMultiplier(opts.lastChangeAt));
  if (opts.runsObserved >= 10) score += 10;
  return Math.min(100, Math.round(score));
}

function classify(opts: {
  seenRecently: boolean;
  perRun: Observation[];
  bothFamilies: boolean;
  sameShaFlips: number;
  retryRescues: number;
  directionChanges: number;
  cfg: ResolvedConfig;
}): Classification {
  const { perRun, cfg } = opts;
  if (!opts.seenRecently) return 'gone';
  if (perRun.length === 0) return 'skipped';
  if (opts.sameShaFlips > 0) return 'flaky-confirmed';
  if (opts.retryRescues > 0) return 'flaky-retry';
  if (opts.directionChanges >= 2 && perRun.length >= cfg.minRuns && opts.bothFamilies)
    return 'flaky-suspected';
  // the last (up to) 5 RUNS all ended fail-family, with enough runs observed
  const lastWindow = perRun.slice(-RECENT_WINDOW);
  if (lastWindow.every((o) => isFail(o.status)) && perRun.length >= cfg.minRuns) return 'failing';
  const last = perRun[perRun.length - 1]!;
  if (isFail(last.status)) return 'new-failure';
  return 'passing';
}

function confidenceFor(
  classification: Classification,
  perRun: Observation[],
  executions: Observation[],
  cfg: ResolvedConfig,
): number {
  switch (classification) {
    case 'flaky-confirmed':
    case 'flaky-retry':
      return 100;
    case 'flaky-suspected':
      return Math.min(70, Math.round((35 * perRun.length) / Math.max(1, cfg.minRuns)));
    case 'failing':
      return Math.min(95, 25 + 5 * trailingConsecutiveFails(perRun));
    case 'new-failure':
      // every failed execution, retries included, is evidence of the failure
      return Math.min(50, 10 + 5 * executions.filter((o) => isFail(o.status)).length);
    default:
      return 100;
  }
}

/**
 * Relative `slow` needs a p95 of at least this many ms: suites of sub-ms
 * tests have a 0 ms median, which would make every 1 ms test "slow".
 */
export const SLOW_RELATIVE_FLOOR_MS = 100;

/**
 * Classify every test seen in `runs`. Implements PLAN §5 exactly — the
 * classification precedence, score arithmetic, confidence formulas and tags
 * are contractual; change them only with an update to PLAN.md.
 */
export function classifyAll(runs: RunRecord[], cfg: ResolvedConfig): TestVerdict[] {
  if (runs.length === 0) return [];

  const sorted = sortRuns(runs);
  // "last 30 RUNS", not records: one run can carry many records (one per
  // report file, one per retry attempt). sortRuns keeps each runId's records
  // contiguous, so collapsing adjacent duplicates yields runs in order.
  const runOrder: string[] = [];
  for (const r of sorted) if (runOrder[runOrder.length - 1] !== r.runId) runOrder.push(r.runId);
  const recentRunIds = new Set(runOrder.slice(-GONE_AFTER_RUNS));
  const histories = collectHistories(sorted);

  const verdicts: TestVerdict[] = histories.map((h) => {
    const nonSkip = h.observations.filter((o) => o.status !== 'skip');
    // executions: one per (runId, attempt, in-report attempt) — retry evidence
    const collapsed = collapsePerAttempt(nonSkip);
    // runs: one per invocation (its final execution) — run counts and windows
    const perRun = collapsePerRun(collapsed);
    const lastObs = h.observations[h.observations.length - 1]!;

    const sameShaFlips = countSameShaFlips(collapsed);
    const retryRescues = countRetryRescues(collapsed);
    const dc = directionChanges(collapsed);
    const seenRecently = h.observations.some((o) => recentRunIds.has(o.runId));
    const bothFamilies =
      collapsed.some((o) => isFail(o.status)) && collapsed.some((o) => !isFail(o.status));

    const classification = classify({
      seenRecently,
      perRun,
      bothFamilies,
      sameShaFlips,
      retryRescues,
      directionChanges: dc.changes,
      cfg,
    });

    const lastFail = [...collapsed].reverse().find((o) => isFail(o.status));
    const score = bothFamilies
      ? flakeScore({
          sameShaFlips,
          retryRescues,
          directionChanges: dc.changes,
          runsObserved: perRun.length,
          lastChangeAt: dc.lastChangeAt,
        })
      : 0;

    const { medianMs, p95Ms } = durationStats(collapsed);
    const passes = collapsed.filter((o) => !isFail(o.status)).length;

    const tags: TestTag[] = [];
    if (!seenRecently) tags.push('long-unseen');
    const firstHalf = perRun.slice(0, Math.floor(perRun.length / 2));
    const lastWindow = perRun.slice(-RECENT_WINDOW);
    if (
      firstHalf.some((o) => isFail(o.status)) &&
      lastWindow.length > 0 &&
      lastWindow.every((o) => !isFail(o.status))
    ) {
      tags.push('recently-fixed');
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
      directionChanges: dc.changes,
    } satisfies TestVerdict;
  });

  // Slow tag needs suite-level context: median of per-test medians within each suite.
  const perSuite = new Map<string, number[]>();
  for (const v of verdicts) {
    if (v.medianDurationMs != null) {
      const list = perSuite.get(v.suite) ?? [];
      list.push(v.medianDurationMs);
      perSuite.set(v.suite, list);
    }
  }
  const suiteMedians = new Map<string, number>();
  for (const [suite, values] of perSuite) {
    const m = median(values);
    if (m != null) suiteMedians.set(suite, m);
  }
  for (const v of verdicts) {
    const suiteMedianMs = suiteMedians.get(v.suite);
    const slowAbsolute =
      v.medianDurationMs != null &&
      cfg.slowThresholdMs != null &&
      v.medianDurationMs > cfg.slowThresholdMs;
    const slowRelative =
      v.p95DurationMs != null &&
      suiteMedianMs != null &&
      v.p95DurationMs >= SLOW_RELATIVE_FLOOR_MS &&
      v.p95DurationMs > cfg.slowMultiplier * suiteMedianMs;
    if (slowAbsolute || slowRelative) v.tags.push('slow');
  }

  return verdicts;
}
