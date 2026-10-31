# Changelog

## 1.2.0

QA rounds 5 and 6. Round 5 fixed every High finding. Round 6 closes the
remaining QA items except the deferred test-identity decision (PAR-4/5/15).

### Round 6 behavior changes

**Scoring (PLAN §5 now states these rules explicitly)**

- One invocation (runId) counts as **one run** for `runsObserved`,
  `minRuns`, the failing/recently-fixed windows and the +10 bonus. A single
  failing `run -R 2` is `new-failure`, not `failing`. Attempts still count
  as same-SHA / retry evidence, and `passRate` is still over executions.
- Recency keys on the most recent flip, not the last failure.
- Flips are counted between chronological visits to a code state, so a
  revert A→B→A counts 2.
- **In-report retries are scored.** Results now carry `attempts` (jest/vitest
  `invocations`, mocha `currentRetry`, Surefire reruns, pytest-rerunfailures,
  go `-count`, Playwright retries); fail-then-pass scores as a retry rescue.
- `slow` additionally needs p95 ≥ 100 ms.

**Runner (`run`)**

- A tree with uncommitted tracked changes records `<HEAD>-dirty-<hash>`, so
  an uncommitted fix is never a same-SHA flip.
- A missing binary in a shell-mode command exits 2 after one attempt.
- Byte-identical rewritten reports are recorded.
- With a TTY, stdin is inherited (watch modes work); the process tree is
  still killed on timeout/Ctrl-C.
- pytest quarantine deselects exact node ids (via a temporary plugin);
  `no:cacheprovider` in ini/pyproject/tox/setup.cfg addopts is honoured.
- Store warnings are printed after `run`.

**Parsers**

- New formats: Playwright JSON (`playwright`) and pytest-json-report
  (`pytest-json`).
- UTF-16 (e.g. PowerShell `>`), BOM-prefixed and gzip-compressed reports are
  read everywhere.
- Unparseable files say why (truncated JSON, gzip, binary, empty…).
- Go messages drop `=== RUN`/`--- PASS` framing; passing tests carry no
  message. jest/vitest/mocha durations are whole milliseconds.

**CLI**

- Exit codes: `ingest` with nothing parsed → 2; `quarantine add/remove` of
  an unknown id → 1; `help <unknown>` → 2; a missing or non-directory `--cwd`
  → 2 everywhere; `doctor --config bad.json` → 1.
- `--config` resolves against `--cwd`; doctor honours `--config` and the
  configured `quarantineFile`.
- Config must be a JSON object; `timeoutSeconds` must be an integer
  (1–2147483); `timeoutSeconds` and `retryMode` are documented.
