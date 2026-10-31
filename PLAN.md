# flakefinder — Build Plan (frozen contract v1)

> **flakefinder** detects, tracks, and quarantines flaky tests — from your terminal and from CI.
> One npm package (`flakefinder`) that is also a GitHub Action. TypeScript, ESM, Node >= 18.

This document is the **single source of truth** for all agents/workers. Interfaces in §4 are
**frozen**: code against them exactly; if you believe a contract must change, do NOT edit this
file or `src/types.ts` — note the deviation in your final report instead and the integrator decides.

---

## 1. Mission

A daily programmer should be able to, in under 5 minutes:

1. `npx flakefinder init` in a repo → get a config that matches their test runner.
2. `npx flakefinder run -- npm test` → immediately learn **which failing tests are flakes**
   (via automatic retries) and which are real failures — with different exit codes.
3. Over weeks of CI runs, accumulate history and get **flake scores, trend reports, an HTML
   dashboard, PR comments, and one-command quarantine** of the worst offenders.

Honest, deterministic, zero cloud. No telemetry. Two runtime dependencies (`commander`,
`fast-xml-parser`) bundled into a single-file CLI.

## 2. Non-goals (v1)

- No LLM/AI features, no network calls, no accounts, no daemons/servers.
- No test-framework plugins beyond report-file parsing.
- No GitLab/CircleCI native integrations (the `ci` command emits GitHub-compatible `::`
  annotations which many CI systems understand; native GitLab is v1.1).
- No per-test targeted re-runs (v1 re-runs the full command; targeted reruns are v1.1).

## 3. Repository layout

```
/
├── PLAN.md                  # this file (frozen)
├── TASKS.md                 # ordered task checklist w/ ownership + status (integrator-maintained)
├── package.json             # name: flakefinder, bin: flakefinder → dist/cli.js
├── tsconfig.json            # strict, NodeNext, noEmit (typecheck only; tsup builds)
├── tsup.config.ts           # bundles dist/cli.js and dist/action/index.cjs
├── vitest.config.ts
├── biome.json
├── action.yml               # GitHub Action definition (repo root)
├── src/
│   ├── types.ts             # FROZEN shared contract (integrator-owned)
│   ├── util/
│   │   └── test-id.ts       # makeTestId — FROZEN (integrator-owned)
│   ├── config.ts            # config load/resolve (Agent C)
│   ├── parsers/             # junit, jest, mocha, gotest + detect (Agent P)
│   ├── store/
│   │   └── history-store.ts # JSONL append-only store (Agent E)
│   ├── engine/
│   │   ├── stats.ts         # median/p95/duration helpers (Agent E)
│   │   └── classify.ts      # histories → verdicts (Agent E)
│   ├── runner/
│   │   └── wrap.ts          # `run` live execution + retry detection (Agent C)
│   ├── quarantine/
│   │   └── manager.ts       # quarantine file + exclusion args (Agent C)
│   ├── report/
│   │   ├── terminal.ts      # colored table (Agent C)
│   │   ├── json.ts          # machine JSON (Agent C)
│   │   ├── markdown.ts      # md render + PR comment (Agent A)
│   │   └── html.ts          # self-contained dashboard (Agent D)
│   ├── cli/
│   │   └── index.ts         # commander CLI, all commands (Agent C)
│   └── action/
│       └── index.ts         # GitHub Action entry (Agent A)
├── .github/workflows/ci.yml # repo's own CI (Agent A)
├── docs/
│   ├── github-action.md     # action usage docs (Agent A)
│   ├── USAGE.md             # full user guide (Agent F draft → integrator final)
│   └── BUILD_REPORT.md      # post-build engineering report (integrator)
├── fixtures/                # real sample projects for e2e (Agent F)
│   ├── jest-project/
│   ├── pytest-project/
│   └── go-project/
├── tests/
│   └── parsers-fixtures/    # static report-file corpus (Agent P)
└── scripts/
    ├── clean-dist.mjs       # integrator
    └── e2e.mjs              # end-to-end harness (Agent F)
```

## 4. Frozen contracts

`src/types.ts` (integrator-owned, already written — read it, import it, never edit it):

