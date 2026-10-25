// STUB — Agent C owns this file. Replace entirely with the real implementation (PLAN §4/§6).
import type { FlakefinderConfig, ResolvedConfig } from './types.js';

export function defaultConfig(): FlakefinderConfig {
  return {};
}

export function loadConfig(_cwd: string): { config: FlakefinderConfig; path: string | null } {
  return { config: {}, path: null };
}

export function resolveConfig(
  config: FlakefinderConfig,
  overrides?: Partial<FlakefinderConfig>,
): ResolvedConfig {
  const defaults: ResolvedConfig = {
    reports: [],
    storeDir: '.flakefinder',
    maxRuns: 300,
    minRuns: 3,
    liveRetries: 2,
    flakeScoreThreshold: 40,
    slowThresholdMs: 10000,
    slowMultiplier: 5,
    quarantineFile: 'flakefinder.quarantine.json',
    runner: 'auto',
    failOnFlakes: false,
  };
  return { ...defaults, ...config, ...overrides };
}
