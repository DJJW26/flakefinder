/**
 * Runner-native "re-run only the failed tests" adapters (PLAN §8, B1).
 *
 * Targeted re-runs turn a 3×(20-minute suite) retry loop into one full run
 * plus two ~1-minute re-runs of just the failures. Selection is NAME-based
 * (not cache-based) so it works identically for jest AND vitest, and leaves
 * no dependency on a runner's internal cache state.
 *
 * Caveat (documented in USAGE): order-dependent flakes may not reproduce in
 * a targeted re-run because neighboring tests no longer run around them —
 * that is a trade-off, not a bug; `--retry-mode full` restores v0.2 behavior.
 */
import type { RunnerKind, TestCaseResult } from '../types.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex alternation matching test titles as the FINAL segment(s) of a full
 * name as jest -t / vitest -t / mocha --grep see it: describe chain + title,
 * SPACE-joined. Report names are normalized first:
 * - vitest's JUnit names join the describe chain with " > " ("suite V >
 *   broken") while -t sees "suite V broken": each " > " accepts either form;
 * - parsers trim titles, but the runner matches the raw title — a title
 *   ending in a space must still match, so callers append `\s*$`.
 */
export function titleAlternation(names: string[]): string {
  const alts = names.map((n) => escapeRegExp(n.trim()).replace(/ > /g, '(?: > | )'));
  return [...new Set(alts)].join('|');
}

/** Extract the failing tests from one attempt's records, deduped by name. */
export function failedNamesOf(records: Array<{ results: TestCaseResult[] }>): string[] {
  const names = new Set<string>();
  for (const r of records) {
    for (const t of r.results) {
      if (t.status === 'fail' || t.status === 'error') names.add(t.name);
    }
  }
  return [...names];
}

/**
 * Selector args that re-run only `failedNames`, excluding `quarantinedNames`
 * where the runner supports both in one selector. Returns null when the
 * runner has no adapter — the caller must fall back to a full re-run.
 */
export function failedOnlyArgs(
  runner: Exclude<RunnerKind, 'auto'>,
  failedNames: string[],
  quarantinedNames: string[] = [],
): string[] | null {
  if (failedNames.length === 0) return null;
  switch (runner) {
    case 'jest':
    case 'mocha': {
      // jest -t / mocha --grep match against the FULL test name
      // ("ancestors title", space-joined). Selectors are boundary-anchored:
      // a failed TITLE matches only when it is a space-delimited final
      // segment of the full name — "update" must not re-run "math re-update".
      // Quarantined names get the same anchoring in a negative lookahead so a
      // suffix collision ("login ok" vs "ui renders login ok") cannot pull a
      // quarantined test back into the re-run (two -t flags would override
      // each other, so include+exclude share one pattern).
      const include = titleAlternation(failedNames);
      const exclude = titleAlternation(quarantinedNames);
      const pattern =
        exclude !== ''
          ? `^(?=(?:.* )?(?:${include})\\s*$)(?!(?:.* )?(?:${exclude})\\s*$)`
          : `^(?:.* )?(?:${include})\\s*$`;
      return runner === 'jest' ? ['-t', pattern] : ['--grep', pattern];
    }
    case 'go': {
      // go -run matches top-level test names; subtests (TestX/sub) rerun via
      // their parent segment.
      const parents = new Set(failedNames.map((n) => (n.includes('/') ? n.split('/')[0]! : n)));
      const pattern = `^(${[...parents].map(escapeRegExp).join('|')})$`;
      return ['-run', pattern];
    }
    case 'pytest':
      // pytest --lf re-runs the last-failed set from attempt 1's own cache —
      // the only per-test selector pytest has that respects node ids.
      // Quarantined tests never entered last-failed: attempt 1 already
      // deselected them. Caveat: a stale last-failed cache from a manual
      // pytest run outside flakefinder could re-run a quarantined test (see
      // USAGE "targeted re-runs").
      return ['--lf'];
    default:
      return null; // generic: no adapter — full re-run
  }
}
