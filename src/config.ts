import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FlakefinderConfig, ResolvedConfig, RunnerKind } from './types.js';

export const CONFIG_FILE_NAME = 'flakefinder.config.json';

/** Strip block- and line-comments that sit outside string literals; drop trailing commas. */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      if (c === '\\') {
        out += c + (next ?? '');
        i += 2;
        continue;
      }
      if (c === quote) inString = false;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  // tolerate trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function defaultConfig(): FlakefinderConfig {
  return {};
}

/** Thrown when user-supplied config fails validation; message lists ALL problems. */
export class ConfigValidationError extends Error {}

const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'reports',
  'storeDir',
  'maxRuns',
  'minRuns',
  'liveRetries',
  'flakeScoreThreshold',
  'slowThresholdMs',
  'slowMultiplier',
  'quarantineFile',
  'runner',
  'failOnFlakes',
  'retryMode',
  'timeoutSeconds',
]);

const VALID_RUNNERS: readonly RunnerKind[] = ['auto', 'pytest', 'jest', 'mocha', 'go', 'generic'];

function describe(v: unknown): string {
  if (typeof v === 'string') return `"${v}" (string)`;
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return `${String(v)} (${typeof v})`;
}

function checkInt(problems: string[], key: string, v: unknown, min: number, max: number): void {
  if (v === undefined) return; // absent keys fall back to defaults
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    problems.push(`${key}: expected integer ${min}–${max}, got ${describe(v)}`);
  }
}

/**
 * Validate user-supplied config keys (partial — absent keys fall back to
 * defaults). Fails fast with every problem listed: wrong-typed values used to
 * silently misbehave (e.g. `runner: "Jest"` fell through to `generic`, which
 * disables quarantine without a warning).
 */