- `maxRuns` keeps the last N distinct runs (retry attempts stay together).
- `--run-id` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` (long numeric
  CI ids accepted).
- `NO_COLOR`/`--no-color`/non-TTY are honoured by every command.
- `ci` records `GITHUB_SHA` / `CI_COMMIT_SHA` and treats a corrupt snapshot
  as no baseline, with a warning.
- JSON report gains `schemaVersion: 1`.
- `html --open` without an opener only warns; quarantine output escapes
  control characters; `init --runner auto` detects like the default.

**GitHub Action / reports**

- The action runs on **node24**, and the bundle now includes all
  dependencies (it previously required `fast-xml-parser` at runtime).
- Matrix legs get separate histories by default (`history-key` defaults to
  `toJSON(matrix)`).
- PR comments and GitLab MR notes are found across all pages (cap 5000).
- The dashboard follows the OS light/dark preference and escapes bidi and
  control characters.
- `THIRD_PARTY_NOTICES.md` is added; CI actions are pinned to commit SHAs;
  docs use `@v1`.

### Round 5
QA round 5: about 80 fixes across the runner, quarantine, engine, store,
config, parsers, reports, GitHub Action and release tooling. The per-fix
detail is in the commit history (`fix(runner|quarantine|engine|store|config|parsers|report|action|gitlab|release)`).

**Behavior changes to know about**

- Retries re-run only the **previous** attempt's failures. Oversized name
  selectors (more than 32 KiB) fall back to a full re-run.
- The exit gates check each test's last *real* execution. Quarantined tests
  and tests that were only skipped never trip `--fail-on-flake`.
- Timeouts and Ctrl-C kill the whole process tree (POSIX process group).
- pytest quarantine uses real node ids (`path/test_x.py::Class::test`).
  jest/mocha exclusion matches whole titles, not substrings.
- `storeDir` / `quarantineFile` in a config file resolve relative to that
  file's directory.
- History-store lock errors fail fast (exit 2). The store header survives
  pruning, and a newer-format store is never downgraded.
- The Action's cache key now includes a stream id (job + working-directory
  + the new `history-key` input). Expect one warm-start restore after
  upgrading.
- PR/MR comments are capped at 50 table rows and 60k chars. Terminal output
  escapes control characters and is redacted.
- Parsers add Surefire reruns, go `-count`/benchmarks/build events,
  mochawesome, TAP block scalars and headerless TAP12, TRX outcome/class
  join/data rows, and jest/vitest/mocha retry-then-pass notes.
  Retry-then-pass inside a single report is reported as a `pass` with a
  `flaky: failed k of n attempts` message plus a warning. It is not yet
  scored as flaky.

## 1.1.1

Bug-fix release from QA round 4. No new features; one stricter-input change
(numeric flags) and one exit-code change (unstartable commands → 2).

**Runner (`run`)**

- **fix: retry re-record semantics** — retry attempts re-record *every*
  matched report, even byte-identical ones: a fail-fail-pass sequence with a
  deterministic report is now detected as a retry rescue (attempt 1 still
  skips stale pre-existing reports).
- **fix: unstartable command exits 2, not 1** — `run -- not-installed` used
  to retry and exit 1 like a test failure; it now stops after attempt 1 with
  `command not found: …`, records nothing, and exits 2 (usage/environment
  error). A test command that itself exits 2 or 127 is unaffected.

**Engine**

- **fix: runId-grouped chronological ordering** — retry pairs are no longer
  split by same-timestamp interleaving across runs, which silently lost
  retry rescues.

**History store**

- **fix: prune concurrency** — `prune` re-reads the store fresh under the
  write lock (and decides its early return from that fresh count), so a
  concurrent writer's appends are no longer deleted.
- **fix: read paths never create directories** — `report`/`doctor` on a
  missing store leave nothing behind; write paths create the store dir
  before taking the lock.
- **fix: `history.jsonl` as a directory (EISDIR) / unreadable (EACCES)** —
  reads degrade to an empty history with a warning; writes fail with an
  error naming the path instead of a raw `EISDIR`; `doctor` reports FAIL.

**CLI**

- **fix: `init --runner`** is validated against the runner enum.
- **fix: `ingest r.xml r.xml`** no longer double-counts — explicit files are
  resolved, then deduplicated.
- **fix: strict numeric flags** — `-R/--retries` (0–10), `--timeout`
  (1–2147483 s), `ingest --attempt` (1–1000000) and `report --threshold`
  (0–100) reject `2.5`, `2x`, `50abc`, `abc`, `0`/negatives where invalid,
  with an error naming the flag and range (exit 2). `-R 50` now blames the
  flag, not the config.
- **fix: usage errors print once** (commander's message was repeated).

**Doctor**

- **fix: resilience** — a corrupt quarantine file is a FAIL instead of a
  crash; the git probe is bounded by a 5 s timeout; an unreadable history
  store is a FAIL (exit 1) instead of `ok "0 run(s)"`.

**Parsers**

- **fix: TAP `t.test()` parents** no longer double-emit (children-count
  aggregate detection, verified against real output).
- **fix: TAP directives** (`# SKIP`/`# TODO`) are case-insensitive per spec;
  node's backslash-escaped `#` in names is unescaped consistently.
- **fix: mocha** parses the passes/failures-only JSON shape the sniffer
  already accepted.
- **fix: TRX** day-inclusive durations (`d.hh:mm:ss.f`); duplicate XML roots
  (JUnit/TRX) warn and use the first root instead of yielding zero results.

**Docs**

- USAGE: `doctor` section and exit-code rows, run re-record semantics,
  `ingest --run-id`, numeric flag ranges, unstartable-command exit code,
  unreadable-store behavior, and the symlink/junction limitation of report
  globs (deliberate, for cycle safety).

## 1.1.0

- **feat: TAP parser** — `node --test --test-reporter=tap` (fixture verified
  against real node 22 output) and generic TAP14. Nested subtests become
  `ancestor > …` suites; `# SKIP`/`# TODO` directives map to skip; YAML
  diagnostic blocks are harvested for failure messages/stacks; suite
  aggregates are de-duplicated against their children so failures never
  double-count.
