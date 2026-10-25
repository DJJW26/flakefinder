import type {
  Classification,
  Observation,
  ResolvedConfig,
  RunRecord,
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

/** Sort runs chronologically; timestamp first, attempt ascending as tie-break. */
function sortRuns(runs: RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.attempt - b.attempt;
  });
}

/** Build one chronological TestHistory per testId. Suite/name taken from the latest record. */
export function buildHistories(runs: RunRecord[]): TestHistory[] {
  const byId = new Map<string, TestHistory>();
  for (const run of sortRuns(runs)) {
    for (const r of run.results) {
      let h = byId.get(r.testId);
      if (!h) {
        h = { testId: r.testId, suite: r.suite, name: r.name, observations: [] };
        byId.set(r.testId, h);
      }
      h.suite = r.suite;
      h.name = r.name;
      h.observations.push({
        runId: run.runId,
        timestamp: run.timestamp,
        status: r.status,
        attempt: run.attempt,
        commitSha: run.commitSha,
        message: r.message,
        durationMs: r.durationMs ?? undefined,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Collapse non-skip observations to one per (runId, attempt) — the LAST one for
 * that pair wins, since later report lines supersede earlier ones.
 */
function collapsePerAttempt(nonSkip: Observation[]): Observation[] {
  const perAttempt = new Map<string, Observation>();
  for (const o of nonSkip) {
    perAttempt.set(`${o.runId}\u0000${o.attempt}`, o);
  }
  return [...perAttempt.values()];
}

function countSameShaFlips(collapsed: Observation[]): number {
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

function countRetryRescues(collapsed: Observation[]): number {
  let rescues = 0;
  for (let i = 1; i < collapsed.length; i++) {
    const prev = collapsed[i - 1]!;
    const cur = collapsed[i]!;
    if (
      prev.runId === cur.runId &&
      cur.attempt === prev.attempt + 1 &&
      isFail(prev.status) &&
      !isFail(cur.status)
    ) {
      rescues++;
    }
  }
  return rescues;
}

/**
 * Direction changes across DISTINCT code states. A state is a commit bucket;
 * observations without a commitSha (runs outside a git repo) bucket by runId
 * instead, so statistical flip-flop detection still works in SHA-less
 * histories. A bucket's family is its chronologically last observation's.
 */
function countDirectionChanges(collapsed: Observation[]): number {
  const bucketFamily = new Map<string, boolean>();
  for (const o of collapsed) {
    bucketFamily.set(o.commitSha ?? o.runId, isFail(o.status));
  }
  const families = [...bucketFamily.values()];
  let changes = 0;
  for (let i = 1; i < families.length; i++) {
    if (families[i] !== families[i - 1]) changes++;
  }
  return changes;
}

function trailingConsecutiveFails(nonSkip: Observation[]): number {
  let n = 0;
  for (let i = nonSkip.length - 1; i >= 0; i--) {
    if (isFail(nonSkip[i]!.status)) n++;
    else break;
  }
  return n;
}

function recencyMultiplier(lastFail: Observation | undefined): number {
  if (!lastFail) return 0.3;
  const ts = Date.parse(lastFail.timestamp);
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
  lastFail: Observation | undefined;
}): number {
  let score = Math.min(50, opts.sameShaFlips * 50);
  score += Math.min(40, opts.retryRescues * 40);
  score += Math.min(24, opts.directionChanges * 8 * recencyMultiplier(opts.lastFail));
  if (opts.runsObserved >= 10) score += 10;
  return Math.min(100, Math.round(score));
}

function classify(opts: {
  seenRecently: boolean;
  nonSkip: Observation[];
  collapsed: Observation[];
  sameShaFlips: number;
  retryRescues: number;
  directionChanges: number;
  cfg: ResolvedConfig;
}): Classification {
  const { nonSkip, collapsed, cfg } = opts;
  if (!opts.seenRecently) return 'gone';
  if (nonSkip.length === 0) return 'skipped';
  const observed = collapsed; // one observation per (runId, attempt)
  const bothFamilies =
    collapsed.some((o) => isFail(o.status)) && collapsed.some((o) => !isFail(o.status));
  if (opts.sameShaFlips > 0) return 'flaky-confirmed';
  if (opts.retryRescues > 0) return 'flaky-retry';
  if (opts.directionChanges >= 2 && observed.length >= cfg.minRuns && bothFamilies)
    return 'flaky-suspected';
  // "last 5 (up to) observations all fail-family" with enough data
  const lastWindow = observed.slice(-RECENT_WINDOW);
  if (lastWindow.every((o) => isFail(o.status)) && observed.length >= cfg.minRuns) return 'failing';
  const last = observed[observed.length - 1]!;
  if (isFail(last.status)) return 'new-failure';
  return 'passing';
}

function confidenceFor(
  classification: Classification,
  observed: Observation[],
  cfg: ResolvedConfig,
): number {
  const totalFails = observed.filter((o) => isFail(o.status)).length;
  switch (classification) {
    case 'flaky-confirmed':
    case 'flaky-retry':
      return 100;
    case 'flaky-suspected':
      return Math.min(70, Math.round((35 * observed.length) / Math.max(1, cfg.minRuns)));
    case 'failing':
      return Math.min(95, 25 + 5 * trailingConsecutiveFails(observed));
    case 'new-failure':
      return Math.min(50, 10 + 5 * totalFails);
    default:
      return 100;
  }
}

/**
 * Classify every test seen in `runs`. Implements PLAN §5 exactly — the
 * classification precedence, score arithmetic, confidence formulas and tags
 * are contractual; change them only with an update to PLAN.md.
 */
export function classifyAll(runs: RunRecord[], cfg: ResolvedConfig): TestVerdict[] {
  if (runs.length === 0) return [];

  const sorted = sortRuns(runs);
  const recentRunIds = new Set(sorted.slice(-GONE_AFTER_RUNS).map((r) => r.runId));
  const histories = buildHistories(sorted);

  const verdicts: TestVerdict[] = histories.map((h) => {
    const nonSkip = h.observations.filter((o) => o.status !== 'skip');
    const collapsed = collapsePerAttempt(nonSkip);
    const lastObs = h.observations[h.observations.length - 1]!;
    const observed = collapsed; // one observation per (runId, attempt)

    const sameShaFlips = countSameShaFlips(collapsed);
    const retryRescues = countRetryRescues(collapsed);
    const directionChanges = countDirectionChanges(collapsed);
    const seenRecently = h.observations.some((o) => recentRunIds.has(o.runId));
    const bothFamilies =
      collapsed.some((o) => isFail(o.status)) && collapsed.some((o) => !isFail(o.status));

    const classification = classify({
      seenRecently,
      nonSkip,
      collapsed,
      sameShaFlips,
      retryRescues,
      directionChanges,
      cfg,
    });

    const lastFail = [...observed].reverse().find((o) => isFail(o.status));
    const score = bothFamilies
      ? flakeScore({
          sameShaFlips,
          retryRescues,
          directionChanges,
          runsObserved: observed.length,
          lastFail,
        })
      : 0;

    const { medianMs, p95Ms } = durationStats(observed);
    const passes = observed.filter((o) => !isFail(o.status)).length;

    const tags: TestTag[] = [];
    if (!seenRecently) tags.push('long-unseen');
    const firstHalf = observed.slice(0, Math.floor(observed.length / 2));
    const lastWindow = observed.slice(-RECENT_WINDOW);
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
      confidence: confidenceFor(classification, observed, cfg),
      passRate: observed.length === 0 ? 0 : passes / observed.length,
      runsObserved: observed.length,
      lastStatus: lastObs.status,
      lastSeen: lastObs.timestamp,
      lastMessage: lastFail?.message,
      medianDurationMs: medianMs,
      p95DurationMs: p95Ms,
      sameShaFlips,
      retryRescues,
      directionChanges,
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
      v.p95DurationMs > cfg.slowMultiplier * suiteMedianMs;
    if (slowAbsolute || slowRelative) v.tags.push('slow');
  }

  return verdicts;
}
