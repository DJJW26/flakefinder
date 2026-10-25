# flakefinder — Build Report

> How this project was built, and the core mechanisms underneath it.
> Written by the build orchestrator at v0.1.0. For usage, see [USAGE.md](USAGE.md).

## What flakefinder is

`flakefinder` detects, tracks, and quarantines **flaky tests** — tests that
randomly pass and fail on the same code. It works in two modes:

1. **Instant (no history needed)** — `flakefinder run -- <cmd>` executes the
   test command, and when it fails, automatically re-runs it up to N more
   times. A test that fails and then passes on retry is a flake, proven
   deterministically, in minutes.
2. **Historical (compounding)** — every run is appended to a local JSONL
   history. The engine scores each test 0–100 using signals that are
   mathematically impossible for a deterministic test to produce (see below).

It ships as one npm package that is simultaneously a CLI (`npx flakefinder`),
a library, and a GitHub Action (this repo's root `action.yml` + `dist/action/index.js`).

## The core mechanism, precisely

### Test identity

A test's identity is `sha256(normalized(suite) + NUL + normalized(name))[0..16]`
(`src/util/test-id.ts`). Whitespace is collapsed so trivial report-formatting
differences don't fork a test's history. Renames do fork history — documented,
accepted trade-off for v1.

### What counts as an observation

A **RunRecord** is one execution of a report file (one CI run, one retry
attempt). Parsers convert four report ecosystems into a normalized
`TestCaseResult[]`:

| format | from | notes |
|---|---|---|
| JUnit XML | pytest, jest-junit, surefire, go-junit, … | nested `<testsuite>` recursion; `classname` preferred as suite |
| Jest JSON | `jest --json`, `vitest --reporter=json` | suite-level failures preserved as `(suite)` pseudo-test |
| Mocha JSON | `mocha --reporter json` | status by membership in `passes`/`failures`/`pending` |
| Go | `go test -json` | NDJSON; package events ignored; ANSI stripped from messages |

All history lives in `.flakefinder/history.jsonl` — one JSON object per line,
append-only, pruned to the last `maxRuns` (default 300). Corrupt lines are
skipped with warnings, never fatal: history must not be the reason a CI job dies.

### Classification (the interesting part)

For each test, observations are filtered to non-skips and collapsed to one per
`(runId, attempt)` (a retry loop writes attempt 1, 2, 3… under one `runId`).
Three signals are derived:

- **sameShaFlips** — distinct commit SHAs that observed BOTH a pass and a
  failure. The strongest possible flake signal: identical code, different outcomes.
- **retryRescues** — consecutive attempt pairs (k fail → k+1 pass) within one
  invocation. The instant-mode signal.
- **directionChanges** — how many times the per-commit outcome family toggles
  across distinct commits (fail→pass→fail…). Weaker, statistical.

Classification precedence (first match wins):

```
gone            absent from the last 30 runs
skipped         every observation was a skip
flaky-confirmed sameShaFlips > 0
flaky-retry     retryRescues > 0
flaky-suspected directionChanges ≥ 2 AND runs ≥ minRuns AND both outcomes seen
failing         last (≤5) observations all failed AND runs ≥ minRuns
new-failure     last observation failed (insufficient data for the above)
passing         everything else
```

**Flake score (0–100)** = `min(100, round(`
`50·min(1, sameShaFlips)` — capped contribution
`+ 40·min(1, retryRescues)` — capped contribution
`+ 8 · directionChanges × recency` capped at 24, where recency is 1.0/0.6/0.3
depending on whether the most recent failure was ≤14d / ≤30d / older
`+ 10 if runs ≥ 10))`

**Confidence**: 100 for confirmed/retry (direct proof), scaled 0–70 for
suspected by observation count, 25+5/trailing-fail for failing.

Tags: `slow` (absolute median bar or p95 > 5× suite median), `recently-fixed`
(failed in the first half of history, clean for the last 5), `long-unseen`.

Every rule above is pinned by table-driven tests in `src/engine/classify.test.ts`
— the tests read like the spec.

### Live mode (`run`)

`runLive` snapshots sha256 of all files matching the configured report globs,
executes the command (`shell: true`, stdio inherited so users see their normal
test output), then re-hashes. Changed/new files are parsed into attempt
records. Loop stops early on exit 0. Exit codes are contract:

- `0` clean, or failures explained entirely by rescued flakes
- `1` a deterministic failure persists on the final attempt (or `--fail-on-flake`)
- `2` usage/environment errors

If no report files ever match, it degrades to a suite-level verdict from exit
codes alone (exits varied → suite is flaky) with a warning explaining how to
configure reports — never a silent no-op.

### Quarantine

`flakefinder quarantine add <testId>` records the test in
`flakefinder.quarantine.json`. The next `run` appends **runner-native
exclusion flags** — `--deselect` (pytest), `-t` with a negative-lookahead
(jest/vitest), `--grep` (mocha) — never editing your test files. Go has no
per-test exclusion; the tool says so honestly and reports only.

Prune is deliberately conservative: quarantined tests are excluded from runs,
so "unseen lately" is NOT evidence of health. Entries leave only on positive
evidence (ran and passed stably ≥10 runs) or `gone` + older than 90 days.

### GitHub Action

`dist/action/index.js` (committed, bundled with esbuild): restores
`.flakefinder/` via `actions/cache` (`flakefinder-history-<sha>` key,
prefix restore-keys give branch inheritance and a default-branch warm start),
ingests report globs, diffs against the previous verdict snapshot
(`verdicts-snapshot.json`) to compute **new vs known** flakes, writes the
summary + outputs, upserts ONE PR comment via a hidden marker, uploads the
HTML dashboard artifact, and optionally fails on new flakes. No network
service; everything stays in the repo's action cache.

## Architecture & how it was built

```
src/
├── types.ts            frozen contract — every module codes against it
├── util/               test-id (identity), glob (dependency-free matcher)
├── parsers/            junit / jest / mocha / gotest + format sniffing
├── store/              append-only JSONL history
├── engine/             stats + classification (the algorithm above)
├── runner/             live command wrapper with retry detection
├── quarantine/         entry management + runner exclusion args
├── report/             terminal / json / markdown+PR-comment / html dashboard
├── cli/                commander wiring for 8 commands
└── action/             GitHub Action entry + ingest + snapshot diff
```

**Process.** The build started with a frozen-contracts phase: `PLAN.md`
(architecture, exact signatures, the classification algorithm written as a
spec) and `src/types.ts` were authored first, with compiling stubs at every
module boundary. Six build agents were then fanned out with strict,
disjoint file ownership. The host's concurrency limits killed five of the six
at launch; the build adapted to **one background agent at a time while the
orchestrator worked remaining scopes in the main thread**, keeping the same
ownership map (parsers → background agent; engine, CLI, action, docs →
orchestrator; dashboard → background agent; fixtures/e2e → background agent).

Integration risk was contained by the stubs: global `tsc` and `npm run build`
were green from commit one, so any moment's tree was shippable. Real bugs the
process caught: duplicate report lines inflating run counts (caught by the
engine's own table tests), the terminal report lying about totals after
filtering (caught by a manual user-style walkthrough), a quarantine prune rule
that would silently un-quarantine everything (caught during design review —
excluded tests can't accrue evidence), and two doc comments where `*/` inside
glob examples (`"**/…"`) closed the comment early.

**Dependency budget** (a feature, not an accident): runtime = `commander` +
`fast-xml-parser`, both bundled by tsup into a single-file CLI (~60 KB).
Everything else — glob matching, JSONC parsing, ANSI, statistics — is
stdlib-grade code in `src/util`/`src/engine`. The Action bundles
`@actions/*` separately into `dist/action/index.js`.

**Testing.** NNN unit tests across 17 files: table-driven engine tests (one per
classification rule, score caps, recency tiers), parser fixtures shaped like
real tool output (including malformed inputs — parsers must warn, never
throw), store round-trips and corruption tolerance, and an integration test
that spawns a REAL node process writing REAL report files with a
counter-based deterministic flake, and asserts `runLive` rescues it. E2E runs
the same loop against actual jest/pytest/go projects in `fixtures/`
(deterministic flakiness via counter files — no `Math.random()` anywhere near
CI).

## Known limitations (v1)

- Test renames fork history (identity is suite+name).
- `run` re-executes the full command on retry, not just failed tests
  (targeted re-runs are v1.1).
- GitLab/other CI get `flakefinder ci` + annotations, not native comments.
- Dashboard shows derived stats per test (score/confidence/flips), not the
  per-observation timeline (the data contract doesn't carry observations to
  the renderer yet — v1.1).

## Version

0.1.0 — see CHANGELOG.md. MIT.
