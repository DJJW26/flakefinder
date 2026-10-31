/**
 * Black-box CLI tests: the CURRENT source of src/cli/index.ts is bundled
 * once (tsup, deps inlined) into a temp dir and spawned like a user would —
 * so these never depend on a stale committed dist/.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

let buildDir = '';
let cliPath = '';
let dirs: string[] = [];

beforeAll(async () => {
  buildDir = mkdtempSync(path.join(tmpdir(), 'ff-cli-build-'));
  await build({
    entry: { cli: fileURLToPath(new URL('./index.ts', import.meta.url)) },
    format: ['esm'],
    platform: 'node',
    target: 'node18',
    outDir: buildDir,
    noExternal: [/.*/],
    config: false,
    silent: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    clean: false,
  });
  cliPath = path.join(buildDir, 'cli.js');
}, 60_000);

afterAll(() => {
  if (buildDir) rmSync(buildDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ff-cli-'));
  dirs.push(d);
  return d;
}

function cli(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = { NO_COLOR: '1' },
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const JUNIT =
  '<testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>';

function historyRecords(cwd: string): { runId: string; results: unknown[] }[] {
  return readFileSync(path.join(cwd, '.flakefinder', 'history.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as { runId?: string; results?: unknown[] })
    .filter((r): r is { runId: string; results: unknown[] } => r.runId !== undefined);
}

describe('ingest dedupes explicitly-passed files (QA A6)', () => {
  it('the same file passed twice (and via another spelling) is ingested once', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['ingest', 'r.xml', 'r.xml', './r.xml', path.join(d, 'r.xml')], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ingested 2 test result(s) from 1/1 file(s)');
    const records = historyRecords(d);
    expect(records).toHaveLength(1);
    expect(records[0]!.results).toHaveLength(2);
  });
});

describe('strict integer flags (QA A7/A8)', () => {
  it.each([
    [
      ['run', '-R', '2.5', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got 2.5)',
    ],
    [
      ['run', '-R', '2x', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got 2x)',
    ],
    [
      ['run', '-R', '50', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got 50)',
    ],
    [
      ['run', '--retries=-1', '--', 'node', '-e', '0'],
      'run -R/--retries must be an integer 0–10 (got -1)',
    ],
    [
      ['run', '--timeout', '1.5', '--', 'node', '-e', '0'],
      'run --timeout must be an integer 1–2147483 (seconds) (got 1.5)',
    ],
    [
      ['run', '--timeout', '0', '--', 'node', '-e', '0'],
      'run --timeout must be an integer 1–2147483 (seconds) (got 0)',
    ],
    [['ingest', 'r.xml', '--attempt=-5'], 'ingest --attempt must be an integer 1–1000000 (got -5)'],
    [
      ['ingest', 'r.xml', '--attempt', '2.7'],
      'ingest --attempt must be an integer 1–1000000 (got 2.7)',
    ],
    [
      ['ingest', 'r.xml', '--attempt', 'abc'],
      'ingest --attempt must be an integer 1–1000000 (got abc)',
    ],
    [
      ['ingest', 'r.xml', '--attempt', '0'],
      'ingest --attempt must be an integer 1–1000000 (got 0)',
    ],
    [['report', '--threshold', '50abc'], 'report --threshold must be an integer 0–100 (got 50abc)'],
    [['report', '--threshold', '101'], 'report --threshold must be an integer 0–100 (got 101)'],
  ])('%j exits 2 naming the flag and range', (args, message) => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    const r = cli(args, d);
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe(`flakefinder: ${message}`);
    // nothing ran, nothing was recorded
    expect(existsSync(path.join(d, '.flakefinder'))).toBe(false);
  });

  it('-R 50 is blamed on the flag even when a valid config exists (QA A8)', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "liveRetries": 1 }', 'utf8');
    const r = cli(['run', '-R', '50', '--', 'node', '-e', '0'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('run -R/--retries must be an integer 0–10 (got 50)');
    expect(r.stderr).not.toContain('config');
  });

  it('valid values still work: --attempt 2, --threshold 0', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ingest', 'r.xml', '--attempt', '2'], d).status).toBe(0);
    expect(historyRecords(d)[0]).toMatchObject({ attempt: 2 });
    expect(cli(['report', '--threshold', '0'], d).status).toBe(0);
  });
});

describe('commander usage errors print once (QA A10)', () => {
  it.each([
    [['frobnicate'], "error: unknown command 'frobnicate'"],
    [['report', '--bogus'], "error: unknown option '--bogus'"],
    [['ingest', '--attempt'], "error: option '--attempt <n>' argument missing"],
  ])('%j prints ONE error line and exits 2', (args, message) => {
    const r = cli(args, tmp());
    expect(r.status).toBe(2);
    const lines = r.stderr.split('\n').filter((l) => l.trim() !== '');
    expect(lines).toEqual([message]);
  });

  it('--help and --version still exit 0', () => {
    const d = tmp();
    expect(cli(['--help'], d).status).toBe(0);
    const v = cli(['--version'], d);
    expect(v.status).toBe(0);
    expect(v.stderr).toBe('');
  });
});

describe('unstartable test command (QA A11)', () => {
  it('run -- <missing binary> exits 2 with one clear message and no report', () => {
    const d = tmp();
    const r = cli(['run', '--', 'definitely-not-a-cmd-xyz'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(
      'flakefinder: command not found: definitely-not-a-cmd-xyz — is it installed and on PATH?',
    );
    expect(r.stdout).not.toContain('no test history yet');
    expect(r.stdout.match(/attempt \d+\/\d+/g)).toEqual(['attempt 1/3']); // no retries
  });
});

describe('config found in a parent dir anchors storeDir/quarantineFile (R5 #6)', () => {
  it('ingest from a subdirectory writes to the store next to the config file', () => {
    const root = tmp();
    writeFileSync(path.join(root, 'flakefinder.config.json'), '{"storeDir": ".ff-store"}', 'utf8');
    const sub = path.join(root, 'packages', 'a');
    mkdirSync(sub, { recursive: true });
    writeFileSync(path.join(sub, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['ingest', 'r.xml'], sub);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(root, '.ff-store', 'history.jsonl'))).toBe(true);
    expect(existsSync(path.join(sub, '.ff-store'))).toBe(false);
  });

  it('--config <path> anchors to that file too', () => {
    const root = tmp();
    const cfgDir = path.join(root, 'cfg');
    mkdirSync(cfgDir);
    writeFileSync(path.join(cfgDir, 'ff.json'), '{"storeDir": "store"}', 'utf8');
    writeFileSync(path.join(root, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['--config', path.join('cfg', 'ff.json'), 'ingest', 'r.xml'], root);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(cfgDir, 'store', 'history.jsonl'))).toBe(true);
  });
});

describe('report/html/ci surface store warnings on stderr (R5 #7)', () => {
  it('report on a directory-shaped store says it is unreadable instead of silently empty', () => {
    const d = tmp();
    mkdirSync(path.join(d, '.flakefinder', 'history.jsonl'), { recursive: true });
    const r = cli(['report', '--format', 'json'], d);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('history store unreadable (EISDIR)');
    expect(() => JSON.parse(r.stdout)).not.toThrow(); // stdout stays machine-readable
  });

  it('report and html print corrupt-line warnings', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ingest', 'r.xml'], d).status).toBe(0);
    writeFileSync(path.join(d, '.flakefinder', 'history.jsonl'), '{ nope\n', { flag: 'a' });
    expect(cli(['report'], d).stderr).toContain('skipping corrupt line');
    expect(cli(['html', '-o', 'out.html'], d).stderr).toContain('skipping corrupt line');
  });

  it('ci prints corrupt-line warnings', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{"reports": ["r.xml"]}', 'utf8');
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ingest', 'r.xml'], d).status).toBe(0);
    writeFileSync(path.join(d, '.flakefinder', 'history.jsonl'), '{ nope\n', { flag: 'a' });
    const r = cli(['ci'], d);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('skipping corrupt line');
  });
});

