/**
 * Secret redaction for report surfaces (PR comments, dashboards, JSON
 * reports, action summaries).
 *
 * Failure messages (and occasionally test names) routinely contain
 * credentials that leaked into test output. History (history.jsonl) stays
 * raw — the local store is the user's own machine and the debugging source
 * of truth — but everything that leaves the machine passes through redact().
 *
 * Design notes:
 * - Token patterns deliberately have NO leading `\b`: tokens embed into word
 *   contexts (`Test_ghp_…`, `TestAKIA…`) and a leading boundary would miss
 *   them. Trailing `\b` is kept so over-long runs of the same alphabet are
 *   not partially consumed.
 * - Over-redaction is accepted for credential-shaped strings, but common
 *   prose is protected: no bare `token` keyword (JSON errors legitimately
 *   contain "token <long number>"), and assignment-form values must reach
 *   12+ chars (so `password: required field` survives).
 */

interface Pattern {
  name: string;
  re: RegExp;
  replacement: string;
}

const PATTERNS: readonly Pattern[] = [
  { name: 'github-pat-classic', re: /ghp_[A-Za-z0-9]{30,}/g, replacement: 'ghp_[REDACTED]' },
  {
    name: 'github-pat-fine',
    re: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: 'github_pat_[REDACTED]',
  },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g, replacement: 'AKIA[REDACTED]' },
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-[REDACTED]' },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: 'xox[REDACTED]' },
  { name: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{20,}/g, replacement: 'glpat-[REDACTED]' },
  {
    name: 'npm-token',
    re: /npm_[A-Za-z0-9]{30,}/g,
    replacement: 'npm_[REDACTED]',
  },
  // JWT-shaped: three base64url segments
  {
    name: 'jwt',
    re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
    replacement: '[REDACTED-JWT]',
  },
  // Authorization header schemes with raw tokens. `token` is deliberately
  // absent — "Unexpected token 1234567890123456789" is ordinary JSON-error prose.
  {
    name: 'auth-header',
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{18,}/gi,
    replacement: '$1 [REDACTED]',
  },
  // Assignment forms: SECRET_KEY=... / "api_key": "..." (quoted or not). No
  // leading \b on purpose: compound names like AWS_SECRET_ACCESS_KEY have an
  // underscore before the matched fragment, which is a word char. Values must
  // reach 12+ chars so validation-error prose ("password: required") survives.
  {
    name: 'secret-assignment',
    re: /((?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"']{12,})/gi,
    replacement: '$1[REDACTED]',
  },
];

/** Replace recognized credential shapes with REDACTED markers. Idempotent. */
export function redact(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, p.replacement);
  }
  return out;
}
