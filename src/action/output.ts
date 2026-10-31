import type { TestVerdict } from '../types.js';
import { redact } from '../util/redact.js';

/** HTML-escape for job-summary table cells (@actions/core inserts them raw into <td>). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Redacted, one-line `suite :: name` label (test names are PR-author controlled). */
function label(v: TestVerdict): string {
  return `${redact(v.suite)} :: ${redact(v.name)}`.replace(/[\r\n]+/g, ' ');
}

/** Rows (without header) for the job-summary table: redacted and HTML-escaped. */
export function summaryRows(verdicts: TestVerdict[], limit = 20): string[][] {
  return verdicts
    .filter((v) => v.classification.startsWith('flaky-'))
    .sort((a, b) => b.flakeScore - a.flakeScore)
    .slice(0, limit)
    .map((v) => [escapeHtml(label(v)), escapeHtml(v.classification), String(v.flakeScore)]);
}

/**
 * Job-summary HTML. The summary is HTML, so markdown after a heading (the
 * old `**N flaky**`) rendered literally. Cells are redacted + escaped; a
 * table is only emitted when there are flakes, and rows beyond `limit` are
 * counted instead of silently dropped.
 */
export function jobSummaryHtml(
  verdicts: TestVerdict[],
  newFlakeCount: number,
  failingCount: number,
  limit = 20,
): string {
  const flakyTotal = verdicts.filter((v) => v.classification.startsWith('flaky-')).length;
  const out = [
    '<h1>flakefinder</h1>',
    `<p><strong>${flakyTotal} flaky</strong> (${newFlakeCount} new) · ${failingCount} failing · ${verdicts.length} tracked</p>`,
  ];
  if (flakyTotal === 0) {
    out.push('<p>✅ No flaky tests detected.</p>');
    return `${out.join('\n')}\n`;
  }
  out.push('<table>', '<tr><th>Test</th><th>Class</th><th>Score</th></tr>');
  for (const [label, cls, score] of summaryRows(verdicts, limit)) {
    out.push(`<tr><td>${label}</td><td>${cls}</td><td>${score}</td></tr>`);
  }
  out.push('</table>');
  if (flakyTotal > limit) {
    out.push(
      `<p><em>…and ${flakyTotal - limit} more flaky test(s) — full list in <code>flakefinder-report.json</code> (the <code>report-json</code> output).</em></p>`,
    );
  }
  return `${out.join('\n')}\n`;
}

/** setFailed message for the new-flakes gate — names redacted, one line per test. */
export function newFlakesFailure(newFlakes: TestVerdict[]): string {
  const names = newFlakes.map((v) => `  • ${label(v)} (score ${v.flakeScore})`).join('\n');
  return `flakefinder: ${newFlakes.length} NEW flaky test(s):\n${names}`;
}
