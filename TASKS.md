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
- ✅ P5.3 dist/action/index.js committed (no sourcemap); placeholders <YOUR_GITHUB>/<YOUR_NPM> in
  README/badges/package.json/action docs
- ✅ P5.4 Final commit + handoff summary
