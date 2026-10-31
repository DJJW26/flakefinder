# TASKS — ordered master checklist

Legend: ⬜ pending · 🔄 in progress · ✅ done · ⚠️ blocked. **Only the integrator updates this
file.** Agents report completion in their final message; the integrator ticks boxes.

---

## Phase 0 — Foundation (integrator)

- ✅ P0.1 Environment verified (node 22.13.1, npm 10.9.2, git 2.54, python 3.13.1, go 1.27.2)
- ✅ P0.2 `git init` on `main`
- ✅ P0.3 PLAN.md (frozen architecture + contracts)
- ✅ P0.4 TASKS.md (this file)
- ✅ P0.5 Tooling scaffold: package.json, tsconfig, tsup, vitest, biome, .gitignore, LICENSE
- ✅ P0.6 Frozen contracts: `src/types.ts`, `src/util/test-id.ts`
- ✅ P0.7 Module stubs at every owned path (frozen signatures, trivial bodies)
- ✅ P0.8 `npm install` (runtime: commander, fast-xml-parser; dev: typescript, tsup, vitest,
  biome, @types/node, @actions/core, @actions/github, @actions/cache, @actions/glob,
  @actions/artifact)
- ✅ P0.9 Baseline green: tsc OK, vitest 3/3, build OK — committed `63a55cd` + amendment

## Phase 1 — Parallel core build (six agents, disjoint ownership)

> Adaptation: host concurrency limits killed 5 of 6 simultaneous agents at
> launch; the build switched to "one background agent at a time + integrator
> works the remaining scopes in the main thread". Same ownership map.

- ✅ P1.1 **parsers** (Agent P): junit/jest/mocha/gotest + `detectParser`, fixture corpus — 46 tests green
- ✅ P1.2 **engine + store** (integrator): stats, classify per PLAN §5, HistoryStore JSONL — 42 tests green
- ✅ P1.3 **CLI surface** (integrator): commander CLI (init/run/ingest/report/html/quarantine/ci/version),
  config loader + JSONC, glob matcher, runLive, QuarantineManager + exclusionArgs,
  terminal/json reports — tests green (config/glob/quarantine/terminal/runner incl. live integration)
- 🔄 P1.4 **dashboard** (Agent D, background): self-contained HTML dashboard per PLAN §11
- ✅ P1.5 **GitHub Action** (integrator): action.yml, src/action (ingest/diff/index with cache,
  PR-comment upsert, artifacts, fail gate), markdown.ts + buildPrComment, .github/workflows/ci.yml,
  docs/github-action.md — tests green (diff + markdown)
- ⬜ P1.6 **fixtures + e2e + README/USAGE draft** (Agent F, queued): three fixture projects with
  deterministic flakiness, scripts/e2e.mjs, README.md, docs/USAGE.md draft

## Phase 2 — Integration (integrator)

- ✅ P2.1 Replace-check: every stub replaced with real implementation
- ✅ P2.2 `npx tsc -p .` clean
- ✅ P2.3 `npm run build` produces dist/cli.js (113 KB, shebang) and dist/action/index.js
- ✅ P2.4 `npx vitest run` — 167/167 green across 17 files
- ✅ P2.5 `npx biome check src tests` clean (config migrated to preset)
- ✅ P2.6 CLI smoke walkthrough on a scratch dir (mixed jest/junit/go reports, quarantine, html)
- ✅ P2.7 Milestone commits (see git log)

## Phase 3 — E2E & verification

- ✅ P3.1 `node scripts/e2e.mjs` green on jest fixture (run/report/html/quarantine roundtrip)
- ✅ P3.2 e2e pytest fixture green (pytest present)
- ✅ P3.3 e2e go fixture green (shell-redirect path verified)
- ✅ P3.4 Dashboard visual pass in a real browser (structure, drawer, Esc, theme, chips,
  XSS escaping) — polish-level notes only, no defects
- ✅ P3.5 Action reviewed; history-max-runs input wired into config (was dead — caught by lint)
- ✅ P3.6 Commits through the final polish pass

## Phase 4 — Polish & docs

- ✅ P4.1 README.md with real fixture output, formats table, FAQ (Agent F)
- ✅ P4.2 LICENSE, CONTRIBUTING.md, CHANGELOG.md; npm files trimmed (85 KB tarball)
- ✅ P4.3 docs/USAGE.md exhaustive (every command/flag, scoring model, quarantine, CI recipes)
- ✅ P4.4 docs/BUILD_REPORT.md finalized with real counts
- ⬜ P4.5 Demo GIF — left as TODO placeholder (best done on a real terminal recording)

## Phase 5 — Release readiness

- ✅ P5.1 Full pipeline green: biome clean, tsc clean, 167 unit tests, build, e2e 10/10
- ✅ P5.2 `npm pack` inspected: 85.3 KB / 5 files (CLI + map + README + LICENSE + package.json)
- ✅ P5.3 dist/action/index.js committed (no sourcemap); handle placeholders (README/badges/package.json/action docs) — replaced with DJJW26 at publish time
- ✅ P5.4 Final commit + handoff summary

