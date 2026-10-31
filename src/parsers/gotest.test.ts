import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeTestId } from '../util/test-id.js';
import { goTestParser } from './gotest.js';

const load = (name: string): string =>
  readFileSync(new URL(`../../tests/parsers-fixtures/${name}`, import.meta.url), 'utf8');

describe('goTestParser', () => {
  it('parses the go test -json fixture exactly', () => {
    const { results, warnings } = goTestParser.parse(load('go-test.jsonl'), 'go-test.jsonl');
    // one malformed final line
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 29');
    expect(warnings[0]).toContain('invalid JSON');

    // package-level events ignored; results in first-seen order
    expect(results).toHaveLength(5);
    expect(results.map((r) => r.name)).toEqual([
      'TestAdd',
      'TestDivide',
      'TestSkip',
      'TestUpper',
      'TestLong',
    ]);

    // TestAdd: pass, ANSI stripped from output, blank line dropped
    expect(results[0]).toMatchObject({
      testId: makeTestId('example.com/flakefinder/math', 'TestAdd'),
      suite: 'example.com/flakefinder/math',
      name: 'TestAdd',
      status: 'pass',
      durationMs: 1,
    });
    // a pass carries no message (QA PAR-19)
    expect(results[0]).not.toHaveProperty('message');

    // TestDivide: fail with detail from red-colored output
    expect(results[1]).toMatchObject({ status: 'fail', durationMs: 10 });
    // go's === RUN / --- FAIL framing is stripped (QA PAR-19)
    expect(results[1]?.message).toBe('    math_test.go:25: division mismatch: got 3, want 3.5');

    // TestSkip: skip, elapsed 0 → 0ms
    expect(results[2]).toMatchObject({ status: 'skip', durationMs: 0 });
    expect(results[2]?.message).toBe('    math_test.go:30: skipping: not implemented on windows');

    // TestUpper: pass with no output events → no message
    expect(results[3]).toMatchObject({
      testId: makeTestId('example.com/flakefinder/strings', 'TestUpper'),
      suite: 'example.com/flakefinder/strings',
      status: 'pass',
      durationMs: 2,
    });
    expect(results[3]).not.toHaveProperty('message');

    // TestLong: fixture output is small enough to survive uncapped (600 L's)
    expect(results[4]).toMatchObject({ status: 'fail', durationMs: 100 });
    expect(results[4]?.message).toBe('L'.repeat(600));
  });

  it('keeps the LAST 2000 chars of oversized test output', () => {
    const lines = [
      JSON.stringify({ Action: 'run', Package: 'big', Test: 'TestBig' }),
      JSON.stringify({
        Action: 'output',
        Package: 'big',
        Test: 'TestBig',
        Output: 'x'.repeat(3000),
      }),
      JSON.stringify({ Action: 'fail', Package: 'big', Test: 'TestBig', Elapsed: 0.4 }),
    ];
    const { results } = goTestParser.parse(lines.join('\n'), 'inline');
    expect(results[0]?.message).toHaveLength(2000);
    expect(results[0]?.message).toBe('x'.repeat(2000)); // tail kept (failure detail lives at the end)
  });

  it('parses old-format output (no elapsed on test events → null durations)', () => {
    const { results, warnings } = goTestParser.parse(
      load('go-test-old.jsonl'),
      'go-test-old.jsonl',
    );
    expect(warnings).toEqual([]);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      suite: 'example.com/legacy/pkg',
      name: 'TestOldPass',
      status: 'pass',
      durationMs: null, // package-level elapsed must not leak into tests
    });
    expect(results[1]).toMatchObject({ name: 'TestOldFail', status: 'fail', durationMs: null });
    expect(results[2]).toMatchObject({ name: 'TestOldSkip', status: 'skip', durationMs: null });
  });

  it('accepts lowercase elapsed/output field spellings', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","output":"something logged\\n"}',
      '{"Action":"pass","Package":"p","Test":"T","elapsed":0.007}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ status: 'pass', durationMs: 7 });
    expect(results[0]).not.toHaveProperty('message'); // passes carry no message
  });

  it('a repeated test that failed once is NOT reported as a plain pass (r5 #2)', () => {
    // previously "last terminal action wins" turned fail→pass into a clean pass
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0.01}',
      '{"Action":"pass","Package":"p","Test":"T","Elapsed":0.02}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'fail', durationMs: 10 });
    expect(results[0]!.message).toBe('flaky: failed 1 of 2 runs in this report');
  });

  it('reports at most 5 malformed lines then a summary', () => {
    // JSON-looking lines that fail to parse (plain-text lines are summarised separately, r5 #4)
    const lines = Array.from({ length: 7 }, (_, i) => `{garbage line ${i} {{`);
    lines.push('{"Action":"pass","Package":"p","Test":"Ok","Elapsed":0.001}');
    const { results, warnings } = goTestParser.parse(lines.join('\n'), 'inline');
    expect(results).toHaveLength(1);
    expect(warnings).toHaveLength(6);
    expect(warnings.slice(0, 5).every((w) => w.includes('invalid JSON'))).toBe(true);
    expect(warnings[5]).toBe('…and 2 more malformed lines');
  });

  it('sniffs NDJSON go test output and rejects other content', () => {
    expect(goTestParser.sniff(load('go-test.jsonl'))).toBe(true);
    expect(goTestParser.sniff(load('go-test-old.jsonl'))).toBe(true);
    expect(goTestParser.sniff('{"Action":"pass","Package":"p"}')).toBe(true);
    expect(goTestParser.sniff('\n\n  {"Action":"fail","Package":"p","Test":"T"}\n')).toBe(true);
    expect(goTestParser.sniff('hello world')).toBe(false);
    expect(goTestParser.sniff('{"Action":"pass"}')).toBe(false); // no Package
    expect(goTestParser.sniff(load('jest.json'))).toBe(false);
    expect(goTestParser.sniff('')).toBe(false);
  });
});

