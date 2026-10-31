import { describe, expect, it } from 'vitest';
import { type CacheApi, cacheUsable, restoreHistory, saveHistory } from './history-cache.js';

function fakeCache(available: boolean, saveResult = 1): CacheApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    isFeatureAvailable: () => available,
    restoreCache: async (_p, key) => {
      calls.push(`restore:${key}`);
      return 'flakefinder-history-old';
    },
    saveCache: async (_p, key) => {
      calls.push(`save:${key}`);
      return saveResult;
    },
  };
}

function log() {
  const info: string[] = [];
  const warning: string[] = [];
  return {
    info,
    warning,
    sink: { info: (m: string) => info.push(m), warning: (m: string) => warning.push(m) },
  };
}

describe('history cache without a cache service (QA ACT-12)', () => {
  it('unavailable service: one warning, no restore/save attempted', () => {
    const api = fakeCache(false);
    const l = log();
    expect(cacheUsable(api, l.sink)).toBe(false);
    expect(l.warning).toHaveLength(1);
    expect(l.warning[0]).toContain('not available');
    expect(api.calls).toEqual([]);
  });

  it('isFeatureAvailable throwing counts as unavailable', () => {
    const api = {
      ...fakeCache(true),
      isFeatureAvailable: () => {
        throw new Error('x');
      },
    };
    expect(cacheUsable(api, log().sink)).toBe(false);
  });

  it('available service: restore + save run; a -1 save is a warning', async () => {
    const api = fakeCache(true, -1);
    const l = log();
    expect(cacheUsable(api, l.sink)).toBe(true);
    await restoreHistory(api, l.sink, '/s', 'k1', ['p-']);
    await saveHistory(api, l.sink, '/s', 'k1');
    expect(api.calls).toEqual(['restore:k1', 'save:k1']);
    expect(l.info[0]).toContain('restored from flakefinder-history-old');
    expect(l.warning[0]).toContain('was not saved under k1');
  });
});
