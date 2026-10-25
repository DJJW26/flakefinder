# Contributing to flakefinder

Thanks for helping make CI less flaky. This repo is intentionally small and
dependency-light — please keep it that way.

## Setup

Node 20+ for development (the vitest toolchain requires it); the published CLI
itself supports Node 18+ and CI exercises that separately.

```bash
git clone https://github.com/DJJW26/flakefinder.git
cd flakefinder
npm install
npm test          # unit tests (vitest)
npm run typecheck # tsc --noEmit
npm run lint      # biome
npm run build     # bundles dist/cli.js and dist/action/index.js
npm run e2e       # fixture end-to-end (needs go/python for those sections; jest always)
```

## Ground rules

- **No new runtime dependencies** without opening an issue first. The CLI
  bundles to a single file with exactly two runtime deps (`commander`,
  `fast-xml-parser`) — that's a feature.
- **The engine contract is PLAN.md §5.** Classification precedence, score
  arithmetic and confidence formulas are behavioral contracts covered by
  table-driven tests. If you change behavior, change PLAN.md and the tests in
  the same PR.
- **Parsers never throw.** Malformed input → `{ results: partial, warnings: [...] }`.
- **Quarantine never edits test source files.** Exclusion happens via runner
  flags only.
- **dist/ is committed.** The GitHub Action runs `dist/action/index.js` — run
  `npm run build` and commit the output (CI checks it's fresh).
- Tests are colocated (`src/**/*.test.ts`). New parser? Add a fixture report
  file under `tests/parsers-fixtures/` shaped like real tool output.

## Adding a report format

1. Create `src/parsers/<name>.ts` implementing `ReportParser` from `src/types.ts`.
2. Add real-shaped fixtures to `tests/parsers-fixtures/` (happy path + malformed).
3. Register in `src/parsers/index.ts` (`parsers` array + `detectParser` sniffing).
4. Update the format table in README.md and docs/USAGE.md.

## PR checklist

- [ ] `npm run typecheck`, `npm test`, `npm run lint` pass
- [ ] `npm run build` committed if action code changed
- [ ] PLAN.md updated if contracts changed
- [ ] No new runtime dependencies (or issue link justifying one)