describe('dangling runs (v0.2.0 — crash coverage)', () => {
  it('synthesizes error results for tests that started but never finished', () => {
    const content = [
      JSON.stringify({ Action: 'run', Package: 'pkg/a', Test: 'TestCrash' }),
      JSON.stringify({
        Action: 'output',
        Package: 'pkg/a',
        Test: 'TestCrash',
        Output: '=== RUN TestCrash\n',
      }),
      JSON.stringify({ Action: 'run', Package: 'pkg/a', Test: 'TestSurvives' }),
      JSON.stringify({ Action: 'pass', Package: 'pkg/a', Test: 'TestSurvives', Elapsed: 0.01 }),
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'crash.jsonl');
    const crashed = results.find((r) => r.name === 'TestCrash')!;
    expect(crashed).toBeDefined();
    expect(crashed.status).toBe('error');
    expect(crashed.message).toContain('never reported a result');
    expect(results.find((r) => r.name === 'TestSurvives')!.status).toBe('pass');
    expect(warnings.some((w) => w.includes('1 test(s) started but never reported'))).toBe(true);
  });

  it('emits no warning when every test reaches a terminal action', () => {
    const content = [
      JSON.stringify({ Action: 'run', Package: 'p', Test: 'T' }),
      JSON.stringify({ Action: 'pass', Package: 'p', Test: 'T', Elapsed: 0.5 }),
    ].join('\n');
    const { warnings } = goTestParser.parse(content, 'ok.jsonl');
    expect(warnings).toEqual([]);
  });
});

