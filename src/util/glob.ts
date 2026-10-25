import { readdirSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * Minimal glob matcher supporting `**` (crosses directories), `*` (within a
 * segment) and `?` (single char). Patterns without a separator match at any
 * depth. Deliberately dependency-free; brace expansion is out of scope.
 */
function globToRegExp(pattern: string, caseInsensitive: boolean): RegExp {
  const parts = pattern.split('/').filter((p) => p.length > 0);
  let re = '^';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '**') {
      re += '(?:[^/]+/)*';
      if (i === parts.length - 1) re += '[^/]*';
      continue;
    }
    let seg = '';
    for (const ch of part) {
      if (ch === '*') seg += '[^/]*';
      else if (ch === '?') seg += '[^/]';
      else seg += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    re += seg;
    if (i < parts.length - 1) re += '/';
  }
  if (!re.endsWith('$')) re += '$';
  return new RegExp(re, caseInsensitive ? 'i' : undefined);
}

/** All files under `cwd` (skipping dependency/VCS dirs and hidden dirs) matching any pattern. Absolute, sorted, deduped. */
export function matchGlobs(cwd: string, patterns: string[]): string[] {
  if (patterns.length === 0) return [];
  const caseInsensitive = process.platform === 'win32';
  const normalized = patterns.map((p) => {
    const posix = p.replace(/\\/g, '/').replace(/^\.\//, '');
    return posix.includes('/') ? posix : `**/${posix}`;
  });
  const regexps = normalized.map((p) => globToRegExp(p, caseInsensitive));

  const matches = new Set<string>();
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        if (regexps.some((re) => re.test(relPath))) matches.add(path.join(dir, entry.name));
      }
    }
  };
  walk(cwd, '');
  return [...matches].sort();
}