describe('newer-format store (QA CLI-5)', () => {
  it('ingest warns about a v2 store and prune keeps the v2 header', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{"maxRuns": 1}', 'utf8');
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ingest', 'r.xml'], d).status).toBe(0);
    const hist = path.join(d, '.flakefinder', 'history.jsonl');
    const lines = readFileSync(hist, 'utf8').split('\n');
    lines[0] = JSON.stringify({ version: 2 });
    writeFileSync(hist, lines.join('\n'), 'utf8');
    const r = cli(['ingest', 'r.xml'], d); // 2 records > maxRuns 1 → prune rewrites
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('store format v2 is newer than this flakefinder');
    expect(JSON.parse(readFileSync(hist, 'utf8').split('\n')[0]!)).toEqual({ version: 2 });
    expect(historyRecords(d)).toHaveLength(1);
  });
});

describe('ci output cannot inject workflow commands or terminal escapes (QA ACT-2)', () => {
  it('a hostile test name stays on one visible line in the table, annotations and stderr', () => {
    const d = tmp();
    const name = 'x\n::error::Rotate creds\r\n::add-mask::y\x1b]0;pwned\x07\x1b[2J\u202eevil';
    const mk = (st: 'passed' | 'failed'): string =>
      JSON.stringify({
        numTotalTests: 1,
        success: st === 'passed',
        testResults: [
          {
            name: '/repo/a.test.js',
            status: st,
            assertionResults: [
              {
                ancestorTitles: ['Suite'],
                title: name,
                fullName: name,
                status: st,
                failureMessages: st === 'failed' ? ['boom'] : [],
              },
            ],
          },
        ],
      });
    writeFileSync(
      path.join(d, 'flakefinder.config.json'),
      '{"reports": ["r.json"], "minRuns": 2}',
      'utf8',
    );
    let r = { status: 0 as number | null, stdout: '', stderr: '' };
    for (const st of ['passed', 'failed', 'passed', 'failed'] as const) {
      writeFileSync(path.join(d, 'r.json'), mk(st), 'utf8');
      r = cli(['ci', '--fail-on-new-flakes'], d);
    }
    const all = `${r.stdout}\n${r.stderr}`;
    expect(all).toContain('flaky'); // the hostile test really was classified and printed
    for (const line of all.split('\n')) {
      if (line.startsWith('::'))
        expect(line.startsWith('::warning title=flakefinder::')).toBe(true);
    }
    expect(all).not.toContain('\x1b');
    expect(all).not.toContain('\x07');
    expect(all).not.toContain('\u202e');
    expect(r.stdout).toContain('x\\x0a::error::Rotate creds');
  });
});

