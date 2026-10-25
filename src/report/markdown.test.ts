import { describe, expect, it } from 'vitest';
import type { TestVerdict } from '../types.js';
import { buildPrComment, PR_COMMENT_MARKER, renderMarkdown } from './markdown.js';

function verdict(over: Partial<TestVerdict> = {}): TestVerdict {
  return {
    testId: 'abcd1234',
    suite: 'src/app.test.ts',
    name: 'does the thing',
    classification: 'flaky-confirmed',
    tags: [],
    flakeScore: 72,
    confidence: 100,
    passRate: 0.5,
    runsObserved: 8,
    lastStatus: 'fail',
    lastSeen: new Date().toISOString(),
    lastMessage: 'AssertionError: expected 3 to be 4',
    medianDurationMs: 120,
    p95DurationMs: 400,
    sameShaFlips: 2,
    retryRescues: 0,
    directionChanges: 1,
    ...over,
  };
}

describe('renderMarkdown', () => {
  it('renders flaky table with score and empty-state variant', () => {
    const md = renderMarkdown([verdict()], { flakesOnly: false });
    expect(md).toContain('Flaky tests: 1');
    expect(md).toContain('does the thing');
    expect(md).toContain('| 72 |');
    expect(md).toContain('tracked: 1 tests');
    const clean = renderMarkdown([verdict({ classification: 'passing' })], { flakesOnly: false });
    expect(clean).toContain('no flakes detected');
  });
  it('escapes pipes in names', () => {
    const md = renderMarkdown([verdict({ name: 'a | b' })], { flakesOnly: true });
    expect(md).toContain('a \\| b');
  });
});

describe('buildPrComment', () => {
  it('marker is the first line', () => {
    const body = buildPrComment([], null);
    expect(body.split('\n')[0]).toBe(PR_COMMENT_MARKER);
  });

  it('summary counts new vs known; first-run note when no previous', () => {
    const body = buildPrComment([verdict()], null);
    expect(body).toContain('**1 flaky** (1 new · 0 known)');
    expect(body).toContain('first run — building history');
  });

  it('Δ column: new / ↑n / ↓n / = relative to previous snapshot', () => {
    const previous = [verdict({ flakeScore: 60 })];
    const current = [
      verdict({ flakeScore: 72 }), // known ↑12
      verdict({ testId: 'new1', name: 'fresh flake', flakeScore: 40 }),
      verdict({ testId: 'down', name: 'calming', flakeScore: 50 }),
    ];
    const previousFull = [
      verdict({ flakeScore: 60 }),
      verdict({ testId: 'down', name: 'calming', flakeScore: 80 }),
    ];
    const body = buildPrComment(current, previousFull);
    void previous;
    expect(body).toContain('**new**');
    expect(body).toContain('↑12');
    expect(body).toContain('↓30');
  });

  it('details block only for NEW flakes, message truncated to 400 chars, fences survive', () => {
    const nasty = `${'x'.repeat(500)}\n\`\`\`nested\n`;
    const body = buildPrComment([verdict({ lastMessage: nasty })], null);
    expect(body).toContain('<details>');
    expect(body).toContain('````text'); // four-backtick outer fence
    expect(body).toContain('flakefinder quarantine add abcd1234');
    expect(body).not.toContain('x'.repeat(450)); // truncated
  });

  it('no flakes → clean summary without tables', () => {
    const body = buildPrComment([verdict({ classification: 'passing' })], null);
    expect(body).toContain('no flakes detected among 1 tracked tests');
    expect(body).not.toContain('<details>');
  });

  it('caps details at 5 new flakes with an overflow note', () => {
    const flakes = Array.from({ length: 7 }, (_, i) => verdict({ testId: `t${i}`, name: `f${i}` }));
    const body = buildPrComment(flakes, null);
    expect((body.match(/<details>/g) ?? []).length).toBe(5);
    expect(body).toContain('…and 2 more new flake(s)');
  });
});

describe('secret redaction (v0.2.0)', () => {
  it('PR comment details redact tokens in failure messages before truncation', () => {
    const long = `token ghp_0123456789abcdefABCDEF0123456789abcd leaked — ${'pad '.repeat(200)}`;
    const body = buildPrComment([verdict({ lastMessage: long })], null);
    expect(body).not.toContain('ghp_0123456789');
    expect(body).toContain('ghp_[REDACTED]');
  });

  it('table cells are redacted too (test names can carry secrets)', () => {
    const md = renderMarkdown([verdict({ name: 'check AKIAIOSFODNN7EXAMPLE works' })], {
      flakesOnly: true,
    });
    expect(md).toContain('AKIA[REDACTED]');
    expect(md).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
