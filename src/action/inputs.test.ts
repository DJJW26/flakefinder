import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheKeys } from './baseline.js';
import { InputError, normalizeHistoryKey, readInputs } from './inputs.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function base(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ff-inputs-'));
  dirs.push(d);
  return d;
}
const getter =
  (vals: Record<string, string>) =>
  (name: string): string =>
    vals[name] ?? '';

describe('action inputs are validated up front (QA ACT-15)', () => {
  it('defaults (action.yml defaults or empty) parse', () => {
    const d = base();
    const i = readInputs(getter({ 'github-token': 't' }), d);
    expect(i).toEqual({
      cwd: d,
      reports: null,
      historyMaxRuns: 300,
      comment: true,
      uploadDashboard: true,
      failOnNewFlakes: false,
      githubToken: 't',
      historyKey: '',
      workingDirectoryRel: '.',
    });
  });

  it('valid explicit values', () => {
    const d = base();
    mkdirSync(path.join(d, 'pkg'));
    const i = readInputs(
      getter({
        'working-directory': 'pkg',
        reports: 'a.xml, b/*.json ,',
        'history-max-runs': '50',
        comment: 'False',
        'upload-dashboard': 'TRUE',
        'fail-on-new-flakes': 'true',
      }),
      d,
    );
    expect(i.cwd).toBe(path.join(d, 'pkg'));
    expect(i.workingDirectoryRel).toBe('pkg');
    expect(i.reports).toEqual(['a.xml', 'b/*.json']);
    expect(i.historyMaxRuns).toBe(50);
    expect([i.comment, i.uploadDashboard, i.failOnNewFlakes]).toEqual([false, true, true]);
  });

  it('lists every bad input at once, blaming the input (not the config)', () => {
    let msg = '';
    try {
      readInputs(
        getter({
          'working-directory': 'missing-dir',
          'history-max-runs': '300abc',
          comment: 'yes',
          'fail-on-new-flakes': '1',
        }),
        base(),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(InputError);
      msg = (err as Error).message;
    }
    expect(msg).toContain('working-directory: does not exist: missing-dir');
    expect(msg).toContain('history-max-runs: expected an integer 1–100000, got "300abc"');
    expect(msg).toContain('comment: expected true or false, got "yes"');
    expect(msg).toContain('fail-on-new-flakes: expected true or false, got "1"');
  });

  it.each(['0', 'abc', '-5', '100001', '2.5'])('history-max-runs "%s" is rejected', (v) => {
    expect(() => readInputs(getter({ 'history-max-runs': v }), base())).toThrow('history-max-runs');
  });
});

describe('history-key defaults to the matrix (QA ACT-4)', () => {
  it('action.yml defaults history-key to toJSON(matrix)', () => {
    const yml = readFileSync(path.resolve(__dirname, '../../action.yml'), 'utf8');
    expect(yml).toMatch(/history-key:[\s\S]*?default: \$\{\{ toJSON\(matrix\) \}\}/);
  });

  it('outside a matrix (`null`) the key is empty — the stream is unchanged', () => {
    expect(normalizeHistoryKey('null')).toBe('');
    expect(normalizeHistoryKey('  ')).toBe('');
    expect(normalizeHistoryKey('{}')).toBe('');
    const gh = { sha: 's', runId: '1', runAttempt: '1', job: 'test' };
    expect(
      cacheKeys(gh, { workingDirectory: '.', historyKey: normalizeHistoryKey('null') }),
    ).toEqual(cacheKeys(gh, { workingDirectory: '.', historyKey: '' }));
  });

  it('matrix JSON is canonical (formatting/key order do not matter), legs differ', () => {
    const pretty = '{\n  "os": "ubuntu-latest",\n  "node": 20\n}';
    const compact = '{"node":20,"os":"ubuntu-latest"}';
    expect(normalizeHistoryKey(pretty)).toBe(normalizeHistoryKey(compact));
    expect(normalizeHistoryKey(pretty)).toBe('{"node":20,"os":"ubuntu-latest"}');
    expect(normalizeHistoryKey('{"a":{"y":1,"x":[2,{"q":1,"p":0}]}}')).toBe(
      '{"a":{"x":[2,{"p":0,"q":1}],"y":1}}',
    );
    const gh = { sha: 's', runId: '1', runAttempt: '1', job: 'test' };
    const leg = (m: string) =>
      cacheKeys(gh, { workingDirectory: '.', historyKey: normalizeHistoryKey(m) }).saveKey;
    expect(leg('{"node": 20}')).not.toBe(leg('{"node": 22}'));
  });

  it('explicit non-JSON keys pass through trimmed', () => {
    expect(normalizeHistoryKey(' linux-20 ')).toBe('linux-20');
    expect(normalizeHistoryKey('{not json')).toBe('{not json');
  });

  it('readInputs applies the normalisation', () => {
    const d = base();
    expect(readInputs(getter({ 'history-key': 'null' }), d).historyKey).toBe('');
    expect(readInputs(getter({ 'history-key': '{ "b": 1, "a": 2 }' }), d).historyKey).toBe(
      '{"a":2,"b":1}',
    );
  });
});
