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
    // headerless TAP12 is accepted since QA PAR-12 (see 'headerless TAP' below)
    expect(tapParser.sniff('ok 1 - no header')).toBe(true);
    expect(tapParser.sniff('ok - no number, no header')).toBe(false);
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

  it('truncates oversized error messages to 2000 chars', () => {
    const content = [
      'TAP version 13',
      'not ok 1 - huge',
      '  ---',
      `  error: '${'x'.repeat(3000)}'`,
      '  ...',
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results[0]!.message).toBe('x'.repeat(2000));
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

describe('TAP directive case-insensitivity (QA B-F2)', () => {
  it('lowercase and mixed-case directives are honored (perl-style output)', () => {
    const content = [
      'TAP version 13',
      'ok 1 - network test # skip no network available',
      'not ok 2 - upload test # Skip flaky',
      'not ok 3 - verify # tOdO after migration',
      'ok 4 - normal test',
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({
      name: 'network test',
      status: 'skip',
      message: 'no network available',
    });
    expect(results[1]).toMatchObject({ name: 'upload test', status: 'skip', message: 'flaky' });
    expect(results[2]).toMatchObject({
      name: 'verify',
      status: 'skip',
      message: 'after migration',
    });
    expect(results[3]).toMatchObject({ name: 'normal test', status: 'pass' });
  });
});

describe('TAP name unescaping (QA B-F4)', () => {
  it("unescapes node's backslash-# escape in test and suite names", () => {
    const BS = String.fromCharCode(92); // backslash, heredoc-proof
    const content = [
      'TAP version 13',
      `# Subtest: handles ${BS}#TODO stuff`,
      `    # Subtest: inner ${BS}#one`,
      `    ok 1 - inner ${BS}#one`,
      '    1..1',
      `ok 1 - handles ${BS}#TODO stuff`,
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      suite: 'handles #TODO stuff',
      name: 'inner #one',
      status: 'pass',
    });
  });
});

// tap-node20-multiline.tap: REAL `node --test --test-reporter=tap` output from
// node 20.20 for tests/tap-sample/multiline.test.mjs (paths rewritten to /repo).
describe('TAP YAML block scalars (r5 #5)', () => {
  it("keeps node's multi-line assertion errors (error: |-) instead of the literal '|-'", () => {
    const { results, warnings } = tapParser.parse(
      load('tap-node20-multiline.tap'),
      'tap-node20-multiline.tap',
    );
    expect(warnings).toEqual([]);
    const byName = new Map(results.map((r) => [r.name, r]));

    const objects = byName.get('strict equal objects')!;
    expect(objects.status).toBe('fail');
    expect(objects.message).not.toBe('|-');
    expect(objects.message).toBe(
      [
        'Expected "actual" to be reference-equal to "expected":',
        '+ actual - expected',
        '',
        '  {',
        '    a: 1,',
        '    b: [',
        '      1,',
        '+     2',
        '-     3',
        '    ]',
        '  }',
      ].join('\n'),
    );
    expect(objects.stack).toMatch(/^TestContext\.<anonymous> \(file:\/\/\/repo\//);

    const strings = byName.get('strict equal strings')!;
    expect(strings.message).toContain('Expected values to be strictly equal:');
    expect(strings.message).toContain("- 'line one\\nline 2\\nline three'");
    // block content stops at the next key — `code:`/`expected:` are not swallowed
    expect(strings.message).not.toContain('ERR_ASSERTION');
  });

  it('handles |, |-, > and >- scalars (folded style joins lines)', () => {
    const block = (indicator: string, n: number) => [
      `not ok ${n} - t${n}`,
      '  ---',
      `  error: ${indicator}`,
      '    first line',
      '    second line',
      '',
      '    after blank',
      "  code: 'ERR_X'",
      '  ...',
    ];
    const content = [
      'TAP version 13',
      ...block('|', 1),
      ...block('|-', 2),
      ...block('>', 3),
      ...block('>-', 4),
      ...block('|+', 5),
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results.map((r) => r.message)).toEqual([
      'first line\nsecond line\n\nafter blank',
      'first line\nsecond line\n\nafter blank',
      'first line second line\nafter blank',
      'first line second line\nafter blank',
      'first line\nsecond line\n\nafter blank',
    ]);
  });
});

describe('TAP robustness (r5 #6)', () => {
  it('accepts assertions without a number and/or a dash (TAP13/14)', () => {
    const content = [
      'TAP version 14',
      'ok 1 numbered no dash',
      'ok - dashed no number',
      'not ok failing bare',
      'ok',
      'not ok',
      'ok 6',
      'ok 7 - classic # SKIP not today',
      'okay this is not an assertion',
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'numbered no dash:pass',
      'dashed no number:pass',
      'failing bare:fail',
      '(test 4):pass',
      '(test 5):fail',
      '(test 6):pass',
      'classic:skip',
    ]);
  });

  it('reads duration_ms and unescapes \\\\ as well as \\#', () => {
    const { results } = tapParser.parse(
      load('tap-node20-multiline.tap'),
      'tap-node20-multiline.tap',
    );
    const slow = results.find((r) => r.name === 'slow pass')!;
    expect(slow.durationMs).toBeGreaterThanOrEqual(20);
    expect(Number.isInteger(slow.durationMs)).toBe(true);
    const BS = String.fromCharCode(92);
    expect(results.map((r) => r.name)).toContain(`passes # with hash and back${BS}slash`);
    // node's TAP stream was the 5 tests of multiline.test.mjs — nothing else
    expect(results).toHaveLength(5);
  });

  it('never re-scans YAML diagnostic lines as assertions', () => {
    const content = [
      'TAP version 13',
      'not ok 1 - outer',
      '  ---',
      '  error: |-',
      '    ok 2 - looks like an assertion',
      '    not ok 3 - so does this',
      '  ...',
      'ok 2 - real second',
    ].join('\n');
    const { results } = tapParser.parse(content, 'inline');
    expect(results.map((r) => r.name)).toEqual(['outer', 'real second']);
    expect(results[0]!.message).toBe('ok 2 - looks like an assertion\nnot ok 3 - so does this');
  });

  it('does not double-emit parents of indentation-nested subtests without # Subtest headers', () => {
    const content = [
      'TAP version 14',
      '    ok 1 - child a',
      '    not ok 2 - child b',
      '    1..2',
      'not ok 1 - parent',
      '        ok 1 - deep',
      '        1..1',
      '    ok 1 - middle',
      '    1..1',
      'ok 2 - outer',
      'ok 3 - flat',
      '1..3',
    ].join('\n');
    const { results, warnings } = tapParser.parse(content, 'inline');
    expect(warnings).toEqual([]);
    expect(results.map((r) => `${r.suite} :: ${r.name}:${r.status}`)).toEqual([
      'parent :: child a:pass',
      'parent :: child b:fail',
      'outer > middle :: deep:pass',
      'node:test :: flat:pass',
    ]);
  });

  // tap-node20-parents.tap: REAL node 20.20 TAP for tests/tap-sample/parents.test.mjs
  it('keeps a parent/suite failure that no child carries; B-F7 suppression otherwise', () => {
    const { results, warnings } = tapParser.parse(
      load('tap-node20-parents.tap'),
      'tap-node20-parents.tap',
    );
    expect(warnings).toEqual([]);
    expect(results.map((r) => `${r.suite} :: ${r.name}:${r.status}`)).toEqual([
      `node:test :: it's quoted "double":fail`,
      'parent throws after passing child :: child ok:pass',
      // its own failure (thrown after the child passed) is reported nowhere else
      'node:test :: parent throws after passing child:fail',
      // before() failed: the cancelled child carries the failure → suite suppressed
      'suite with failing before :: child a:fail',
    ]);
    expect(results[0]!.message).toBe(`it's broken: "x"`);
    expect(results[2]!.message).toBe('parent own failure');
  });
});

// tap-perl-no-header.tap: REAL Perl Test::More output (QA fixture) — TAP12
// style, no `TAP version` line (prove/bats/Test::More default).
describe('headerless TAP (QA PAR-12)', () => {
  it('detects and parses TAP that starts with a plan or a numbered assertion', () => {
    const content = load('tap-perl-no-header.tap');
    expect(tapParser.sniff(content)).toBe(true);
    const { results } = tapParser.parse(content, 'a.t');
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'first passes:pass',
      'second fails:fail',
      '(test 3):skip',
    ]);
    expect(tapParser.sniff('ok 1 - only\nok 2 - two\n')).toBe(true);
  });

  it('stays strict: anything not TAP-shaped is rejected', () => {
    // plain `go test` output, a log that happens to start with "ok", prose
    expect(tapParser.sniff('ok  \texample.com/pkg\t0.002s\n')).toBe(false);
    expect(tapParser.sniff('=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\n')).toBe(false);
    expect(tapParser.sniff('ok 1 - fine\nStarting server on :8080\n')).toBe(false);
    expect(tapParser.sniff('1..2 apples\n')).toBe(false);
    expect(tapParser.sniff('okay then\n')).toBe(false);
    expect(tapParser.sniff('{"Action":"pass"}\n')).toBe(false);
  });
});
