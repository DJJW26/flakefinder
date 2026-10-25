# flakefinder — GitHub Action

Detect and track flaky tests on every CI run. The action ingests your test
report files, updates a per-branch history cache, comments on PRs with new vs
known flakes, uploads an HTML dashboard artifact, and can fail the job when
*new* flakes appear.

## Quick start

```yaml
name: tests
on: [push, pull_request]
permissions:
  contents: read
  pull-requests: write   # needed for PR comments

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm test                       # your tests must write report files
      - name: flakefinder
        uses: <YOUR_GITHUB>/flakefinder@main
        if: always()                        # analyze even when tests fail
```

Before the first run, create a `flakefinder.config.json` in your repo (or run
`npx flakefinder init` locally and commit the result) pointing `reports` at the
files your test runner writes, e.g.:

```json
{ "reports": ["junit.xml"], "runner": "jest" }
```

## How the history cache works

The action stores history in `.flakefinder/` and persists it with
`actions/cache`:

- **Key**: `flakefinder-history-<commit sha>` (immutable per commit).
- **Restore keys**: `flakefinder-history-` prefix-matching gives you the most
  recent cache on your branch; on a new branch you inherit the default
  branch's history (warm start).
- No external service, no upload of your test data — everything stays inside
  GitHub's cache for your repository.

## Inputs

| input | default | description |
|---|---|---|
| `reports` | _(from config)_ | Comma-separated report globs; overrides `flakefinder.config.json` |
| `github-token` | `${{ github.token }}` | Token used for PR comments |
| `fail-on-new-flakes` | `false` | Fail the job when flakes appear that were not flaky in the previous run |
| `comment` | `true` | Upsert a PR comment (found via a hidden marker, never duplicated) |
| `upload-dashboard` | `true` | Upload `flakefinder-dashboard.html` as artifact `flakefinder-dashboard` |
| `history-max-runs` | `300` | History retention (number of runs) |
| `working-directory` | `.` | Directory with config + reports (monorepos) |

## Outputs

| output | description |
|---|---|
| `flaky-count` | Total flaky tests (confirmed + retry + suspected) |
| `new-flaky-count` | Flakes not flagged in the previous run |
| `failing-count` | Deterministically failing tests |
| `report-json` | Path to the full JSON verdict report |

## PR comment behavior

- One comment per PR, updated in place (marker `<!-- flakefinder:report -->`).
- Summary line: `N flaky (X new · Y known) · M failing · T tracked`.
- Table with per-test score, confidence and Δ vs the previous run.
- `<details>` blocks for up to 5 NEW flakes with the failure message and the
  exact `flakefinder quarantine add <testId>` command.

## FAQ

**Do I need the config file if I set the `reports` input?**
No — the input overrides it. The config file is still useful for local runs.

**Private repos?** Yes; the default `GITHUB_TOKEN` works. PR comments need the
`pull-requests: write` permission. Comment on fork PRs may fail (token
restrictions) — the action warns and continues.

**Monorepo?** Set `working-directory` to the package root, or give absolute-ish
globs like `packages/api/junit.xml` relative to the repo root.

**Which report formats?** JUnit XML (pytest, jest-junit, surefire, go-junit…),
Jest/vitest JSON, Mocha JSON, and `go test -json` output.

**What if my tests fail?** Add `if: always()` to the flakefinder step so it
still analyzes the reports (that's usually exactly when you want it).
