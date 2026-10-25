## What

<!-- one paragraph -->

## Why

<!-- link the issue, or explain the motivation -->

## Checklist
- [ ] `npm run typecheck` && `npm test` && `npm run lint` pass
- [ ] New behavior has tests (table-driven where it's engine logic)
- [ ] New parser → fixture file in `tests/parsers-fixtures/` shaped like REAL tool output
- [ ] Contracts changed → PLAN.md updated in the same commit
- [ ] `npm run build` run and dist/ committed (Action runs it)
- [ ] No new runtime dependencies (or a linked issue justifying one)
