import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { jestParser } from './jest.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('jestParser', () => {
  it('parses the multi-file fixture exactly (passes, failure, pending, suite failure)', () => {
    const { results, warnings } = jestParser.parse(load('jest.json'), 'jest.json');
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(5);

    // [0] pass with ancestorTitles
    expect(results[0]).toMatchObject({
      testId: makeTestId('Calculator > add', 'adds two numbers'),
      suite: 'Calculator > add',
      name: 'adds two numbers',
      status: 'pass',
      durationMs: 12,
    });
    expect(results[0]).not.toHaveProperty('message');

    // [1] failure with failureMessages[0] as message
    expect(results[1]).toMatchObject({
      testId: makeTestId('Calculator > divide', 'divides evenly'),
      suite: 'Calculator > divide',
      name: 'divides evenly',
      status: 'fail',
      durationMs: 8,
    });
    expect(results[1]?.message).toBe(
      'Expected: 2\nReceived: 1\n\n    at Object.<anonymous> (/repo/src/calc.test.js:23:5)\n    at Promise (native)',
    );

    // [2] pass without ancestorTitles → suite is the file path
    expect(results[2]).toMatchObject({
      testId: makeTestId('/repo/src/config.test.js', 'parses a config file'),
      suite: '/repo/src/config.test.js',
      name: 'parses a config file',
      status: 'pass',
      durationMs: 5,
    });

    // [3] pending → skip, duration null
    expect(results[3]).toMatchObject({
      suite: 'Config',
      name: 'skips legacy format',
      status: 'skip',
      durationMs: null,
    });
    expect(results[3]).not.toHaveProperty('message');

    // [4] file-level suite failure → one synthetic '(suite)' result
    expect(results[4]).toMatchObject({
      testId: makeTestId('/repo/src/util.test.js', '(suite)'),
      suite: '/repo/src/util.test.js',
      name: '(suite)',
      status: 'fail',
      durationMs: null,
    });
    expect(results[4]?.message).toMatch(/^FAIL \/repo\/src\/util\.test\.js/);
    expect(results[4]?.message).toContain('SyntaxError');
  });

  it('parses the minimal fixture (single pass, no ancestorTitles, no duration)', () => {
    const { results, warnings } = jestParser.parse(load('jest-minimal.json'), 'jest-minimal.json');
    expect(warnings).toEqual([]);
    expect(results).toEqual([
      {
        testId: makeTestId('/repo/smoke.test.js', 'works'),
        suite: '/repo/smoke.test.js',
        name: 'works',
        status: 'pass',
        durationMs: null,
      },
    ]);
  });

  it('normalizes windows file paths to forward slashes', () => {
    const content = JSON.stringify({
      testResults: [
        {
          name: 'C:\\repo\\src\\win.test.js',
          status: 'passed',
          assertionResults: [
            {
              status: 'passed',
              title: 'runs on windows',
              ancestorTitles: [],
              duration: 3,
              failureMessages: [],
            },
          ],
        },
      ],
    });
    const { results } = jestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({
      suite: 'C:/repo/src/win.test.js',
      name: 'runs on windows',
      status: 'pass',
      durationMs: 3,
    });
  });

  it('maps todo to skip and truncates messages to 2000 chars', () => {
    const longMessage = 'x'.repeat(3000);
    const content = JSON.stringify({
      testResults: [
        {
          name: '/repo/t.test.js',
          status: 'failed',
          assertionResults: [
            {
              status: 'todo',
              title: 'someday',
              ancestorTitles: [],
              failureMessages: [longMessage],
            },
          ],
        },
      ],
    });
    const { results } = jestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ name: 'someday', status: 'skip', durationMs: null });
    expect(results[0]?.message).toBe('x'.repeat(2000));
  });

  it('collects a warning instead of throwing on invalid JSON', () => {
    const { results, warnings } = jestParser.parse('{"testResults": [bro', 'bad.json');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('invalid JSON');
  });

  it('collects a warning when testResults is missing', () => {
    const { results, warnings } = jestParser.parse('{"success": true}', 'not-jest.json');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('testResults');
  });

  it('sniffs jest JSON and rejects other shapes', () => {
    expect(jestParser.sniff(load('jest.json'))).toBe(true);
    expect(jestParser.sniff(load('jest-minimal.json'))).toBe(true);
    expect(jestParser.sniff('hello world')).toBe(false);
    expect(jestParser.sniff('{"testResults": []}')).toBe(false);
    expect(jestParser.sniff(load('mocha.json'))).toBe(false);
  });
});