describe('ci annotations and table are redacted (QA ACT-3)', () => {
  it('a ghp_ token in a flaky test name never reaches ci output', () => {
    const d = tmp();
    const tok = 'ghp_0123456789abcdefABCDEF0123456789abcd';
    const junit = (fail: boolean): string =>
      `<testsuites><testsuite name="s"><testcase classname="s" name="auth ${tok}">${fail ? '<failure message="boom"/>' : ''}</testcase></testsuite></testsuites>`;
    writeFileSync(
      path.join(d, 'flakefinder.config.json'),
      '{"reports": ["r.xml"], "minRuns": 2}',
      'utf8',
    );
    let out = '';
    for (const fail of [false, true, false, true]) {
      writeFileSync(path.join(d, 'r.xml'), junit(fail), 'utf8');
      const r = cli(['ci', '--fail-on-new-flakes'], d);
      out = `${r.stdout}\n${r.stderr}`;
    }
    expect(out).toContain('::warning title=flakefinder::');
    expect(out).toContain('ghp_[REDACTED]');
    expect(out).not.toContain(tok);
  });
});

describe('ci on a first run where nothing parses (QA ACT-5 / CLI-7)', () => {
  it('does not crash with ENOENT writing the snapshot', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{"reports": ["r.xml"]}', 'utf8');
    writeFileSync(path.join(d, 'r.xml'), 'this is not a test report', 'utf8');
    const r = cli(['ci'], d);
    expect(r.stderr).not.toContain('ENOENT');
    expect(r.status).toBe(0);
    expect(existsSync(path.join(d, '.flakefinder', 'verdicts-snapshot.json'))).toBe(true);
  });
});

describe('--cwd must be an existing directory (QA CLI-19)', () => {
  it.each([['report'], ['init'], ['ingest'], ['html'], ['doctor'], ['ci'], ['quarantine', 'list']])(
    '%s with a missing --cwd exits 2 with a clear error',
    (...cmd) => {
      const d = tmp();
      const r = cli(['--cwd', path.join(d, 'nope'), ...cmd], d);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/--cwd .*nope does not exist/);
      expect(r.stderr).not.toMatch(/ENOENT|\n\s+at /);
    },
  );

  it('a --cwd that is a file is rejected', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'f'), '', 'utf8');
    const r = cli(['--cwd', 'f', 'report'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not a directory/);
  });
});

