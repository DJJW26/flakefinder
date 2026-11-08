import { renameSync } from 'node:fs';

/** Errors Windows reports when a rename raced another open handle / scanner. */
const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** ~2s worst case: AV/indexers usually release the destination in <1s. */
const RETRY_ATTEMPTS = 30;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `from` over `to`, atomically. On POSIX this is a single rename(2).
 * On Windows it maps to MoveFileEx(MOVEFILE_REPLACE_EXISTING), which can
 * transiently fail with EPERM/EACCES/EBUSY while another process (another
 * reader, antivirus, the search indexer) still has the destination open.
 * Retry briefly instead of failing the whole command; the write itself is
 * already complete in the temp file.
 */
export function renameOverSync(
  from: string,
  to: string,
  opts: { platform?: NodeJS.Platform; attempts?: number } = {},
): void {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    renameSync(from, to);
    return;
  }
  const attempts = opts.attempts ?? RETRY_ATTEMPTS;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt + 1 >= attempts || !RETRYABLE.has(code)) throw err;
      sleepSync(Math.min(5 * (attempt + 1), 100));
    }
  }
}
