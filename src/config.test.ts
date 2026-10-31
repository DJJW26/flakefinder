import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anchorConfigPaths,
  CONFIG_FILE_NAME,
  defaultConfig,
  detectRunner,
  loadConfig,
  readConfigFile,
  resolveConfig,
  stripJsonComments,
  TIMEOUT_MAX_SECONDS,
  validateConfig,
} from './config.js';
import type { FlakefinderConfig, RunnerKind } from './types.js';

let dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-cfg-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('resolveConfig defaults (PLAN §6)', () => {
  it('returns the documented defaults', () => {
    expect(resolveConfig()).toEqual({
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
    });
  });
  it('merges defaults < file < overrides', () => {
    const cfg = resolveConfig({ minRuns: 5 }, { liveRetries: 0 });
    expect(cfg.minRuns).toBe(5);
    expect(cfg.liveRetries).toBe(0);
    expect(cfg.maxRuns).toBe(300);
  });
  it('defaultConfig is empty (defaults come from resolveConfig)', () => {
    expect(defaultConfig()).toEqual({});
  });
});

describe('stripJsonComments', () => {
  it('removes line comments', () => {
    expect(stripJsonComments('{"a": 1} // hi\n')).toBe('{"a": 1} \n');
  });
  it('removes block comments', () => {
    expect(stripJsonComments('{/* c */"a": 1}')).toBe('{"a": 1}');
  });
  it('preserves comment-like content inside strings', () => {
    expect(stripJsonComments('{"url": "http://x" /* c */}')).toBe('{"url": "http://x" }');
    expect(stripJsonComments('{"p": "a/*b*/c"}')).toBe('{"p": "a/*b*/c"}');
  });
  it('preserves escaped quotes inside strings', () => {
    expect(stripJsonComments('{"s": "a\\"//b"}')).toBe('{"s": "a\\"//b"}');
  });
  it('drops trailing commas', () => {
    expect(JSON.parse(stripJsonComments('{"a": [1, 2,],}'))).toEqual({ a: [1, 2] });
  });
  it('drops trailing commas separated by whitespace and comments', () => {
    expect(JSON.parse(stripJsonComments('{"a": [1, 2, // last\n ], /* end */\n}'))).toEqual({
      a: [1, 2],
    });
  });
  it('does not rewrite ",}" / ",]" inside string literals (R5 #5)', () => {
    const src = '{"reports": ["r-{a,}.xml", "x[1,]", "esc\\",}"],}';
    expect(JSON.parse(stripJsonComments(src))).toEqual({
      reports: ['r-{a,}.xml', 'x[1,]', 'esc",}'],
    });
  });
});

describe('loadConfig discovery', () => {
  it('finds config in cwd', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), '{"reports": ["junit.xml"]}', 'utf8');
    const { config, path: p } = loadConfig(dir);
    expect(config.reports).toEqual(['junit.xml']);
    expect(p).toBe(path.join(dir, CONFIG_FILE_NAME));
  });
  it('walks up to 3 levels', () => {
    const root = tmpDir();
    writeFileSync(path.join(root, CONFIG_FILE_NAME), '{"minRuns": 7}', 'utf8');
    const deep = path.join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    const { config } = loadConfig(deep);
    expect(config.minRuns).toBe(7);
  });
  it('returns null path when nothing found', () => {
    const dir = tmpDir();
    const { config, path: p } = loadConfig(dir);
    expect(config).toEqual({});
    expect(p).toBeNull();
  });
  it('supports JSONC and throws with path on invalid content', () => {
    const dir = tmpDir();
    const file = path.join(dir, CONFIG_FILE_NAME);
    writeFileSync(file, '{\n  // flaky stuff\n  "liveRetries": 4,\n}', 'utf8');
    expect(loadConfig(dir).config.liveRetries).toBe(4);
    writeFileSync(file, '{ broken', 'utf8');
    expect(() => loadConfig(dir)).toThrow(dir);
  });
});

