import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import {
  deselectedNodeIds,
  exclusionArgs,
  PYTEST_EXACT_PLUGIN_MODULE,
  pytestExactDeselectEnv,
} from '../quarantine/manager.js';
import type { FlakefinderConfig } from '../types.js';
import {
  commandResolvable,
  INTERRUPT_GRACE_MS,
  missingCommandWord,
  processTree,
  pytestCacheDisabled,
  runLive,
} from './wrap.js';

let dirs: string[] = [];
function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-r6-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});
const quiet = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  return vi.spyOn(console, 'error').mockImplementation(() => {});
};
const cfg = (over: Partial<FlakefinderConfig> = {}) =>
  resolveConfig({ reports: ['out.json'], storeDir: '.ffstore', minRuns: 1, ...over });

const JEST_REPORT = (status: 'passed' | 'failed') =>
  JSON.stringify({
    testResults: [
      {
        name: 't.js',
        status,
        assertionResults: [
          {
            title: 'gen',
            fullName: 'gen',
            status,
            ancestorTitles: [],
            duration: 1,
            failureMessages: status === 'failed' ? ['x'] : [],
          },
        ],
      },
    ],
  });

describe('shell-mode "command not found" (QA RUN-12)', () => {
  it('a missing binary in a shell-mode command exits 2 after ONE attempt', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    const err = quiet();
    const result = await runLive(['nosuch-binary-xyz-r6', '>', 'out.txt'], cfg(), {
      retries: 2,
      cwd,
      applyQuarantine: false,
    });
    expect(result.finalExitCode).toBe(2);
    expect(result.attempts).toEqual([]);
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat();
    expect(logged.filter((l) => String(l).includes('attempt ')).length).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('command not found: nosuch-binary-xyz-r6');
  });

  it('a script that itself exits 127 in shell mode is still a test failure (exit 1)', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'nf.js'), 'process.exit(127);', 'utf8');
    quiet();
    const result = await runLive(['node', 'nf.js', '>', 'log.txt'], cfg({ reports: [] }), {
      retries: 0,
      cwd,
      applyQuarantine: false,
    });
    expect(result.finalExitCode).toBe(1);
  });

  it('commandResolvable / missingCommandWord', () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'run.sh'), '', 'utf8');
    expect(commandResolvable('node', cwd)).toBe(true);
    expect(commandResolvable('cd', cwd)).toBe(true); // builtin
    expect(commandResolvable('./run.sh', cwd)).toBe(true);
    expect(commandResolvable('./nope.sh', cwd)).toBe(false);
    expect(commandResolvable('$TOOL', cwd)).toBe(true); // expanded by the shell: can't judge
    expect(commandResolvable('nosuch-xyz', cwd, { PATH: '' })).toBe(false);
    expect(missingCommandWord(['cd', '.', '&&', 'nosuch-xyz', '>', 'o'], cwd)).toBe('nosuch-xyz');
    expect(missingCommandWord(['FOO=1', 'node', 'x.js', '|', 'cat'], cwd)).toBeUndefined();
  });
});

describe('report freshness uses mtime, not only content (QA RUN-13)', () => {
  it('a byte-identical report rewritten by attempt 1 is recorded', async () => {
    const cwd = tmpCwd();
    writeFileSync(
      path.join(cwd, 'gen.js'),
      `require('fs').writeFileSync('out.json', ${JSON.stringify(JEST_REPORT('passed'))});`,
      'utf8',
    );
    // yesterday's run left the very same bytes behind
    writeFileSync(path.join(cwd, 'out.json'), JEST_REPORT('passed'), 'utf8');
    const old = new Date(Date.now() - 86_400_000);
    utimesSync(path.join(cwd, 'out.json'), old, old);
    quiet();
    const result = await runLive(['node', 'gen.js'], cfg(), {
      retries: 0,
      cwd,
      applyQuarantine: false,
    });
    expect(result.attempts).toHaveLength(1);
    expect(result.verdicts.map((v) => v.name)).toEqual(['gen']);
  });

  it('an untouched identical report is still ignored on attempt 1', async () => {
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'out.json'), JEST_REPORT('failed'), 'utf8');
    writeFileSync(path.join(cwd, 'noop.js'), '', 'utf8');
    quiet();
    const result = await runLive(['node', 'noop.js'], cfg(), {
      retries: 0,
      cwd,
      applyQuarantine: false,
    });
    expect(result.attempts).toEqual([]);
    expect(result.finalExitCode).toBe(0);
  });
});

