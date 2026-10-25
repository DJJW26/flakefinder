/**
 * Secret redaction for report surfaces (PR comments, dashboards).
 *
 * Failure messages routinely contain credentials that leaked into test
 * output. History (history.jsonl) stays raw — the local store is the user's
 * own machine and the debugging source of truth — but everything that leaves
 * the machine (PR comments, CI artifacts) passes through redact().
 */

interface Pattern {
  name: string;
  re: RegExp;
  replacement: string;
}

const PATTERNS: readonly Pattern[] = [
  { name: 'github-pat-classic', re: /\bghp_[A-Za-z0-9]{30,}\b/g, replacement: 'ghp_[REDACTED]' },
  {
    name: 'github-pat-fine',
    re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: 'github_pat_[REDACTED]',
  },
  { name: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: 'AKIA[REDACTED]' },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, replacement: 'sk-[REDACTED]' },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: 'xox[REDACTED]' },
  { name: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replacement: 'glpat-[REDACTED]' },
  {
    name: 'npm-token',
    re: /\bnpm_[A-Za-z0-9]{30,}\b/g,
    replacement: 'npm_[REDACTED]',
  },
  // JWT-shaped: three base64url segments
  {
    name: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    replacement: '[REDACTED-JWT]',
  },
  // Authorization headers with raw tokens
  {
    name: 'bearer',
    re: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{18,}/gi,
    replacement: '$1 [REDACTED]',
  },
  // Assignment forms: SECRET_KEY=... / "api_key": "..." (quoted or not). No
  // leading \b on purpose: compound names like AWS_SECRET_ACCESS_KEY have an
  // underscore before the matched fragment, which is a word char.
  {
    name: 'secret-assignment',
    re: /((?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|password|passwd|client[_-]?secret)["']?\s*[:=]\s*["']?)([^\s"']{8,})/gi,
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
