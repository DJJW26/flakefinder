// STUB — Agent A owns this file. Replace entirely (PLAN §10/§12).
import type { TestVerdict } from '../types.js';

export const PR_COMMENT_MARKER = '<!-- flakefinder:report -->';

export function renderMarkdown(_verdicts: TestVerdict[], _opts: { flakesOnly: boolean }): string {
  return `${PR_COMMENT_MARKER}\nflakefinder: markdown stub\n`;
}

export function buildPrComment(_verdicts: TestVerdict[], _previous: TestVerdict[] | null): string {
  return `${PR_COMMENT_MARKER}\nflakefinder: PR comment stub\n`;
}