describe('report decoding (PAR-9 call site)', () => {
  it('a UTF-16LE (BOM) report written by PowerShell-style redirection is parsed', async () => {
    const cwd = tmpCwd();
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(JEST_REPORT('failed'), 'utf16le'),
    ]);
    writeFileSync(path.join(cwd, 'bytes.bin'), bytes);
    writeFileSync(
      path.join(cwd, 'gen.js'),
      "const fs = require('fs'); fs.writeFileSync('out.json', fs.readFileSync('bytes.bin')); process.exit(1);",
      'utf8',
    );
    quiet();
    const result = await runLive(['node', 'gen.js'], cfg(), {
      retries: 0,
      cwd,
      applyQuarantine: false,
    });
    expect(result.verdicts.map((v) => [v.name, v.lastStatus])).toEqual([['gen', 'fail']]);
  });
});

describe('pytest cache detection in config files (no:cacheprovider)', () => {
  const project = (files: Record<string, string>): string => {
    const cwd = tmpCwd();
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(cwd, f)), { recursive: true });
      writeFileSync(path.join(cwd, f), c, 'utf8');
    }
    return cwd;
  };
  const env = {};

  it('pytest.ini / tox.ini / setup.cfg addopts', () => {
    const ini = '[pytest]\naddopts = -q -p no:cacheprovider\n';
    expect(pytestCacheDisabled(['pytest'], project({ 'pytest.ini': ini }), env)).toBe(true);
    expect(pytestCacheDisabled(['pytest'], project({ 'tox.ini': ini }), env)).toBe(true);
    expect(
      pytestCacheDisabled(
        ['pytest'],
        project({ 'setup.cfg': '[tool:pytest]\naddopts =\n    -pno:cacheprovider\n' }),
        env,
      ),
    ).toBe(true);
    // in another section, or commented out → not disabled
    expect(
      pytestCacheDisabled(
        ['pytest'],
        project({ 'tox.ini': '[testenv]\ncommands = pytest -p no:cacheprovider\n[pytest]\n' }),
        env,
      ),
    ).toBe(false);
    expect(
      pytestCacheDisabled(
        ['pytest'],
        project({ 'pytest.ini': '[pytest]\n# addopts = -p no:cacheprovider\n' }),
        env,
      ),
    ).toBe(false);
  });

  it('pyproject.toml (string and list addopts, ini_options and native table)', () => {
    const list = '[tool.pytest.ini_options]\naddopts = [\n  "-p", "no:cacheprovider",\n]\n';
    expect(pytestCacheDisabled(['pytest'], project({ 'pyproject.toml': list }), env)).toBe(true);
    const str = '[project]\nname = "x"\n[tool.pytest]\naddopts = "-p no:cacheprovider"\n';
    expect(pytestCacheDisabled(['pytest'], project({ 'pyproject.toml': str }), env)).toBe(true);
    const other =
      '[tool.pytest.ini_options]\naddopts = "-q"\n[tool.x]\ny = "-p no:cacheprovider"\n';
    expect(pytestCacheDisabled(['pytest'], project({ 'pyproject.toml': other }), env)).toBe(false);
  });

  it('precedence: pytest.ini wins even without addopts; config found from a subdir', () => {
    const cwd = project({
      'pytest.ini': '[pytest]\n',
      'tox.ini': '[pytest]\naddopts = -p no:cacheprovider\n',
    });
    expect(pytestCacheDisabled(['pytest'], cwd, env)).toBe(false);
    const nested = project({ 'setup.cfg': '[tool:pytest]\naddopts = -p no:cacheprovider\n' });
    mkdirSync(path.join(nested, 'tests'));
    expect(pytestCacheDisabled(['pytest'], path.join(nested, 'tests'), env)).toBe(true);
  });

  it('-c / --config-file and PYTEST_ADDOPTS', () => {
    const cwd = project({ 'ci/pytest-ci.ini': '[pytest]\naddopts = -p no:cacheprovider\n' });
    expect(pytestCacheDisabled(['pytest', '-c', 'ci/pytest-ci.ini'], cwd, env)).toBe(true);
    expect(pytestCacheDisabled(['pytest', '--config-file=ci/pytest-ci.ini'], cwd, env)).toBe(true);
    expect(pytestCacheDisabled(['pytest'], cwd, { PYTEST_ADDOPTS: '-p no:cacheprovider' })).toBe(
      true,
    );
    expect(pytestCacheDisabled(['pytest'], cwd, env)).toBe(false);
  });

  it('runLive: ini-disabled cache → full re-run, no --lf', async () => {
    const cwd = project({ 'pytest.ini': '[pytest]\naddopts = -p no:cacheprovider\n' });
    writeFileSync(
      path.join(cwd, 'fake.js'),
      `const fs = require('fs'); let n = 0; try { n = +fs.readFileSync('c.txt', 'utf8'); } catch {}
n++; fs.writeFileSync('c.txt', String(n)); fs.writeFileSync('argv' + n + '.json', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync('junit.xml', '<testsuites><testsuite name="p"><testcase classname="t" name="test_a">' + (n === 1 ? '<failure message="x"/>' : '') + '</testcase></testsuite></testsuites>');
process.exit(n === 1 ? 1 : 0);`,
      'utf8',
    );
    quiet();
    await runLive(['node', 'fake.js'], cfg({ reports: ['junit.xml'], runner: 'pytest' }), {
      retries: 1,
      cwd,
      applyQuarantine: false,
    });
    expect(JSON.parse(readFileSync(path.join(cwd, 'argv2.json'), 'utf8'))).toEqual([]);
  });
});

