import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/** Files above this size are identified by size+mtime instead of being hashed. */
const MAX_HASHED_BYTES = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;

export interface CodeState {
  /** HEAD sha, or `<HEAD sha>-dirty-<content hash>` for a dirty tree; undefined outside git. */
  commitSha: string | undefined;
  /** Tracked files with uncommitted changes (repo-root relative), after exclusions. */
  dirtyFiles: string[];
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    // not created yet: resolve the parent so symlinked tmp dirs still compare equal
    const parent = path.dirname(p);
    return parent === p ? p : path.join(real(parent), path.basename(p));
  }
}

/**
 * Paths of tracked files with uncommitted changes (staged or not), relative
 * to the repo root, from `git status --porcelain -z`. Untracked files are
 * ignored on purpose: build output, counters and caches that nobody listed in
 * .gitignore would otherwise make every run "dirty".
 */
export function parsePorcelainZ(out: string): string[] {
  const files: string[] = [];
  const tokens = out.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.length < 4) continue;
    const xy = t.slice(0, 2);
    files.push(t.slice(3));
    // renames/copies carry the original path as the NEXT token
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return files;
}

/**
 * The code state a live run executes (PLAN §5 "Dirty working trees"). A clean
 * tree is HEAD's sha. Uncommitted changes to tracked files — ignoring
 * flakefinder's own files (`exclude`: store dir, quarantine file, config,
 * report files) — make it `<sha>-dirty-<hash>`, where the hash covers the
 * changed paths and their current contents: a local, uncommitted fix is a
 * different code state from HEAD (a direction change, not a same-SHA flip),
 * while re-running the SAME edits still compares like with like.
 */
export function detectCodeState(cwd: string, exclude: string[] = []): CodeState {
  const head = git(cwd, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return { commitSha: undefined, dirtyFiles: [] };
  const status = git(cwd, ['status', '--porcelain', '-z', '--untracked-files=no']);
  const top = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
  if (status === null || !top) return { commitSha: head, dirtyFiles: [] };

  const root = real(top);
  const excluded = exclude.map((p) => real(path.resolve(cwd, p)));
  const isExcluded = (abs: string): boolean =>
    excluded.some((e) => abs === e || abs.startsWith(e + path.sep));
  const dirtyFiles = parsePorcelainZ(status)
    .filter((rel) => !isExcluded(path.join(root, rel)))
    .sort();
  if (dirtyFiles.length === 0) return { commitSha: head, dirtyFiles };

  const h = createHash('sha256');
  for (const rel of dirtyFiles) {
    const abs = path.join(root, rel);
    h.update(rel).update('\0');
    try {
      const st = statSync(abs);
      if (!st.isFile()) h.update(`[${st.isDirectory() ? 'dir' : 'other'}]`);
      else if (st.size > MAX_HASHED_BYTES) h.update(`[${st.size}:${st.mtimeMs}]`);
      else h.update(readFileSync(abs));
    } catch {
      h.update('[deleted]');
    }
    h.update('\0');
  }
  return { commitSha: `${head}-dirty-${h.digest('hex').slice(0, 12)}`, dirtyFiles };
}