describe('config-relative paths (R5 #6)', () => {
  it('storeDir/quarantineFile from a parent-dir config resolve against the CONFIG dir', () => {
    const root = tmpDir();
    writeFileSync(
      path.join(root, CONFIG_FILE_NAME),
      '{"storeDir": ".ff", "quarantineFile": "q/quarantine.json", "reports": ["junit.xml"]}',
      'utf8',
    );
    const deep = path.join(root, 'packages', 'a');
    mkdirSync(deep, { recursive: true });
    const cfg = resolveConfig(loadConfig(deep).config);
    expect(cfg.storeDir).toBe(path.join(root, '.ff'));
    expect(cfg.quarantineFile).toBe(path.join(root, 'q', 'quarantine.json'));
    // reports globs stay relative to the working directory
    expect(cfg.reports).toEqual(['junit.xml']);
    // callers' path.resolve(cwd, …) is a no-op on the anchored values
    expect(path.resolve(deep, cfg.storeDir)).toBe(path.join(root, '.ff'));
  });
  it('a config in cwd resolves exactly as before; defaults stay cwd-relative', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), '{"storeDir": "hist"}', 'utf8');
    const cfg = resolveConfig(loadConfig(dir).config);
    expect(path.resolve(dir, cfg.storeDir)).toBe(path.join(dir, 'hist'));
    expect(cfg.quarantineFile).toBe('flakefinder.quarantine.json');
  });
  it('absolute and invalid values are left for validation', () => {
    const abs = path.resolve('/abs/store');
    expect(anchorConfigPaths({ storeDir: abs }, '/x').storeDir).toBe(abs);
    const bad = anchorConfigPaths({ storeDir: 5 as unknown as string }, '/x');
    expect(() => resolveConfig(bad)).toThrow('storeDir');
  });
});

describe('detectRunner', () => {
  it('package.json with jest devDependency → jest', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'package.json'), '{"devDependencies": {"jest": "^29"}}', 'utf8');
    expect(detectRunner(dir)).toBe('jest');
  });
  it('vitest maps to jest (jest-shaped json reporter)', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'package.json'), '{"scripts": {"test": "vitest run"}}', 'utf8');
    expect(detectRunner(dir)).toBe('jest');
  });
  it('mocha devDependency → mocha', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'package.json'), '{"devDependencies": {"mocha": "^10"}}', 'utf8');
    expect(detectRunner(dir)).toBe('mocha');
  });
  it('pyproject.toml → pytest', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n', 'utf8');
    expect(detectRunner(dir)).toBe('pytest');
  });
  it('go.mod → go', () => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, 'go.mod'), 'module x\n', 'utf8');
    expect(detectRunner(dir)).toBe('go');
  });
  it('empty dir → generic', () => {
    expect(detectRunner(tmpDir())).toBe('generic');
  });
});

