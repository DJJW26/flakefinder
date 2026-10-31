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

describe('threshold filter (v0.2.0 — table matches md behavior)', () => {
  it('drops flaky-suspected below threshold, keeps confirmed/retry/failures', () => {
    const verdicts = [
      verdict({
        testId: 'hi',
        name: 'suspected high',
        classification: 'flaky-suspected',
        flakeScore: 55,
      }),
      verdict({
        testId: 'lo',
        name: 'suspected low',
        classification: 'flaky-suspected',
        flakeScore: 10,
      }),
      verdict({
        testId: 'conf',
        name: 'confirmed low score',
        classification: 'flaky-confirmed',
        flakeScore: 50,
      }),
    ];
    const out = renderTerminal(verdicts, { color: false, flakesOnly: false, threshold: 40 });
    expect(out).toContain('suspected high');
    expect(out).not.toContain('suspected low');
    expect(out).toContain('confirmed low score'); // confirmed always shows, even at score 50
    // tracked = every test in history, independent of the threshold (QA CLI-26)
    expect(out).toContain('3 tracked test(s), 2 need attention');
    expect(out).toContain('1 flaky-suspected test(s) hidden below score 40');
  });

  it('no threshold → suspected rows always shown (run/ci surfaces unchanged)', () => {
    const out = renderTerminal([verdict({ classification: 'flaky-suspected', flakeScore: 5 })], {
      color: false,
      flakesOnly: false,
    });
    expect(out).toContain('FLAKY (suspected)');
  });
});

describe('threshold honesty (review round)', () => {
  it('reports hidden-row count instead of silently dropping', () => {
    const out = renderTerminal(
      [
        verdict({
          testId: 'lo',
          name: 'suspected low',
          classification: 'flaky-suspected',
          flakeScore: 10,
        }),
        verdict({ testId: 'p', classification: 'passing' }),
      ],
      { color: false, flakesOnly: false, threshold: 40 },
    );
    expect(out).toContain('hidden below score 40');
    expect(out).toContain('2 tracked test(s)');
  });

  it('never claims "no test history" when the store has tests but all rows are filtered', () => {
    const out = renderTerminal([verdict({ classification: 'flaky-suspected', flakeScore: 5 })], {
      color: false,
      flakesOnly: false,
      threshold: 40,
    });
    expect(out).not.toContain('no test history yet');
    expect(out).toContain('hidden below score 40');
  });
});

describe('terminal output escapes control characters (QA ACT-2)', () => {
  it('names, suites and tags cannot emit raw ESC/CR/LF/C1/bidi characters', () => {
    const v = verdict({
      suite: 'S\x1b[2J',
      name: 'n\n::error::boom\x9b31m\u202Eabc',
      classification: 'flaky-confirmed',
      tags: ['slow\x1b]8;;http://evil\x07' as TestVerdict['tags'][number]],
    });
    const out = renderTerminal([v], { color: true, flakesOnly: false });
    // our own colour codes are the only escape sequences left: SGR `ESC[<n>m`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting on control characters
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting on control characters
    expect(stripped).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
    expect(out.split('\n').some((l) => l.startsWith('::'))).toBe(false);
    expect(stripped).toContain('S\\x1b[2J');
    expect(stripped).toContain('\\x0a::error::boom\\x9b31m\\u202eabc');
    expect(stripped).toContain('slow\\x1b]8;;http://evil\\x07');
  });
});

describe('terminal output is redacted (QA ACT-3)', () => {
  it('a token in a test name or suite is not printed verbatim', () => {
    const tok = 'ghp_0123456789abcdefABCDEF0123456789abcd';
    const out = renderTerminal(
      [verdict({ name: `uses ${tok}`, suite: 'password=hunter2', classification: 'failing' })],
      { color: false, flakesOnly: false },
    );
    expect(out).not.toContain(tok);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('ghp_[REDACTED]');
  });
});

describe('terminal truncation keeps surrogate pairs whole (QA ACT-9)', () => {
  it('truncateMiddle cuts by code point', async () => {
    const { truncateMiddle } = await import('./terminal.js');
    const out = truncateMiddle('😀'.repeat(60), 48);
    expect(Array.from(out).length).toBeLessThanOrEqual(48);
    expect(out).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    const v = verdict({ name: `${'😀'.repeat(30)}x${'😀'.repeat(30)}`, classification: 'failing' });
    expect(renderTerminal([v], { color: false, flakesOnly: true })).not.toContain('�');
    expect(renderTerminal([v], { color: false, flakesOnly: true })).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
  });
});

describe('tracked count and hint text (QA CLI-26)', () => {
  it('the tracked count is the same at every threshold; the hint reads cleanly', () => {
    const verdicts = [
      verdict({ testId: 'a', name: 'a', classification: 'flaky-suspected', flakeScore: 10 }),
      verdict({ testId: 'b', name: 'b', classification: 'flaky-suspected', flakeScore: 25 }),
      verdict({ testId: 'c', name: 'c', classification: 'passing' }),
    ];
    for (const threshold of [undefined, 0, 20, 30, 100]) {
      const out = renderTerminal(verdicts, { color: false, flakesOnly: false, threshold });
      expect(out).toContain('3 tracked test(s)');
    }
    const out = renderTerminal(verdicts, { color: false, flakesOnly: false, threshold: 30 });
    expect(out).toContain(
      '2 flaky-suspected test(s) hidden below score 30 — show them with --all or a lower --threshold',
    );
    expect(out).not.toContain('raise --threshold visibility');
  });
});
