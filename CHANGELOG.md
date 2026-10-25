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

- _(fill in before tagging — this stub is created by scripts/release.mjs)_

# Changelog

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