- **feat: TRX parser** — .NET `dotnet test` results. Suite = the test class
  (`TestMethod/@className`), `duration` (`HH:MM:SS.f`) parsed to ms,
  `ErrorInfo` → error status with message/stack, `NotExecuted` → skip.
- **feat: GitLab MR notes** — on GitLab CI, `flakefinder ci` upserts one
  marker-scoped merge-request note (env-driven: `GITLAB_TOKEN`,
  `CI_MERGE_REQUEST_IID`); posting failures never fail the job.
- Parsers are now six: JUnit XML, Jest JSON, Mocha JSON, `go test -json`,
  TAP, TRX.

## 1.0.0

First stable release. Highlights since 0.2.x:

- **feat: `flakefinder doctor`** — one command that checks the setup: config
  validity, runner detection, report files actually matching, history size
  and freshness, corruption counts, git metadata, quarantine health — each
  with an actionable hint. Exit 1 on any failure, so CI can gate on it.
- **feat: store write lock.** Appends and prunes serialize across concurrent
  CI shards via an advisory lock (stale locks stolen after 30 s); a busy
  store fails with instructions instead of corrupting a line.
- **feat: `run --timeout <seconds>` / `timeoutSeconds` config.** An attempt
  exceeding the limit gets its whole process tree killed (Windows:
  `taskkill /T /F`) and resolves exit 124 (GNU-timeout convention).
- **feat: Ctrl-C done right.** SIGINT/SIGTERM kill the current tree, stop the
  retry loop, keep all evidence ingested so far, and exit 130.
- **feat: `ingest --run-id`** — share a runId across CI artifacts so a
  fail→pass across invocations counts as a retry rescue.
- **feat: release automation** — `scripts/release.mjs` (two-location version
  bump, changelog stub, full pipeline, tag) and a `release` workflow that
  publishes to npm with provenance when `NPM_TOKEN` is configured.
- Targeted failed-only re-runs, stat-first change detection, perf smoke and
  coverage gates shipped in 0.3.0 (see that entry).

## 0.3.0

- **feat: targeted failed-only re-runs (`run --retry-mode auto|failed|full`,
  default `auto`).** Attempt 1 runs the whole suite; re-runs execute only the
  failed tests — jest/vitest via `-t`, mocha via `--grep`, go via `-run`,
  pytest via `--lf`. Retry cost drops from 3×(whole suite) to roughly
  suite + 2×(failed tests only). Selectors are boundary-anchored (a failure
  named `update` does not re-run `math re-update`), quarantine exclusions
  survive into re-runs even on name collisions, and flags join the runner's
  segment before shell operators. Order-dependent flakes may not reproduce in
  targeted mode — `full` restores whole-suite retries.
- **perf: report change detection is stat-first** (size+mtime short-circuit;
  sha256 only on change) and the history store loads without duplicating the
  file as a string array. 150k-observation store: `report` ~90 ms, dashboard
  ~100 ms.
- **ci: performance smoke** (150k-observation store, budgets asserted) and a
  **coverage gate** (≥85% lines on engine/parsers/store) run on every push.
- Hardenings found by adversarial QA on the feature: `--retry-mode` is fully
  wired (flag → engine, validation exit 2 on bad values); shell-mode spawns
  quote every non-operator token (user values like `w1&&w2` no longer corrupt
  the command); operator detection matches whole tokens only; clearer
  fallback messages distinguish "no adapter" from "no failures recorded".

## 0.2.1

QA round 2 (independent agent, all findings double-verified):

- **fix: `run` exit code no longer trusts a stale report.** When a passing
  re-run leaves the report unchanged or deletes it, the earlier failure
  evidence is kept — exit 0 is reserved for "clean or all failures were
  flakes". Previously a rescued exit code could hide a reported failure.
- **fix: quarantine flags reach the runner in shell commands.** Flags now
  join the runner's segment (before `|`/`&&`/`>`), and shell-mode spawns use
  the quoted argv — previously flags appended after the last shell word and
  cmd.exe ate metacharacters like `^` in exclusion patterns.
- **fix: `--fail-on-flake` now fires on suite-level flakes** (varying exit
  codes with no report files), matching its documented contract.