## Phase 6 — Post-release QA iteration (v0.1.1)

- ✅ P6.1 Adversarial + longitudinal + scale testing (concurrency limits blocked QA
  subagents; orchestrator ran the full battery in-thread)
- ✅ P6.2 FIXED: quarantine flags never reached runners via npm/yarn/pnpm (missing `--`
  separator + shell-split patterns) — spawn reworked: no-shell default, shell fallback
  with quoting, CVE-2024-27980 aware, close-race guarded (+3 tests)
- ✅ P6.3 FIXED: SHA-less histories blind to flip-flop flakes (runId-bucket fallback,
  +2 tests) — 143/143 detected in the scale repro, was 0
- ✅ P6.4 FIXED: Action `history-max-runs` dead input wired into config
- ✅ P6.5 Docs accuracy audit: 18/18 flags documented correctly; README claims verified
- ✅ P6.6 docs/QA_FINDINGS.md — fixed/open/non-bugs record; 14 open items ranked
- ✅ P6.7 All docs updated for v0.1.1 mechanisms; release tagged v0.1.1 (171 tests,
  e2e 10/10)

## Phase 7 — v0.2.0 production-hardening pack (PRODUCTION_PLAN Phase A)

- ✅ P7.1 Merged leftover job lists into a single execution order (PRODUCTION_PLAN.md, local)
- ✅ P7.2 Config schema validation (`validateConfig`, all-problems-listed errors, did-you-mean runner hints) + tests
- ✅ P7.3 Secret redaction for PR comments + dashboard artifacts (`src/util/redact.ts`) + tests
- ✅ P7.4 `--threshold` consistency between table and md reports + tests
- ✅ P7.5 Go dangling-run crash coverage (synthesized error results) + tests
- ✅ P7.6 UX debts: `html -o` mkdir, command-not-found message
- ✅ P7.7 Store schema version header + legacy tolerance + PLAN.md §4 sync + tests
- ✅ P7.8 Full pipeline green (193 tests / 18 files, tsc, biome, build, e2e 10/10)
- ✅ P7.9 Independent reviewer pass: 12 verified findings (3 MAJOR), ALL fixed + regression-tested (193 → 205 tests)
- ✅ P7.10 Release v0.2.0 (version bump both places, tag, push, CI green)

## Phase 8 — QA round 2 → v0.2.1

- ✅ P8.1 Independent QA agent (~35 probes, round-2 surfaces): 6 findings (4 MAJOR), all double-verified
- ✅ P8.2 FIX: stale-report + rescued exit code → exit 1 (evidence not erased by finalAttempt gating)
- ✅ P8.3 FIX: quarantine flags join runner segment before shell operators; shell-mode uses quoted argv (^-eating bug)
- ✅ P8.4 FIX: --fail-on-flake fires on suite-level flakes
- ✅ P8.5 FIX: vitest status:"skipped" mapped to skip
- ✅ P8.6 FIX: BOM-prefixed configs; namespace-prefixed JUnit XML
- ✅ P8.7 Engine edge-case suite promoted to permanent tests; ci reuses computeNewFlakes
- ✅ P8.8 Release v0.2.1 (217 tests / 20 files, pipeline green)

## Phase 9 — Overnight loop: Phase B → v0.3.0

- ✅ P9.1 B1 targeted failed-only re-runs (adapters, operator-aware insertion, --retry-mode, retryMode config+validation) + 11 tests
- ✅ P9.2 B2 stat-first report change detection (sha256 only on size+mtime change); B3 walk-once REJECTED (walks catch newly created reports)
- ✅ P9.3 B4 store load without full-file string-array duplicate
- ✅ P9.4 B5 perf smoke (scripts/perf-smoke.mjs, 150k obs, CI-wired) + B6 coverage gate (≥85% engine/parsers/store)
- ✅ P9.5 B1 adversarial QA agent (28 probes): 6 findings (1 CRITICAL, 2 HIGH/MEDIUM×2) — ALL fixed + regression tests:
  --retry-mode wiring (was dead), quarantine-aware boundary-anchored selectors, whole-token operator detection + quote-all shell model, fallback message split, pytest --lf caveat documented
- ✅ P9.6 Pipeline: 230 tests / 21 files, tsc, biome, e2e 10/10, perf 90/98 ms
- ✅ P9.7 Release v0.3.0

## Phase 10 — Watchdog continuation: Phase C → v1.0.0