const PYTEST = process.env.FF_TEST_PYTEST ?? 'pytest';
const hasPytest = spawnSync(PYTEST, ['--version']).status === 0;

describe('pytest quarantine is exact, not a node-id prefix', () => {
  it('env builder keeps the user PYTEST_PLUGINS / PYTHONPATH', () => {
    const ids = deselectedNodeIds(['--deselect', 'a.py::t', '-x', '--deselect', 'b.py::u']);
    expect(ids).toEqual(['a.py::t', 'b.py::u']);
    const env = pytestExactDeselectEnv(ids, '/plug', { PYTEST_PLUGINS: 'mine', PYTHONPATH: '/p' });
    expect(env.PYTEST_PLUGINS).toBe(`mine,${PYTEST_EXACT_PLUGIN_MODULE}`);
    expect(env.PYTHONPATH).toBe(`/plug${path.delimiter}/p`);
    expect(JSON.parse(env.FLAKEFINDER_EXACT_DESELECT!)).toEqual(ids);
  });

  it.skipIf(!hasPytest)(
    'real pytest: quarantining test_mod keeps test_mod2 and the user own --deselect',
    async () => {
      const cwd = tmpCwd();
      writeFileSync(
        path.join(cwd, 'test_q.py'),
        [
          'import pytest',
          'def test_mod(): assert False',
          'def test_mod2(): pass',
          '@pytest.mark.parametrize("x", [1, 2])',
          'def test_par(x): assert False',
          'def test_user_skip(): assert False',
          '',
        ].join('\n'),
        'utf8',
      );
      writeFileSync(path.join(cwd, 'pytest.ini'), '[pytest]\n', 'utf8');
      const entry = (name: string) => ({
        testId: name,
        suite: 'test_q',
        name,
        reason: 'flaky',
        quarantinedAt: new Date().toISOString(),
        flakeScore: 90,
      });
      writeFileSync(
        path.join(cwd, 'flakefinder.quarantine.json'),
        JSON.stringify({ version: 1, entries: [entry('test_mod'), entry('test_par')] }),
        'utf8',
      );
      expect(exclusionArgs('pytest', [entry('test_mod')], cwd)).toEqual([
        '--deselect',
        'test_q.py::test_mod',
      ]);
      quiet();
      const result = await runLive(
        [
          PYTEST,
          '-q',
          '--junitxml=junit.xml',
          '--deselect',
          'test_q.py::test_user_skip',
          '>',
          'pytest.log',
        ],
        cfg({ reports: ['junit.xml'], runner: 'pytest' }),
        { retries: 0, cwd, applyQuarantine: true },
      );
      const ran = result.verdicts.map((v) => v.name).sort();
      expect(ran).toEqual(['test_mod2']);
      expect(result.finalExitCode).toBe(0);
      expect(readFileSync(path.join(cwd, 'pytest.log'), 'utf8')).toMatch(/4 deselected/);
    },
    60_000,
  );
});

