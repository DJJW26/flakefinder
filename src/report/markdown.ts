import type { TestVerdict } from '../types.js';
import { redact } from '../util/redact.js';
import { escapeControlChars, truncateCodePoints } from './text.js';

export const PR_COMMENT_MARKER = '<!-- flakefinder:report -->';

const FLAKY_CLASSES = ['flaky-confirmed', 'flaky-retry', 'flaky-suspected'] as const;

function isFlaky(v: TestVerdict): boolean {
  return (FLAKY_CLASSES as readonly string[]).includes(v.classification);
}

/**
 * Neutralise untrusted text (test names, suites — anyone who can open a PR
 * controls them) for inline GitHub/GitLab markdown:
 * - HTML: `&`, `<`, `>` become entities, so `</details>`, `<img …>` or an
 *   autolink can't break out of our markup (they still render as text);
 * - link/image syntax: `[` and `]` are backslash-escaped;
 * - @mentions: a zero-width joiner after `@` stops user/team pings;
 * - table pipes are escaped.
 * Expects one line of already-redacted text.
 */
export function escapeMarkdownInline(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[[\]]/g, '\\$&')
    .replace(/@(?=[A-Za-z0-9_-])/g, '@\u200D')
    .replace(/\|/g, '\\|');
}

/** Table-cell safe: one line, capped length, secrets redacted, markdown/HTML neutralised. */
function cell(s: string | undefined, max = 80): string {
  if (!s) return '';
  // redact BEFORE truncating (a split token can't survive), escape AFTER (an
  // entity can't be cut in half)
  const oneLine = escapeControlChars(redact(s).replace(/\r?\n/g, ' '));
  return escapeMarkdownInline(truncateCodePoints(oneLine, max));
}

/**
 * A backtick fence longer than any backtick run in `content` (min 3), so
 * content can never close the code block early. Inside a fence, mentions,
 * links and HTML are inert.
 */