- `TestStatus` = `'pass' | 'fail' | 'skip' | 'error'` (fail and error are the "fail family")
- `TestCaseResult`, `RunRecord`, `Observation`, `TestHistory`, `Classification`, `TestTag`,
  `TestVerdict`, `FlakefinderConfig`, `ResolvedConfig`, `ReportParser`, `QuarantineEntry`,
  `DashboardData`, `DashboardRun`

Module export signatures (agents implement; stubs already exist at these paths):

```ts
// src/util/test-id.ts  (FROZEN, implemented)
makeTestId(suite: string, name: string): string

// src/config.ts  (Agent C)
defaultConfig(): FlakefinderConfig
loadConfig(cwd: string): { config: FlakefinderConfig; path: string | null }  // flakefinder.config.json w/ JSONC support
resolveConfig(config: FlakefinderConfig, overrides?: Partial<FlakefinderConfig>): ResolvedConfig

// src/parsers/*  (Agent P)
junitParser: ReportParser; jestParser: ReportParser; mochaParser: ReportParser; goTestParser: ReportParser
parsers: ReportParser[]
detectParser(content: string): ReportParser | null

// src/store/history-store.ts  (Agent E)
class HistoryStore {
  constructor(storeDir: string)
  readonly path: string            // <storeDir>/history.jsonl
  formatVersion: number | null     // schema header version; null = legacy header-less file
  append(run: RunRecord): void     // fs append + in-memory; writes {"version":1} header when creating the file
  loadAll(): RunRecord[]           // tolerant of corrupt lines (skips them)
  runs(): RunRecord[]              // in-memory, chronological
  prune(maxRuns: number): void     // keep last N, atomic rewrite (tmp+rename); preserves/inserts header
}
// v0.2.0+: the file starts with a {"version":1} header line; readers tolerate
// legacy header-less stores and treat the header as a schema marker, not a record.
snapshotPath(storeDir: string): string  // <storeDir>/verdicts-snapshot.json

// src/engine/stats.ts  (Agent E)
median(values: number[]): number | null
p95(values: number[]): number | null          // nearest-rank
durationStats(obs: Observation[]): { medianMs: number | null; p95Ms: number | null }

// src/engine/classify.ts  (Agent E)
buildHistories(runs: RunRecord[]): TestHistory[]
classifyAll(runs: RunRecord[], cfg: ResolvedConfig): TestVerdict[]   // all tests ever seen, any order

// src/runner/wrap.ts  (Agent C)
interface LiveRunResult { attempts: RunRecord[]; finalExitCode: number; verdicts: TestVerdict[]; usedReportFiles: string[]; suiteFlake: boolean }
runLive(command: string[], cfg: ResolvedConfig, opts: { retries: number; cwd: string; applyQuarantine: boolean }): Promise<LiveRunResult>

// src/quarantine/manager.ts  (Agent C)
class QuarantineManager {
  constructor(filePath: string)
  list(): QuarantineEntry[]
  add(entry: QuarantineEntry): void
  remove(testId: string): boolean
  prune(verdicts: TestVerdict[], unseenRunCount?: number): QuarantineEntry[]
  save(): void
}
exclusionArgs(runner: 'pytest'|'jest'|'mocha'|'go'|'generic', entries: QuarantineEntry[]): string[]

// src/report/terminal.ts  (Agent C)
renderTerminal(verdicts: TestVerdict[], opts: { color: boolean; flakesOnly: boolean }): string

// src/report/json.ts  (Agent C)
renderJson(verdicts: TestVerdict[], cfg: ResolvedConfig): string

// src/report/markdown.ts  (Agent A)
renderMarkdown(verdicts: TestVerdict[], opts: { flakesOnly: boolean }): string
buildPrComment(verdicts: TestVerdict[], previous: TestVerdict[] | null): string  // includes marker '<!-- flakefinder:report -->'

// src/report/html.ts  (Agent D)
renderDashboard(data: DashboardData): string   // single self-contained HTML file content

// src/action/index.ts  (Agent A)  — entry, wires real services into runAction() (src/action/main.ts); bundled to dist/action/index.cjs
// src/cli/index.ts  (Agent C)    — entry; commander program; bin banner shebang added by tsup
```

