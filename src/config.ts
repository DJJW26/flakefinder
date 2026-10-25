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

/** Defaults per PLAN §6. */
export function resolveConfig(
  config: FlakefinderConfig = {},
  overrides: Partial<FlakefinderConfig> = {},
): ResolvedConfig {
  return {
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
        const parsed = JSON.parse(stripJsonComments(raw)) as FlakefinderConfig;
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
export function detectRunner(cwd: string): RunnerKind {
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
      const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, any>;
      const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
      const scripts = JSON.stringify(pkg.scripts ?? {});
      if (deps.jest || deps.vitest || /\b(jest|vitest)\b/.test(scripts)) return 'jest';
      if (deps.mocha || /\bmocha\b/.test(scripts)) return 'mocha';
    } catch {
      // fall through to file markers
    }
  }
  if (has('pyproject.toml') || has('pytest.ini') || has('setup.py') || has('setup.cfg')) return 'pytest';
  if (has('.mocharc.yml') || has('.mocharc.json') || has('.mocharc.js') || has('.mocharc.cjs')) return 'mocha';
  if (has('go.mod')) return 'go';
  return 'generic';
}