export function validateConfig(config: FlakefinderConfig): void {
  const problems: string[] = [];
  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      problems.push(`${key}: unknown key (valid keys: ${[...KNOWN_KEYS].sort().join(', ')})`);
    }
  }
  const c = config as Record<string, unknown>;

  if (c.reports !== undefined) {
    const ok =
      Array.isArray(c.reports) &&
      (c.reports as unknown[]).every((x) => typeof x === 'string' && x.trim() !== '');
    if (!ok)
      problems.push(
        'reports: expected array of non-empty glob strings, got ' + describe(c.reports),
      );
  }
  if (c.storeDir !== undefined && (typeof c.storeDir !== 'string' || c.storeDir.trim() === '')) {
    problems.push(`storeDir: expected non-empty string, got ${describe(c.storeDir)}`);
  }
  checkInt(problems, 'maxRuns', c.maxRuns, 1, 100_000);
  checkInt(problems, 'minRuns', c.minRuns, 1, 1_000);
  checkInt(problems, 'liveRetries', c.liveRetries, 0, 10);
  checkInt(problems, 'flakeScoreThreshold', c.flakeScoreThreshold, 0, 100);
  if (
    c.slowThresholdMs !== undefined &&
    c.slowThresholdMs !== null &&
    (typeof c.slowThresholdMs !== 'number' ||
      !Number.isFinite(c.slowThresholdMs) ||
      c.slowThresholdMs <= 0)
  ) {
    problems.push(
      `slowThresholdMs: expected positive number or null, got ${describe(c.slowThresholdMs)}`,
    );
  }
  if (
    c.slowMultiplier !== undefined &&
    (typeof c.slowMultiplier !== 'number' ||
      !Number.isFinite(c.slowMultiplier) ||
      c.slowMultiplier <= 0)
  ) {
    problems.push(`slowMultiplier: expected positive number, got ${describe(c.slowMultiplier)}`);
  }
  if (
    c.quarantineFile !== undefined &&
    (typeof c.quarantineFile !== 'string' || c.quarantineFile.trim() === '')
  ) {
    problems.push(`quarantineFile: expected non-empty string, got ${describe(c.quarantineFile)}`);
  }
  if (c.runner !== undefined) {
    if (typeof c.runner !== 'string' || !VALID_RUNNERS.includes(c.runner as RunnerKind)) {
      const guess = VALID_RUNNERS.find(
        (r) => typeof c.runner === 'string' && r.toLowerCase() === c.runner.toLowerCase(),
      );
      problems.push(
        `runner: expected one of ${VALID_RUNNERS.join('|')}, got ${describe(c.runner)}` +
          (guess ? ` (did you mean "${guess}"?)` : ''),
      );
    }
  }
  if (c.failOnFlakes !== undefined && typeof c.failOnFlakes !== 'boolean') {
    problems.push(`failOnFlakes: expected boolean, got ${describe(c.failOnFlakes)}`);
  }
  if (c.retryMode !== undefined) {
    const modes: readonly string[] = ['auto', 'failed', 'full'];
    if (typeof c.retryMode !== 'string' || !modes.includes(c.retryMode)) {
      problems.push(`retryMode: expected one of ${modes.join('|')}, got ${describe(c.retryMode)}`);
    }
  }
  if (
    c.timeoutSeconds !== undefined &&
    c.timeoutSeconds !== null &&
    (typeof c.timeoutSeconds !== 'number' || !Number.isFinite(c.timeoutSeconds) || c.timeoutSeconds <= 0)
  ) {
    problems.push(
      `timeoutSeconds: expected positive number or null, got ${describe(c.timeoutSeconds)}`,
    );
  }

  if (problems.length > 0) {
    throw new ConfigValidationError(`invalid flakefinder config:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Defaults per PLAN §6. User-supplied values are validated before merging.
 * flakeScoreThreshold defaults to 30: flaky-suspected scores cap at 34
 * (directionChanges ≤ 24 + data bonus 10), so a 40 default would make the
 * class invisible at default settings. */
export function resolveConfig(
  config: FlakefinderConfig = {},
  overrides: Partial<FlakefinderConfig> = {},
): ResolvedConfig {
  validateConfig(config);
  validateConfig(overrides);
  return {
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
    ...config,
    ...overrides,
  };
}

/** Look for flakefinder.config.json in `cwd` and up to 3 parent directories. */
export function loadConfig(cwd: string): { config: FlakefinderConfig; path: string | null } {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth <= 3; depth++) {
    const candidate = path.join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) {
      let raw: string;
      try {
        raw = readFileSync(candidate, 'utf8');
      } catch (err) {
        throw new Error(`cannot read ${candidate}: ${(err as Error).message}`);
      }
      try {
        // strip a UTF-8 BOM — PowerShell's Out-File and Notepad emit one, and
        // JSON.parse rejects it
        const parsed = JSON.parse(
          stripJsonComments(raw.replace(/^\uFEFF/, '')),
        ) as FlakefinderConfig;
        return { config: parsed, path: candidate };
      } catch (err) {
        throw new Error(`invalid config in ${candidate}: ${(err as Error).message}`);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { config: {}, path: null };
}

/**
 * Best-effort test-runner detection from project files. vitest is mapped to
 * `jest` (its --reporter=json output is Jest-shaped).
 */
export function detectRunner(cwd: string): Exclude<RunnerKind, 'auto'> {
  const has = (f: string): boolean => {
    try {
      statSync(path.join(cwd, f));
      return true;
    } catch {
      return false;
    }
  };

  if (has('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<
        string,
        any
      >;
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = JSON.stringify(pkg.scripts ?? {});
      if (deps.jest || deps.vitest || /\b(jest|vitest)\b/.test(scripts)) return 'jest';
      if (deps.mocha || /\bmocha\b/.test(scripts)) return 'mocha';
    } catch {
      // fall through to file markers
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('setup.cfg'))
    return 'pytest';
  if (has('.mocharc.yml') || has('.mocharc.json') || has('.mocharc.js') || has('.mocharc.cjs'))
    return 'mocha';
  if (has('go.mod')) return 'go';
  return 'generic';
}