describe('--config resolves against --cwd (QA CLI-25)', () => {
  it('a relative --config is looked up inside --cwd, not the process cwd', () => {
    const outer = tmp();
    const proj = path.join(outer, 'proj');
    mkdirSync(proj);
    writeFileSync(path.join(proj, 'ff.json'), '{ "storeDir": "hist" }', 'utf8');
    writeFileSync(path.join(proj, 'r.xml'), JUNIT, 'utf8');
    const r = cli(['--cwd', 'proj', '--config', 'ff.json', 'ingest', 'r.xml'], outer);
    expect(r.status).toBe(0);
    expect(existsSync(path.join(proj, 'hist', 'history.jsonl'))).toBe(true);
  });

  it('a config that is not a JSON object is a clear exit-2 error (QA CLI-16)', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), 'null', 'utf8');
    const r = cli(['report'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/config must be a JSON object, got null/);
    expect(r.stderr).not.toMatch(/TypeError/);
  });
});

describe('doctor honours --config and color settings (QA CLI-9/CLI-13)', () => {
  it('doctor --config bad.json exits 1 with a FAIL line', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'bad.json'), '{ "runner": "Jest" }', 'utf8');
    const r = cli(['--config', 'bad.json', 'doctor'], d);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[FAIL]');
    expect(r.stdout).toContain('did you mean "jest"?');
  });

  it('piped doctor output carries no ANSI escapes even without NO_COLOR', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "runner": 1 }', 'utf8');
    const r = cli(['doctor'], d, { NO_COLOR: undefined });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('[FAIL]');
    expect(r.stdout).not.toContain('\x1b[');
  });
});

describe('UTF-16 report files (QA PAR-9)', () => {
  const utf16 = (s: string): Buffer =>
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);

  it('ingest reads a UTF-16LE (BOM) JUnit report', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), utf16(JUNIT));
    const r = cli(['ingest', 'r.xml'], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ingested 2 test result(s) from 1/1 file(s)');
  });

  it('ci reads a UTF-16LE (BOM) JUnit report', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": ["r.xml"] }', 'utf8');
    writeFileSync(path.join(d, 'r.xml'), utf16(JUNIT));
    const r = cli(['ci'], d);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('unrecognized');
    expect(historyRecords(d)[0]!.results).toHaveLength(2);
  });
});

describe('ingest exits 2 when nothing could be ingested (QA CLI-6)', () => {
  it.each([
    ['missing', null],
    ['empty', ''],
    ['unparseable', 'not a report at all'],
  ])('every file %s → exit 2, no history written', (_label, content) => {
    const d = tmp();
    if (content !== null) writeFileSync(path.join(d, 'r.xml'), content, 'utf8');
    const r = cli(['ingest', 'r.xml'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('nothing ingested');
    expect(existsSync(path.join(d, '.flakefinder', 'history.jsonl'))).toBe(false);
  });

  it('one good file among bad ones still succeeds', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'good.xml'), JUNIT, 'utf8');
    writeFileSync(path.join(d, 'bad.xml'), 'garbage', 'utf8');
    const r = cli(['ingest', 'good.xml', 'bad.xml', 'missing.xml'], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('from 1/3 file(s)');
  });
});

describe('--run-id validation (QA CLI-27)', () => {
  it.each(['123456789', '9876543210', '1234567890-2', 'build.42_a', '7', crypto.randomUUID()])(
    'accepts %s',
    (id) => {
      const d = tmp();
      writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
      const r = cli(['ingest', 'r.xml', '--run-id', id], d);
      expect(r.status).toBe(0);
      expect(historyRecords(d)[0]!.runId).toBe(id);
    },
  );

  it.each(['----------', '-123', '..', 'a b', 'x'.repeat(129), 'id\x1b[31m', ''])(
    'rejects %j',
    (id) => {
      const d = tmp();
      writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
      const r = cli(['ingest', 'r.xml', '--run-id', id], d);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('--run-id must be');
      expect(r.stderr).not.toContain('\x1b');
    },
  );
});

