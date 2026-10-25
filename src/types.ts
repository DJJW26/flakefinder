/**
 * flakefinder — frozen shared contract.
 *
 * Owned by the integrator. All modules code against this file; NEVER edit it
 * without integrator approval. See PLAN.md §4 for the full contract list.
 */

/** Status of a single test case in a single run. `fail` and `error` form the "fail family". */
export type TestStatus = 'pass' | 'fail' | 'skip' | 'error';

/** How a RunRecord entered the store. */
export type RunSource = 'live' | 'report' | 'action';

/** One test case as parsed from a report file or live run. */
export interface TestCaseResult {
  /** Stable identity: makeTestId(suite, name). */
  testId: string;
  /** Suite / file / package the test belongs to (parser-specific, documented in PLAN). */
  suite: string;
  /** Human-readable test name (not including suite). */
  name: string;
  status: TestStatus;
  durationMs: number | null;
  /** Failure message (first line or trimmed excerpt). */
  message?: string;
  /** Stack trace excerpt, if the report carries one. */
  stack?: string;
}

/** One full test-run record persisted in the history store. */
export interface RunRecord {
  /** Shared across retry attempts of the same invocation. */
  runId: string;
  /** ISO 8601. */
  timestamp: string;
  source: RunSource;
  /** Parser name: 'junit' | 'jest' | 'mocha' | 'go' | 'suite' | 'unknown'. */
  parsedFrom: string;
  /** 1-based retry attempt; >1 means a retry of the same code state. */
  attempt: number;
  commitSha?: string;
  branch?: string;
  /** CI run id when running inside CI. */
  ciRunId?: string;
  results: TestCaseResult[];
}

/** A single chronological observation of a test. */
export interface Observation {
  runId: string;
  /** ISO 8601. */
  timestamp: string;
  status: TestStatus;
  attempt: number;
  commitSha?: string;
  message?: string;
  /** Carried from TestCaseResult when available. */
  durationMs?: number;
}

/** All observations for one test, chronological. */
export interface TestHistory {
  testId: string;
  suite: string;
  name: string;
  observations: Observation[];
}

export type Classification =
  | 'flaky-confirmed'
  | 'flaky-retry'
  | 'flaky-suspected'
  | 'failing'
  | 'new-failure'
  | 'passing'
  | 'skipped'
  | 'gone';

export type TestTag = 'slow' | 'recently-fixed' | 'long-unseen';

/** The engine's verdict for one test. Field semantics: PLAN §5. */
export interface TestVerdict {
  testId: string;
  suite: string;
  name: string;
  classification: Classification;
  tags: TestTag[];
  /** 0–100. */
  flakeScore: number;
  /** 0–100. */
  confidence: number;
  /** 0–1 over non-skip observations. */
  passRate: number;
  runsObserved: number;
  lastStatus: TestStatus;
  /** ISO 8601. */
  lastSeen: string;
  lastMessage?: string;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  sameShaFlips: number;
  retryRescues: number;
  directionChanges: number;
}

export type RunnerKind = 'auto' | 'pytest' | 'jest' | 'mocha' | 'go' | 'generic';

/** User-facing config (flakefinder.config.json). All fields optional. */
export interface FlakefinderConfig {
  /** Report file globs relative to cwd (e.g. "junit*.xml", "test-results/*.json"). */
  reports?: string[];
  storeDir?: string;
  maxRuns?: number;
  minRuns?: number;
  liveRetries?: number;
  /** Report inclusion threshold; confirmed/retry flakes always included. */
  flakeScoreThreshold?: number;
  slowThresholdMs?: number | null;
  slowMultiplier?: number;
  quarantineFile?: string;
  runner?: RunnerKind;
  failOnFlakes?: boolean;
}

export type ResolvedConfig = Required<FlakefinderConfig>;

/** A report-format parser. `sniff` must be cheap and side-effect free. */
export interface ReportParser {
  name: string;
  sniff(content: string): boolean;
  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] };
}

export interface QuarantineEntry {
  testId: string;
  suite: string;
  name: string;
  reason: string;
  /** ISO 8601. */
  quarantinedAt: string;
  flakeScore: number;
}

/** One column in the dashboard's runs strip chart. */
export interface DashboardRun {
  runId: string;
  timestamp: string;
  commitSha?: string;
  passCount: number;
  failCount: number;
}

/** Input to renderDashboard. */
export interface DashboardData {
  generatedAt: string;
  flakefinderVersion: string;
  verdicts: TestVerdict[];
  runs: DashboardRun[];
}

export const FLAKEFINDER_VERSION = '0.2.1';
