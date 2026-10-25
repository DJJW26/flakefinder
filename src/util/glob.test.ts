import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { matchGlobs } from './glob.js';

let dirs: string[] = [];
function makeTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ff-glob-'));
  dirs.push(root);
  const files: Array<string[]> = [
    ['junit.xml'],
    ['a', 'junit1.xml'],
    ['a', 'b', 'junit2.xml'],
    ['a', 'out.json'],
    ['node_modules', 'pkg', 'junit-nm.xml'],
    ['dist', 'junit-dist.xml'],
    ['test-results', 'report.json'],
  ];
  for (const parts of files) {
    const dir = path.join(root, ...parts.slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, ...parts), 'x', 'utf8');
  }
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, '.git', 'junit-git.xml'), 'x', 'utf8');
  return root;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const rel = (root: string, p: string): string => p.slice(root.length + 1).replace(/\\/g, '/');

describe('matchGlobs', () => {
  it('bare pattern matches at any depth', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['junit*.xml']).map((p) => rel(root, p));
    expect(matches).toEqual(['a/b/junit2.xml', 'a/junit1.xml', 'junit.xml']);
  });

  it('single-star stays within one directory level', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['a/*.xml']).map((p) => rel(root, p));
    expect(matches).toEqual(['a/junit1.xml']);
  });

  it('explicit ** crosses directories', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['**/*.json']).map((p) => rel(root, p));
    expect(matches).toEqual(['a/out.json', 'test-results/report.json']);
  });

  it('? matches a single character', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['a/junit?.xml']).map((p) => rel(root, p));
    expect(matches).toEqual(['a/junit1.xml']);
  });

  it('skips node_modules, dist and hidden directories', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['**/*.xml']).map((p) => rel(root, p));
    expect(matches.some((m) => m.includes('node_modules'))).toBe(false);
    expect(matches.some((m) => m.startsWith('dist/'))).toBe(false);
    expect(matches.some((m) => m.startsWith('.git/'))).toBe(false);
    expect(matches).toEqual(['a/b/junit2.xml', 'a/junit1.xml', 'junit.xml']);
  });

  it('dedupes overlapping patterns and returns sorted absolute paths', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['junit.xml', '**/junit*.xml', 'a/*.xml']);
    expect(matches[0]).toBe(path.join(root, 'a', 'b', 'junit2.xml'));
    expect(new Set(matches).size).toBe(matches.length);
  });

  it('accepts backslash separators in patterns', () => {
    const root = makeTree();
    const matches = matchGlobs(root, ['a\\*.xml']).map((p) => rel(root, p));
    expect(matches).toEqual(['a/junit1.xml']);
  });

  it('empty patterns → empty result', () => {
    const root = makeTree();
    expect(matchGlobs(root, [])).toEqual([]);
  });

  it('no matches → empty result', () => {
    const root = makeTree();
    expect(matchGlobs(root, ['nothing*.xml'])).toEqual([]);
  });
});