describe('html output path and --open (QA CLI-10/CLI-31)', () => {
  it('-o "" is a clear exit-2 error, not a raw EISDIR', () => {
    const d = tmp();
    const r = cli(['html', '-o', ''], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('needs a file path');
    expect(r.stderr).not.toMatch(/EISDIR|\n\s+at /);
  });

  it('-o pointing at a directory says so', () => {
    const d = tmp();
    mkdirSync(path.join(d, 'out'));
    const r = cli(['html', '-o', 'out'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/cannot write the dashboard to .*out — it is a directory/);
  });

  it.runIf(process.platform === 'linux')('--open without xdg-open warns and still exits 0', () => {
    const d = tmp();
    const r = cli(['html', '--open'], d, { NO_COLOR: '1', PATH: path.join(d, 'empty-bin') });
    expect(r.status).toBe(0);
    expect(existsSync(path.join(d, 'flakefinder-report.html'))).toBe(true);
    expect(r.stderr).toMatch(/could not open a browser \(xdg-open: /);
    expect(r.stderr).not.toMatch(/Unhandled|\n\s+at /);
  });
});

function firstTestId(d: string): string {
  const r = cli(['report', '--format', 'json'], d);
  return (JSON.parse(r.stdout) as { verdicts: { testId: string }[] }).verdicts[0]!.testId;
}

describe('quarantine exit codes, output and side effects (QA CLI-11/CLI-22/CLI-30)', () => {
  it('add/remove of an unknown testId exits 1 (a missing testId argument stays 2)', () => {
    const d = tmp();
    expect(cli(['quarantine', 'add', 'deadbeefdeadbeef'], d).status).toBe(1);
    expect(cli(['quarantine', 'remove', 'deadbeefdeadbeef'], d).status).toBe(1);
    expect(cli(['quarantine', 'add'], d).status).toBe(2);
    expect(cli(['quarantine', 'remove'], d).status).toBe(2);
    expect(cli(['quarantine', 'bogus'], d).status).toBe(2);
  });

  it('prune on an empty history does not create the quarantine file', () => {
    const d = tmp();
    const r = cli(['quarantine', 'prune'], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('nothing to prune');
    expect(existsSync(path.join(d, 'flakefinder.quarantine.json'))).toBe(false);
  });

  it('control characters in --reason are escaped by quarantine list', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ingest', 'r.xml'], d).status).toBe(0);
    const id = firstTestId(d);
    const add = cli(['quarantine', 'add', id, '--reason', 'evil\x1b[2J\rspoof\nline'], d);
    expect(add.status).toBe(0);
    const list = cli(['quarantine', 'list'], d);
    expect(list.status).toBe(0);
    expect(list.stdout).not.toContain('\x1b');
    expect(list.stdout).not.toContain('\r');
    const entryLines = list.stdout.split('\n').filter((l) => l.includes(id));
    expect(entryLines).toHaveLength(1);
    expect(entryLines[0]).toContain('evil');
    expect(entryLines[0]).toContain('spoof');
  });

  it('prune prints escaped test names', () => {
    const d = tmp();
    const hostile = 'name\x1b[31mred\rCR';
    const junit = `<testsuites><testsuite name="s"><testcase name="${hostile}"/></testsuite></testsuites>`;
    writeFileSync(path.join(d, 'r.xml'), junit, 'utf8');
    expect(cli(['ingest', 'r.xml'], d).status).toBe(0);
    const id = firstTestId(d);
    // an old entry for a test that has since passed 10+ times is pruned
    writeFileSync(
      path.join(d, 'flakefinder.quarantine.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            testId: id,
            suite: 's',
            name: hostile,
            reason: 'flaky',
            quarantinedAt: '2000-01-01T00:00:00.000Z',
            flakeScore: 50,
          },
        ],
      }),
      'utf8',
    );
    for (let i = 0; i < 10; i++) expect(cli(['ingest', 'r.xml'], d).status).toBe(0);
    const r = cli(['quarantine', 'prune'], d);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pruned 1 entry:');
    expect(r.stdout).not.toContain('\x1b');
    expect(r.stdout).not.toContain('\r');
  });
});

describe('help behaviour (QA CLI-20)', () => {
  it('bare flakefinder prints help to stdout and exits 0', () => {
    const d = tmp();
    for (const args of [[], ['--no-color'], ['--cwd', '.']]) {
      const r = cli(args, d);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage: flakefinder');
      expect(r.stderr).toBe('');
    }
  });

  it('help <command> describes that command; help alone lists commands', () => {
    const d = tmp();
    const sub = cli(['help', 'ingest'], d);
    expect(sub.status).toBe(0);
    expect(sub.stdout).toContain('Usage: flakefinder ingest');
    const all = cli(['help'], d);
    expect(all.status).toBe(0);
    expect(all.stdout).toContain('Commands:');
  });

  it('help <unknown> exits 2 with an error instead of the general help', () => {
    const d = tmp();
    const r = cli(['help', 'nosuch'], d);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown command "nosuch"');
  });
});

