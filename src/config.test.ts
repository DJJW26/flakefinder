import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONFIG_FILE_NAME,
  defaultConfig,
  detectRunner,
  loadConfig,
  resolveConfig,
  stripJsonComments,
} from './config.js';

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
      flakeScoreThreshold: 40,
      slowThresholdMs: 10_000,
      slowMultiplier: 5,
      quarantineFile: 'flakefinder.quarantine.json',
      runner: 'auto',
      failOnFlakes: false,
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
