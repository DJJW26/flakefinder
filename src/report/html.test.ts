import { describe, expect, it } from 'vitest';
import type { DashboardData, DashboardRun, TestVerdict } from '../types.js';
import { renderDashboard } from './html.js';

const DATA_OPEN = '<script id="ff-data" type="application/json">';

function verdict(overrides: Partial<TestVerdict> = {}): TestVerdict {
  return {
    testId: 'jest:tests/sample.spec.ts::sample',
    suite: 'tests/sample.spec.ts',
    name: 'sample',
    classification: 'passing',
    tags: [],
    flakeScore: 0,
    confidence: 100,
    passRate: 1,
    runsObserved: 12,
    lastStatus: 'pass',
    lastSeen: '2026-10-24T10:00:00.000Z',
    medianDurationMs: 940,
    p95DurationMs: 1600,
    sameShaFlips: 0,
    retryRescues: 0,
    directionChanges: 0,
    ...overrides,
  };
}

function fixtureData(): DashboardData {
  const verdicts: TestVerdict[] = [
    verdict({
      testId: 'jest:tests/checkout.spec.ts::checkout > applies the coupon',
      suite: 'tests/checkout.spec.ts',
      name: 'checkout > applies the coupon ❄ éü ✓',
      classification: 'flaky-confirmed',
      tags: ['slow'],
      flakeScore: 88,
      confidence: 100,
      passRate: 0.62,
      runsObserved: 42,
      lastStatus: 'fail',
      lastSeen: '2026-10-24T18:22:41.000Z',
      lastMessage: 'expect(received).toBe(expected)\n\nObject.is equality\n\n- 19.99\n+ 21.99',
      medianDurationMs: 12873.5,
      p95DurationMs: 21300,
      sameShaFlips: 3,
      retryRescues: 0,
      directionChanges: 7,
    }),
    verdict({
      testId: 'jest:tests/auth.spec.ts::auth > token refresh race',
      suite: 'tests/auth.spec.ts',
      name: 'auth > token refresh race',
      classification: 'flaky-retry',
      flakeScore: 74,
      passRate: 0.81,
      runsObserved: 25,
      lastStatus: 'pass',
      medianDurationMs: 2100,
      p95DurationMs: 4400,
      retryRescues: 3,
      directionChanges: 4,
    }),
    verdict({
      testId: 'jest:tests/search.spec.ts::search › pagination',
      suite: 'tests/search.spec.ts',
      name: 'search › pagination',
      classification: 'flaky-suspected',
      tags: ['slow'],
      flakeScore: 46,
      confidence: 55,
      passRate: 0.58,
      runsObserved: 8,
      lastStatus: 'fail',
      medianDurationMs: 15400,
      p95DurationMs: 28900,
      directionChanges: 3,
    }),
    verdict({
      testId: 'jest:tests/payments.spec.ts::payments > charges card',
      suite: 'tests/payments.spec.ts',
      name: 'payments > charges card',
      classification: 'failing',
      flakeScore: 30,
      confidence: 70,
      passRate: 0.1,
      runsObserved: 12,
      lastStatus: 'fail',
      lastMessage: 'AssertionError: expected 200, got 503',
      medianDurationMs: 640,
      p95DurationMs: 900,
    }),
    verdict({
      testId: 'jest:tests/security.spec.ts::hostile',
      suite: 'tests/security.spec.ts',
      name: '</script><script>alert(1)</script> <!-- not a comment -->',
      classification: 'new-failure',
      flakeScore: 0,
      confidence: 20,
      passRate: 0,
      runsObserved: 1,
      lastStatus: 'error',
      lastMessage: '<!-- not a comment --></script><img src=x onerror=alert(2)>',
      medianDurationMs: null,
      p95DurationMs: null,
    }),
    verdict({
      testId: 'jest:tests/api.spec.ts::api > health check',
      suite: 'tests/api.spec.ts',
      name: 'api > health check',
      classification: 'passing',
      runsObserved: 60,
      medianDurationMs: 812,
      p95DurationMs: 1200,
    }),
    verdict({
      testId: 'jest:tests/login.spec.ts::login > remembers session',
      suite: 'tests/login.spec.ts',
      name: 'login > remembers session',
      classification: 'passing',
      tags: ['recently-fixed'],
      passRate: 0.97,
      runsObserved: 33,
      medianDurationMs: 1500,
      p95DurationMs: 2600,
    }),
    verdict({
      testId: 'jest:tests/legacy.spec.ts::legacy > deprecated flow',
      suite: 'tests/legacy.spec.ts',
      name: 'legacy > deprecated flow',
      classification: 'skipped',
      passRate: 1,
      runsObserved: 5,
      lastStatus: 'skip',
      medianDurationMs: null,
      p95DurationMs: null,
    }),
    verdict({
      testId: 'jest:tests/imports.spec.ts::imports > csv parser v1',
      suite: 'tests/imports.spec.ts',
      name: 'imports > csv parser v1',
      classification: 'gone',
      tags: ['long-unseen'],
      flakeScore: 12,
      passRate: 0.7,
      runsObserved: 44,
      lastStatus: 'pass',
      lastSeen: '2026-09-15T08:00:00.000Z',
    }),
    verdict({
      testId: 'jest:测试/集成/auth.spec.ts::认证流程',
      suite: '测试/集成/auth.spec.ts',
      name: '认证流程应该在令牌过期后刷新并保持会话状态（重试场景）',
      classification: 'passing',
      passRate: 0.94,
      runsObserved: 17,
      medianDurationMs: 43200,
      p95DurationMs: 61000,
    }),
    verdict({
      testId:
        'jest:tests/network.spec.ts::network > retries fetch with backoff and a very long name that should be truncated in the table view',
      suite: 'tests/network.spec.ts',
      name: 'network > retries fetch with backoff and a very long name that should be truncated in the table view',
      classification: 'flaky-confirmed',
      flakeScore: 95,
      passRate: 0.44,
      runsObserved: 88,
      lastStatus: 'fail',
      lastMessage: 'TimeoutError: exceeded 5000ms waiting for response body',
      medianDurationMs: 5100,
      p95DurationMs: 9800,
      sameShaFlips: 5,
      retryRescues: 2,
      directionChanges: 9,
    }),
    verdict({
      testId: 'jest:tests/flaky.spec.ts::flaky <!-- injector -->',
      suite: 'tests/flaky.spec.ts',
      name: 'flaky <!-- injector -->',
      classification: 'flaky-suspected',
      flakeScore: 41,
      confidence: 48,
      passRate: 0.66,
      runsObserved: 9,
      lastStatus: 'pass',
      directionChanges: 4,
    }),
  ];

  const runs: DashboardRun[] = [
    {
      runId: 'run-1',
      timestamp: '2026-10-18T09:12:00.000Z',
      commitSha: '9af31c0aa11bb22cc33dd44ee55ff66aa77bb88c',
      passCount: 214,
      failCount: 3,
    },
    {
      runId: 'run-2',
      timestamp: '2026-10-19T09:14:00.000Z',
      commitSha: '1b2c3d4e5f60718293a4b5c6d7e8f90123456789',
      passCount: 220,
      failCount: 0,
    },
    {
      runId: 'run-3',
      timestamp: '2026-10-20T09:11:00.000Z',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      passCount: 205,
      failCount: 11,
    },
    { runId: 'run-4', timestamp: '2026-10-21T09:13:00.000Z', passCount: 218, failCount: 1 },
    {
      runId: 'run-5',
      timestamp: '2026-10-22T09:10:00.000Z',
      commitSha: '4242424242424242424242424242424242424242',
      passCount: 219,
      failCount: 0,
    },
    {
      runId: 'run-6',
      timestamp: '2026-10-23T09:15:00.000Z',
      commitSha: 'abcdef0abcdef0abcdef0abcdef0abcdef0abcd',
      passCount: 211,
      failCount: 4,
    },
  ];

  return { generatedAt: '2026-10-25T14:03:22.000Z', flakefinderVersion: '0.1.0', verdicts, runs };
}