describe('go parser robustness (review round)', () => {
  it('does not invent phantom crashes from output-only events', () => {
    const content = [
      '{"Action":"output","Package":"p","Test":"TestGhost","Output":"orphan line"}',
      '{"Action":"pause","Package":"p","Test":"TestGhost"}',
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'ghost.jsonl');
    expect(results).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('synthesizes a (package) error when a package fails before running any test', () => {
    const content = [
      '{"Action":"start","Package":"p2"}',
      '{"Action":"output","Package":"p2","Output":"# p2"}',
      '{"Action":"output","Package":"p2","Output":"main.go:5:2: syntax error"}',
      '{"Action":"fail","Package":"p2"}',
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'build.jsonl');
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe('(package)');
    expect(results[0]!.status).toBe('error');
    expect(results[0]!.message).toContain('build or init crash');
    expect(results[0]!.message).toContain('syntax error');
    expect(warnings.some((w) => w.includes('no test results'))).toBe(true);
  });

  it('does not double-report when a package fails WITH tests (dangling logic covers it)', () => {
    const content = [
      '{"Action":"run","Package":"p3","Test":"TestA"}',
      '{"Action":"fail","Package":"p3"}', // package-level
    ].join('\n');
    const { results } = goTestParser.parse(content, 'mixed.jsonl');
    expect(results).toHaveLength(1); // dangling TestA only, no (package) row
    expect(results[0]!.name).toBe('TestA');
  });
});

// go-count2.jsonl: REAL `go test -json -count=2 ./flaky` output (go 1.23.4).
// TestFlaky fails on the first run and passes on the second; TestTable has a
// failing subtest; TestParentOwnFailure fails itself after a passing child.
describe('go test -count=N (r5 #2)', () => {
  it('does not erase a failure that a later repeated run passed', () => {
    const { results, warnings } = goTestParser.parse(load('go-count2.jsonl'), 'go-count2.jsonl');
    const flaky = results.find((r) => r.name === 'TestFlaky')!;
    expect(flaky.status).toBe('fail');
    expect(flaky.message).toMatch(/^flaky: failed 1 of 2 runs/);
    expect(flaky.message).toContain('first attempt fails: got 1, want 2');
    // the passing run's output is not glued onto the failing run's
    expect(flaky.message).not.toContain('marker present');
    expect(warnings.some((w) => w.includes('1 test(s)') && w.includes('TestFlaky'))).toBe(true);
  });

  it('keeps per-run output: a stable test reports one run, not both concatenated', () => {
    const { results } = goTestParser.parse(load('go-count2.jsonl'), 'go-count2.jsonl');
    const stable = results.find((r) => r.name === 'TestStable')!;
    expect(stable.status).toBe('pass');
    expect(stable).not.toHaveProperty('message');
    const flaky = results.find((r) => r.name === 'TestFlaky')!;
    expect(flaky.message?.match(/first attempt fails/g)).toHaveLength(1);
    expect(flaky.message).not.toMatch(/=== RUN|--- FAIL/);
  });

  it('failing on every repeated run is a plain failure (no flaky note, no warning)', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"boom 1\\n"}',
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0.01}',
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"boom 2\\n"}',
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0.02}',
    ].join('\n');
    const { results, warnings } = goTestParser.parse(content, 'inline');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'fail', message: 'boom 1' });
    expect(results[0]?.attempts).toEqual(['fail', 'fail']);
    expect(warnings).toEqual([]);
  });

  it('sets attempts for -count repeats (QA PAR-6); a single run has none', () => {
    const { results } = goTestParser.parse(load('go-count2.jsonl'), 'go-count2.jsonl');
    const byName = new Map(results.map((r) => [r.name, r]));
    // TestFlaky: fail then pass — reported 'fail', so the failing run is listed last
    expect(byName.get('TestFlaky')?.attempts).toEqual(['pass', 'fail']);
    expect(byName.get('TestStable')?.attempts).toEqual(['pass', 'pass']);
    const single = goTestParser.parse(load('go-test.jsonl'), 'go-test.jsonl').results;
    for (const r of single) expect(r).not.toHaveProperty('attempts');
  });

  it('keeps attempts chronological when the last run is the reported one', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"pass","Package":"p","Test":"T","Elapsed":0.01}',
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"=== RUN   T\\n"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"    t_test.go:3: boom\\n"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"--- FAIL: T (0.00s)\\n"}',
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0.02}',
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"=== RUN   T\\n"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"panic: bad\\n"}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    // third run crashed: error, chronological
    expect(results[0]).toMatchObject({ status: 'error', attempts: ['pass', 'fail', 'error'] });
    expect(results[0]?.message).toContain('panic: bad');
    expect(results[0]?.message).not.toContain('=== RUN');
  });
});

