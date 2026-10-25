# TASKS — ordered master checklist

Legend: ⬜ pending · 🔄 in progress · ✅ done · ⚠️ blocked. **Only the integrator updates this
file.** Agents report completion in their final message; the integrator ticks boxes.

---

## Phase 0 — Foundation (integrator)

- ✅ P0.1 Environment verified (node 22.13.1, npm 10.9.2, git 2.54, python 3.13.1, go 1.27.2)
- ✅ P0.2 `git init` on `main`
- 🔄 P0.3 PLAN.md (frozen architecture + contracts)
- ⬜ P0.4 TASKS.md (this file)
- ⬜ P0.5 Tooling scaffold: package.json, tsconfig, tsup, vitest, biome, .gitignore, LICENSE
- ⬜ P0.6 Frozen contracts: `src/types.ts`, `src/util/test-id.ts`
- ⬜ P0.7 Module stubs at every owned path (frozen signatures, trivial bodies)
- ⬜ P0.8 `npm install` (runtime: commander, fast-xml-parser; dev: typescript, tsup, vitest,
  biome, @types/node, @actions/core, @actions/github, @actions/cache, @actions/glob,
  @actions/artifact)
- ⬜ P0.9 Baseline green: `npx vitest run` passes (stub smoke tests), first commit

## Phase 1 — Parallel core build (six agents, disjoint ownership)

- ⬜ P1.1 **Agent P — parsers**: junit/jest/mocha/gotest + `detectParser`, fixture corpus,
  unit tests passing (`npx vitest run src/parsers`)
- ⬜ P1.2 **Agent E — engine + store**: stats, classify (exact PLAN §5), HistoryStore JSONL,
  unit tests passing (`npx vitest run src/engine src/store`)
- ⬜ P1.3 **Agent C — CLI + config + runner + quarantine + terminal/json reports**:
  commander CLI (all §7 commands), config loader + `src/util/glob.ts`, `runLive`,
  QuarantineManager + exclusionArgs, unit tests passing
- ⬜ P1.4 **Agent D — dashboard**: self-contained HTML dashboard per PLAN §11, unit tests
  passing (embedding, escaping, structure)
- ⬜ P1.5 **Agent A — GitHub Action**: action.yml, src/action/index.ts (§10), markdown.ts +
  buildPrComment, .github/workflows/ci.yml, docs/github-action.md, unit tests passing
- ⬜ P1.6 **Agent F — fixtures + e2e + README/USAGE draft**: three fixture projects with
  deterministic flakiness, scripts/e2e.mjs, README.md, docs/USAGE.md draft

## Phase 2 — Integration (integrator)

- ⬜ P2.1 Replace-check: every stub replaced with real implementation
- ⬜ P2.2 `npx tsc -p .` clean
- ⬜ P2.3 `npm run build` produces dist/cli.js (+executable banner) and dist/action/index.js
- ⬜ P2.4 `npx vitest run` — full suite green
- ⬜ P2.5 `npx biome check src tests --write` clean pass
- ⬜ P2.6 CLI smoke: `node dist/cli.js version|init|run|report|html|quarantine` on a scratch dir
- ⬜ P2.7 Milestone commit

## Phase 3 — E2E & verification

- ⬜ P3.1 `npm run e2e` green on jest fixture (guaranteed runtime)
- ⬜ P3.2 e2e pytest fixture (python available) green
- ⬜ P3.3 e2e go fixture (go available) green
- ⬜ P3.4 Dashboard visual pass: generate real dashboard from fixture data, render in
  browser, verify layout/interactions, fix issues
- ⬜ P3.5 Action dry review: walk action.yml + src/action against GitHub docs, verify
  inputs/outputs/caching/artifact API usage; simulate with act-like harness or mocked GITHUB_* env
- ⬜ P3.6 Commit + tag v0.1.0-rc.1

## Phase 4 — Polish & docs

- ⬜ P4.1 README final pass (badges, hero, comparison table, FAQ)
- ⬜ P4.2 LICENSE, CONTRIBUTING stub, publish checklist (npm `files`, prepublish)
- ⬜ P4.3 docs/USAGE.md finalized (every command, every flag, CI recipes)
- ⬜ P4.4 docs/BUILD_REPORT.md (architecture, mechanisms, decisions, stats)
- ⬜ P4.5 Demo GIF script (asciinema/vhs or scripted terminal capture) — best effort

## Phase 5 — Release readiness

- ⬜ P5.1 Full clean-room check: fresh clone → install → build → test → e2e
- ⬜ P5.2 `npm pack` + inspect tarball contents
- ⬜ P5.3 Release checklist: verify action dist committed, versions bumped, placeholders
  documented for the user to swap (<YOUR_GITHUB>, <YOUR_NPM>)
- ⬜ P5.4 Final commit + summary to user
