# Contributing to flakefinder

Thanks for helping make CI less flaky. This repo is intentionally small and
dependency-light — please keep it that way.

## Setup

Use Node 24 for development. CI also runs the source tests on Ubuntu with Node
22 and 26. The published CLI supports Node 18+, and CI installs and exercises
the npm tarball on Windows and Ubuntu with Node 18 and 24.

```bash
git clone https://github.com/DJJW26/flakefinder.git
cd flakefinder
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run e2e
```

## Ground rules

- **No new runtime dependencies** without opening an issue first. The CLI
  builds to a single entry file with two direct runtime dependencies
  (`commander` and `fast-xml-parser`).
- **The engine contract is PLAN.md §5.** Classification precedence, score
  arithmetic and confidence formulas are behavioral contracts covered by
  table-driven tests. If you change behavior, change PLAN.md and the tests in
  the same PR.
- **Parsers never throw.** Malformed input → `{ results: partial, warnings: [...] }`.
- **Quarantine never edits test source files.** Exclusion happens via runner
  flags only.
- **dist/ is committed.** The GitHub Action runs `dist/action/index.cjs`.
  Rebuild and commit changed bundles when source changes affect them. CI checks
  bundle freshness. Git should record `dist/cli.js` with mode `100755`; check
  it with `git ls-files -s -- dist/cli.js`.
- Tests are colocated (`src/**/*.test.ts`). New parser? Add a fixture report
  file under `tests/parsers-fixtures/` shaped like real tool output.

## Adding a report format

1. Create `src/parsers/<name>.ts` implementing `ReportParser` from `src/types.ts`.
2. Add real-shaped fixtures to `tests/parsers-fixtures/` (happy path + malformed).
3. Register in `src/parsers/index.ts` (`parsers` array + `detectParser` sniffing).
4. Update the format table in README.md and docs/USAGE.md.

## Cross-platform CLI checks

For changes to spawning, quoting, or filesystem behavior, test from a checkout
whose absolute path contains a space. On Windows, use PowerShell and
`cmd.exe` to exercise the npm-installed CLI shim. The invoking shell parses
your command line first. Quote spaced arguments, and use the shell's own
builtins and quoting rules when passing pipelines or redirects. CI uses
Ubuntu for the POSIX side of this check. The original failing Linux distro
and command are unknown. The reference fork is `arahe-dev/flakefinder`.

The E2E runner uses real Jest, pytest, and Go fixtures. Use the strict
mode that CI uses to require all three. Install the Go version from
`fixtures/go-project/go.mod`, put Go and Python on `PATH`, and install the
Python fixture requirements with
`python -m pip install -r fixtures/pytest-project/requirements.txt`.

| Shell | Strict E2E commands |
| --- | --- |
| PowerShell | `$env:FF_E2E_STRICT = '1'` then `npm run e2e` |
| Command Prompt | `set "FF_E2E_STRICT=1"` then `npm run e2e` |
| POSIX shell | `FF_E2E_STRICT=1 npm run e2e` |

The `ci` workflow runs the source and fixture checks and ends with the
`Release parity` check. Each workflow run packs the npm CLI once and verifies
its SHA-256 in all four Windows and Ubuntu runtime jobs. The packed checks
cover the executable users install from npm. The Action bundle and
runner-specific report identity are outside that packed CLI contract.

## Releasing (maintainers)

See [Releasing flakefinder](docs/RELEASING.md) for preparing a release PR,
checking the exact tag and artifacts, and configuring npm credentials.

## PR checklist

- [ ] `npm run typecheck`, `npm test`, `npm run lint` pass
- [ ] Changed bundles from `npm run build` committed
- [ ] Strict E2E passes for changes that affect runner or CLI behavior
- [ ] PLAN.md updated if contracts changed
- [ ] No new runtime dependencies (or issue link justifying one)
