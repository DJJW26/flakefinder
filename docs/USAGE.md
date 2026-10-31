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
$ git clone https://github.com/DJJW26/flakefinder
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
| `--config <path>` | Use this config file instead of auto-discovery (a relative path resolves against `--cwd`) |
| `--cwd <dir>` | Working directory for config, reports, and store (default: `.`). Must be an existing directory — otherwise every command exits `2` |
| `--no-color` | Disable ANSI colors. Colors are also off when the `NO_COLOR` environment variable is set (non-empty) or when output is not a terminal — the same rule for every command |

Help: `flakefinder` with no command, `flakefinder --help` and
`flakefinder help` print the command list to stdout and exit `0`;
`flakefinder help <command>` (or `<command> --help`) describes one command.
`flakefinder help <unknown>` and an unknown command exit `2` with an error.

Config discovery: `flakefinder.config.json` in `--cwd`, walking up to 3 parent
levels. JSONC (comments) is allowed. Relative `storeDir` and `quarantineFile`
values written in a config file resolve against **that file's directory**
(also with `--config`), so every subdirectory shares one store; `reports`
globs and the built-in defaults stay relative to `--cwd`.

### `init`

```console
$ npx flakefinder init [--force] [--runner <runner>]
```

Detects your runner from repo markers (`pyproject.toml`/`pytest.ini` →
pytest, `jest` in package.json → jest, `go.mod` → go, mocha configs → mocha),
then writes `flakefinder.config.json` with default report globs.

