import { lstatSync } from 'node:fs';
import path from 'node:path';
import { snapshotPath } from '../store/history-store.js';
import { baselinePath } from './baseline.js';

/**
 * History persistence via the Actions cache. The cache API is injected so
 * the behavior is testable without a cache service.
 */

export interface CacheApi {
  isFeatureAvailable(): boolean;
  restoreCache(
    paths: string[],
    primaryKey: string,
    restoreKeys?: string[],
  ): Promise<string | undefined>;
  saveCache(paths: string[], key: string): Promise<number>;
}

export interface Log {
  info(message: string): void;
  warning(message: string): void;
}

/**
 * Is the cache service reachable at all? Without it (GHES without cache,
 * act, local runs) each restore/save burns ~5 s of retries and warns twice
 * per run. One warning instead, and both calls are skipped.
 */
export function cacheUsable(api: CacheApi, log: Log): boolean {
  let ok = false;
  try {
    ok = api.isFeatureAvailable();
  } catch {
    ok = false;
  }
  if (!ok) {
    log.warning(
      'Actions cache service not available — flakefinder history will not persist between runs',
    );
  }
  return ok;
}

// @actions/cache accepts newline-delimited glob patterns. Pass only the
// owned files, even when the config places the store at the workspace root.
function historyFiles(storeDir: string): string[] {
  return [path.join(storeDir, 'history.jsonl'), snapshotPath(storeDir), baselinePath(storeDir)];
}

function literalPatterns(files: string[]): string[] {
  return files.map((file) => {
    if (/[\r\n]/.test(file)) throw new Error('cache paths cannot contain line breaks');
    const pattern = process.platform === 'win32' ? file : file.replaceAll('\\', '\\\\');
    return pattern.replace(/[[?*]/g, (c) => `[${c}]`);
  });
}

export async function restoreHistory(
  api: CacheApi,
  log: Log,
  storeDir: string,
  saveKey: string,
  restoreKeys: string[],
): Promise<void> {
  try {
    const hit = await api.restoreCache(
      literalPatterns(historyFiles(storeDir)),
      saveKey,
      restoreKeys,
    );
    if (hit) log.info(`history cache restored from ${hit}`);
  } catch (err) {
    log.warning(`history cache restore failed (continuing): ${(err as Error).message}`);
  }
}

/** @actions/cache reports most save failures by returning -1, not by throwing. */
export async function saveHistory(
  api: CacheApi,
  log: Log,
  storeDir: string,
  saveKey: string,
): Promise<void> {
  try {
    const files = historyFiles(storeDir);
    for (const file of files) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) throw new Error(`expected a regular history file at ${file}`);
    }
    const id = await api.saveCache(literalPatterns(files), saveKey);
    if (id === -1) {
      log.warning(
        `history cache was not saved under ${saveKey} (key taken — e.g. matrix legs of one job — or cache unavailable); this run's history will not carry over`,
      );
    }
  } catch (err) {
    log.warning(`history cache save failed: ${(err as Error).message}`);
  }
}
