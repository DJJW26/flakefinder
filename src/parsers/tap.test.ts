import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { tapParser } from './tap.js';

const load = (name: string): string =>
  readFileSync(path.join('tests', 'parsers-fixtures', name), 'utf8');

describe('tapParser', () => {
  it('sniffs TAP version headers, rejects other formats', () => {
    expect(tapParser.sniff('TAP version 13\n')).toBe(true);
    expect(tapParser.sniff('TAP version 14\r\n')).toBe(true);
    expect(tapParser.sniff('ok 1 - no header')).toBe(false);
    expect(tapParser.sniff('<xml/>')).toBe(false);
    expect(tapParser.sniff('')).toBe(false);
  });

  it('parses the node:test fixture exactly', () => {
    const { results, warnings } = tapParser.parse(load('tap-node.jsonl'), 'tap-node.jsonl');
    // 6 tests ran (matches the "# tests 6" summary); the two suite aggregates
    // ("math", "inner") are NOT emitted — their children carry the results.
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(6);

    const byName = new Map(results.map((r) => [r.name, r]));

    // leaf inside describe > describe: suite = ancestor chain
    const nested = byName.get('nested multiply')!;
    expect(nested).toMatchObject({ status: 'pass', suite: 'math > inner' });
    expect(nested.testId).toBe(makeTestId('math > inner', 'nested multiply'));

    const failing = byName.get('subtracts badly')!;
    expect(failing).toMatchObject({
      status: 'fail',
      suite: 'math',
      message: 'subtraction is broken',
    });
    expect(failing.stack).toContain('TestContext.<anonymous>');

    const skipped = byName.get('skipped one')!;
    expect(skipped).toMatchObject({
      status: 'skip',
      suite: 'math > inner',
      message: 'not ready yet',
    });

    const todo = byName.get('todo probe')!;
    expect(todo).toMatchObject({ status: 'skip', suite: 'node:test' });

    const root = byName.get('root level pass')!;
    expect(root).toMatchObject({ status: 'pass', suite: 'node:test' });
  });

  it('truncated stream: emits a warning for unclosed subtests', () => {
    const content = ['TAP version 13', '# Subtest: started', ''].join('\n');
    const { results, warnings } = tapParser.parse(content, 'inline');
    expect(results).toEqual([]);
    expect(warnings.some((w) => w.includes('never reported a result'))).toBe(true);
  });

  it('malformed diagnostic blocks degrade to warnings, never throw', () => {
    const content = [
      'TAP version 13',
      'not ok 1 - broken',
      '  ---',
      '  error: "unterminated',
      // no closing ... — block runs to EOF
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe('fail');
  });

  it('empty file → warning, no results', () => {
    const { results, warnings } = tapParser.parse('', 'empty.tap');
    expect(results).toEqual([]);
    expect(warnings[0]).toContain('file is empty');
  });
});