describe('init --runner auto (QA CLI-28)', () => {
  it('detects like the default and writes the detected runner with its report globs', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'go.mod'), 'module x\n', 'utf8');
    const r = cli(['init', '--runner', 'auto'], d);
    expect(r.status).toBe(0);
    const cfg = JSON.parse(readFileSync(path.join(d, 'flakefinder.config.json'), 'utf8'));
    expect(cfg).toEqual({ reports: ['test-output.jsonl'], runner: 'go' });
  });

  it('fails like the default when nothing can be detected (no reports: [] config)', () => {
    const d = tmp();
    const r = cli(['init', '--runner', 'auto'], d);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not detect a test runner');
    expect(existsSync(path.join(d, 'flakefinder.config.json'))).toBe(false);
  });
});

describe('ci verdict snapshot robustness (QA CLI-29)', () => {
  const FLAKY_RUNS = [false, true, false, true];
  function setupFlaky(d: string): void {
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": ["r.xml"] }', 'utf8');
    for (const fail of FLAKY_RUNS) {
      const tc = fail
        ? '<testcase name="t"><failure message="x"/></testcase>'
        : '<testcase name="t"/>';
      writeFileSync(
        path.join(d, 'r.xml'),
        `<testsuites><testsuite name="s">${tc}</testsuite></testsuites>`,
        'utf8',
      );
      expect(cli(['ci'], d).status).toBe(0);
    }
  }

  it.each([
    ['corrupt JSON', '{ not json'],
    ['an object', '{"verdicts": []}'],
    ['a number', '42'],
    ['an array of junk', '[null, 1, "x", {"testId": 5}]'],
  ])('%s: warns (or drops junk), never crashes, and rewrites the snapshot', (_label, content) => {
    const d = tmp();
    setupFlaky(d);
    const snap = path.join(d, '.flakefinder', 'verdicts-snapshot.json');
    writeFileSync(snap, content, 'utf8');
    const r = cli(['ci', '--fail-on-new-flakes'], d);
    expect(r.stderr).not.toMatch(/TypeError|\n\s+at /);
    expect([0, 1]).toContain(r.status);
    if (!content.startsWith('[')) expect(r.stderr).toContain('ignoring');
    expect(Array.isArray(JSON.parse(readFileSync(snap, 'utf8')))).toBe(true);
  });
});

describe('ci commit sha from the CI environment (QA ACT-18)', () => {
  function shaOf(d: string, env: Record<string, string | undefined>): string | undefined {
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": ["r.xml"] }', 'utf8');
    writeFileSync(path.join(d, 'r.xml'), JUNIT, 'utf8');
    expect(cli(['ci'], d, { NO_COLOR: '1', ...env }).status).toBe(0);
    const recs = historyRecords(d) as unknown as { commitSha?: string }[];
    return recs[recs.length - 1]!.commitSha;
  }
  const sha = 'a'.repeat(40);

  it('GITHUB_SHA wins', () => {
    expect(shaOf(tmp(), { GITHUB_SHA: sha, CI_COMMIT_SHA: undefined })).toBe(sha);
  });

  it('CI_COMMIT_SHA (GitLab) is used when GITHUB_SHA is absent', () => {
    expect(shaOf(tmp(), { GITHUB_SHA: undefined, CI_COMMIT_SHA: 'B'.repeat(40) })).toBe(
      'b'.repeat(40),
    );
  });

  it('a malformed CI sha is ignored (falls back to git, here: none)', () => {
    expect(shaOf(tmp(), { GITHUB_SHA: 'not-a-sha', CI_COMMIT_SHA: undefined })).toBeUndefined();
  });
});

describe('run surfaces history-store warnings', () => {
  it('a corrupt history line is reported on stderr after a run', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": ["r.xml"] }', 'utf8');
    mkdirSync(path.join(d, '.flakefinder'));
    writeFileSync(path.join(d, '.flakefinder', 'history.jsonl'), '{"version":1}\n{ corrupt\n');
    writeFileSync(
      path.join(d, 'write.js'),
      `require('fs').writeFileSync('r.xml', ${JSON.stringify(JUNIT)});`,
      'utf8',
    );
    const r = cli(['run', '--', process.execPath, 'write.js'], d);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('skipping corrupt line 2');
    expect(r.stderr.match(/skipping corrupt line 2/g)).toHaveLength(1);
  });
});
