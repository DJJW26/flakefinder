# QA Findings & Improvement List — flakefinder v0.1.0 → v0.1.1

> Multi-iteration QA pass (2026-10-25): adversarial black-box testing, longitudinal
> scenario simulation, scale testing, edge-case probes, and a fresh-eyes pragmatism
> audit. Every item below was verified by reproduction before being listed.

Legend: **FIXED** = already fixed & committed in this pass. **OPEN** = listed for the
next iteration, with a recommendation.

---

## Bugs found and FIXED in this pass

### 1. [MAJOR→FIXED] SHA-less histories could not detect flip-flop flakes at all

- **Repro**: in a directory with no git repo, ingest 6 alternating pass/fail runs for
  143 genuinely flaky tests (1000-test suite, every 7th flaky), then `report`.
- **Was**: 0 flakes detected. Half the flaky tests classified `new-failure`, the other
  half literally **`passing` with a 50% pass rate**. `directionChanges` only counted
  across distinct commit SHAs — with no SHAs recorded, the statistical signal was
  silently zero.
- **Fix**: observations now bucket by `commitSha ?? runId` (src/engine/classify.ts), so
  SHA-less histories get run-level flip-flop detection. Same-runId retry attempts stay
  a single bucket (no phantom changes). After the fix: **143/143 detected** as
  `flaky-suspected`, score 24, confidence 70%.
- **Tests**: +2 regression tests (`src/engine/classify.test.ts`).
- **Who this protects**: anyone running flakefinder outside git (scratch dirs, SVN, or
  CI setups where SHA capture failed) — previously a silent blind spot.

### 2. [CRITICAL→FIXED] Quarantine flags never reached the test runner through npm/yarn/pnpm

- **Repro**: quarantine a jest test whose name contains a space, then
  `flakefinder run -- npm test`.
- **Was**: two stacked failures —
  1. `npm test -t …`: npm swallows flags itself; only args after `--` are forwarded to
     the test runner. The runner never saw `-t` at all.
  2. Even for direct runners, the exclusion pattern (`^(?!.*(?:annoying flake))`) was
     passed through `shell: true` unquoted, so the shell split it at the space into
     two garbage arguments.
- **Net effect before fix**: quarantine silently did nothing on npm-style commands —
  the tool *said* "quarantine active" while every quarantined test still ran.
- **Fix** (src/runner/wrap.ts):
  - npm/yarn/pnpm/bun commands get a `--` separator inserted before exclusion flags;
  - the command now spawns **without a shell** by default (argv passes verbatim — the
    entire quoting hazard disappears), falling back to shell mode with targeted
    quoting only when the user's command contains shell operators (`>`, `|`, `&&`) or
    the spawn is refused (Windows blocks `.cmd` shims like npm without a shell —
    EINVAL since the CVE-2024-27980 fix);
  - fixed a race where the abandoned first spawn's `close` event resolved the exit
    code before the shell fallback finished.
- **Verified end-to-end**: `npm test` now receives exactly `["-t", "^(?!.*(?:annoying flake))"]`
  — one intact argument — and the run exits 0.
- **Tests**: +3 (`isPackageManagerWrapper`, `shellQuote`, npm end-to-end forwarding).

### 3. [MINOR→FIXED] Lint-caught dead code in the GitHub Action

- `history-max-runs` input was parsed but never used (prune always took config's
  `maxRuns`). Now wired through `resolveConfig`. Found by biome during the sweep.

---

## Open items (recommended for v0.1.1)

### Correctness / robustness

1. **No config validation.** `flakefinder.config.json` with wrong types
   (`maxRuns: "300"`, `runner: "Jest"`, `reports: "junit.xml"` instead of an array)
   either half-works via JS coercion or silently misbehaves (wrong-case runner falls
   to `generic` — quarantine then does nothing, without a warning).
   *Recommendation*: validate types/enum-case on load; fail fast with a table of
   valid keys. Half-day work, kills a whole class of silent misuse.
