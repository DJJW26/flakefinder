import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('redacts GitHub tokens (classic + fine-grained)', () => {
    expect(redact('failed with token ghp_0123456789abcdefABCDEF0123456789abcd in output')).toBe(
      'failed with token ghp_[REDACTED] in output',
    );
    expect(redact('auth github_pat_AAAAA0123456789abcdefg failed')).toBe(
      'auth github_pat_[REDACTED] failed',
    );
  });

  it('redacts AWS access keys, OpenAI keys, Slack, GitLab, npm tokens', () => {
    expect(redact('key AKIAIOSFODNN7EXAMPLE rejected')).toBe('key AKIA[REDACTED] rejected');
    expect(redact('openai sk-proj0123456789abcdefghijklmnop failed')).toBe(
      'openai sk-[REDACTED] failed',
    );
    expect(redact('slack xoxb-123456789012-SECRET')).toBe('slack xox[REDACTED]');
    expect(redact('gitlab glpat-0123456789abcdefgHIJK denied')).toBe(
      'gitlab glpat-[REDACTED] denied',
    );
    expect(redact('npm npm_0123456789abcdefghijklmnopqrstuvwxyz bad')).toBe(
      'npm npm_[REDACTED] bad',
    );
  });

  it('redacts JWTs and Authorization headers', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N0FULk';
    expect(redact(`got 401 for ${jwt}`)).toBe('got 401 for [REDACTED-JWT]');
    expect(redact('Authorization: Bearer abcdef0123456789abcdef0123456789 expired')).toBe(
      'Authorization: Bearer [REDACTED] expired',
    );
  });

  it('redacts assignment forms (api_key=, SECRET_KEY: , etc.)', () => {
    expect(redact('using API_KEY=0123456789abcdef01 in test')).toBe(
      'using API_KEY=[REDACTED] in test',
    );
    expect(redact('config {"secret_key": "0123456789abcdef012345"} rejected')).toBe(
      'config {"secret_key": "[REDACTED]"} rejected',
    );
    expect(redact('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY failed')).toBe(
      'AWS_SECRET_ACCESS_KEY=[REDACTED] failed',
    );
  });

  it('leaves ordinary failure messages untouched', () => {
    const plain =
      'AssertionError: expected 3 to be 4\n    at Object.<anonymous> (app.test.js:12:5)';
    expect(redact(plain)).toBe(plain);
    expect(redact('cannot read properties of undefined (reading "name")')).toBe(
      'cannot read properties of undefined (reading "name")',
    );
  });

  it('is idempotent (redacted output re-redacts to itself)', () => {
    const once = redact('token ghp_0123456789abcdefABCDEF0123456789abcd leaked');
    expect(redact(once)).toBe(once);
  });

  it('does not mangle lookalike ordinary words', () => {
    // short segments that don't reach token lengths stay intact
    expect(redact('the task sk-1 completed')).toBe('the task sk-1 completed');
    expect(redact('monkey patching xoxo-brownies')).toBe('monkey patching xoxo-brownies');
  });
});

describe('redaction hardening (review round)', () => {
  it('catches tokens embedded in words (test names like Test_ghp_… / TestAKIA…)', () => {
    expect(redact('Test_ghp_0123456789abcdefABCDEF0123456789abcd')).toBe('Test_ghp_[REDACTED]');
    expect(redact('TestAKIAIOSFODNN7EXAMPLE_passes')).toBe('TestAKIA[REDACTED]_passes');
  });

  it('spares ordinary prose that used to over-redact', () => {
    expect(redact('password: required field')).toBe('password: required field');
    expect(redact('Unexpected token 1234567890123456789 in JSON')).toBe(
      'Unexpected token 1234567890123456789 in JSON',
    );
    expect(redact('access denied for user')).toBe('access denied for user');
  });
});