- ✅ P10.0 Watchdog run started (cron automation, lock-guarded); v0.3.0 CI confirmed green on first check
- ✅ P10.1 C1 store advisory write lock (serialize appends/prune across CI shards; stale-lock steal; busy error) + 3 tests
- ✅ P10.2 C2 per-attempt --timeout with process-tree kill (exit 124) + SIGINT/SIGTERM handling (exit 130) + PLAN §6/§8 + USAGE + test
- ✅ P10.3 C3 flakefinder doctor (config/runner/reports/history/git/quarantine checks, actionable hints, exit 1 on FAIL) + 4 tests
- ✅ P10.4 C5 ingest --run-id (cross-invocation retry pairs) + USAGE recipe
- ✅ P10.5 C4 release automation: scripts/release.mjs (two-place bump, changelog stub, full pipeline, tag, --push) + release.yml (npm publish w/ NPM_TOKEN guard + GitHub Release)
- ✅ P10.6 v1.0.0 release (CI + release workflow green; npm publish auto-skips without NPM_TOKEN)
- ✅ P10.7 Phase D: D5 community templates (bug/parser-request/PR) · D2 dashboard render cap 500 + show-all toggle · D1 PR comments → plain fetch + env-parsed context (octokit removed from OUR code; bundle unchanged because @actions/artifact depends on it transitively — raw blob-upload protocol rejected as fragile) · D3 TRX/TAP DEFERRED (needs real tool-output samples to avoid shipping guesswork parsers)
- ✅ P10.8 docs/CLOUD_SCALING.md — cloud migration research (competitor landscape, staged path: engine extraction → ingest API → hosted dashboard → GitHub App → self-hosted; Postgres/JSONB storage rationale; security/privacy requirements; pricing sketch)
- ✅ P10.9 OVERNIGHT_DONE — loop complete

## Phase 11 — Phase D continuation (user-resumable: state kept in TASKS + commits)

- ✅ P11.0 Continuation started (D1/D2/D5 already shipped in Phase 10; D3 un-deferred via real-output research, D4 GitLab MR notes)
- ✅ P11.1 D3a: TAP parser — fixture verified against real node 22 output; suite aggregates de-duplicated; SKIP/TODO + YAML diagnostics
- ✅ P11.2 D3b: TRX parser — documented-schema fixture (dotnet unavailable locally); className suites, ErrorInfo→error, NotExecuted→skip, TRX duration parsing
- ✅ P11.3 D4: GitLab MR notes — env-driven (src/report/gitlab.ts), marker-scoped upsert, fetch-injected tests, failures never fail the job
- ✅ P11.4 Docs: README formats table (+TAP/TRX rows), USAGE report-formats + GitLab section, CHANGELOG 1.1.0
- ✅ P11.5 v1.1.0 released via automation — CI + release workflow green on first poll (f1f9f8a)

## Phase 12 — QA round 4 fix backlog → v1.1.1

CLI QA agent findings A1–A14, parsers QA agent findings B-F1–B-F7.

- ✅ P12.1 Doctor resilience: corrupt quarantine file → FAIL instead of crash; git probe bounded by a 5 s timeout (39fcc76)
- ✅ P12.2 Engine: runId-grouped chronological ordering — retry pairs no longer split by same-timestamp interleaving (e8db1b1)
- ✅ P12.3 A1 retry attempts re-record all matched reports; USAGE re-record semantics (9857481, b8b0899)
- ✅ P12.4 A2 prune re-reads fresh state under the lock; early return uses the fresh count (9d7e96a, 3c988f1, 4b345fd)
- ✅ P12.5 A3 init --runner validated against the runner enum (21dd038)
- ✅ P12.6 B-F7 TAP t.test() parents no longer double-emit (3fbe679)
- ✅ P12.7 B-F1 mocha passes/failures-only shape (fa5e19b) · B-F2 TAP directives case-insensitive (89e32e5) · B-F6 duplicate XML roots warn + first root (e1c584e) · B-F5 TRX day-inclusive durations (67c9c3d) · B-F4 TAP backslash-# unescape (36a575a, 0203c15)
- ✅ P12.8 A4 store read paths no longer create directories (baad00d)
- ✅ P12.9 A5 history.jsonl as a directory / unreadable: HistoryStore.unreadable, actionable write error, doctor FAIL; fixes d50c991's broken test import (21f9f7f)
- ✅ P12.10 A6 ingest dedupes explicitly-passed files; black-box CLI test harness src/cli/cli.test.ts (79f4adb)
- ✅ P12.11 A7 strict integer parsing for -R/--timeout/--attempt/--threshold (parseStrictInt) (2e1738a)
- ✅ P12.12 A8 -R out-of-range blames the flag, not the config; USAGE 0–10 range (7e8521c)
- ✅ P12.13 A10 commander usage errors print once (10d5fc7)
- ✅ P12.14 A11 unstartable test command exits 2, no retries, nothing recorded (8d1a9a5)
- ✅ P12.15 A9 symlink/junction limitation documented (deliberate) (46029a0)
- ✅ P12.16 A14 ingest --run-id documented in USAGE (25f5f0b)
- ✅ P12.17 Biome clean (unused TAP binding) (77326e7)
- ✅ P12.18 Pipeline: 316 tests / 29 files, tsc clean, biome clean, e2e 10/10, perf 51/55 ms; concurrency re-check 5/5 (two simultaneous ingests, all records survive)
- ✅ P12.19 CHANGELOG 1.1.1 (646923d); version 1.1.1 + rebuilt dist (627ead7) — not tagged, not pushed
