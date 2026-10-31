import { describe, expect, it } from 'vitest';
import type { ResolvedConfig, TestVerdict } from '../types.js';
import { JSON_SCHEMA_VERSION, renderJson } from './json.js';

const cfg = {
  reports: [],
  storeDir: '.flakefinder',
  maxRuns: 300,
  minRuns: 3,
  liveRetries: 2,
  flakeScoreThreshold: 30,
  slowThresholdMs: 10_000,
  slowMultiplier: 5,
  quarantineFile: 'flakefinder.quarantine.json',
  runner: 'auto',
  failOnFlakes: false,
  retryMode: 'auto',
  timeoutSeconds: null,
} as ResolvedConfig;

function verdict(over: Partial<TestVerdict> = {}): TestVerdict {
  return {
    testId: 'abc',
    suite: 's.test.ts',
    name: 'n',
    classification: 'failing',
    tags: [],
    flakeScore: 0,
    confidence: 50,
    passRate: 0,
    runsObserved: 1,
    lastStatus: 'fail',
    lastSeen: new Date().toISOString(),
    medianDurationMs: null,
    p95DurationMs: null,
    sameShaFlips: 0,
    retryRescues: 0,
    directionChanges: 0,
    ...over,
  };
}

describe('renderJson redaction (review round)', () => {
  it('redacts secrets in lastMessage, names and suites (json is a CI artifact)', () => {
    const out = renderJson(
      [
        verdict({
          name: 'Test_ghp_0123456789abcdefABCDEF0123456789abcd',
          lastMessage: 'key AKIAIOSFODNN7EXAMPLE rejected',
        }),
      ],
      cfg,
    );
    const parsed = JSON.parse(out) as { verdicts: Array<Record<string, string>> };
    expect(parsed.verdicts[0]!.name).toBe('Test_ghp_[REDACTED]');
    expect(parsed.verdicts[0]!.lastMessage).toContain('AKIA[REDACTED]');
    expect(out).not.toContain('ghp_0123456789');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('schemaVersion (QA ACT-18)', () => {
  it('is the first key and leaves the existing fields untouched', () => {
    const parsed = JSON.parse(renderJson([verdict()], cfg)) as Record<string, unknown>;
    expect(JSON_SCHEMA_VERSION).toBe(1);
    expect(Object.keys(parsed)).toEqual([
      'schemaVersion',
      'generatedAt',
      'flakefinderVersion',
      'config',
      'verdicts',
    ]);
    expect(parsed.schemaVersion).toBe(1);
    expect((parsed.verdicts as unknown[]).length).toBe(1);
  });
});