## 5. Detection algorithm (Agent E implements EXACTLY this)

Given chronological `Observation[]` per test (from `RunRecord`s grouped by `runId`, groups
ordered by their earliest timestamp, attempts ascending within a group):

- **fail family** = status `fail` or `error`. Skips are excluded from flake math.
- **Executions vs runs.** An *execution* is one (`runId`, `attempt`, in-report attempt) — a
  live retry attempt, or one entry of a result's in-report `attempts` (the reporter retried
  the test itself: jest/vitest/mocha retries, Surefire reruns, go `-count`, …). A result
  with `attempts` expands into one execution per entry, oldest first; its final entry is
  always the result's `status`. Results without `attempts` are one execution, as before.
  A *run* is one invocation = one `runId`; its outcome is its final non-skip execution.
  Retry attempts are evidence for `sameShaFlips` / `retryRescues`, but are NOT extra runs:
  `runsObserved`, `cfg.minRuns`, the 5-run `failing` / `recently-fixed` windows and the
  `+10` data bonus all count **runs** (one `-R 2` invocation that fails 3 times is 1 run →
  `new-failure`, never `failing`). `passRate` = pass-family executions / all non-skip
  executions (a rescued F,P run reads 50%).
- `sameShaFlips`: count of distinct `commitSha` values whose executions include BOTH families.
- `retryRescues`: count of consecutive execution pairs with the SAME `runId` where the first
  is fail-family and the next is pass-family. Consecutive = live attempt k → k+1 (last
  in-report attempt of k → first of k+1), or in-report attempt i → i+1 within one result.
  An in-report retry-then-pass therefore scores exactly like a live retry rescue.
- `directionChanges`: walk executions chronologically. A code state is the `commitSha`;
  executions WITHOUT a commitSha (no git repo) use their `runId`, so SHA-less histories
  still get statistical flip-flop detection while a run's own retries stay one state.
  Consecutive executions of the same state form one **visit** whose family is the latest
  family seen in it. `directionChanges` = number of family changes between consecutive
  visits. Returning to an earlier commit is a NEW visit: a revert A(pass) → B(fail) →
  A(pass) counts 2 changes (→ `flaky-suspected` at `minRuns` 3), as does alternating
  between branches whose commits differ in outcome.
- The time of a direction change is when the new family was first seen in that visit; the
  **most recent flip** is the time of the latest direction change.
