import type { TestVerdict } from '../types.js';

export const PR_COMMENT_MARKER = '<!-- flakefinder:report -->';

const FLAKY_CLASSES = ['flaky-confirmed', 'flaky-retry', 'flaky-suspected'] as const;

function isFlaky(v: TestVerdict): boolean {
  return (FLAKY_CLASSES as readonly string[]).includes(v.classification);
}

/** Table-cell safe: no pipes, no newlines, capped length. */
function cell(s: string | undefined, max = 80): string {
  if (!s) return '';
  const oneLine = s.replace(/\r?\n/g, ' ');
  const out = oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
  return out.replace(/\|/g, '\\|');
}

function classLabel(v: TestVerdict): string {
  switch (v.classification) {
    case 'flaky-confirmed':
      return 'flaky ✅❌';
    case 'flaky-retry':
      return 'flaky 🔁';
    case 'flaky-suspected':
      return 'flaky ❓';
    case 'failing':
      return 'failing';
    case 'new-failure':
      return 'new failure';
    case 'passing':
      return 'passing';
    case 'skipped':
      return 'skipped';
    case 'gone':
      return 'gone';
  }
}

function table(
  rows: Array<{ v: TestVerdict; delta: string }>,
): string {
  const lines = ['| Test | Suite | Class | Score | Conf | Δ |', '| --- | --- | --- | --- | --- | --- |'];
  for (const { v, delta } of rows) {
    lines.push(
      `| ${cell(v.name, 60)} | ${cell(v.suite, 40)} | ${classLabel(v)} | ${v.flakeScore} | ${v.confidence}% | ${delta} |`,
    );
  }
  return lines.join('\n');
}

function flakeRows(verdicts: TestVerdict[]): Array<{ v: TestVerdict; delta: string }> {
  return verdicts
    .filter(isFlaky)
    .sort((a, b) => b.flakeScore - a.flakeScore)
    .map((v) => ({ v, delta: '' }));
}

/** Standalone markdown report (`flakefinder report --format md`). */
export function renderMarkdown(verdicts: TestVerdict[], opts: { flakesOnly: boolean }): string {
  const flaky = flakeRows(verdicts);
  const failing = verdicts.filter((v) => v.classification === 'failing' || v.classification === 'new-failure');
  const sections: string[] = ['## flakefinder report', ''];
  if (flaky.length > 0) {
    sections.push(`**Flaky tests: ${flaky.length}**`, '', table(flaky), '');
  } else {
    sections.push('✅ no flakes detected', '');
  }
  if (failing.length > 0) {
    sections.push(`**Deterministic failures: ${failing.length}**`, '', table(failing.map((v) => ({ v, delta: '' }))), '');
  }
  if (!opts.flakesOnly) {
    const passing = verdicts.filter((v) => v.classification === 'passing').length;
    sections.push(`_tracked: ${verdicts.length} tests · ${passing} passing_`, '');
  }
  return sections.join('\n');
}

/**
 * PR comment body (PLAN §10): marker first line so the action can upsert.
 * `previous` is the verdict snapshot from the previous CI run (null on first run).
 */
export function buildPrComment(verdicts: TestVerdict[], previous: TestVerdict[] | null): string {
  const prevFlaky = new Set((previous ?? []).filter(isFlaky).map((v) => v.testId));
  const prevScore = new Map((previous ?? []).map((v) => [v.testId, v.flakeScore]));
  const flaky = verdicts
    .filter(isFlaky)
    .sort((a, b) => b.flakeScore - a.flakeScore);
  const newFlakes = flaky.filter((v) => !prevFlaky.has(v.testId));
  const failing = verdicts.filter((v) => v.classification === 'failing' || v.classification === 'new-failure');

  const rows = flaky.map((v) => {
    if (!previous) return { v, delta: '—' };
    if (!prevFlaky.has(v.testId)) return { v, delta: '**new**' };
    const d = v.flakeScore - (prevScore.get(v.testId) ?? 0);
    return { v, delta: d === 0 ? '=' : d > 0 ? `↑${d}` : `↓${-d}` };
  });

  const out: string[] = [PR_COMMENT_MARKER, '## 🐍 flakefinder', ''];
  const summary =
    flaky.length === 0
      ? `✅ no flakes detected among ${verdicts.length} tracked tests`
      : `**${flaky.length} flaky** (${newFlakes.length} new · ${flaky.length - newFlakes.length} known) · ${failing.length} failing · ${verdicts.length} tracked`;
  out.push(summary);
  if (previous === null && flaky.length > 0) out.push('_first run — building history_');
  out.push('');

  if (flaky.length > 0) out.push(table(rows), '');

  const detailCount = Math.min(newFlakes.length, 5);
  for (let i = 0; i < detailCount; i++) {
    const v = newFlakes[i]!;
    out.push(`<details><summary><code>${cell(v.name, 60)}</code> — score ${v.flakeScore}</summary>`, '');
    out.push('````text');
    out.push((v.lastMessage ?? '(no failure message recorded)').slice(0, 400));
    out.push('````', '');
    out.push('Quarantine it:', '');
    out.push('```bash');
    out.push(`flakefinder quarantine add ${v.testId}`);
    out.push('```', '');
    out.push('</details>', '');
  }
  if (newFlakes.length > detailCount) {
    out.push(`_…and ${newFlakes.length - detailCount} more new flake(s) — see the dashboard artifact._`, '');
  }
  out.push('---', '_📊 HTML dashboard uploaded as artifact `flakefinder-dashboard` · docs: `docs/github-action.md`_');
  return out.join('\n');
}
