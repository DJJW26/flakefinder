import { describe, expect, it } from 'vitest';
import type { TestVerdict } from '../types.js';
import { renderTerminal } from './terminal.js';

function verdict(over: Partial<TestVerdict> = {}): TestVerdict {
  return {
    testId: 'abc123',
    suite: 'src/app.test.ts',
    name: 'does the thing',
    classification: 'flaky-confirmed',
    tags: [],
    flakeScore: 72,
    confidence: 100,
    passRate: 0.55,
    runsObserved: 9,
    lastStatus: 'fail',
    lastSeen: new Date().toISOString(),
    lastMessage: 'boom',
    medianDurationMs: 4200,
    p95DurationMs: 9000,
    sameShaFlips: 1,
    retryRescues: 0,
    directionChanges: 2,
    ...over,
  };
}

describe('renderTerminal', () => {
  it('empty history → friendly onboarding, no ANSI when color off', () => {
    const out = renderTerminal([], { color: false, flakesOnly: false });
    expect(out).toContain('no test history yet');
    expect(out).toContain('flakefinder run --');
    expect(out).not.toContain('\x1b[');
  });

  it('renders a section per problem class with counts and rows', () => {
    const out = renderTerminal(
      [
        verdict(),
        verdict({ testId: 'd4', classification: 'failing', name: 'always dies', flakeScore: 0 }),
      ],
      { color: false, flakesOnly: false },
    );
    expect(out).toContain('FLAKY (confirmed) — 1');
    expect(out).toContain('FAILING — 1');
    expect(out).toContain('does the thing');
    expect(out).toContain('always dies');
    expect(out).toContain('2 tracked test(s)');
    expect(out).not.toContain('\x1b[');
  });

  it('includes the healthy summary line unless flakesOnly', () => {
    const verdicts = [
      verdict(),
      verdict({ testId: 'p1', classification: 'passing', flakeScore: 0 }),
    ];
    const withSummary = renderTerminal(verdicts, { color: false, flakesOnly: false });
    expect(withSummary).toContain('ok: 1 passing');
    const flakesOnly = renderTerminal(verdicts, { color: false, flakesOnly: true });
    expect(flakesOnly).not.toContain('ok:');
  });

  it('color mode wraps output in ANSI escapes; plain mode never does', () => {
    const colorOut = renderTerminal([verdict()], { color: true, flakesOnly: false });
    expect(colorOut).toContain('\x1b[');
    const plain = renderTerminal([verdict()], { color: false, flakesOnly: false });
    expect(plain).not.toContain('\x1b[');
  });

  it('suggests quarantining the worst flake with its testId', () => {
    const out = renderTerminal(
      [verdict({ testId: 'weak', flakeScore: 30 }), verdict({ testId: 'worst', flakeScore: 95 })],
      { color: false, flakesOnly: false },
    );
    expect(out).toContain('flakefinder quarantine add worst');
  });

  it('allRows lists passing tests; default only summarizes them', () => {
    const verdicts = [
      verdict(),
      verdict({ testId: 'p1', classification: 'passing', name: 'calm test', flakeScore: 0 }),
    ];
    const summary = renderTerminal(verdicts, { color: false, flakesOnly: false });
    expect(summary).toContain('ok: 1 passing');
    expect(summary).not.toContain('calm test');
    const all = renderTerminal(verdicts, { color: false, flakesOnly: false, allRows: true });
    expect(all).toContain('ok: 1 passing');
    expect(all).toContain('calm test');
    expect(all).toContain('PASSING — 1');
  });

  it('header counts every tracked test, not just problem rows', () => {
    const verdicts = [
      verdict(),
      verdict({ testId: 'p1', classification: 'passing' }),
      verdict({ testId: 'p2', classification: 'passing' }),
    ];
    const out = renderTerminal(verdicts, { color: false, flakesOnly: false });
    expect(out).toContain('3 tracked test(s), 1 need attention');
  });

  it('long test names are middle-truncated to keep rows readable', () => {
    const out = renderTerminal([verdict({ name: 'x'.repeat(120), suite: 's'.repeat(40) })], {
      color: false,
      flakesOnly: false,
    });
    expect(out).toContain('…');
    expect(out.split('\n').every((l) => l.length <= 160)).toBe(true);
  });
});