/** Raw text between the ff-data open tag and its closing tag (before any unescaping). */
function dataBlock(html: string): string {
  const start = html.indexOf(DATA_OPEN);
  expect(start).toBeGreaterThan(-1);
  const from = start + DATA_OPEN.length;
  const end = html.indexOf('</script>', from);
  expect(end).toBeGreaterThan(-1);
  return html.slice(from, end);
}

/** Parse the embedded payload exactly the way the dashboard's JS does. */
function extractData(html: string): unknown {
  return JSON.parse(dataBlock(html).replace(/<\\!/g, '<!'));
}

describe('renderDashboard', () => {
  const data = fixtureData();
  const html = renderDashboard(data);

  it('renders a complete HTML document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html');
    expect(html).toContain('<head>');
    expect(html).toContain('</head>');
    expect(html).toContain('<body>');
    expect(html).toContain('</body>');
    expect(html).toContain('</html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<title>');
  });

  it('embeds the exact input data in #ff-data (deep-equal after unescaping)', () => {
    expect(html).toContain(DATA_OPEN);
    expect(extractData(html)).toEqual(data);
  });

  it('neutralizes script-breakout sequences inside the data block', () => {
    const block = dataBlock(html);
    expect(block.toLowerCase()).not.toContain('</script');
    expect(block).not.toContain('<!--');
    // The escape round-trips: hostile strings survive verbatim as data.
    expect(extractData(html)).toEqual(data);
    // Only the two real script elements ever close: without a literal closing
    // sequence and without a raw comment-open, nothing can break out of the
    // data block, so a hostile opening tag inside it stays inert JSON text.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it('shows a summary chip for every classification and tag', () => {
    const start = html.indexOf('<nav id="ff-chips"');
    expect(start).toBeGreaterThan(-1);
    const end = html.indexOf('</nav>', start);
    const region = html.slice(start, end);
    const labels = [
      'Tests tracked',
      'Flaky (confirmed)',
      'Flaky (retry-rescued)',
      'Flaky (suspected)',
      'Failing',
      'New failure',
      'Passing',
      'Skipped',
      'Gone',
      'Slow',
      'Recently fixed',
      'Long unseen',
    ];
    for (const label of labels) {
      expect(region).toContain(label);
    }
  });

  it('renders the tests table scaffolding with sortable headers', () => {
    for (const header of [
      'Score',
      'Conf %',
      'Runs',
      'Pass rate',
      'Median',
      'Class',
      'Test',
      'Tags',
    ]) {
      expect(html).toContain(header);
    }
    expect(html).toContain('id="ff-tbody"');
    expect(html).toContain('data-key="score"');
    expect(html).toContain('data-key="name"');
  });

  it('renders an empty state when there are no verdicts', () => {
    const empty = renderDashboard({
      generatedAt: '2026-10-25T14:03:22.000Z',
      flakefinderVersion: '0.1.0',
      verdicts: [],
      runs: [],
    });
    expect(empty).toContain('No test history yet');
    expect(empty).not.toContain('id="ff-table"');
    // Header + theme toggle still exist.
    expect(empty).toContain('id="ff-toggle"');
    expect(empty).toContain(DATA_OPEN);
  });

  it('hides the runs strip when the runs array is empty', () => {
    const noRuns = renderDashboard({ ...data, runs: [] });
    expect(noRuns).toContain('No runs recorded yet');
    expect(noRuns).not.toContain('id="ff-runs"');
  });

  it('references no external resources', () => {
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    expect(html).not.toContain('@import');
    expect(html).not.toContain('fonts.googleapis');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('exposes integration marker ids', () => {
    for (const id of [
      'ff-data',
      'ff-chips',
      'ff-table',
      'ff-tbody',
      'ff-filter',
      'ff-showing',
      'ff-drawer',
      'ff-toggle',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('embeds dark theme tokens and a light theme override', () => {
    expect(html).toContain(`[data-theme='dark']`);
    expect(html).toContain(`[data-theme='light']`);
    expect(html).toContain(`#0d1117`);
  });
});

describe('dashboard truncation keeps surrogate pairs whole (QA ACT-9)', () => {
  it('midTrunc (the dashboard JS) cuts by code point', () => {
    const html = renderDashboard(fixtureData());
    const src = html.match(/function midTrunc\(s, max\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(src).toBeDefined();
    const midTrunc = new Function(`${src}; return midTrunc;`)() as (s: string, n: number) => string;
    const out = midTrunc('😀'.repeat(100), 9);
    expect(Array.from(out)).toHaveLength(9);
    expect(out).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(midTrunc('short', 9)).toBe('short');
  });
});

describe('dashboard follows prefers-color-scheme (QA ACT-16)', () => {
  const html = renderDashboard(fixtureData());

  it('CSS: light tokens apply under prefers-color-scheme: light unless dark was chosen', () => {
    const media = html.match(
      /@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme='dark'\]\) \{([\s\S]*?)\}\s*\}/,
    );
    expect(media).not.toBeNull();
    expect(media?.[1]).toContain('color-scheme: light');
    expect(media?.[1]).toContain('--bg: #f6f8fa');
    // no hard-coded theme on <html>: the media query decides before any JS runs
    expect(html).toMatch(/<html lang="en">/);
    expect(html).toContain('<meta name="color-scheme" content="dark light">');
  });

  /** Run the theme-selection snippet of the page JS against a fake DOM. */
  function pickTheme(prefersLight: boolean | null, stored: string | null): string | null {
    const src = html.match(
      / {2}\/\/ ---------- theme toggle ----------[\s\S]*?\n {2}applyTheme\(\);/,
    )?.[0];
    expect(src).toBeDefined();
    let attr: string | null = null;
    const document = {
      documentElement: {
        setAttribute: (_k: string, v: string) => {
          attr = v;
        },
      },
    };
    const window = {
      matchMedia:
        prefersLight === null
          ? undefined
          : () => ({ matches: prefersLight, addEventListener: () => {} }),
      localStorage: { getItem: () => stored, setItem: () => {} },
    };
    const $ = () => null;
    new Function('window', 'document', '$', src as string)(window, document, $);
    return attr;
  }

  it('JS: OS preference picks the theme, a stored choice wins, dark is the fallback', () => {
    expect(pickTheme(true, null)).toBe('light');
    expect(pickTheme(false, null)).toBe('dark');
    expect(pickTheme(null, null)).toBe('dark');
    expect(pickTheme(true, 'dark')).toBe('dark');
    expect(pickTheme(false, 'light')).toBe('light');
  });

  it('stays self-contained: no external resources or network calls', () => {
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|@import/);
  });
});

describe('dashboard neutralises bidi/control characters (QA ACT-17)', () => {
  const RLO = '\u202e';
  const data: DashboardData = {
    generatedAt: '2026-10-24T10:00:00.000Z',
    flakefinderVersion: '1.0.0',
    verdicts: [
      verdict({
        testId: `jest:spoof.spec.ts::safe ${RLO}gnp.exe`,
        suite: `spoof${RLO}.spec.ts`,
        name: `safe ${RLO}gnp.exe\u2066x\u2069`,
        lastMessage: `line one\r\nline ${RLO}two\n\tindented\x1b[2J`,
        classification: 'flaky-confirmed',
      }),
    ],
    runs: [
      {
        runId: 'r1',
        timestamp: '2026-10-24T10:00:00.000Z',
        commitSha: `abc${RLO}`,
        passCount: 1,
        failCount: 0,
      },
    ],
  };
  const html = renderDashboard(data);

  it('the HTML file carries no raw bidi override/isolate characters', () => {
    expect(html).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it('names/suites/shas show visible escapes; messages keep their line breaks', () => {
    const parsed = extractData(html) as DashboardData;
    const v = parsed.verdicts[0] as TestVerdict;
    expect(v.name).toBe('safe \\u202egnp.exe\\u2066x\\u2069');
    expect(v.suite).toBe('spoof\\u202e.spec.ts');
    expect(v.lastMessage).toBe('line one\nline \\u202etwo\n\tindented\\x1b[2J');
    expect(parsed.runs[0]?.commitSha).toBe('abc\\u202e');
  });

  it('the testId stays exact for copy, and is escaped for display', () => {
    const parsed = extractData(html) as DashboardData;
    expect(parsed.verdicts[0]?.testId).toBe(`jest:spoof.spec.ts::safe ${RLO}gnp.exe`);
    const src = html.match(/function visible\(s\) \{[\s\S]*?\n {2}\}/)?.[0];
    expect(src).toBeDefined();
    const visible = new Function(`${src}; return visible;`)() as (s: string) => string;
    expect(visible(`a${RLO}b\x1b`)).toBe('a\\u202eb\\x1b');
    expect(html).toContain('idEl.textContent = visible(v.testId)');
    expect(html).toContain("'flakefinder quarantine add ' + visible(v.testId)");
  });
});
