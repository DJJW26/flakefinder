import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { junitAddress, pytestJsonParser } from './pytest-json.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

// pytest-json-report.json: hand-made in the pytest-json-report 1.5 shape (no
// pytest install was available): pass, parametrized class-method failure,
// setup error, skip, xfail, a pytest-rerunfailures rescue ("rerun") and a
// module that failed to collect.
describe('pytestJsonParser (QA PAR-21)', () => {
  it('sniffs pytest-json-report only', () => {
    expect(pytestJsonParser.sniff(load('pytest-json-report.json'))).toBe(true);
    expect(pytestJsonParser.sniff('{"tests": [], "stats": {}}')).toBe(false);
    expect(pytestJsonParser.sniff('{"summary": {}, "tests": []}')).toBe(false);
  });

  it('splits nodeids exactly like pytest --junitxml (same testIds)', () => {
    expect(junitAddress('tests/test_shop.py::TestCart::test_add[a/b::c]')).toEqual({
      classname: 'tests.test_shop.TestCart',
      name: 'test_add[a/b::c]',
    });
    expect(junitAddress('test_x.py::test_y')).toEqual({ classname: 'test_x', name: 'test_y' });
    expect(junitAddress('tests/test_broken.py')).toEqual({
      classname: '',
      name: 'tests.test_broken',
    });
  });

  it('maps outcomes, messages and durations', () => {
    const { results, warnings } = pytestJsonParser.parse(load('pytest-json-report.json'), 'r.json');
    expect(results.map((r) => `${r.suite} :: ${r.name}:${r.status}`)).toEqual([
      'tests.test_shop :: test_total:pass',
      'tests.test_shop.TestCart :: test_add[2-3]:fail',
      'tests.test_shop :: test_db:error',
      'tests.test_shop :: test_skip:skip',
      'tests.test_shop :: test_known:skip',
      'tests.test_shop :: test_flips:pass',
      'pytest :: tests.test_broken:error',
    ]);
    expect(results[0]).toMatchObject({
      testId: makeTestId('tests.test_shop', 'test_total'),
      durationMs: 1, // 0.0014 s total
    });
    expect(results[0]).not.toHaveProperty('message');
    expect(results[1]).toMatchObject({ message: 'AssertionError: assert 5 == 6', durationMs: 13 });
    expect(results[1]!.stack).toContain('tests/test_shop.py:14');
    expect(results[2]).toMatchObject({ message: 'ConnectionError: db down', durationMs: 500 });
    expect(results[3]).toMatchObject({ message: 'no network' });
    expect(results[5]).toMatchObject({
      attempts: ['fail', 'pass'],
      message: 'flaky: failed, then passed on pytest-rerunfailures rerun',
    });
    expect(results[6]!.message).toContain('ImportError while importing test module');
    for (const r of results.filter((x) => x.name !== 'test_flips')) {
      expect(r).not.toHaveProperty('attempts');
    }
    expect(warnings.some((w) => w.includes('test_broken.py failed to collect'))).toBe(true);
    expect(warnings.some((w) => w.includes('FLAKY') && w.includes('test_flips'))).toBe(true);
  });

  it('warns on unknown outcomes and never throws', () => {
    const doc = {
      summary: {},
      exitcode: 1,
      tests: [null, { nodeid: 'a.py::t', outcome: 'weird' }, { outcome: 'passed' }],
    };
    const { results, warnings } = pytestJsonParser.parse(JSON.stringify(doc), 'x');
    expect(results).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(pytestJsonParser.parse('{"summary":', 'x').warnings[0]).toContain('invalid JSON');
  });
});
