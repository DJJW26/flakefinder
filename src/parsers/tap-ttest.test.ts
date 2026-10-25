import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tapParser } from './tap.js';

const load = (name: string): string =>
  readFileSync(path.join('tests', 'parsers-fixtures', name), 'utf8');

describe('tapParser — t.test() parents (QA B-F7)', () => {
  it('does not double-emit t.test() parents (no type:suite marker on those aggregates)', () => {
    const { results, warnings } = tapParser.parse(load('tap-ttest.jsonl'), 'tap-ttest.jsonl');
    expect(warnings).toEqual([]);
    // EXACTLY the two inner tests — no `node:test > failing parent` /
    // `node:test > passing parent` phantom rows.
    expect(results).toHaveLength(2);
    expect(results.map((r) => `${r.suite} :: ${r.name}`)).toEqual([
      'failing parent :: inner fail',
      'passing parent :: inner ok',
    ]);
    expect(results[0]).toMatchObject({ status: 'fail', message: 'boom' });
    expect(results[1]).toMatchObject({ status: 'pass' });
  });
});
