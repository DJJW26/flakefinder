# flakefinder

**Find flaky tests locally and track them in CI.**

[![CI](https://github.com/DJJW26/flakefinder/actions/workflows/ci.yml/badge.svg)](https://github.com/DJJW26/flakefinder/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/flakefinder)](https://www.npmjs.com/package/flakefinder)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

flakefinder wraps your existing test command and shows which tests passed on
retry and which failures persisted. In CI, it reads the reports your tests
already produce and builds a history you can review in the terminal, an HTML
dashboard, or GitHub pull requests.

## Who it’s for

If your team regularly reruns red builds, flakefinder can show which tests
repeatedly cost you time. It accepts mixed report formats, including Playwright
JSON, pytest reports, and Go test output, so you can use it across a repo with
multiple test runners. The CLI stores history locally and requires no hosted
account or separate service.

## How it works

Two modes, one history store.

**INSTANT — `flakefinder run -- <command>`**
Wraps your command and re-runs it when it fails (up to `--retries` extra
attempts). A test that fails on attempt 1 and passes on attempt 2 of the same
invocation was *rescued by a retry*. A test that still fails on the final
attempt is reported as a persistent failure. The exit code lets CI distinguish
a run with only retry-rescued tests from one with failures still present.

**HISTORY — `flakefinder ingest` / `report` / `html`**
Every parsed run lands in an append-only JSONL store (`.flakefinder/history.jsonl`).
The engine replays each test's timeline and classifies it: same-commit flips
(failed *and* passed on one commit — the strongest possible signal), retry
rescues, and flip-flop patterns across commits (or across runs, when no git
metadata exists) each count toward a 0–100 flake score with a confidence
value. Weeks of CI runs turn into a ranked list of worst offenders.

### Classification

| Verdict | Meaning |
|---|---|
| `FLAKY (confirmed)` | observed both a failure and a pass on the same commit |
| `FLAKY (retry-rescued)` | failed, then passed on a retry of the same run |
| `FLAKY (suspected)` | result flipped ≥ 2 times across commits/runs; score-gated |
| `FAILING` | last 5 observations all failed |
| `NEW FAILURE` | failed on the latest run, not enough data yet to say more |
| passing / skipped / gone | healthy, always-skipped, not seen in 30 runs |

Tags: `slow` (median over `slowThresholdMs`, or p95 far above the suite
median), `recently-fixed` (failed historically, stably passing now),
`long-unseen`.

## Quickstart

Your test runner must emit a machine-readable report (one flag — see the
table below). Then:

```console
$ npx flakefinder init
created flakefinder.config.json (runner: jest)

next step — make your runner emit machine-readable reports:
  jest: add the jest-junit reporter (npm i -D jest-junit), jest.config:
    reporters: ['default', ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }]]

$ npx flakefinder run -- npm test
flakefinder: attempt 1/3 → npm test
  … your normal test output — attempt 1 fails …
flakefinder: attempt 2/3 → npm test
  … the flaky test passes this time; the other test still fails …
flakefinder: attempt 3/3 → npm test
  … the other test still fails on the final attempt …

flakefinder — 5 tracked test(s), 2 need attention

FLAKY (confirmed) — 1
   90  conf 100%  runs   3  pass  33%  med    1ms  flaky-counter fails on odd counts :: flaky-counter fails on odd counts

FAILING — 1
    0  conf  40%  runs   3  pass   0%  med    2ms  always-fail fails deterministically :: always-fail fails deterministically

ok: 3 passing · 0 skipped · 0 gone from recent runs

next steps:
  • quarantine the worst offender:
      flakefinder quarantine add b6930d21e68e49f7
  • full interactive report: flakefinder html

$ echo $?
1        # a failure persisted through the final attempt

$ npx flakefinder report          # terminal table from accumulated history
$ npx flakefinder report --flakes-only --no-color   # CI-friendly, problems only
$ npx flakefinder html            # writes flakefinder-report.html — open it
```

<!-- TODO: screenshot: terminal report -->

The sample above is the real output of this repo's jest fixture
(`fixtures/jest-project`), where `flaky-counter` fails on odd invocations by
design and `always-fail` never passes.

<!-- TODO: screenshot: dashboard -->

## Supported report formats

| Format | Runners | How to make your runner emit it |
|---|---|---|
| JUnit XML | pytest, Jest (jest-junit), vitest (junit reporter), Maven/surefire, anything JUnit-shaped | pytest: `--junitxml=junit.xml` · jest: `reporters: ['default', ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }]]` |
| Jest JSON | Jest, vitest (`--json` stream) | `jest --json --outputFile=jest.json` (flakefinder also accepts jest-junit XML) |
| Mocha JSON | Mocha, mocha-wrapper runners | `mocha --reporter json --reporter-options output=test-results/report.json` |
| go test -json | Go | `go test -json ./... > test-output.jsonl` (add `-count=1` to defeat Go's result cache) |
| TAP | node:test (`--test-reporter=tap`), TAP14 producers | `node --test --test-reporter=tap > tap.txt` |
| TRX | .NET (`dotnet test`), VSTest | `dotnet test --logger "trx;LogFileName=results.trx"` |
| Playwright JSON | Playwright (per-attempt retries) | `PLAYWRIGHT_JSON_OUTPUT_NAME=pw.json npx playwright test --reporter=json` |
| pytest-json-report | pytest with the `pytest-json-report` plugin | `pytest --json-report --json-report-file=report.json` |

Reports may be UTF-8 or UTF-16 (e.g. PowerShell `>` output) and may be gzip-compressed.

The parser is auto-detected per file from its content, so mixed reports in one
repo are fine. Point `flakefinder.config.json` → `reports` globs at them.

## GitHub Action

```yaml
      - run: npm test            # your tests write report files
      - name: flakefinder
        uses: DJJW26/flakefinder@f1bc4dd92ad2a11ac49d74d7ac272f9f25e11d7f
        if: always()
        with:
          fail-on-new-flakes: 'false'
```

The action caches `.flakefinder/` between runs (history-aware verdicts),
comments on PRs with **new vs known** flakes, uploads the HTML dashboard as an
artifact, and can fail the job when *new* flakes appear. Matrix legs keep
separate histories automatically. Full input/output reference, matrix and
monorepo recipes: [docs/github-action.md](docs/github-action.md).

Start with reporting and review the results from your own suite before
enabling `fail-on-new-flakes`. The example pins a full commit SHA from `main`
so each workflow run uses the same Action code.

## Quarantine

```console
$ npx flakefinder quarantine add b6930d21e68e49f7 --reason "order-dependent"
quarantined flaky-counter fails on odd counts :: flaky-counter fails on odd counts (flaky-confirmed, score 90)

$ npx flakefinder quarantine list
1 quarantined test(s):
  b6930d21e68e49f7  flaky-counter fails on odd counts :: flaky-counter fails on odd counts  (score 90, order-dependent)
next run will add: -t ^(?!.*(?:flaky-counter fails on odd counts))

$ npx flakefinder run -- npm test     # quarantined tests are now excluded
$ npx flakefinder quarantine remove b6930d21e68e49f7
$ npx flakefinder quarantine prune    # releases entries with positive evidence of health
```

Exclusion is done with runner flags — `pytest --deselect`, `jest -t`,
`mocha --grep` — computed from the quarantine list at run time. flakefinder
**never edits your test files**; remove the entry and the test is back.
Package-manager wrappers forward the flags using the package manager's
argument rules. For example, npm uses `--` and pnpm forwards the flags directly. For `go` there is no per-test exclusion flag: entries are
tracked and reported, but not auto-excluded.

## Design principles

- **Local-first.** The CLI keeps test history on disk. The optional GitHub
  Action uses GitHub for caching, dashboard artifacts, and PR comments.
- **Small CLI.** A single entry file with two direct runtime dependencies
  (`commander` and `fast-xml-parser`), installed by npm.
- **Exit codes you can script.** For `run`, `0` means clean or retry-rescued
  tests only, `1` means a failure persisted, and `2` means a usage or
  environment error.
- **Deterministic.** Classification, scores, and confidence are transparent
  rules over your history — no AI, no randomness, same input → same verdict.

## FAQ

**How much overhead does `run` add?**
Retries run only after a failed attempt. By default, supported runners retry
just the failed tests and other runners retry the full command. A green suite
runs once. Set the retry limit with `-R` or `liveRetries`, or ingest reports
directly to skip live retries.

**What happens when tests get renamed?**
Identity is `sha256(suite + name)`, so a rename forks history: the old test
goes `gone`, the new one starts fresh. Live with it by renaming deliberately
(fresh history is honest), or keep names stable and change the *assertions*.

**Monorepo support?**
Yes — run each package with `--cwd <dir>` (config, reports, and store resolve
relative to it), or use the Action's `working-directory` input. Each package
keeps its own history store.

**Does it modify my tests or my runner config?**
No. `init` writes one new file (`flakefinder.config.json`), `run` only reads
report files your runner writes, and quarantine works by appending runner
flags — never by editing sources. The one thing you must do yourself is turn
on machine-readable reports (one flag, shown in the table above).

**Where does my data live, and who can see it?**
`.flakefinder/history.jsonl` next to your config — plain JSON Lines, one run
per line. `cat` it, grep it, delete it, gitignore it (init reminders do).
Nothing is uploaded anywhere unless you use the GitHub Action, in which case
history lives in your repository's actions cache.

**Does it work with runner X?**
If X can emit JUnit XML, Jest JSON, Mocha JSON, `go test -json`, TAP, TRX,
Playwright JSON, or pytest-json-report,
yes — that covers most of the ecosystem.

## Development

```console
$ npm ci && npm run build           # build the CLI and Action bundles
$ npm test                          # unit tests
$ npm run e2e                       # real jest/pytest/go fixtures, end to end
```

The fixtures under `fixtures/` are three real mini-projects (Jest, pytest, Go)
with a deterministic file-counter flake — the e2e harness proves the whole
pipeline: run → retries → classify → report → dashboard → quarantine.

## Project documentation

- [Usage guide](docs/USAGE.md) for CLI commands, configuration, and report formats.
- [Project context](docs/PROJECT_CONTEXT.md) for the codebase and build map.
- [Release runbook](docs/RELEASING.md) for preparing releases and verifying Windows, Ubuntu, and macOS builds.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). The GitHub Action bundle includes third-party packages; their
licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
