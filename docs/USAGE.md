# flakefinder — Usage Guide

Everything the CLI does, every flag, every config key, and the reasoning
behind the scores. For a shorter introduction see the
[README](../README.md); for the GitHub Action see
[docs/github-action.md](github-action.md).

- [Installation](#installation)
- [The 5-minute path](#the-5-minute-path)
- [Command reference](#command-reference)
- [Configuration reference](#configuration-reference)
- [Exit codes](#exit-codes)
- [Report formats](#report-formats)
- [The scoring model, explained for humans](#the-scoring-model-explained-for-humans)
- [Quarantine deep-dive](#quarantine-deep-dive)
- [GitHub Action recipes](#github-action-recipes)
- [Other CI systems](#other-ci-systems)
- [History store](#history-store)
- [Troubleshooting](#troubleshooting)
- [Privacy](#privacy)

## Installation

**One-off (no install):**

```console
$ npx flakefinder init
$ npx flakefinder run -- npm test
```

**Global:**

```console
$ npm install -g flakefinder
$ flakefinder run -- npm test
```

**From source** (this repo):

```console
$ git clone https://github.com/<YOUR_GITHUB>/flakefinder
$ cd flakefinder && npm install && npm run build
$ node dist/cli.js run -- npm test        # or: npm link
```

Requires Node >= 18. The CLI is a single bundled file (`dist/cli.js`) with two
runtime dependencies baked in — nothing else to manage.

## The 5-minute path

1. Make your test runner emit machine-readable reports (usually one flag):

   | Runner | What to add |
   |---|---|
   | pytest | `pytest.ini`: `addopts = --junitxml=junit.xml` |
   | Jest | `npm i -D jest-junit` + jest config `reporters: ['default', ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }]]` |
   | vitest | junit reporter → `junit.xml` (or `--json --outputFile=jest.json`) |
   | Mocha | `--reporter json --reporter-options output=test-results/report.json` |
   | Go | `go test -count=1 -json ./... > test-output.jsonl` |

2. `npx flakefinder init` — detects your runner, writes
   `flakefinder.config.json` with sensible report globs, prints the snippet
   above if it can't find reports yet.
3. `npx flakefinder run -- <your test command>` — runs it, retries failures,
   and prints a report separating flakes from real failures.
4. `npx flakefinder report` / `npx flakefinder html` — see accumulated
   history as a table or an interactive dashboard.
5. `npx flakefinder quarantine add <testId>` — take the worst offender out of
   rotation until it's fixed.

## Command reference

Global options, valid before any command:

| Flag | Meaning |
|---|---|
| `--config <path>` | Use this config file instead of auto-discovery |
| `--cwd <dir>` | Working directory for config, reports, and store (default: `.`) |
| `--no-color` | Disable ANSI colors |

Config discovery: `flakefinder.config.json` in `--cwd`, walking up to 3 parent
levels. JSONC (comments) is allowed.

### `init`

```console
$ npx flakefinder init [--force] [--runner <runner>]
```

Detects your runner from repo markers (`pyproject.toml`/`pytest.ini` →
pytest, `jest` in package.json → jest, `go.mod` → go, mocha configs → mocha),
then writes `flakefinder.config.json` with default report globs.

- `--force` — overwrite an existing config
- `--runner <pytest|jest|mocha|go|generic>` — skip detection, force a runner

Prints the exact reporter setup your runner still needs. Exits `2` if it
can't detect a runner (pass `--runner` explicitly) or the config exists
(pass `--force`).

### `run`

```console
$ npx flakefinder run [-R <n>] [--fail-on-flake] [--no-quarantine] -- <command…>
```

Executes `<command>` (everything after `--`) up to `retries + 1` times,
stopping early on exit 0. The command is spawned **directly** (no shell) —
arguments pass through verbatim, including spaces and special characters.
Commands containing shell operators (`>`, `|`, `&&`) automatically fall back
to shell mode so redirects keep working. After each attempt it parses the
report files that **changed** and records them as attempts of one run. Then
it classifies and prints a terminal report restricted to the tests observed
in this invocation.

- `-R, --retries <n>` — extra attempts (default: config `liveRetries`, itself
  default 2). `-R 0` runs once with no retries but still records history.
- `--fail-on-flake` — exit non-zero when *flakes* (not just real failures) are
  detected. Default behavior: flakes alone exit 0, so known flakes don't fail
  your CI gate.
- `--no-quarantine` — run the full suite, ignoring the quarantine list.

If quarantined entries exist and the runner supports exclusion, the exclusion
flags are appended automatically (with a notice); see
[Quarantine](#quarantine-deep-dive).

If **no** report files match, per-test detection is impossible; flakefinder
falls back to a suite-level verdict from the attempt exit codes and warns
accordingly.

### `ingest`

```console
$ npx flakefinder ingest [files…] [--attempt <n>] [--source <live|report|action>]
```

Parses report files into the history store without running anything. With no
file arguments it uses the configured `reports` globs. The parser is detected
per file from content.

- `--attempt <n>` — attempt number to record (default 1). Useful for
  reconstructing a retry sequence from CI artifacts.
- `--source <source>` — provenance tag stored on the run (default `report`).

**Same-runId note:** each `ingest` invocation creates its **own** `runId`.
Retry-rescue classification (`flaky-retry`) requires attempts 1→2 to share a
runId, which only `run` produces. Two separate `ingest` calls can still flag a
flake — via the same-commit-flip rule — but it will classify as
`flaky-confirmed` rather than `flaky-retry`. Exits `2` if nothing matched.

### `report`

```console
$ npx flakefinder report [--format table|json|md] [--flakes-only] [--all] [--threshold <n>]
```

Classifies everything in the history store and prints it.

- `--format table` (default) — the terminal table. Default view shows the
  problem classes (flaky/failing/new-failure) plus an `ok: N passing…` line.
- `--format json` — machine-readable `{ generatedAt, flakefinderVersion,
  config, verdicts }` on stdout alone — safe to pipe into `jq`.
- `--format md` — markdown (same shape as PR comments).
- `--flakes-only` — drop the `ok:` summary line (table).
- `--all` — include passing/skipped/gone rows (table), all tests (md).
- `--threshold <n>` — minimum score for `flaky-suspected` inclusion;
  confirmed/retry flakes are always included. Default: config
  `flakeScoreThreshold`.

### `html`

```console
$ npx flakefinder html [-o <file>] [--open]
```

Writes a **self-contained** HTML dashboard (inline CSS/JS/data, dark/light
toggle, no CDN, no network) from the history store: summary chips, a runs
strip chart (last 50 runs), a sortable/filterable tests table, and a detail
drawer per test with its full observation timeline, failure message, duration
sparkline, and a copyable `quarantine add` command.

- `-o, --out <file>` — output path (default `flakefinder-report.html`)
- `--open` — open it in your browser after writing

### `quarantine`

```console
$ npx flakefinder quarantine list
$ npx flakefinder quarantine add <testId> [--reason "<text>"]
$ npx flakefinder quarantine remove <testId>
$ npx flakefinder quarantine prune
```

Manages `flakefinder.quarantine.json`. `testId`s come from
`report` (the "next steps" hint) or `report --format json`. See the
[deep-dive](#quarantine-deep-dive) for mechanics and the prune policy.

### `ci`

```console
$ npx flakefinder ci [--fail-on-new-flakes]
```

One-shot CI mode (what the GitHub Action uses under the hood, minus caching
and PR comments): ingests all configured report globs into the store, prints
the table report, emits GitHub-flavored `::warning` annotations (one per
flaky test — also understood by GitLab, Buildkite, and others), writes
`flakefinder-report.json`, and snapshots the verdict set to
`.flakefinder/verdicts-snapshot.json`.

- `--fail-on-new-flakes` — exit `1` when flakes appear that were not flaky in
  the previous snapshot. Known flakes never fail the build; new ones do.

### `version`

Prints the flakefinder version.

## Configuration reference

`flakefinder.config.json` (JSONC allowed). All keys optional.

| Key | Default | Meaning |
|---|---|---|
| `reports` | `[]` | Globs (relative to cwd) for report files: `**`, `*`, `?` supported; `node_modules`, `.git`, `dist`, and the store dir are skipped. Example: `["junit*.xml", "test-results/*.json"]` |
| `storeDir` | `".flakefinder"` | History directory (holds `history.jsonl` and the verdict snapshot) |
| `maxRuns` | `300` | Prune history to the last N runs after each append |
| `minRuns` | `3` | Minimum observations before statistical claims (gates `flaky-suspected` and `failing`) |
| `liveRetries` | `2` | Extra attempts for `run` (override per invocation with `-R`) |
| `flakeScoreThreshold` | `40` | Score bar for including `flaky-suspected` in reports; confirmed/retry always included |
| `slowThresholdMs` | `10000` | Absolute bar for the `slow` tag (median duration above this) |
| `slowMultiplier` | `5` | Relative bar: p95 above `slowMultiplier ×` suite median also tags `slow` |
| `quarantineFile` | `"flakefinder.quarantine.json"` | Quarantine list location |
| `runner` | `"auto"` | `auto` (detect per run), `pytest`, `jest`, `mocha`, `go`, `generic`. Controls quarantine exclusion flags and `init` hints |
| `failOnFlakes` | `false` | Flakes make `run` exit non-zero (same as `--fail-on-flake`) |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean run, **or** failures that were all proven flakes (unless `--fail-on-flake` / `failOnFlakes`) |
| `1` | A deterministic failure persisted to the final attempt (`run`); a quarantined testId wasn't found; `ci --fail-on-new-flakes` saw new flakes |
| `2` | Usage or environment error: bad flags, unreadable config, no report files matched for `ingest`/`ci`, unknown quarantine action |

These are stable and scriptable — gate CI on `run`'s exit code directly.

## Report formats

- **table** — sections per classification (`FLAKY (confirmed)`,
  `FLAKY (retry-rescued)`, `FLAKY (suspected)`, `FAILING`, `NEW FAILURE`),
  columns: score, confidence, runs, pass-rate, median duration,
  `suite :: name`, tags. Footer: `ok:` line and next-step hints (worst
  offender's exact `quarantine add` command).
- **json** — full verdict objects: classification, `flakeScore`,
  `confidence`, `passRate`, `runsObserved`, `lastStatus`, `lastMessage`,
  `medianDurationMs`, `p95DurationMs`, `sameShaFlips`, `retryRescues`,
  `directionChanges`, `tags`, plus identity (`testId`, `suite`, `name`).
- **md** — markdown tables; the PR-comment body is a variant of this with a
  hidden upsert marker and new-vs-known deltas.

## The scoring model, explained for humans

flakefinder never guesses. Every verdict is a transparent rule over the
timeline of observations it has for a test, and the two flake classes that
matter most require *proof*:

- **Same-commit flip → `flaky-confirmed`, +50 score points.** Your CI ran one
  commit and the test both failed and passed on it. Nothing changed — same
  code, same environment claim — so the difference must come from the test
  itself (order, timing, network, port, leftover state). This is the
  strongest signal available and outweighs everything else.
- **Retry rescue → `flaky-retry`, +40 points.** Within a single `run`
  invocation (attempts share a `runId`), attempt 1 failed and attempt 2
  passed. Proof the test can pass without any code change. In a git repo a
  retry rescue is usually *also* a same-commit flip, so it classifies as
  `flaky-confirmed`; without git metadata you'll see `flaky-retry`.
- **Direction changes → up to +24 points, gated by `minRuns`.** Across
  *distinct code states* — commits when git metadata exists, otherwise
  individual runs — how many times did the test's result family flip
  (pass→fail or fail→pass)? Two or more flips over enough runs is statistical
  suspicion, not proof — hence `flaky-suspected`, score-gated by
  `flakeScoreThreshold`, and it never fails your build. (Projects outside a
  git repo get run-level flip tracking automatically; same-run retry attempts
  count as one state.)
- **Long track record → +10 points** at ≥ 10 observed runs.

Recency dampens history: flips in the last 14 days count fully, ≤ 30 days at
60%, older at 30%. A flake from six months ago that never recurred shouldn't
outrank last night's. The sum is capped at 100.

**Confidence** is a separate 0–100 number answering "how sure am I of this
verdict?": 100 for the two proven flake classes; scaled by observation count
for `flaky-suspected`; scaled by consecutive failures for `failing` and fail
count for `new-failure`. A `new-failure` on its first appearance carries low
confidence by design — one red run is not a diagnosis.

Tags: `slow` flags duration outliers (absolute `slowThresholdMs`, or p95 far
above the suite's own median via `slowMultiplier`). `recently-fixed` flags
tests that failed in the first half of history and passed the last 5 —
candidates to un-quarantine.

## Quarantine deep-dive

Quarantine removes a test from the *run path* without touching source code.
The list lives in `flakefinder.quarantine.json`; `run` consults it (unless
`--no-quarantine`), appends the right exclusion flags to your command, and
prints a notice.

**How the flags reach your runner.** flakefinder spawns your command directly
(no shell) whenever possible, so patterns with spaces and special characters
arrive as one intact argument. If your command itself needs a shell
(redirects like `>`, pipes), it runs through the shell with the exclusion
values quoted. When the command goes through a package-manager wrapper
(`npm test`, `yarn test`, `pnpm test`, `bun test`), a `--` separator is
inserted automatically — npm & friends swallow flags themselves and only
forward what follows `--` to the underlying runner.

Per runner:

- **pytest** — one `--deselect "<suite>::<name>"` pair per entry. pytest
  skips those node ids; the rest of the suite runs normally.
- **Jest** — a single `-t "<pattern>"` where pattern is
  `^(?!.*(?:name1|name2))` (names regex-escaped, deduped): a negative
  lookahead that matches every test name *except* the quarantined ones, so
  Jest's name filter keeps everything else.
- **Mocha** — same construction via `--grep`.
- **Go / generic** — **no per-test exclusion exists** in `go test`; entries
  are stored and reported (you'll see exactly which tests are quarantined)
  but not auto-excluded. `quarantine list` says so explicitly.

**Prune policy (deliberately conservative).** `quarantine prune` removes an
entry only on *positive* evidence: the verdict is `passing` with ≥ 10 runs
observed (i.e. it ran — with quarantine disabled or a full-suite run — and
was stable), or the test is `gone` while the entry is older than 90 days.
Why so strict: a quarantined test is excluded from runs, so "not seen lately"
is exactly what quarantine looks like when it's working. Treating absence as
health would silently un-quarantine the entire list. Empty history → no-op.

flakefinder never edits your test files, never comments out tests, never
touches your runner config. `quarantine remove <id>` (or delete the JSON
file) restores the previous behavior exactly.

## GitHub Action recipes

Minimal step after your tests (full reference:
[docs/github-action.md](github-action.md)):

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test                      # must write report files
      - name: flakefinder
        uses: <YOUR_GITHUB>/flakefinder@main
        if: always()                       # analyze even when tests fail
```

**Fail the job only on NEW flakes** (known flakes stop failing your CI the
moment they're recorded — that's the point):

```yaml
      - name: flakefinder
        uses: <YOUR_GITHUB>/flakefinder@main
        if: always()
        with:
          fail-on-new-flakes: true
```

**PR comments** (upserted via a hidden marker, never duplicated) and the
**dashboard artifact** are on by default; disable with `comment: false` /
`upload-dashboard: false`. Outputs `flaky-count`, `new-flaky-count`,
`failing-count`, `report-json` are available to later steps.

**Monorepo** — point the action at the package directory:

```yaml
      - name: flakefinder (services/api)
        uses: <YOUR_GITHUB>/flakefinder@main
        if: always()
        with:
          working-directory: services/api
```

History is cached per repository under `.flakefinder/` (immutable key per
commit, prefix restore for warm starts on new branches).

## Other CI systems

Any CI that can run a node command can use `flakefinder ci` after the test
step:

```yaml
after_tests:
  - npx flakefinder ci --fail-on-new-flakes
```

It ingests your configured globs, prints the table, emits `::warning`
annotations (GitHub, GitLab 15+, Buildkite, and friends render these inline),
writes `flakefinder-report.json` (attach it as an artifact for `report`
diffing later), and updates the snapshot that powers new-vs-known detection.
Persist `.flakefinder/` between runs (cache it like any build artifact) to
keep history-aware verdicts.

## History store

Location: `<storeDir>/history.jsonl` (default `.flakefinder/history.jsonl`),
relative to `--cwd`. Format: JSON Lines, one run record per line:

```json
{"runId":"…uuid…","timestamp":"2026-10-25T10:20:44.101Z","source":"live","parsedFrom":"junit","attempt":2,"commitSha":"1a2b3c…","results":[{"testId":"b6930d21e68e49f7","suite":"tests/flaky-counter.test.js","name":"flaky-counter fails on odd counts","status":"fail","durationMs":1,"message":"flaky-counter saw odd count 1"}]}
```

- `runId` — shared by retry attempts of one invocation; this is what makes
  retry-rescue detection possible
- `source` — `live` (from `run`), `report` (from `ingest`), `action` (GitHub Action)
- `attempt` — 1-based; > 1 means a retry at the same code state
- `commitSha` — best-effort `git rev-parse HEAD` at ingest time

Pruning: after each append the store is atomically rewritten (tmp + rename)
to the last `maxRuns` records (default 300). Corrupt lines are skipped on
load, never crash the CLI. A second file, `<storeDir>/verdicts-snapshot.json`,
holds the previous classification used by `ci --fail-on-new-flakes` and the
action's new-vs-known diff.

To reset all history: delete the `.flakefinder` directory. To inspect:
`jq` the JSONL — it's plain data, no database, no lock-in.

## Troubleshooting

**"no report files matched"** (`ingest`/`ci` exit 2, or `run` warns about
suite-level fallback) — your runner didn't write a report where flakefinder
looked. Check the exact output filename (`junit.xml` vs `junit-junit.xml` etc.),
make sure `reports` globs in `flakefinder.config.json` cover it, and confirm
the file exists after a plain test run *without* flakefinder. For Go, remember
`go test -json` writes to **stdout** — the redirect (`> test-output.jsonl`)
must be part of the command you pass after `--`.

**"unrecognized report format — skipped"** — the parser couldn't identify the
file. Common causes: truncated XML (a CI step killed the runner mid-write),
an HTML coverage report instead of JUnit XML, or an empty file. Re-run the
suite; if it persists, open the file and check it's the format you think it
is. Malformed-but-detected files produce warnings, not crashes, and every
parsable test case still records.

**Renamed tests fork their history** — identity is `sha256(suite + name)`, so
after a rename the old id goes `gone` and the new id starts empty. This is
honest (a renamed test *is* a new test observably). If the fork bothers you:
prefer changing assertions over names, or accept the fresh start — scores
recover within a few runs.

**Windows paths** — use forward slashes in globs (`test-results/*.xml` works
everywhere). `run` spawns your command directly (no shell) so arguments with
spaces survive intact; commands with `>` redirects or pipes automatically
switch to shell mode where they behave as in your terminal — quote paths
containing spaces in that case. The store and reports use `path.join`, so
mixed separators in existing files are tolerated. In scripts that wrap the
CLI, pass the go redirect as **argument tokens**
(`… -- go test -json ./... ">" test-output.jsonl`) rather than letting an
outer shell expand it — this repo's `scripts/e2e.mjs` does exactly that.

**"quarantine has entries but runner go has no per-test exclusion"** —
working as designed: `go test` has no `--deselect` equivalent. Entries stay
tracked (and `list`/reports show them), but Go suites must be filtered
manually (e.g. `-run` in your own scripts) until Go grows a selector.

**Exit code 2** — a flag/config problem, not a test result: check the error
message above the exit (unreadable config, invalid `--retries`, empty
quarantine action, no matching reports for `ingest`/`ci`).

## Privacy

flakefinder is local-first: **no network calls, no telemetry, no accounts.**
The CLI never sends anything anywhere. What it stores on your disk is what
your own report files contain: test names, suites, statuses, durations,
failure messages/stacks (excerpted), plus run metadata (timestamp, attempt,
commit sha). Delete `.flakefinder/` at any time; that is the entire footprint.

The GitHub Action keeps the same data inside *your* repository's actions
cache — no third-party service ever sees it. PR comments contain only what
the terminal report contains.
