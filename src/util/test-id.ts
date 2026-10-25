import { createHash } from 'node:crypto';

/**
 * Stable test identity: 16-hex-char sha256 of normalized `suite` + NUL + `name`.
 * Normalization trims and collapses internal whitespace so trivial formatting
 * differences in report files don't fork a test's history.
 */
export function makeTestId(suite: string, name: string): string {
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${norm(suite)}\u0000${norm(name)}`).digest('hex').slice(0, 16);
}
