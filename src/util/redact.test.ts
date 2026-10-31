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

describe('redaction coverage (R5 #8)', () => {
  const t36 = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';

  it('redacts every GitHub token family (ghp_, gho_, ghu_, ghs_, ghr_)', () => {
    for (const p of ['ghp', 'gho', 'ghu', 'ghs', 'ghr']) {
      expect(redact(`x-access-token ${p}_${t36} used`)).toBe(`x-access-token ${p}_[REDACTED] used`);
    }
  });

  it('redacts PEM private key blocks (complete and truncated)', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\nabc+/=\n-----END RSA PRIVATE KEY-----';
    expect(redact(`loaded ${pem} ok`)).toBe('loaded [REDACTED-PRIVATE-KEY] ok');
    expect(redact('-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg')).toBe('[REDACTED-PRIVATE-KEY]');
    expect(
      redact('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbn\n-----END OPENSSH PRIVATE KEY-----'),
    ).toBe('[REDACTED-PRIVATE-KEY]');
    // public material is not a secret
    expect(redact('-----BEGIN CERTIFICATE-----')).toBe('-----BEGIN CERTIFICATE-----');
  });

  it('redacts the password in scheme://user:pass@host URLs', () => {
    expect(redact('connect postgres://app:hunter2@db:5432/x failed')).toBe(
      'connect postgres://app:[REDACTED]@db:5432/x failed',
    );
    expect(redact('git clone https://x-access-token:abc@github.com/o/r')).toBe(
      'git clone https://x-access-token:[REDACTED]@github.com/o/r',
    );
    // no credentials → untouched
    expect(redact('GET http://localhost:3000/api@v2')).toBe('GET http://localhost:3000/api@v2');
  });

  it('redacts Google API keys, Stripe live keys and AWS temporary (ASIA) keys', () => {
    expect(redact('maps AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q denied')).toBe(
      'maps AIza[REDACTED] denied',
    );
    expect(redact('stripe sk_live_51H8abcdefGHIJKLmnop rejected')).toBe(
      'stripe sk_live_[REDACTED] rejected',
    );
    expect(redact('stripe rk_live_51H8abcdefGHIJKLmnop rejected')).toBe(
      'stripe rk_live_[REDACTED] rejected',
    );
    expect(redact('sts ASIAIOSFODNN7EXAMPLE expired')).toBe('sts ASIA[REDACTED] expired');
  });

  it('redacts Azure AccountKey= and token=/secret=/password= assignments, short values too', () => {
    expect(
      redact('DefaultEndpointsProtocol=https;AccountName=dev;AccountKey=Eby8vdM02x+/K1==;Suffix=x'),
    ).toBe('DefaultEndpointsProtocol=https;AccountName=dev;AccountKey=[REDACTED];Suffix=x');
    expect(redact('GET /cb?token=abc123&page=2')).toBe('GET /cb?token=[REDACTED]&page=2');
    expect(redact('password=hunter2 rejected')).toBe('password=[REDACTED] rejected');
    expect(redact('client_secret="s3cr3t"')).toBe('client_secret="[REDACTED]"');
    expect(redact('ACCESS_TOKEN=x9')).toBe('ACCESS_TOKEN=[REDACTED]');
  });

  it('stays idempotent with the new patterns', () => {
    const s =
      'postgres://u:p@h ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 password=x AccountKey=k== -----BEGIN PRIVATE KEY-----\nx';
    const once = redact(s);
    expect(redact(once)).toBe(once);
  });

  it('leaves ordinary test names and prose alone', () => {
    const names = [
      'ghost_user can log in',
      'ASIA region pricing works',
      'tokenizer handles = signs',
      'token === undefined is rejected',
      'expect(password).toBe(undefined)',
      'secrets are hidden in the UI',
      'mailto:user@example.com is linkified',
      'parses http://example.com/path',
      'sk_test fixture loads',
      'password: required field',
      'Unexpected token 1234567890123456789 in JSON',
      'tokens=5 are minted',
    ];
    for (const n of names) expect(redact(n)).toBe(n);
  });
});