describe('go framing lines (QA PAR-19)', () => {
  it('strips === RUN/PAUSE/CONT/NAME and --- PASS/FAIL/SKIP lines, keeping the reason', () => {
    const out = (text: string): string =>
      `{"Action":"output","Package":"p","Test":"T","Output":${JSON.stringify(text)}}`;
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      out('=== RUN   T\n'),
      out('=== PAUSE T\n'),
      out('=== CONT  T\n'),
      out('=== NAME  T\n'),
      out('    t_test.go:9: got 1, want 2\n'),
      out('    --- PASS: T/sub (0.00s)\n'),
      out('--- FAIL: T (0.00s)\n'),
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results[0]?.message).toBe('    t_test.go:9: got 1, want 2');
  });

  it('a failure whose only output is framing has no message', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"T"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"=== RUN   T\\n"}',
      '{"Action":"output","Package":"p","Test":"T","Output":"--- FAIL: T (0.00s)\\n"}',
      '{"Action":"fail","Package":"p","Test":"T","Elapsed":0}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ status: 'fail' });
    expect(results[0]).not.toHaveProperty('message');
  });
});

describe('go subtest parents (r5 #3)', () => {
  it('does not emit parents whose failure is just their subtest failing', () => {
    const { results } = goTestParser.parse(load('go-count2.jsonl'), 'go-count2.jsonl');
    const names = results.map((r) => r.name);
    expect(names).toEqual([
      'TestFlaky',
      'TestStable',
      'TestTable/one',
      'TestTable/two',
      'TestParentOwnFailure',
      'TestParentOwnFailure/child',
    ]);
    // the failing child is the one failure — no duplicate on TestTable
    expect(results.filter((r) => r.status === 'fail').map((r) => r.name)).toEqual([
      'TestFlaky',
      'TestTable/two',
      'TestParentOwnFailure',
    ]);
  });

  it('keeps a parent that failed on its own, with no failing child', () => {
    const { results } = goTestParser.parse(load('go-count2.jsonl'), 'go-count2.jsonl');
    const parent = results.find((r) => r.name === 'TestParentOwnFailure')!;
    expect(parent.status).toBe('fail');
    expect(parent.message).toContain('parent assertion after children');
  });

  it('suppresses passing parents and intermediate levels of nested subtests', () => {
    const ev = (action: string, test: string) =>
      JSON.stringify({ Action: action, Package: 'p', Test: test });
    const content = [
      ev('run', 'TestA'),
      ev('run', 'TestA/b'),
      ev('run', 'TestA/b/c'),
      ev('fail', 'TestA/b/c'),
      ev('fail', 'TestA/b'),
      ev('fail', 'TestA'),
      ev('run', 'TestB'),
      ev('run', 'TestB/x'),
      ev('pass', 'TestB/x'),
      ev('pass', 'TestB'),
      ev('run', 'TestBravo'), // shares a prefix with TestB but is not its child
      ev('pass', 'TestBravo'),
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'TestA/b/c:fail',
      'TestB/x:pass',
      'TestBravo:pass',
    ]);
  });
});

