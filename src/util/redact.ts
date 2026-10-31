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
 *   contain "token <long number>"), and loose assignment forms (`key: value`,
 *   spaces allowed) must reach 12+ chars (so `password: required field`
 *   survives). Only the tight `token=…`/`secret=…`/`password=…` form is
 *   redacted at any length.
 */

interface Pattern {
  name: string;
  re: RegExp;
  replacement: string;
}

const PATTERNS: readonly Pattern[] = [
  // PEM private keys (RSA/EC/OPENSSH/PKCS#8/encrypted…) — the whole block, or
  // to the end of the text when a truncated message lost the END line.
  // Certificates and public keys are not secrets and are left alone.
  {
    name: 'pem-private-key',
    re: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    replacement: '[REDACTED-PRIVATE-KEY]',
  },
  // Credentials embedded in URLs: scheme://user:password@host — the password
  // goes, the user and host stay for debugging.
  {
    name: 'url-credentials',
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi,
    replacement: '$1[REDACTED]@',
  },
  // GitHub tokens: ghp_ (classic PAT), gho_ (OAuth), ghu_ (user-to-server),
  // ghs_ (server-to-server / GITHUB_TOKEN), ghr_ (refresh)
  { name: 'github-token', re: /(gh[pousr])_[A-Za-z0-9]{30,}/g, replacement: '$1_[REDACTED]' },
  {
    name: 'github-pat-fine',
    re: /github_pat_[A-Za-z0-9_]{20,}/g,
    replacement: 'github_pat_[REDACTED]',
  },
  // AKIA = long-lived access key id, ASIA = temporary (STS) key id. Exactly
  // 16 trailing chars: a longer all-caps run is a word, not a key id.
  {
    name: 'aws-access-key',
    re: /(AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g,
    replacement: '$1[REDACTED]',
  },
  {
    name: 'google-api-key',
    re: /AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g,
    replacement: 'AIza[REDACTED]',
  },
  {
    name: 'stripe-key',
    // live keys only: sk_test_/rk_test_ are sandbox keys, and `…_test_…` is
    // far too common in test names to match safely
    re: /\b([sr]k)_live_[0-9A-Za-z]{10,}/g,
    replacement: '$1_live_[REDACTED]',
  },
  // Azure storage / service bus connection strings
  {
    name: 'azure-account-key',
    re: /\b(AccountKey|SharedAccessKey)=[^;\s"']+/gi,
    replacement: '$1=[REDACTED]',
  },
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
  // Strict `=` assignments of token/secret/password (env dumps, query
  // strings, CLI flags) are redacted at ANY length — `password=hunter2` is a
  // real leak. Only the tight `key=value` form qualifies (no spaces, no
  // `==`), so prose and code like `token === undefined` survive.
  {
    name: 'short-assignment',
    re: /((?:token|secret|password|passwd)["']?=["']?)(?!\[REDACTED\])[^\s"'=&;,()<>[\]][^\s"'&;,()<>]*/gi,
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
