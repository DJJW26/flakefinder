# Flakefinder project context and build handoff

Flakefinder is a local-first TypeScript CLI and GitHub Action that detects flaky tests from test reports and live retries. It keeps a history of test outcomes, distinguishes intermittent failures from persistent ones, and supports quarantine and CI reporting. The GitHub repository is `DJJW26/flakefinder`.

## Where to start

| Task | Start here |
| --- | --- |
| Install or use the CLI, choose report formats, interpret exit codes | [Usage](USAGE.md) |
| Understand the scoring and product behavior | [PLAN.md](PLAN.md), [technical explainer](EXPLAINER.md), and the tests in `src/engine` |
| Set up a development checkout or write cross-platform changes | [Contributing](../CONTRIBUTING.md) |
| Integrate the GitHub Action | [GitHub Action guide](github-action.md) and [action.yml](../action.yml) |
| Prepare, verify, or publish a version | [Release runbook](RELEASING.md) and [release workflow](../.github/workflows/release.yml) |
| Review release history | [Changelog](../CHANGELOG.md) and Git history |

## Code and data flow

`run` launches a test runner and collects reports. `ingest` accepts existing reports. The CLI and Action normalize parser results into records, use `HistoryStore`, classify tests with `classifyAll`, and format verdicts for people or CI. A run can contain multiple retry attempts under one `runId`. Scoring uses evidence such as outcome changes on the same code state and failures that pass on retry. The shared data contracts live in [src/types.ts](../src/types.ts).

| Area | Code and behavior |
| --- | --- |
| CLI and setup | [src/cli/index.ts](../src/cli/index.ts) registers `init`, `run`, `ingest`, `report`, `html`, `quarantine`, `ci`, `doctor`, `help`, and `version`. [src/config.ts](../src/config.ts) validates JSONC configuration and resolves paths. [src/doctor.ts](../src/doctor.ts) diagnoses setup issues. |
| Report input | [src/parsers/index.ts](../src/parsers/index.ts) detects JUnit XML, Jest/Vitest JSON, Mocha JSON, Go test JSON lines, TAP, TRX, Playwright JSON, and pytest JSON reports. [src/util/read-text.ts](../src/util/read-text.ts) handles report encodings and gzip. Real parser samples are under `tests/parsers-fixtures`. |
| Live runs | [src/runner/wrap.ts](../src/runner/wrap.ts) handles subprocesses, shell operators, retries, timeouts, and report discovery. [adapters.ts](../src/runner/adapters.ts) builds runner-specific arguments. [git-state.ts](../src/runner/git-state.ts) identifies clean and dirty code states. |
| Storage and scoring | [src/store/history-store.ts](../src/store/history-store.ts) manages the append-only JSONL history, warnings for malformed records, locking, and pruning. The default file is `.flakefinder/history.jsonl`. [src/engine/classify.ts](../src/engine/classify.ts) computes verdicts, and [stats.ts](../src/engine/stats.ts) computes duration statistics. |
| Quarantine and output | [src/quarantine/manager.ts](../src/quarantine/manager.ts) handles quarantine entries and runner exclusions. [src/report](../src/report) includes terminal, JSON, Markdown, HTML, and GitLab integration. |
| GitHub Action | [src/action/index.ts](../src/action/index.ts) wires GitHub services into [main.ts](../src/action/main.ts). The Action uses cache and baseline modules to identify new flakes, generate summaries and artifacts, and optionally comment or fail the CI step. |

## Build and verification

Use Node 24 for development. The installed CLI supports Node 18 and newer. The Action bundle targets the separate GitHub Actions Node 24 runtime. The two direct CLI runtime dependencies are `commander` and `fast-xml-parser`.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run e2e
npm run perf
node scripts/third-party-notices.mjs --check
```

- [tsup.config.ts](../tsup.config.ts) builds `dist/cli.js` for npm and the self-contained `dist/action/index.cjs` for GitHub Actions. The CLI keeps its npm dependencies external. Build output is committed. `dist/cli.js` has Git mode `100755`.
- Colocated Vitest tests are under `src`. `tests` also holds release-script tests and parser samples. Coverage gates apply to the engine, parsers, and history store.
- [scripts/e2e.mjs](../scripts/e2e.mjs) runs real Jest, pytest, and Go projects from scratch directories. Set `FF_E2E_STRICT=1` to require all three. pytest and Go need to be available locally. `FF_E2E_NOBUILD=1` uses the existing built CLI.
- [scripts/packed-smoke.mjs](../scripts/packed-smoke.mjs) accepts an absolute `.tgz` path and an expected SHA-256. It installs the tarball in a temporary directory and invokes the installed CLI shim to check ingest, report, HTML, and live retry behavior with spaced paths and redirection.

## CI and releases

[ci.yml](../.github/workflows/ci.yml) calls [verify.yml](../.github/workflows/verify.yml) and reports the stable `Release parity` check. The reusable workflow builds and packs once on Ubuntu with Node 24. Windows, Ubuntu, and macOS jobs verify the digest and install the same tarball on Node 18 and Node 24. Real runner fixtures run on all three operating systems in strict mode. Ubuntu also runs source tests on Node 22 and 26.

[release.yml](../.github/workflows/release.yml) validates the version tag, default-branch ancestry, package metadata, and changelog. It calls the same verification workflow and publishes the verified tarball with the repository’s `NPM_TOKEN`. The GitHub Release follows a successful npm publish. `scripts/release.mjs <version>` prepares reviewable local changes. Tagging and pushing the chosen version are separate maintainer steps. Follow the [release runbook](RELEASING.md) for the exact procedure.

## Verified repository snapshot

Snapshot taken November 25, 2026. Recheck refs and remote CI when resuming work.

| Ref at snapshot | Commit | State |
| --- | --- | --- |
| `origin/codex/release-parity` | `c5cd056` | Version `1.2.0` in the branch’s metadata. All 10 GitHub CI jobs passed, including Windows and Ubuntu packed installs. [CI run](https://github.com/DJJW26/flakefinder/actions/runs/45618419489) |
| `origin/main` | `660b3aa` | Version `1.1.0` in the branch’s metadata. The rebuilt bundles and Node CI updates passed all five hosted jobs. [CI run](https://github.com/DJJW26/flakefinder/actions/runs/45613967173) |
| `origin/fix/windows-parity` | `a8dfd32` | Earlier Windows parity branch. The later release gate and follow-up fixes are on `codex/release-parity`. [CI run](https://github.com/DJJW26/flakefinder/actions/runs/42587843442) |

The release-parity work is on a review branch. CI tested the `1.2.0` candidate. Check npm separately for publication status. The [arahe-dev QA branch](https://github.com/arahe-dev/flakefinder/tree/fix/r6-all) supplied the imported QA baseline and used Ubuntu CI. The original failing Linux distribution and command are unknown. The recorded parity evidence covers the tested Windows and Ubuntu environments.

## Refresh this context

Use `git status --short --branch`, `git log -1 --oneline`, and `git remote -v` to orient a fresh session. Update the dated snapshot with the exact tested commit and CI link when branch or release status changes. Keep command details in the existing usage and release guides and link them here.
