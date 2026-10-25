# Changelog

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