// go124-build-fail.jsonl: REAL `go test -json -count=2 ./...` from go 1.24.4 —
// the stream OPENS with build-output/build-fail events (ImportPath, no Package)
// for a package that does not compile.
// go-stderr-merged.jsonl: REAL go 1.23.4 `go test -json ./broken 2>&1` — the
// compiler's stderr lands BEFORE the first JSON event.
describe('go sniff + build failures (r5 #4)', () => {
  it('sniffs streams that open with build events or stray stderr lines', () => {
    expect(goTestParser.sniff(load('go124-build-fail.jsonl'))).toBe(true);
    expect(goTestParser.sniff(load('go-stderr-merged.jsonl'))).toBe(true);
    expect(
      goTestParser.sniff('{"ImportPath":"p [p.test]","Action":"build-output","Output":"# p\\n"}'),
    ).toBe(true);
    // still rejects non-go content and JSON without the event keys
    expect(goTestParser.sniff('# just a comment\nnot json\n')).toBe(false);
    expect(goTestParser.sniff('{"Output":"x"}\n{"Action":"pass"}')).toBe(false);
  });

  it('surfaces go 1.24 build-fail events as a warning and in the (package) error', () => {
    const { results, warnings } = goTestParser.parse(
      load('go124-build-fail.jsonl'),
      'go124-build-fail.jsonl',
    );
    const pkg = results.find((r) => r.suite === 'example.com/ffdemo/broken')!;
    expect(pkg).toMatchObject({ name: '(package)', status: 'error' });
    expect(pkg.message).toContain('undefined: undefinedThing');
    const build = warnings.filter((w) => w.includes('build failed'));
    expect(build).toHaveLength(1);
    expect(build[0]).toContain('example.com/ffdemo/broken');
    expect(build[0]).toContain('undefined: undefinedThing');
    // the build failure is reported once, not again as a generic "(package)" warning
    expect(warnings.some((w) => w.includes('failed with no test results'))).toBe(false);
    expect(warnings.some((w) => w.includes('invalid JSON'))).toBe(false);
    // the compiling package's tests still parse
    expect(results.find((r) => r.name === 'TestStable')).toMatchObject({ status: 'pass' });
  });

  it('turns leading stderr text into one warning instead of invalid-JSON noise', () => {
    const { results, warnings } = goTestParser.parse(
      load('go-stderr-merged.jsonl'),
      'go-stderr-merged.jsonl',
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: '(package)', status: 'error' });
    expect(warnings.some((w) => w.includes('invalid JSON'))).toBe(false);
    const text = warnings.find((w) => w.includes('non-JSON'));
    expect(text).toContain('2 non-JSON line(s)');
    expect(text).toContain('undefined: undefinedThing');
  });
});

// go-bench-pass.jsonl / go-bench.jsonl: REAL `go test -json -bench=.` (QA
// fixtures, go 1.23). test2json emits NO terminal `pass` for a benchmark —
// only its result line (`BenchmarkX-4  10  21.00 ns/op`) — while a failing
// benchmark does get `fail`.
describe('go benchmarks (QA PAR-2)', () => {
  it('passing benchmarks are passes, not "never reported a result" errors', () => {
    const { results, warnings } = goTestParser.parse(load('go-bench-pass.jsonl'), 'bench.jsonl');
    expect(warnings).toEqual([]);
    expect(results.map((r) => `${r.name}:${r.status}`)).toEqual([
      'TestA:pass',
      'ExampleHello:pass',
      'BenchmarkX:pass',
      'BenchmarkSub/size=10:pass',
    ]);
    expect(results[2]).not.toHaveProperty('message'); // passes carry no message
  });

  it('a failing benchmark still fails; its passing siblings do not turn into errors', () => {
    const { results, warnings } = goTestParser.parse(load('go-bench.jsonl'), 'bench.jsonl');
    expect(warnings).toEqual([]);
    expect(Object.fromEntries(results.map((r) => [r.name, r.status]))).toEqual({
      TestA: 'pass',
      ExampleHello: 'pass',
      BenchmarkX: 'pass',
      'BenchmarkSub/size=10': 'pass',
      BenchmarkFails: 'fail',
    });
  });

  it('a benchmark that crashed (no result line, package failed) is still an error', () => {
    const content = [
      '{"Action":"run","Package":"p","Test":"BenchmarkBoom"}',
      '{"Action":"output","Package":"p","Test":"BenchmarkBoom","Output":"panic: boom\\n"}',
      '{"Action":"fail","Package":"p","Elapsed":0.01}',
    ].join('\n');
    const { results } = goTestParser.parse(content, 'inline');
    expect(results[0]).toMatchObject({ name: 'BenchmarkBoom', status: 'error' });
  });
});