describe('validateConfig (v0.2.0)', () => {
  it('accepts every documented key with a valid value', () => {
    expect(() =>
      validateConfig({
        reports: ['junit*.xml'],
        storeDir: '.ff',
        maxRuns: 500,
        minRuns: 2,
        liveRetries: 1,
        flakeScoreThreshold: 50,
        slowThresholdMs: null,
        slowMultiplier: 3,
        quarantineFile: 'q.json',
        runner: 'jest',
        failOnFlakes: true,
      }),
    ).not.toThrow();
  });

  it('rejects unknown keys (typo protection) listing valid keys', () => {
    expect(() => validateConfig({ minRun: 3 } as FlakefinderConfig)).toThrow(
      /minRun.*unknown key.*valid keys/s,
    );
  });

  it('rejects wrong types with expected-vs-got in the message', () => {
    expect(() => validateConfig({ maxRuns: '300' as unknown as number })).toThrow(
      /maxRuns: expected integer 1–100000, got "300" \(string\)/,
    );
    expect(() => validateConfig({ reports: 'junit.xml' as unknown as string[] })).toThrow(
      /reports: expected array of non-empty glob strings/,
    );
    expect(() => validateConfig({ failOnFlakes: 'yes' as unknown as boolean })).toThrow(
      /failOnFlakes: expected boolean/,
    );
  });

  it('rejects wrong-case runner with a did-you-mean hint', () => {
    expect(() => validateConfig({ runner: 'Jest' as unknown as RunnerKind })).toThrow(
      /did you mean "jest"\?/,
    );
    expect(() => validateConfig({ runner: 'sqlite' as RunnerKind })).toThrow(
      /expected one of auto\|pytest\|jest\|mocha\|go\|generic/,
    );
  });

  it('enforces ranges', () => {
    expect(() => validateConfig({ liveRetries: -3 })).toThrow(/liveRetries: expected integer 0–10/);
    expect(() => validateConfig({ minRuns: 0 })).toThrow(/minRuns: expected integer 1–1000/);
    expect(() => validateConfig({ flakeScoreThreshold: 101 })).toThrow(
      /flakeScoreThreshold: expected integer 0–100/,
    );
    expect(() => validateConfig({ slowThresholdMs: -5 })).toThrow(
      /slowThresholdMs: expected positive number or null/,
    );
    expect(() => validateConfig({ slowMultiplier: 0 })).toThrow(
      /slowMultiplier: expected positive number/,
    );
  });

  it('collects ALL problems into one error', () => {
    try {
      validateConfig({
        maxRuns: 'x' as unknown as number,
        runner: 'Jest' as unknown as RunnerKind,
        nope: 1,
      } as unknown as FlakefinderConfig);
      expect.unreachable('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('maxRuns');
      expect(msg).toContain('runner');
      expect(msg).toContain('nope');
      expect(msg.match(/ {2}- /g)).toHaveLength(3);
    }
  });

  it('resolveConfig validates both file config and overrides', () => {
    expect(() => resolveConfig({ runner: 'Jest' as unknown as RunnerKind })).toThrow(
      /did you mean "jest"\?/,
    );
    expect(() => resolveConfig({}, { liveRetries: 99 })).toThrow(/liveRetries/);
    expect(resolveConfig({ minRuns: 2 }, { liveRetries: 1 }).liveRetries).toBe(1);
  });
});

describe('BOM tolerance (QA round 2)', () => {
  it('loads a UTF-8-BOM-prefixed config (PowerShell Out-File / Notepad emit one)', () => {
    const dir = tmpDir();
    const file = path.join(dir, CONFIG_FILE_NAME);
    writeFileSync(file, '\uFEFF{\n  "liveRetries": 4,\n}', 'utf8');
    const { config } = loadConfig(dir);
    expect(config.liveRetries).toBe(4);
  });
});

describe('top-level config shape (QA CLI-16)', () => {
  it.each([
    ['null', 'null'],
    ['[]', 'array'],
    ['42', '42 \\(number\\)'],
    ['"abc"', '"abc" \\(string\\)'],
  ])('%s → "config must be a JSON object"', (json, got) => {
    const dir = tmpDir();
    writeFileSync(path.join(dir, CONFIG_FILE_NAME), json, 'utf8');
    expect(() => loadConfig(dir)).toThrow(new RegExp(`config must be a JSON object, got ${got}`));
    expect(() => readConfigFile(path.join(dir, CONFIG_FILE_NAME))).toThrow(
      /config must be a JSON object/,
    );
    expect(() => validateConfig(JSON.parse(json))).toThrow(/config must be a JSON object/);
  });

  it('readConfigFile anchors paths to the file directory and names the file on errors', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'custom.json');
    writeFileSync(file, '{ "storeDir": "h" }', 'utf8');
    expect(readConfigFile(file).storeDir).toBe(path.join(dir, 'h'));
    expect(() => readConfigFile(path.join(dir, 'missing.json'))).toThrow(/cannot read config/);
    writeFileSync(file, '{ nope', 'utf8');
    expect(() => readConfigFile(file)).toThrow(/invalid config in .*custom\.json/);
  });
});

describe('timeoutSeconds validation (QA CLI-17)', () => {
  it('accepts a positive integer within the run --timeout range, or null', () => {
    expect(() => validateConfig({ timeoutSeconds: 1 })).not.toThrow();
    expect(() => validateConfig({ timeoutSeconds: TIMEOUT_MAX_SECONDS })).not.toThrow();
    expect(() => validateConfig({ timeoutSeconds: null })).not.toThrow();
  });

  it.each([0.5, 0, -1, 1e12, TIMEOUT_MAX_SECONDS + 1, Number.NaN])('rejects %s', (v) => {
    expect(() => validateConfig({ timeoutSeconds: v })).toThrow(
      new RegExp(`timeoutSeconds: expected integer 1–${TIMEOUT_MAX_SECONDS}`),
    );
  });

  it('rejects a non-number', () => {
    expect(() => validateConfig({ timeoutSeconds: '30' as unknown as number })).toThrow(
      /timeoutSeconds: expected integer/,
    );
  });
});