describe('interactive stdin (TTY) keeps tree kills working', () => {
  const PARENT = `
const { spawn } = require('child_process');
const gc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync('gc.pid', String(gc.pid));
require('fs').writeFileSync('me.pid', String(process.pid));
setInterval(() => {}, 1000);
`;
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitDead = async (pid: number, ms = 8000): Promise<boolean> => {
    for (let t = 0; t < ms && alive(pid); t += 50) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  };
  const waitFile = async (file: string): Promise<void> => {
    for (let i = 0; i < 400 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 25));
  };
  const pgid = (pid: number): string =>
    spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  const asTty = () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    return () => {
      if (desc) Object.defineProperty(process.stdin, 'isTTY', desc);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    };
  };

  it('processTree lists descendants', () => {
    if (process.platform === 'win32') return;
    expect(processTree(process.pid)[0]).toBe(process.pid);
  });

  it('TTY: the child shares our process group, and a timeout still kills grandchildren', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'parent.js'), PARENT, 'utf8');
    quiet();
    const restore = asTty();
    let gcPid = 0;
    try {
      const pending = runLive(['node', 'parent.js'], cfg({ reports: [], timeoutSeconds: 2 }), {
        retries: 0,
        cwd,
        applyQuarantine: false,
      });
      await waitFile(path.join(cwd, 'gc.pid'));
      await waitFile(path.join(cwd, 'me.pid'));
      const me = Number(readFileSync(path.join(cwd, 'me.pid'), 'utf8'));
      expect(pgid(me)).toBe(pgid(process.pid)); // foreground group: can read the terminal
      const result = await pending;
      gcPid = Number(readFileSync(path.join(cwd, 'gc.pid'), 'utf8'));
      expect(result.finalExitCode).toBe(1);
      expect(await waitDead(gcPid)).toBe(true);
    } finally {
      restore();
      if (gcPid && alive(gcPid)) process.kill(gcPid, 'SIGKILL');
    }
  }, 30_000);

  it('TTY: SIGINT gives the child a grace period, then kills the tree; exit 130', async () => {
    if (process.platform === 'win32') return;
    const cwd = tmpCwd();
    writeFileSync(path.join(cwd, 'parent.js'), PARENT, 'utf8');
    quiet();
    const restore = asTty();
    let gcPid = 0;
    try {
      const pending = runLive(['node', 'parent.js'], cfg({ reports: [] }), {
        retries: 2,
        cwd,
        applyQuarantine: false,
      });
      await waitFile(path.join(cwd, 'gc.pid'));
      gcPid = Number(readFileSync(path.join(cwd, 'gc.pid'), 'utf8'));
      const t0 = Date.now();
      process.emit('SIGINT', 'SIGINT');
      const result = await pending;
      expect(Date.now() - t0).toBeGreaterThanOrEqual(INTERRUPT_GRACE_MS - 100);
      expect(result.finalExitCode).toBe(130);
      expect(await waitDead(gcPid)).toBe(true);
    } finally {
      restore();
      if (gcPid && alive(gcPid)) process.kill(gcPid, 'SIGKILL');
    }
  }, 30_000);
});
