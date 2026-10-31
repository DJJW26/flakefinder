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
    const nasty = `\`\`\`nested\n${'x'.repeat(500)}\n`;
    const body = buildPrComment([verdict({ lastMessage: nasty })], null);
    expect(body).toContain('<details>');
    expect(body).toContain('````text'); // outer fence longer than the nested ```
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
    expect(md).toContain('AKIA\\[REDACTED\\]'); // brackets escaped (R5 #9); renders as AKIA[REDACTED]
    expect(md).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('markdown injection is neutralised (R5 #9)', () => {
  const ZWJ = '\u200d';

  it('@mentions in names/suites do not ping anyone', () => {
    const md = renderMarkdown([verdict({ name: 'ping @octocat and @org/team', suite: '@x' })], {
      flakesOnly: true,
    });
    expect(md).not.toMatch(/@octocat|@org\/team|@x/);
    expect(md).toContain(`@${ZWJ}octocat`);
    expect(md).toContain(`@${ZWJ}org/team`);
  });

  it('link and image syntax is escaped', () => {
    const md = renderMarkdown(
      [verdict({ name: 'click [here](https://evil.example) ![x](https://evil.example/p.png)' })],
      { flakesOnly: true },
    );
    expect(md).not.toContain('[here](');
    expect(md).not.toContain('![x](');
    expect(md).toContain('\\[here\\](https://evil.example)');
  });

  it('HTML tags cannot close the details block or inject elements', () => {
    const body = buildPrComment(
      [verdict({ name: 'x</code></summary></details><img src=x onerror=1>', suite: '<b>s</b>' })],
      null,
    );
    expect((body.match(/<\/details>/g) ?? []).length).toBe(1); // only our own
    expect(body).not.toContain('<img');
    expect(body).not.toContain('<b>');
    expect(body).toContain('&lt;/details&gt;');
  });

  it('lastMessage fence is longer than any backtick run inside it', () => {
    const msg = 'before\n``````\n</details>\n@octocat\nafter';
    const body = buildPrComment([verdict({ lastMessage: msg })], null);
    expect(body).toContain('```````text\n'); // 7 > 6
    const lines = body.split('\n');
    const open = lines.indexOf('```````text');
    const close = lines.indexOf('```````', open + 1);
    expect(close).toBeGreaterThan(open);
    // the hostile content sits entirely inside the fence
    const inner = lines.slice(open + 1, close).join('\n');
    expect(inner).toContain('``````');
    expect(inner).toContain('</details>');
  });

  it('a plain message still gets a normal fence', () => {
    const body = buildPrComment([verdict({ lastMessage: 'boom' })], null);
    expect(body).toContain('```text\nboom\n```\n');
  });
});

describe('PR comment size cap (QA ACT-1)', () => {
  const many = (n: number, over: Partial<TestVerdict> = {}): TestVerdict[] =>
    Array.from({ length: n }, (_, i) =>
      verdict({ testId: `t${i}`, name: `flaky test number ${i}`, flakeScore: 50, ...over }),
    );

  it('2000 flakes: rows capped, "…and K more", body under GitHub’s 65,536 limit', () => {
    const body = buildPrComment(many(2000), null);
    expect(body.length).toBeLessThan(65_536);
    const rows = body.split('\n').filter((l) => l.startsWith('| flaky test number'));
    expect(rows).toHaveLength(50);
    expect(body).toContain('…and 1950 more flaky test(s) not shown');
    expect(body.split('\n')[0]).toBe(PR_COMMENT_MARKER);
  });

  it('hostile, escape-heavy names still fit under the hard cap with intact fences', () => {
    const name = `${'&<>[]@|'.repeat(200)}😀`.repeat(3);
    const msg = `${'`'.repeat(50)}\n${'😀'.repeat(1000)}`;
    const body = buildPrComment(many(500, { name, lastMessage: msg }), null, {
      maxRows: 500,
      maxChars: 20_000,
    });
    expect(body.length).toBeLessThanOrEqual(20_000);
    // every <details> is closed and fences are balanced
    expect((body.match(/<details>/g) ?? []).length).toBe((body.match(/<\/details>/g) ?? []).length);
    const fences = body.split('\n').filter((l) => /^`{3,}/.test(l));
    expect(fences.length % 2).toBe(0);
    // no lone surrogates anywhere
    expect(body).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(body).toMatch(/…and \d+ more flaky test\(s\) not shown/);
    expect(body.endsWith('docs: `docs/github-action.md`_')).toBe(true);
  });

  it('small runs are unchanged: every row shown, no overflow note', () => {
    const body = buildPrComment(many(3), null);
    expect(body).not.toContain('not shown');
    expect(body.split('\n').filter((l) => l.startsWith('| flaky test number'))).toHaveLength(3);
  });
});

describe('dashboard footer only when uploaded (QA ACT-13)', () => {
  it('no artifact → no claim that a dashboard was uploaded', () => {
    const body = buildPrComment([verdict()], null);
    expect(body).not.toContain('uploaded as artifact');
    expect(body).not.toContain('dashboard artifact');
    expect(body.endsWith('_docs: `docs/github-action.md`_')).toBe(true);
  });
  it('uploaded artifact → footer names it', () => {
    const body = buildPrComment([verdict()], null, { dashboardArtifact: 'flakefinder-dashboard' });
    expect(body).toContain('HTML dashboard uploaded as artifact `flakefinder-dashboard`');
  });
  it('overflow notes only point at the dashboard when it exists', () => {
    const flakes = Array.from({ length: 7 }, (_, i) => verdict({ testId: `t${i}`, name: `f${i}` }));
    expect(buildPrComment(flakes, null)).toContain('…and 2 more new flake(s) without details here');
    expect(buildPrComment(flakes, null, { dashboardArtifact: 'd' })).toContain(
      '…and 2 more new flake(s) — see the dashboard artifact',
    );
  });
});