- **fix: vitest `status:"skipped"` is recognized** by the jest parser (jest
  emits `"pending"`, vitest `"skipped"` — vitest users lost every skipped
  test from history).
- **fix: UTF-8-BOM-prefixed configs load** (PowerShell `Out-File`/Notepad
  emit a BOM; JSON.parse rejected it).
- **fix: namespace-prefixed JUnit XML parses** (`<x:testsuites xmlns:x=…>`)
  — sniff and element lookup are prefix-tolerant.
- Engine edge-case regression suite added (future timestamps, resurrected
  `gone` tests, error-only histories, `gone` boundary, suite-identity).

## 0.2.0

- **feat: config validation.** `flakefinder.config.json` keys are now
  type- and range-checked on load; unknown keys and wrong-typed values
  (including wrong-case `runner`) fail fast with all problems listed.
  Previously these silently misbehaved.
- **feat: secret redaction.** Failure messages, test names, and suites in PR
  comments, dashboards, JSON reports, and the Action step summary are scanned
  for credential shapes (GitHub/AWS/OpenAI/Slack/GitLab/npm tokens, JWTs,
  `Bearer`/`Basic` headers, `SECRET_KEY=…` assignments) and replaced with
  `[REDACTED]`. Patterns match tokens embedded in words; ordinary prose
  (`password: required field`, JSON error numbers) is spared. The local
  history store keeps the raw text.
- **fix: `--threshold` is now consistent** between the table and markdown
  reports (previously only md filtered suspected flakes by score). `json`
  and the `ci`/Action surfaces remain unfiltered by design.
- **fix: Go tests that crash mid-run** (started, never reported a terminal
  result) are now synthesized as `error` results with a warning instead of
  silently vanishing from verdicts. Output-only events no longer invent
  phantom crashes, and a package that fails before running any test
  (build/init crash) is synthesized as a `(package)` error.
- **fix: `flakeScoreThreshold` default 40 → 30.** flaky-suspected scores cap
  at 34 (flip points + data bonus), so the old default made the class
  invisible; the terminal report now also states how many suspected rows were
  hidden below the threshold instead of silently dropping them.
- **feat: store schema header.** `history.jsonl` gains a `{"version":1}`
  first line (readers tolerate legacy v0.1.x files) to support future
  migrations. Record lines are shape-validated on load: schema markers in
  wrong positions, partial writes, and garbage no longer crash report
  surfaces — they are skipped with warnings.
- **fix: `html -o` creates missing directories**; `--threshold` validates
  its input (0–100); clearer not-found hints (direct-spawn ENOENT message +
  exit 127/9009 detection); parser warnings no longer double-prefix; stored
  failure messages keep up to 2000 chars so redaction sees whole tokens.
- Docs: configuration reference gained a Type column and validation notes.

## 0.1.1

- **fix**: quarantine flags now actually reach the test runner through
  npm/yarn/pnpm commands (`--` separator inserted) and are shell-safe in direct
  mode (spawn without shell by default, quoting only in shell fallback).
- **fix**: flake detection no longer goes blind outside git repositories —
  flip-flop detection falls back to per-run buckets when no commit SHA exists.
- **fix**: GitHub Action `history-max-runs` input is now honored.
- QA pass results and open items: docs/QA_FINDINGS.md.

## 0.1.0

Initial release.

- **Instant flake detection**: `flakefinder run -- <cmd>` re-runs failing
  attempts and separates retry-rescued flakes from deterministic failures with
  distinct exit codes.
- **History-based scoring**: append-only JSONL history; same-commit flips,
  retry rescues and flip-flop patterns combine into a 0–100 flake score with
  confidence, tags (`slow`, `recently-fixed`, `long-unseen`).
- **Parsers**: JUnit XML (pytest, jest-junit, surefire, …), Jest/vitest JSON,
  Mocha JSON, `go test -json`.
- **Quarantine**: `flakefinder quarantine add|remove|list|prune`; exclusion via
  runner flags (`--deselect` / `-t` / `--grep`), never by editing tests.
- **HTML dashboard**: single self-contained offline file
  (`flakefinder html`).
- **GitHub Action**: history cache per branch, PR comments (new vs known
  flakes with Δ), dashboard artifact, `fail-on-new-flakes` gate.
- **CI command**: `flakefinder ci` for any CI — GitHub-compatible `::warning`
  annotations + JSON report + snapshot diffing.