export function fenceFor(content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
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

function table(rows: Array<{ v: TestVerdict; delta: string }>): string {
  const lines = [
    '| Test | Suite | Class | Score | Conf | Δ |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
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
  const failing = verdicts.filter(
    (v) => v.classification === 'failing' || v.classification === 'new-failure',
  );
  const sections: string[] = ['## flakefinder report', ''];
  if (flaky.length > 0) {
    sections.push(`**Flaky tests: ${flaky.length}**`, '', table(flaky), '');
  } else {
    sections.push('✅ no flakes detected', '');
  }
  if (failing.length > 0) {
    sections.push(
      `**Deterministic failures: ${failing.length}**`,
      '',
      table(failing.map((v) => ({ v, delta: '' }))),
      '',
    );
  }
  if (!opts.flakesOnly) {
    const passing = verdicts.filter((v) => v.classification === 'passing').length;
    sections.push(`_tracked: ${verdicts.length} tests · ${passing} passing_`, '');
  }
  return sections.join('\n');
}

/** Rows shown in the PR/MR comment table; the rest are summarised in one line. */
export const PR_COMMENT_MAX_ROWS = 50;
/**
 * Hard cap on the comment body. GitHub rejects bodies over 65,536 characters
 * with a 422 (GitLab allows 1,000,000), so stay well below the smaller one.
 */
export const PR_COMMENT_MAX_CHARS = 60_000;

export interface PrCommentOptions {
  maxRows?: number;
  maxChars?: number;
  /**
   * Name of the dashboard artifact, set only when it WAS uploaded for this
   * run; the comment then points at it. Omitted → no dashboard claim.
   */
  dashboardArtifact?: string;
}

/**
 * PR comment body (PLAN §10): marker first line so the action can upsert.
 * `previous` is the verdict snapshot from the previous CI run (null on first run).
 *
 * Size-bounded: at most `maxRows` table rows and 5 details blocks, and the
 * whole body stays under `maxChars`. The body is assembled from whole lines and
 * blocks, so the cap never cuts a code fence, an HTML tag or a multibyte
 * character in half. Anything left out is counted in an "…and K more" line.
 */
export function buildPrComment(
  verdicts: TestVerdict[],
  previous: TestVerdict[] | null,
  opts: PrCommentOptions = {},
): string {
  const maxRows = opts.maxRows ?? PR_COMMENT_MAX_ROWS;
  const maxChars = opts.maxChars ?? PR_COMMENT_MAX_CHARS;
  const prevFlaky = new Set((previous ?? []).filter(isFlaky).map((v) => v.testId));
  const prevScore = new Map((previous ?? []).map((v) => [v.testId, v.flakeScore]));
  const flaky = verdicts.filter(isFlaky).sort((a, b) => b.flakeScore - a.flakeScore);
  const newFlakes = flaky.filter((v) => !prevFlaky.has(v.testId));
  const failing = verdicts.filter(
    (v) => v.classification === 'failing' || v.classification === 'new-failure',
  );

  const deltaOf = (v: TestVerdict): string => {
    if (!previous) return '—';
    if (!prevFlaky.has(v.testId)) return '**new**';
    const d = v.flakeScore - (prevScore.get(v.testId) ?? 0);
    return d === 0 ? '=' : d > 0 ? `↑${d}` : `↓${-d}`;
  };

  const head: string[] = [PR_COMMENT_MARKER, '## 🐍 flakefinder', ''];
  const summary =
    flaky.length === 0
      ? `✅ no flakes detected among ${verdicts.length} tracked tests`
      : `**${flaky.length} flaky** (${newFlakes.length} new · ${flaky.length - newFlakes.length} known) · ${failing.length} failing · ${verdicts.length} tracked`;
  head.push(summary);
  if (previous === null && flaky.length > 0) head.push('_first run — building history_');
  head.push('');
  const dashboard = opts.dashboardArtifact;
  const footer = [
    '---',
    dashboard
      ? `_📊 HTML dashboard uploaded as artifact \`${dashboard}\` · docs: \`docs/github-action.md\`_`
      : '_docs: `docs/github-action.md`_',
  ];
  const seeMore = dashboard ? ' — see the dashboard artifact' : '';

  // budget for everything between head and footer, leaving room for the
  // two "…and K more" notes (each < 200 chars)
  const size = (lines: string[]): number => lines.reduce((n, l) => n + l.length + 1, 0);
  let budget = maxChars - size(head) - size(footer) - 400;
  const body: string[] = [];

  if (flaky.length > 0) {
    const tableLines = table([]).split('\n');
    budget -= size(tableLines);
    let shown = 0;
    for (const v of flaky) {
      if (shown >= maxRows) break;
      const row = table([{ v, delta: deltaOf(v) }]).split('\n')[2]!;
      if (row.length + 1 > budget) break;
      tableLines.push(row);
      budget -= row.length + 1;
      shown++;
    }
    body.push(...tableLines);
    if (flaky.length > shown) {
      body.push(
        '',
        `_…and ${flaky.length - shown} more flaky test(s) not shown in this table${seeMore}._`,
      );
    }
    body.push('');
  }

  let detailCount = 0;
  for (const v of newFlakes.slice(0, 5)) {
    // redact BEFORE truncating so a token split by the slice can't survive partially
    const message = truncateCodePoints(
      redact(v.lastMessage ?? '(no failure message recorded)'),
      400,
    );
    const fence = fenceFor(message);
    const block = [
      `<details><summary><code>${cell(v.name, 60)}</code> — score ${v.flakeScore}</summary>`,
      '',
      `${fence}text`,
      message,
      fence,
      '',
      'Quarantine it:',
      '',
      '```bash',
      `flakefinder quarantine add ${v.testId}`,
      '```',
      '',
      '</details>',
      '',
    ];
    if (size(block) > budget) break;
    body.push(...block);
    budget -= size(block);
    detailCount++;
  }
  if (newFlakes.length > detailCount) {
    body.push(
      `_…and ${newFlakes.length - detailCount} more new flake(s)${seeMore || ' without details here'}._`,
      '',
    );
  }
  return [...head, ...body, ...footer].join('\n');
}