2. **`report --format md` vs `table` inconsistency.** The `--threshold` filter
   applies to `md` output but the table shows all suspected flakes regardless of
   score. *Recommendation*: unify — apply threshold to suspected rows in both (or
   neither) and document it.
3. **Go tests that never emit a terminal event** (crashed package, `run` without
   `pass|fail|skip`) are silently absent from results — a test that hard-crashes the
   Go test binary vanishes rather than being reported failed. *Recommendation*:
   emit a synthetic `error` result for `run`-events without terminal events.
4. **`ingest` across invocations can't form retry pairs** (each invocation mints a
   new runId, so fail→pass on two manual ingests counts as two observations, not a
   rescue). Documented in USAGE, but a `--run-id` flag would let users reconstruct
   retries from CI artifacts. Low effort, real CI value.
5. **Dashboard renders all rows** (no virtualization/paging). 1000 tests is fine
   (~370 KB file, instant); 10k+ rows would chug. *Recommendation*: cap initial
   render at ~500 rows with a "show all" toggle.

### Pragmatism / UX

6. **`html -o` into a nonexistent directory errors** instead of creating parents.
   `mkdir -p` behavior would remove a small stumble.
7. **`run` with a nonexistent command** prints the generic onboarding hint; leading
   with "command not found: X" would save a double-take.
8. **`flakefinder init` for generic runner writes `reports: []`** — the user's very
   next command (`ingest` with no args) then fails with "no report files matched".
   *Recommendation*: init should prompt for (or document inline) at least one glob
   example in the written config as a comment.
9. **No `flakefinder doctor`**: one command that checks "does my runner emit reports?
   did the last run ingest? is the store growing?" would kill most setup confusion
   (already on the roadmap — worth pulling forward).
10. **Quarantine UX on `generic`/`go`**: the warning is printed but easy to miss in
    test output. Consider requiring `--force` to add entries for unsupported runners.

### Nice-to-haves (unchanged from roadmap)

11. Targeted failed-only re-runs per runner (pytest `--lf`, jest `--onlyFailures`) —
    biggest remaining speed win for `run` mode.
12. TRX (.NET) and node:test TAP parsers — the two most-requested formats.
13. GitLab native MR comments.
14. `--open` on the html command is quiet no-op on headless CI (fine) but could say so.

---

## Verified non-bugs (tested, correctly resisted)

- **`ci --fail-on-new-flakes` gate**: fires exactly once per new flake (exit 1), and
  correctly stays green once the flake is known. (An initial test suggestion of a bug
  here was the tester's own pipeline masking exit codes and pre-reading snapshots.)
- **Corrupt `history.jsonl` lines**: skipped with warnings; reporting continues.
- **Longitudinal fidelity**: 15 simulated days × 2 runs/day with five test
  personalities (stable / 50% flake / 10% flake / broken-then-fixed / slow) — every
  verdict, tag, and score came out exactly right (`flaky-confirmed` 60 for both
  flakers, `recently-fixed` on the ex-bug, `slow` on the 200ms test).
- **Scale**: 1000 tests × 7 runs → report in ~0.12 s, dashboard 373 KB, no degradation.
- **Exit-code contract** through the real CLI: clean/flakes-only → 0; deterministic
  failure → 1; usage errors → 2; bare `flakefinder` → help + 0.
- **Parser abuse resistance** (0-byte files, whitespace-only, BOM, garbage): warn and
  skip, never throw.
- **Quarantine honesty**: entries for unsupported runners are informational only, and
  prune refuses to un-quarantine tests that merely went unseen (they're excluded —
  silence isn't health).
- **Documentation accuracy**: all 18 CLI flags verified present and correct in
  docs/USAGE.md against live `--help` output; README claims (85 KB package, exit-code
  table, offline dashboard, "never edits test files", formats table) verified against
  actual behavior.

---

## Verdict

The two fixed bugs were exactly the "silent lie" class that kills trust in dev tools:
quarantine claiming to work while doing nothing, and flake detection going blind
without git metadata. Both are now regression-tested. The remaining list is polish;
nothing in it blocks daily use.