- `--force` — overwrite an existing config
- `--runner <pytest|jest|mocha|go|generic>` — skip detection, force a runner.
  `--runner auto` is the same as omitting the flag: it detects, writes the
  detected runner and its report globs, and exits `2` when nothing is detected

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
report files that **changed** and records them as attempts of one run. Every
attempt records exactly the reports it **wrote** — new files, or files whose
mtime, size or content changed since before the attempt. A byte-identical
rewrite still counts (its mtime moves): a deterministic report generator is
recorded on every run, and a fail-fail-pass sequence with identical failure
reports is detected as a rescue. Files nobody touched — stale reports from a
previous job, or the previous attempt's report when a retry crashed before
writing — are ignored. Reports are decoded as UTF-8 or UTF-16 (with a BOM,
as PowerShell 5.1's `>` writes them).
Then it classifies and prints a terminal report restricted to the tests
observed in this invocation.

**Uncommitted changes.** Each run is tagged with the code state it ran:
HEAD's commit sha, or — when tracked files have uncommitted changes —
`<sha>-dirty-<hash>` (the hash covers the changed files' contents;
flakefinder's own store, quarantine file, config and report files are
ignored, and so are untracked files). `run` prints a one-line notice when
that happens. So fixing a failing test locally and re-running is a change of
code state (fail on HEAD → pass on the dirty state), not a same-commit flip:
it is not called `flaky-confirmed`. Re-running the *same* uncommitted edits
still compares like with like, so a real flake on your edits is caught.
(`ingest`/`ci` record HEAD's sha as-is.)

- `-R, --retries <n>` — extra attempts, an integer 0–10 (default: config
  `liveRetries`, itself default 2; the same 0–10 range applies to both the
  flag and the config key). `-R 0` runs once with no retries but still
  records history. An out-of-range flag is reported against the flag
  (`run -R/--retries must be an integer 0–10 (got 50)`), not the config.
- `--fail-on-flake` — exit non-zero when *flakes* (not just real failures) are
  detected. Default behavior: flakes alone exit 0, so known flakes don't fail
  your CI gate. Only tests that actually executed in this invocation count:
  quarantined tests (even if the runner lists them as skipped) and tests
  that only skipped never trip it.
- `--no-quarantine` — run the full suite, ignoring the quarantine list.
- `--timeout <seconds>` — kill the attempt (whole process tree) after N
  seconds (an integer 1–2147483); the attempt counts as failed (exit 124, GNU-timeout convention)
  and the retry loop proceeds. Default: config `timeoutSeconds`, itself
  unlimited. SIGINT/SIGTERM (Ctrl-C) are forwarded to the current tree, stop
  the loop, and exit 130 while keeping everything observed so far in history.
  When stdin is a terminal, the test command inherits it and shares the
  terminal (watch modes, prompts and debuggers work); the whole tree is still
  killed on timeout, and Ctrl-C reaches it directly — flakefinder only steps
  in (SIGTERM, then SIGKILL) if it hasn't exited 2 s later. Otherwise (CI,
  piped stdin) each attempt runs in its own process group so the tree can be
  signalled as one.
- `--retry-mode auto|failed|full` — retry strategy (default: config `retryMode`,
  itself default `auto`). `auto`: attempt 1 runs everything; each re-run
  executes **only the tests that failed on the previous attempt** (a test that
  already recovered is not re-run again) — jest/vitest via `-t`, mocha via `--grep`, go via
  `-run`, pytest via `--lf` — falling back to a full re-run when the runner has
  no adapter, the previous attempt recorded no failures, or the selector would
  be too long to pass to the OS (more than 32 KiB — thousands of failures;
  6000 chars on Windows). `full` restores re-running the entire command every
  attempt.

**Targeted re-runs** cut retry cost from 3×(whole suite) to roughly
suite + 2×(failed tests only). One honest caveat: order-dependent flakes may
not reproduce in a targeted re-run because neighboring tests no longer run
around them — if you suspect ordering flakiness, use `--retry-mode full`.
Correctness is unaffected either way: a test only counts as flaky when it
explicitly *passes* on a re-run, so an empty or partial re-run can never fake
a rescue. Two implementation notes: targeted selectors match failed test
names as space-delimited final segments of the full name (a failure named
`update` does not drag in `math re-update`), and quarantined tests are
excluded from re-runs even on name collisions (pytest `--lf` retries keep the
`--deselect` flags; with `-p no:cacheprovider` — on the command line, in
`PYTEST_ADDOPTS`, or in the `addopts` of your pytest.ini / pyproject.toml /
tox.ini / setup.cfg — `--lf` is unavailable, so pytest retries are full
re-runs). pytest's `--lf` trusts pytest's
own last-failed cache — a stale cache from a *manual* pytest run outside
flakefinder could re-run a quarantined test once; clear it with
`pytest --cache-clear` if that ever bites. If your command already passes
its own jest `-t`/`--testNamePattern` or mocha `--grep`/`-g`/`--fgrep`, it is
folded into flakefinder's selector (both must match) instead of being passed
twice. A go `-run` (or mocha `--invert`) cannot be combined — flakefinder
warns once that its injected selector comes later and wins.

If quarantined entries exist and the runner supports exclusion, the exclusion
flags are appended automatically (with a notice); see
[Quarantine](#quarantine-deep-dive).

If **no** report files match, per-test detection is impossible; flakefinder
falls back to a suite-level verdict from the attempt exit codes and warns
accordingly.

**Exit status through pipes.** flakefinder sees the exit status of your
whole command line. In shell mode `npx jest 2>&1 | tee out.txt` reports
`tee`'s status (0), so a failing attempt looks green and is never retried.
Wrap it so the pipeline fails when the test command does, e.g.
`run -- bash -o pipefail -c 'npx jest 2>&1 | tee out.txt'` (or set
`set -o pipefail` in the CI step that runs it).

**A command that cannot be found** — a misspelled binary, also inside a
shell-mode command line such as `nosuch-tool > out.txt` — exits 2 after one
attempt with `command not found: …`; nothing is retried or recorded. A test
script that itself exits 127 is still an ordinary failure.

### `ingest`

```console
$ npx flakefinder ingest [files…] [--attempt <n>] [--source <live|report|action>] [--run-id <id>]
```

Parses report files into the history store without running anything. With no
file arguments it uses the configured `reports` globs. The parser is detected
per file from content.

- `--attempt <n>` — attempt number to record (default 1; an integer
  1–1000000). Useful for reconstructing a retry sequence from CI artifacts.
- `--source <source>` — provenance tag stored on the run (default `report`).
- `--run-id <id>` — reuse one `runId` across several `ingest` invocations, so
  a fail on `--attempt 1` followed by a pass on `--attempt 2` counts as a
  retry rescue exactly as it would under `run` (+40 score; `flaky-retry`, or
  `flaky-confirmed` when the same commit also flipped). Use one id per
  CI job (e.g. `--run-id "$GITHUB_RUN_ID"`, `"$CI_PIPELINE_ID"` or a
  `uuidgen`); it must be 1–128 characters of letters, digits, `.`, `_` and
  `-`, starting with a letter or digit (so `1234567890-2` works, `----------`
  does not), otherwise `ingest` exits `2`.

**Same-runId note:** without `--run-id`, each `ingest` invocation creates its
**own** `runId`. Retry-rescue detection requires attempts 1→2 to share a runId
— which `run` does automatically, and `ingest` does only when you pass the
same `--run-id` to each call. Separate `ingest` calls without it can still flag
a flake in a git repo — via the same-commit-flip rule (`flaky-confirmed`) — but
without the retry-rescue evidence; outside git they cannot flag it at all.
Exits `2` if nothing matched, or if none of the files could be read and
parsed (every one missing, empty or in an unrecognized format) — nothing is
recorded then. A run where at least one file parsed exits `0`; the skipped
files are listed as warnings.

### `report`

```console
$ npx flakefinder report [--format table|json|md] [--flakes-only] [--all] [--threshold <n>]
```

Classifies everything in the history store and prints it.

- `--format table` (default) — the terminal table. Default view shows the
  problem classes (flaky/failing/new-failure) plus an `ok: N passing…` line.
- `--format json` — machine-readable `{ schemaVersion, generatedAt,
  flakefinderVersion, config, verdicts }` on stdout alone — safe to pipe into
  `jq`. The same shape is written by `ci` (`flakefinder-report.json`) and the
  GitHub Action. `schemaVersion` (currently `1`) changes only when a field is
  removed, renamed or retyped; new fields can appear without a bump, so
  ignore keys you do not know.
- `--format md` — markdown (same shape as PR comments).
- `--flakes-only` — drop the `ok:` summary line (table).
- `--all` — include passing/skipped/gone rows (table), all tests (md).
- `--threshold <n>` — minimum score (an integer 0–100) for `flaky-suspected` inclusion; applied
  identically to the table and md formats. Confirmed/retry flakes and
  failures are always included. Default: config `flakeScoreThreshold`. The
  `json` format is always complete, and the `ci` command / GitHub Action
  report unfiltered by design (CI surfaces favor full visibility).

### `html`

```console
$ npx flakefinder html [-o <file>] [--open]
```

Writes a **self-contained** HTML dashboard (inline CSS/JS/data, dark/light
toggle, no CDN, no network) from the history store: summary chips, a runs
strip chart (last 50 runs), a sortable/filterable tests table, and a detail
drawer per test with its full observation timeline, failure message, duration
sparkline, and a copyable `quarantine add` command.

- `-o, --out <file>` — output path (default `flakefinder-report.html`);
  missing parent directories are created automatically. An empty path, a
  directory, or an unwritable location exits `2` with the reason
- `--open` — open it in your browser after writing (`xdg-open` on Linux,
  `open` on macOS, `start` on Windows). When no opener is available (e.g. a
  headless box without `xdg-open`) this is a one-line warning; the dashboard
  is still written and the exit code stays `0`

### `doctor`

```console
$ npx flakefinder doctor
```

Checks the whole setup in one pass: config validity, detected runner, report
files actually matching the globs, history size/freshness/corruption, git
metadata availability, quarantine health. It checks exactly what the other
commands would use: the `--config` file when one is given (a missing or
invalid one is a FAIL), and the configured `storeDir` and `quarantineFile`.
Each line is `[ok]`/`[warn]`/`[FAIL]`/`[info]` with an actionable hint where
relevant. Exit `1` when any check FAILed — safe to gate CI or a setup script
on it.

### `quarantine`

```console
$ npx flakefinder quarantine list
$ npx flakefinder quarantine add <testId> [--reason "<text>"]
$ npx flakefinder quarantine remove <testId>
$ npx flakefinder quarantine prune
```

Manages `flakefinder.quarantine.json` (or the configured `quarantineFile`).
`testId`s come from `report` (the "next steps" hint) or
`report --format json`. See the [deep-dive](#quarantine-deep-dive) for
mechanics and the prune policy.

- `add`/`remove` of a `testId` that is not in history / not quarantined exits
  `1`; a missing `testId` argument or an unknown action exits `2`.
- `prune` writes the file only when it actually removes entries — with
  nothing to prune (e.g. an empty history) no file is created.
- `list` and `prune` print test names, ids and reasons with control
  characters made visible (`\x1b`, `\x0d`, …), never raw.

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
  With no snapshot (first run) every current flake is new. A corrupt or
  wrongly-shaped snapshot is treated the same way, with a warning naming the
  file, and is overwritten by this run's snapshot.

The commit sha recorded with each run comes from the CI system when it
provides one — `GITHUB_SHA` (GitHub Actions), then `CI_COMMIT_SHA`
(GitLab) — and from `git rev-parse HEAD` otherwise, so shallow or git-less
checkouts still get same-commit flip detection.

On **GitLab**, `flakefinder ci` additionally upserts ONE merge-request note
(marker-scoped, never duplicated) when these CI variables exist:
`GITLAB_CI`, `CI_API_V4_URL`, `CI_PROJECT_ID`, `CI_MERGE_REQUEST_IID`, and a
project/personal access token with `api` scope exposed as `GITLAB_TOKEN`
(defined under Settings → CI/CD → Variables). Posting failures are warnings,
never job failures — the annotations and exit codes work regardless.


### `version`

Prints the flakefinder version.

## Configuration reference

`flakefinder.config.json` (JSONC allowed). The file must hold a JSON
**object**; `null`, an array, a number or a string is rejected with
`config must be a JSON object` (exit `2`). All keys optional.

**Validation (v0.2.0+):** every key is type- and range-checked on load —
unknown keys and wrong-typed values (including wrong-case `runner` values,
e.g. `"Jest"`) fail fast with ALL problems listed and their expected types.
Previously these silently misbehaved (a wrong-case runner fell back to
`generic`, which quietly disables quarantine).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `reports` | `string[]` | `[]` | Globs (relative to cwd) for report files: `**`, `*`, `?` supported; `node_modules`, `.git`, `dist`, and the store dir are skipped. Example: `["junit*.xml", "test-results/*.json"]` |
| `storeDir` | string | `".flakefinder"` | History directory (holds `history.jsonl` and the verdict snapshot); relative to the config file's directory |
| `maxRuns` | integer 1–100000 | `300` | Prune history to the last N runs after each append. A run is one `runId`: all retry attempts of one `run` (or ingests sharing a `--run-id`) count once and are kept or dropped together |
| `minRuns` | integer 1–1000 | `3` | Minimum observations before statistical claims (gates `flaky-suspected` and `failing`) |
| `liveRetries` | integer 0–10 | `2` | Extra attempts for `run` (override per invocation with `-R`) |
| `flakeScoreThreshold` | integer 0–100 | `30` | Score bar for including `flaky-suspected` in reports; confirmed/retry always included |
| `slowThresholdMs` | number \| null | `10000` | Absolute bar for the `slow` tag (median duration above this) |
| `slowMultiplier` | number > 0 | `5` | Relative bar: p95 above `slowMultiplier ×` suite median also tags `slow` |
| `quarantineFile` | string | `"flakefinder.quarantine.json"` | Quarantine list location; relative to the config file's directory |
| `runner` | enum | `"auto"` | `auto` (detect per run), `pytest`, `jest`, `mocha`, `go`, `generic`. Controls quarantine exclusion flags and `init` hints |
| `failOnFlakes` | boolean | `false` | Flakes make `run` exit non-zero (same as `--fail-on-flake`) |
| `retryMode` | enum | `"auto"` | How `run` retries: `auto` (re-run only the failed tests when the runner supports it, else the whole command), `failed` (always targeted), `full` (always re-run everything). Same as `run --retry-mode` |
| `timeoutSeconds` | integer 1–2147483 \| null | `null` | Kill an attempt of `run` (and its process tree) after N seconds; `null` = no limit. Same range as `run --timeout`, which overrides it |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean run, **or** failures that were all proven flakes (unless `--fail-on-flake` / `failOnFlakes`) |
| `1` | A deterministic failure persisted to the final attempt (`run`); `quarantine add`/`remove` could not find the testId; `ci --fail-on-new-flakes` saw new flakes |
| `1` (doctor) | `doctor` found at least one FAIL-level problem (e.g. invalid config, unreadable quarantine file, unreadable `history.jsonl`) |
| `2` | Usage or environment error: bad flags, unreadable config, missing `--cwd`, no report files matched for `ingest`/`ci` (or none of them parsed, for `ingest`), unknown quarantine action, test command could not be started (`run` — e.g. not installed / not on PATH; nothing is retried or recorded) |

These are stable and scriptable — gate CI on `run`'s exit code directly.

## Report formats

Supported parsers (auto-detected per file): **JUnit XML** (pytest, jest-junit,
surefire…; a Surefire rerun that passed after `<flakyFailure>`/`<flakyError>`,
or a pytest-rerunfailures rerun, stays a pass flagged with a
`flaky: failed k of n attempts` message and is **scored as a retry rescue**
(its per-attempt results are recorded in `attempts`); `<skipped>` +
`<failure>` (a failing TODO) is a skip), **Jest JSON** (jest + vitest; a test that passed only on a retry —
`retryTimes`/vitest `retry` — stays a pass flagged `flaky: failed k of n
attempts` and is scored as a retry rescue, as is a mocha test with `currentRetry` > 0; a file that failed outside any test — e.g.
an `afterAll` that threw — is recorded as a `(suite)` failure; vitest's
fractional durations are rounded to whole milliseconds), **Mocha JSON** (`--reporter json` or mochawesome; statuses matched
per file + full title; a failing `before`/`after` hook is recorded as a
failure named e.g. `"before all" hook`), **`go test -json`**
(NDJSON; with `-count=N` a test that failed in any run is reported as a fail,
noted `flaky: failed k of n runs` when other runs passed; a parent test with
`t.Run` subtests is only reported when it failed on its own; messages drop
go's `=== RUN`/`--- FAIL:` framing lines and a passing test carries no
message; build failures —
go 1.24 `build-fail` events or compiler errors on merged stderr — become
warnings), **TAP** (node:test `--test-reporter=tap`, plain TAP13/14, and headerless
TAP12 from Perl/prove/bats when every line is TAP-shaped; nested
subtests — by indentation, with or without `# Subtest:` headers — become
`ancestor > …` suites, a parent is only reported when it failed on its own,
`# SKIP`/`# TODO` map to skip, multi-line YAML `error: |-` diagnostics and
`duration_ms` are read), **TRX**
(.NET `dotnet test --logger trx`; suite = the test class name, joined by
test id so same-named methods in different classes stay distinct;
Timeout → fail, Error/Aborted → error, NotExecuted/Inconclusive → skip;
data-driven rows are reported individually), **Playwright JSON**
(`--reporter=json`; the same test ids as Playwright's JUnit reporter —
suite = spec file, name = `describe › title`; the browser projects of one
test are folded into one result in which a failure in any project wins,
prefixed `[project]`; a pass that needed a retry is flagged `flaky: failed k
of n attempts`; `test.fail()` that failed is a pass; errors outside any
test become a `playwright :: (global)` error), and **pytest-json-report**
(`pytest --json-report`; the same test ids as `pytest --junitxml`;
xfail → skip, setup/teardown failures → error, a module that fails to
collect → an error named after the module, a pytest-rerunfailures `rerun`
→ a pass flagged flaky).

**In-report retries.** When the report itself shows that a test ran more
than once — jest `invocations`, vitest/mocha retries, Surefire
`flakyFailure`/`rerunFailure`, pytest-rerunfailures, Playwright retries and
`--repeat-each`, go `-count` — the result keeps the final status and also
records every attempt's status (oldest first), so a retry-then-pass is
evidence of flakiness rather than a clean pass.

**Encoding and compression.** A leading byte-order mark is ignored. Reports
must be plain text: a gzip-compressed report is not read (decompress it
first). A file no parser recognizes is skipped with a reason, e.g.
`truncated/invalid JSON (…)` for a JSON report cut off mid-write.

- **table** — sections per classification (`FLAKY (confirmed)`,
  `FLAKY (retry-rescued)`, `FLAKY (suspected)`, `FAILING`, `NEW FAILURE`),
  columns: score, confidence, runs, pass-rate, median duration,
  `suite :: name`, tags. Footer: `ok:` line and next-step hints (worst
  offender's exact `quarantine add` command).
- **json** — `schemaVersion: 1` plus full verdict objects: classification, `flakeScore`,
  `confidence`, `passRate`, `runsObserved`, `lastStatus`, `lastMessage`,
  `medianDurationMs`, `p95DurationMs`, `sameShaFlips`, `retryRescues`,
  `directionChanges`, `tags`, plus identity (`testId`, `suite`, `name`).
- **md** — markdown tables; the PR-comment body is a variant of this with a
  hidden upsert marker and new-vs-known deltas.

**Secret redaction (v0.2.0+):** failure messages and table cells in the md/PR
and dashboard outputs are scanned for credential shapes (GitHub/AWS/OpenAI/
Slack/GitLab/npm tokens, JWTs, `Bearer`/`Basic` headers, `SECRET_KEY=…`-style
assignments) and replaced with `[REDACTED]` markers before anything leaves
your machine. Redaction happens **after** the raw message is stored —
`history.jsonl` keeps the original text so debugging isn't degraded. The
terminal table never prints messages at all.

## The scoring model, explained for humans

flakefinder never guesses. Every verdict is a transparent rule over the
timeline of observations it has for a test, and the two flake classes that
matter most require *proof*:

- **Same-commit flip → `flaky-confirmed`, +50 score points.** Your CI ran one
  commit and the test both failed and passed on it. Nothing changed — same
  code, same environment claim — so the difference must come from the test
  itself (order, timing, network, port, leftover state). This is the
  strongest signal available and outweighs everything else. (A `run` on a
  working tree with uncommitted changes counts as its own code state, not
  as HEAD — see [`run`](#run).)
- **Retry rescue → `flaky-retry`, +40 points.** Within a single `run`
  invocation (attempts share a `runId`), attempt 1 failed and attempt 2
  passed. Proof the test can pass without any code change. In a git repo a
  retry rescue is usually *also* a same-commit flip, so it classifies as
  `flaky-confirmed`; without git metadata you'll see `flaky-retry`. A
  runner's **own** retries count the same way: when a report records that
  a test failed and then passed on an in-report retry (jest `retryTimes`,
  vitest `retry`, mocha retries, Surefire/pytest reruns, go `-count` — where
  the parser records the attempts), that is a retry rescue too.
- **Direction changes → up to +24 points, gated by `minRuns`.** Walking the
  history in time order across *code states* — commits when git metadata
  exists, otherwise individual runs — how many times did the test's result
  family flip (pass→fail or fail→pass) from one state to the next? Two or
  more flips over enough runs is statistical suspicion, not proof — hence
  `flaky-suspected`, score-gated by `flakeScoreThreshold`, and it never
  fails your build. (Projects outside a git repo get run-level flip tracking
  automatically; same-run retry attempts count as one state.) Going *back*
  to an earlier commit counts as a new state: pass on A, fail on B, pass on
  A again (a revert, or alternating runs of two branches that share one
  history) is two flips.
- **Long track record → +10 points** at ≥ 10 observed runs.

**What counts as a run.** One invocation — one `flakefinder run`, one
`ingest`/Action run — is ONE run, however many retry attempts it made.
Attempts are evidence for rescues and same-commit flips, but they never
inflate `runsObserved`: a brand-new test that fails all 3 attempts of a
`run -R 2` is 1 run, so it is a `new-failure`, not `failing` (that needs
`minRuns` runs). The `failing` window ("last 5"), `recently-fixed`, the
`minRuns` gate and the +10 bonus all count runs; a run's outcome is its
final attempt. `passRate` is over individual executions, so a run that
failed once and passed on retry reads 50%.

Recency dampens history: if the **most recent flip** (the latest direction
change, not the latest failure) was in the last 14 days, direction changes
count fully; ≤ 30 days at 60%; older at 30%. A flake from six months ago
that never recurred shouldn't outrank last night's — but a test that just
flipped back is fresh evidence even if its failures are old. The sum is
capped at 100.

**Confidence** is a separate 0–100 number answering "how sure am I of this
verdict?": 100 for the two proven flake classes; scaled by observation count
for `flaky-suspected`; scaled by consecutive failures for `failing` and fail
count for `new-failure`. A `new-failure` on its first appearance carries low
confidence by design — one red run is not a diagnosis.

Tags: `slow` flags duration outliers (absolute `slowThresholdMs`, or p95 far
above the suite's own median via `slowMultiplier` — the relative rule also
needs a p95 of at least 100 ms, so a 1 ms test in a suite of 0 ms tests is
not "slow"). `recently-fixed` flags tests with a failed run in the first
half of their history and passing last 5 runs — candidates to un-quarantine.

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

- **pytest** — one `--deselect <node id>` pair per entry. The stored suite
  is pytest's JUnit classname (`tests.test_x.TestCls`), so it is converted
  back to a rootdir-relative node id (`tests/test_x.py::TestCls::test_y`):
  the module is the longest dotted prefix that exists as a `.py` file,
  falling back to "trailing Capitalized components are classes". pytest
  skips those node ids; the rest of the suite runs normally. pytest itself
  matches `--deselect` as a node-id *prefix* (quarantining `test_mod` would
  also drop `test_mod2`), so `run` also loads a tiny temporary plugin (via
  `PYTEST_PLUGINS`/`PYTHONPATH`) that deselects exactly the quarantined ids
  and their parametrizations (`test_mod[...]`) — `test_mod2` keeps running,
  and your own `--deselect` flags keep pytest's usual meaning. If a wrapper
  strips the environment (e.g. tox without `pass_env`), the plain
  `--deselect` prefix match still applies.
- **Jest** — a single `-t "<pattern>"` where pattern is
  `^(?!(?:.* )?(?:name1|name2)\s*$)` (names regex-escaped, deduped): a negative
  lookahead that matches every test name *except* the quarantined ones, so
  Jest's name filter keeps everything else. `-t` sees the full name
  (describe chain + title, space-joined), and each quarantined title must be
  its whole final segment: quarantining `login` excludes `login` and
  `ui login`, but not `login ok works` or `relogin`. vitest's JUnit names
  (`suite > test`) match the space-joined name `-t` sees, and a title with
  trailing whitespace still matches.
- **Mocha** — same construction via `--grep`.
- **Go / generic** — **no per-test exclusion exists** in `go test`; entries
  are stored and reported (you'll see exactly which tests are quarantined)
  but not auto-excluded. `quarantine list` says so explicitly.

**Prune policy (deliberately conservative).** `quarantine prune` removes an
entry only on *positive* evidence: the verdict is `passing` with ≥ 10 runs
observed and the test was last seen *after* it was quarantined (i.e. it ran —
with quarantine disabled or a full-suite run — and was stable), or the test is `gone` while the entry is older than 90 days.
Why so strict: a quarantined test is excluded from runs, so "not seen lately"
is exactly what quarantine looks like when it's working. Treating absence as
health would silently un-quarantine the entire list. Empty history → no-op.

The file is written atomically (temp file + rename), so a crash mid-save
never leaves it half-written. If it is unreadable anyway (e.g. a bad hand
edit), `run` warns and runs **without** exclusions rather than failing;
`doctor` reports it as a FAIL and `quarantine add/remove` refuse to touch it
until it is fixed or deleted.

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
        uses: DJJW26/flakefinder@v1
        if: always()                       # analyze even when tests fail
```

**Fail the job only on NEW flakes** (known flakes stop failing your CI the
moment they're recorded — that's the point):

```yaml
      - name: flakefinder
        uses: DJJW26/flakefinder@v1
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
        uses: DJJW26/flakefinder@v1
        if: always()
        with:
          working-directory: services/api
```

**Matrix builds** — each leg keeps its own history automatically
(`history-key` defaults to `${{ toJSON(matrix) }}`). Pin it to the
dimensions you care about if you want it stable when the matrix changes:

```yaml
      - name: flakefinder
        uses: DJJW26/flakefinder@v1
        if: always()
        with:
          history-key: ${{ matrix.os }}-node${{ matrix.node }}
```

History is cached under `.flakefinder/` in one stream per job, working
directory and `history-key`: saved as
`flakefinder-history-<stream>-<sha>-<run id>-<attempt>` (an immutable key
per run attempt) and restored by the `flakefinder-history-<stream>-` prefix,
falling back to any flakefinder cache as a warm start on a stream's first
run. Details: [docs/github-action.md](github-action.md#how-the-history-cache-works).

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
relative to `--cwd` (a `storeDir` set in a config file is relative to that
file's directory). Format: JSON Lines, one run record per line, preceded by
a schema header (v0.2.0+):

```json
{"version":1}
{"runId":"…uuid…","timestamp":"2026-10-25T10:20:44.101Z","source":"live","parsedFrom":"junit","attempt":2,"commitSha":"1a2b3c…","results":[{"testId":"b6930d21e68e49f7","suite":"tests/flaky-counter.test.js","name":"flaky-counter fails on odd counts","status":"fail","durationMs":1,"message":"flaky-counter saw odd count 1"}]}
```

The header identifies the on-disk schema so future versions can migrate
safely; readers tolerate legacy header-less stores (v0.1.x files) unchanged.

- `runId` — shared by retry attempts of one invocation; this is what makes
  retry-rescue detection possible
- `source` — `live` (from `run`), `report` (from `ingest`), `action` (GitHub Action)
- `attempt` — 1-based; > 1 means a retry at the same code state
- `commitSha` — best-effort `git rev-parse HEAD` at ingest time (`run` on a
  tree with uncommitted tracked changes records `<HEAD>-dirty-<hash>`)

Pruning: after each append the store is atomically rewritten (tmp + rename)
to the last `maxRuns` runs (default 300) — distinct `runId`s, not lines:
the attempts of one run are never split, so a retry rescue is never cut in
half. Corrupt lines are skipped on
load, never crash the CLI. If `history.jsonl` itself cannot be read (it is a
directory, or permissions deny access) read-only commands treat history as
empty, `doctor` reports it as a FAIL, and any command that writes history
(`run`, `ingest`, `ci`) stops with an error naming the path instead of a raw
`EISDIR`/`EACCES`. A second file, `<storeDir>/verdicts-snapshot.json`,
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

**Reports behind symlinks/junctions are not discovered** — glob matching
(`reports` in the config, and `run`/`ingest`/`ci`/`doctor` discovery) walks
real files and directories only: a symlinked report file, or a report inside
a symlinked directory or Windows junction, is silently not matched. This is
deliberate — following links risks cycles and walking outside the project.
Point globs at the real path instead. Files passed **explicitly** to
`ingest <files…>` are read normally, links included.

**Renamed tests fork their history** — identity is `sha256(suite + name)`, so
after a rename the old id goes `gone` and the new id starts empty. This is
honest (a renamed test *is* a new test observably). If the fork bothers you:
prefer changing assertions over names, or accept the fresh start — scores
recover within a few runs.

**Windows paths** — use forward slashes in globs (`test-results/*.xml` works
everywhere). `run` spawns your command directly (no shell) so arguments with
spaces survive intact; commands with `>` redirects or pipes automatically
switch to shell mode, where every argument token is quoted for the shell
(POSIX single quotes; caret-escaping for cmd.exe) so it still arrives
verbatim — only the operator tokens themselves are interpreted. The store and reports use `path.join`, so
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
quarantine action, no matching or parseable reports for `ingest`, no matching reports for `ci`, or a `run` test
command that could not be started — `command not found: …`). Numeric flags
(`-R`, `--timeout`, `--attempt`, `--threshold`) accept plain integers only —
`2.5`, `2x` or `50abc` are rejected with the flag's accepted range rather than
silently truncated.

## Privacy

flakefinder is local-first: **no network calls, no telemetry, no accounts.**
The CLI never sends anything anywhere. What it stores on your disk is what
your own report files contain: test names, suites, statuses, durations,
failure messages/stacks (excerpted), plus run metadata (timestamp, attempt,
commit sha). Delete `.flakefinder/` at any time; that is the entire footprint.

The GitHub Action keeps the same data inside *your* repository's actions
cache — no third-party service ever sees it. PR comments contain only what
the terminal report contains.