- **Dirty working trees** (`run` only): a run with uncommitted changes to tracked files
  (ignoring flakefinder's store, quarantine, config and report files) is recorded with
  `commitSha = "<HEAD sha>-dirty-<hash>"` (hash over the changed tracked files' paths and
  contents; untracked files ignored), a code state distinct from HEAD — so a local,
  uncommitted fix of a real failure is a direction change, never a same-SHA flip, while
  re-running identical edits is still the same state.

Classification precedence (first match wins):

| # | Classification | Condition |
|---|---|---|
| 1 | `gone` | seen historically but absent from the last 30 runs |
| 2 | `skipped` | every observation is `skip` |
| 3 | `flaky-confirmed` | `sameShaFlips > 0` |
| 4 | `flaky-retry` | `retryRescues > 0` |
| 5 | `flaky-suspected` | `directionChanges >= 2` AND `runsObserved >= cfg.minRuns` AND both families seen |
| 6 | `failing` | last 5 runs all ended fail-family AND `runsObserved >= cfg.minRuns` |
| 7 | `new-failure` | last run ended fail-family (insufficient data for the above) |
| 8 | `passing` | everything else (pass-family + skips) |

`flakeScore` 0–100 (only computed when both families have been seen; else 0):

```
+ 50 per sameShaFlips                          (cap 50)
+ 40 per retryRescue                           (cap 40)
+ min(24, 8 × directionChanges × recencyMultiplier)   (cap applied AFTER the multiplier)
+ 10 if runsObserved >= 10                             (runs, not attempts)
recencyMultiplier = 1.0 if the most recent flip (latest direction change) ≤ 14 days ago
                  | 0.6 if ≤ 30 days
                  | 0.3 otherwise
                  (keyed on the flip, NOT the last failure: F,P,F 60 days ago then a
                   P yesterday on a new commit → 3 × 8 × 1.0 = 24)
final = min(100, round(sum))
```

`confidence` 0–100:

```
flaky-confirmed | flaky-retry → 100
flaky-suspected            → min(70, round(35 × runsObserved / cfg.minRuns))
failing                    → min(95, 25 + 5 × consecutive trailing failed RUNS)
new-failure                → min(50, 10 + 5 × total fail-family EXECUTIONS)
passing | skipped | gone   → 100
```

Tags:

- `slow`: `medianMs > cfg.slowThresholdMs` OR (`p95Ms > cfg.slowMultiplier × suiteMedianMs`
  AND `p95Ms >= 100`, where suiteMedianMs = median of all per-test medians in the same
  suite; the 100 ms floor keeps 1 ms tests in a 0 ms-median suite from being "slow").
  Durations are per execution; an expanded in-report attempt carries no duration except
  the final one.
- `recently-fixed`: any run in the first half of the test's runs ended fail-family AND the
  last 5 runs all ended pass-family.
- `long-unseen`: not observed in the last 30 runs (co-occurs with `gone`).

## 6. Config spec

`flakefinder.config.json` (JSONC allowed) at repo root (discovered from `--cwd`, walk up max 3 levels):

| field | default | meaning |
|---|---|---|
| `reports` | `[]` | globs (fast-glob syntax via simple `glob`-match we implement with `node:fs` + tiny matcher; see note) |
| `storeDir` | `".flakefinder"` | history dir (relative to cwd) |
| `maxRuns` | `300` | prune history to last N runs |
| `minRuns` | `3` | min observations before statistical claims |
| `liveRetries` | `2` | retries for `run` |
| `flakeScoreThreshold` | `40` | report inclusion threshold (confirmed/retry always included) |
| `slowThresholdMs` | `10000` | absolute slow bar |
| `slowMultiplier` | `5` | relative-to-suite slow bar |
| `quarantineFile` | `"flakefinder.quarantine.json"` | quarantine path |
| `runner` | `"auto"` | `auto|pytest|jest|mocha|go|generic` |
| `failOnFlakes` | `false` | flakes make `run`/action exit non-zero |
| `timeoutSeconds` | `null` | per-attempt wall-clock limit for `run` (seconds; `null` = unlimited; killed attempts resolve exit 124) |
| `retryMode` | `"auto"` | `run` retry strategy: `auto` = attempt 1 full, attempts 2+ re-run only failed tests via runner-native selectors (fall back to full when no adapter/no failures recorded); `failed` = force targeted (warn + full when impossible); `full` = always re-run everything |

Note on globs: implement a minimal brace-free glob (`**`, `*`, `?`) matcher in
`src/util/glob.ts` **(Agent C owns this file)** walking `cwd` (skip `node_modules`, `.git`,
`dist`, `storeDir`). No external glob dependency.

## 7. CLI spec (Agent C)

```
flakefinder <command> [options] [-- <command…> for run]

global:            --config <path>   --cwd <dir>   --no-color
init [--force] [--runner <r>]        detect runner, write flakefinder.config.json, print next steps
run [-R <n>] [--fail-on-flake] [--no-quarantine] -- <cmd…>
                                     execute cmd up to retries+1 times, stop early on exit 0;
                                     ingest changed report files per attempt; verdicts; exit:
                                       0 = clean or flakes-only (unless --fail-on-flake)
                                       1 = deterministic failure persists on final attempt
                                       2 = usage/environment error (no reports configured → warn + suite-level fallback verdict)
ingest <files…> [--attempt <1>] [--source report]   parse + append to store
report [--format table|json|md] [--flakes-only] [--all] [--threshold <n>]
html [-o <file>] [--open]            write flakefinder-report.html (default), open in browser if --open
quarantine list|add <testId>|remove <testId>|prune
ci [--fail-on-new-flakes]            ingest configured globs, table report, GitHub ::annotations, json file output
version
```

Terminal output rules: ANSI colors only when `process.stdout.isTTY` and not `--no-color`.
`init` detection: `pyproject.toml`/`pytest.ini`/`setup.py` → pytest; `jest` in package.json
(devDeps/scripts) → jest; `go.mod` → go; `.mocharc`/mocha in package.json → mocha; else generic.
`init` prints the exact snippet the user must add so their runner emits machine-readable
reports (jest-junit config / `pytest --junitxml=...` / `go test -json > test-output.jsonl`).

## 8. Live-run spec (Agent C, `src/runner/wrap.ts`)

1. Resolve report globs from `cwd`; snapshot `path → sha256` of existing matches.
2. `attempt = 1..retries+1`: spawn the command (stdio inherit so the user sees their test
   output; `cwd` set), stopping early after exit 0. TARGETED RE-RUNS (v0.3.0): attempts 2+
   re-run only the failed tests of the previous attempt(s) via `src/runner/adapters.ts` —
   jest `-t` / mocha `--grep` positive name patterns, go `-run` anchored regex (top-level
   parents of subtests), pytest `--lf` — inserted with the same operator-aware, wrapper-aware
   mechanism as quarantine flags. No adapter (generic) or no failures recorded → full re-run.
   Correctness invariant: a "rescue" requires an explicit PASS observation of a previously
   failing test, so selectors that match nothing can never fake a rescue. Spawn strategy: **no shell by default**
   (argv passes verbatim — no quoting hazards for quarantine patterns); fall back to shell
   mode, with our injected values shell-quoted, when the command contains shell operators
   (`>`, `|`, `&&`) or the direct spawn is refused (Windows blocks `.cmd` shims like npm
   without a shell — EINVAL since the CVE-2024-27980 fix). Abandoned first attempts' events
   are ignored (close-race guard).
3. After each attempt: hash report files again; new-or-changed files are parsed
   (`detectParser`), results → `RunRecord` with the SAME `runId` across attempts, `attempt`
   set, `source: 'live'`, best-effort `commitSha` via `git rev-parse HEAD` (absent → undefined; a dirty tracked tree
   records `<HEAD>-dirty-<12-hex content hash>` so uncommitted edits never count as same-SHA flips).
4. Append all records to `HistoryStore`, then `classifyAll`.
5. `suiteFlake` fallback: if zero report files ever matched, classify the SUITE: attempts with
   differing exit codes → print warning + suite-level flake verdict (no per-test data).
6. Quarantine: when `applyQuarantine` and runner is pytest/jest/mocha and entries exist,
   append `exclusionArgs` to the command — inserting a `--` separator first when the command
   is an npm/yarn/pnpm/bun wrapper (they swallow flags; only post-`--` args reach the runner).
   Emit a notice listing quarantined test count.
7. `finalExitCode` per §7 exit rules. `verdicts` restricted to tests observed in THIS
   invocation (testIds present in this invocation's records) — the CLI prints those, while
   history still contains everything.

## 9. Quarantine spec (Agent C)

`QuarantineEntry = { testId, suite, name, reason, quarantinedAt (ISO), flakeScore }`,
file format `{ "version": 1, "entries": [...] }`.

`exclusionArgs`:
- pytest: for each entry `--deselect "<suite>::<name>"` (only when suite looks like a path or
  dotted module; else skip that entry with a warning collected in the result… simple: still emit).
- jest: single `-t` arg: `"^(?!.*(?:name1|name2))"` with regex-escaped names, deduped.
- mocha: `--grep` with negative lookahead pattern, same construction.
- go / generic: `[]` (unsupported — caller warns).

`prune(verdicts)`: CONSERVATIVE — quarantined tests are excluded from runs, so
"unseen lately" is not evidence of health. An entry leaves quarantine only on
positive evidence (verdict `passing` with ≥ 10 runs observed) or when the test
is `gone` AND the entry is older than 90 days. Empty verdicts → no-op.
Returns removed entries; caller saves.

## 10. GitHub Action spec (Agent A)

`action.yml` (root):

```yaml
name: flakefinder
description: Detect, track and quarantine flaky tests. History-aware PR comments, HTML dashboard artifact.
branding: { icon: activity, color: orange }
inputs:
  reports:            { description: 'Comma-separated globs (overrides config)', required: false }
  github-token:       { description: 'Token for PR comments', default: '${{ github.token }}' }
  fail-on-new-flakes: { description: 'Fail the job if NEW flakes appear', default: 'false' }
  comment:            { description: 'Comment on PRs', default: 'true' }
  upload-dashboard:   { description: 'Upload HTML dashboard artifact', default: 'true' }
  history-max-runs:   { description: 'History retention', default: '300' }
  working-directory:  { description: 'Where reports/config live', default: '.' }
  history-key:        { description: 'Extra cache-stream key', default: '${{ toJSON(matrix) }}' }
outputs:
  flaky-count: { description: 'Total flaky tests' }
  new-flaky-count: { description: 'Flakes not previously flagged' }
  failing-count: { description: 'Deterministically failing tests' }
  report-json: { description: 'Path to written JSON report' }
runs:
  using: node24
  main: dist/action/index.cjs
```

Flow in `runAction()` (`src/action/main.ts`; env, `@actions/core`, cache, artifact upload,
glob and fetch are injected — `src/action/index.ts` only wires the real services):

1. Read and validate EVERY input first (`readInputs`; one failure listing all problems,
   nothing done yet); `working-directory` → chdir context for config/store.
2. Cache keys (`cacheKeys`): stream = short hash of job + working directory + `history-key`
   (`null`/empty = no key; matrix JSON canonicalised). Save key
   `flakefinder-history-<stream>-<sha>-<run id>-<run attempt>` (immutable per attempt);
   restore keys `flakefinder-history-<stream>-`, then `flakefinder-history-` (warm start).
   Skipped with one warning when the cache service is unavailable.
3. Baseline (`resolveBaseline`): the restored `verdicts-snapshot.json`, unless
   `action-baseline.json` shows this same run id already recorded one (re-run / second job)
   — then that recorded baseline, so re-runs can't bypass the gate.
4. `@actions/glob` expand report globs (input overrides config `reports`); read files
   (UTF-8/UTF-16 aware); `detectParser` parse → one `RunRecord` per file (source `action`,
   attempt 1, `ciRunId = runId`, `commitSha`/`branch` from context). Unparsable files warn.
5. Append to store; `prune(historyMaxRuns)`; `classifyAll`. `newFlakes` = flaky-* verdicts
   whose testId wasn't flaky-* in the baseline. Write fresh snapshot + `recordBaseline`.
6. `saveHistory` best-effort (a taken key or failure is a warning).
7. `core.setOutput`s; JSON report `flakefinder-report.json` via `renderJson`; job summary
   (HTML, redacted + escaped).
8. If `upload-dashboard`: build `DashboardData` (last 50 runs) → `renderDashboard` → upload
   `flakefinder-dashboard.html` via `@actions/artifact` (failure = warning).
9. If PR context and `comment`: upsert ONE comment (marker `<!-- flakefinder:report -->`,
   only our own/bot-authored comment is updated, plain `fetch`, all pages, 15 s timeout,
   no cross-origin redirects) using `buildPrComment`; mentions the dashboard only if uploaded.
10. If `fail-on-new-flakes` and newFlakes > 0 → `core.setFailed(...)` naming them.

`buildPrComment` format (Agent A, in `src/report/markdown.ts`):
marker line; `## 🐍 flakefinder` heading; one-line summary (counts, new vs known);
table of flakes (name, suite, class, score, confidence, Δ vs previous); per-flaky detail for
NEW flakes with last failure message (fenced, truncated 400 chars) and the exact
`flakefinder quarantine add <testId>` command; footer with dashboard artifact name.

## 11. Dashboard spec (Agent D)

`renderDashboard(data: DashboardData): string` → ONE self-contained HTML file:
inline CSS + inline JS + data embedded as `<script id="ff-data" type="application/json">`
(with `</script>` and `<!--` escaped). **No CDN, no external fonts, no network.** Dark theme
default with light toggle. Sections:

1. **Header**: title, generated timestamp, summary chips (tests tracked, flaky-confirmed,
   flaky-retry, flaky-suspected, failing, slow, recently-fixed).
2. **Runs strip chart**: one column per `DashboardRun` (last 50): stacked pass/fail bar +
   tooltip (timestamp, sha, counts).
3. **Tests table**: sortable columns (score, confidence, runs, pass rate, median duration,
   last status); text filter box; classification filter chips; row = suite + name, chips for
   tags, mini pass-rate bar.
4. **Detail drawer** (row click): full identity (testId + copy button), observation timeline
   as colored dots (pass green / fail red / skip gray, ring for attempt > 1), tooltip per dot
   (timestamp, sha, attempt, message excerpt), failure message block, duration sparkline
   (inline SVG), pass-rate donut, `flakefinder quarantine add <testId>` copy button.

Vanilla JS only; ~700–1000 lines of template is fine. Escape all user-derived strings when
injected into DOM (build DOM via `textContent`, not innerHTML for message content).

## 12. Report formats

- **terminal**: sections per classification (flaky-confirmed → …), columns: score, conf, runs,
  pass-rate, suite::name, median ms; footer with exit-code explanation + next-step hints.
- **json**: `{ generatedAt, flakefinderVersion, config: ResolvedConfig, verdicts: TestVerdict[] }`.
- **md / PR comment**: per §10.

## 13. Testing strategy

- Unit tests colocated `*.test.ts` (vitest). Every agent ships tests for its own modules.
- Parser corpus: real-shaped fixture files in `tests/parsers-fixtures/` (Agent P): nested
  JUnit (pytest-style), jest-junit XML, Jest JSON, Mocha JSON, Go test JSON (incl. `output`
  blocks, retries/`run` events, package with no tests), plus edge cases: empty suites,
  malformed XML (must produce warnings, not throw), unicode names, missing durations.
- Engine: table-driven tests per classification rule + score caps + recency tiers + tags.
- Store: JSONL round-trip, corrupt-line tolerance, prune atomicity.
- E2E (`scripts/e2e.mjs`, Agent F): build root; run fixtures (jest always; pytest & go if
  toolchains available — skip gracefully otherwise); assert verdicts + exit codes + html file
  written + non-empty.
- Fixture determinism: flaky tests use a counter FILE (fails on odd count) so e2e is
  deterministic in CI; e2e deletes counter state before starting.

## 14. Ownership map (STRICT — only edit inside your paths)

| Owner | Paths |
|---|---|
| **Integrator (me)** | `PLAN.md`, `TASKS.md`, `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `biome.json`, `.gitignore`, `LICENSE`, `scripts/clean-dist.mjs`, `src/types.ts`, `src/util/test-id.ts`, git commits, final wiring, `docs/BUILD_REPORT.md` |
| **Agent P** | `src/parsers/**`, `tests/parsers-fixtures/**` |
| **Agent E** | `src/engine/**`, `src/store/**` |
| **Agent C** | `src/cli/**`, `src/config.ts`, `src/runner/**`, `src/quarantine/**`, `src/report/terminal.ts`, `src/report/json.ts`, `src/util/glob.ts` |
| **Agent D** | `src/report/html.ts` (self-contained; no new files outside it) |
| **Agent A** | `action.yml`, `src/action/**`, `src/report/markdown.ts`, `.github/**`, `docs/github-action.md` |
| **Agent F** | `fixtures/**`, `scripts/e2e.mjs`, `README.md`, `docs/USAGE.md` (draft) |

Stubs already exist at every owned path with the frozen signatures — **replace the stub
contents entirely** with your implementation. Never edit another agent's file or a frozen
file. If you need a helper module, put it inside your own paths.

## 15. Conventions & build

- TypeScript **strict**, ESM everywhere, **`.js` suffix on relative imports** (NodeNext).
- No new npm dependencies without integrator approval (the dependency budget is a feature).
- Format: biome (2-space, single quotes, semicolons, width 100). Run `npx biome check src` on
  your files if convenient; integrator runs the final pass.
- Node APIs only for fs/crypto/child_process. Cross-platform paths (`path.join`), no `/tmp`.
- Verify with `npx vitest run <your-path-filter>` — do NOT run global `tsc` or `npm run build`
  during parallel phase (siblings are incomplete; integration is the integrator's job).
- Never run `npm install`/`npm update`, never run git commands.

## 16. v1.1 roadmap (document, don't build)

TRX (.NET) & node:test TAP parsers · targeted failed-only re-runs per runner · SQLite store
option · GitLab CI native comments · `flakefinder doctor` (CI wiring checks) · optional LLM
explanations (off by default, BYO key).
