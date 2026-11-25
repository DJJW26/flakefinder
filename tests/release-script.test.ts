import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const version = '3.1.0-rc.1';
const notes = '### Fixes\n\n- Preserve paths with spaces.';
const changelog = `# Changelog\r\n\r\n## ${version}\r\n\r\n${notes.replaceAll('\n', '\r\n')}\r\n\r\n## 3.0.0\r\n\r\n- Earlier notes.\r\n`;

let root: string;

function write(file: string, content: string) {
  writeFileSync(path.join(root, file), content);
}

function runRelease(...args: string[]) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'release.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function commitFixture() {
  git('init', '--quiet');
  git('config', 'core.autocrlf', 'false');
  git(
    'add',
    '--',
    'scripts/release.mjs',
    'package.json',
    'package-lock.json',
    'src/types.ts',
    'CHANGELOG.md',
  );
  git(
    '-c',
    'user.name=Release Test',
    '-c',
    'user.email=release-test@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'release test fixture',
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ff release '));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'scripts'));
  copyFileSync(script, path.join(root, 'scripts', 'release.mjs'));
  write('package.json', JSON.stringify({ version }));
  write('package-lock.json', JSON.stringify({ version, packages: { '': { version } } }));
  write('src/types.ts', `export const FLAKEFINDER_VERSION = '${version}';\r\n`);
  write('CHANGELOG.md', changelog);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('release tag validation', () => {
  it('prints only the exact prerelease notes from a CRLF changelog', () => {
    const result = runRelease('--validate-tag', `v${version}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${notes}\n`);
    expect(result.stderr).toBe('');
  });

  it.each(['3.1.0-rc.1', 'v03.1.0', 'v3.1.0-rc.01', 'v3.1.0+build.1', 'v3.1', 'v3.1.0\n'])(
    'rejects malformed or unsupported tags (%j)',
    (tag) => {
      const result = runRelease('--validate-tag', tag);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/Invalid release version|start with v/);
    },
  );

  it.each([
    ['package.json', JSON.stringify({ version: '3.0.0' }), 'package.json'],
    [
      'package-lock.json',
      JSON.stringify({ version: '3.0.0', packages: { '': { version } } }),
      'package-lock.json: 3.0.0',
    ],
    [
      'package-lock.json',
      JSON.stringify({ version, packages: {} }),
      'package-lock.json (root package): (missing)',
    ],
    [
      'src/types.ts',
      "export const FLAKEFINDER_VERSION = '3.0.0';\n",
      'src/types.ts (FLAKEFINDER_VERSION): 3.0.0',
    ],
  ])('rejects a version mismatch in %s before printing notes', (file, contents, message) => {
    write(file, contents);
    const result = runRelease('--validate-tag', `v${version}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(message);
  });

  it.each([
    '## 3.1.0-rc.10\n\n- Different release.',
    `## ${version}\n\n## 3.0.0\n\n- Earlier notes.`,
    `## ${version}\n\n### Fixes\n\n<!-- Add notes here -->`,
    `## ${version}\n\n- _(fill in before tagging — this stub is created by scripts/release.mjs)_`,
    `## ${version}\n\n- Fix a bug.\n- **TODO**`,
    `## ${version}\n\n- TODO: Add the release summary.`,
    `## ${version}\n\n- Fix a bug.\n\n## ${version}\n\n- Duplicate notes.`,
  ])('rejects missing, empty, placeholder, or ambiguous notes (%j)', (body) => {
    write('CHANGELOG.md', `# Changelog\n\n${body}\n`);
    const result = runRelease('--validate-tag', `v${version}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/CHANGELOG\.md/);
  });
});

describe('release preparation', () => {
  it('refuses to mutate a checkout with unrelated changes', () => {
    commitFixture();
    write('unrelated.txt', 'local work');
    const result = runRelease('3.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('clean working tree');
    expect(git('status', '--porcelain').trim()).toBe('?? unrelated.txt');
    expect(git('tag', '--list')).toBe('');
  });

  it('refuses to prepare a clean checkout without notes for the requested version', () => {
    commitFixture();
    const result = runRelease('3.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('## 3.2.0');
    expect(git('status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toContain(version);
    expect(git('tag', '--list')).toBe('');
  });

  it('prepares only local version changes and preserves dependency versions', () => {
    const next = '3.2.0-beta.2';
    const scripts = Object.fromEntries(
      ['test', 'typecheck', 'lint', 'build', 'perf', 'e2e'].map((name) => [name, 'node --version']),
    );
    write('package.json', JSON.stringify({ version, scripts }));
    write(
      'package-lock.json',
      JSON.stringify({ version, packages: { '': { version }, 'node_modules/x': { version } } }),
    );
    write('CHANGELOG.md', `# Changelog\n\n## ${next}\n\n${notes}\n`);
    commitFixture();

    const result = runRelease(next);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(runRelease('--validate-tag', `v${next}`).stdout).toBe(`${notes}\n`);
    const lockfile = readFileSync(path.join(root, 'package-lock.json'), 'utf8');
    expect(JSON.parse(lockfile).packages['node_modules/x'].version).toBe(version);
    expect(git('diff', '--name-only').trim().split('\n')).toEqual([
      'package-lock.json',
      'package.json',
      'src/types.ts',
    ]);
    expect(git('diff', '--cached', '--name-only')).toBe('');
    expect(git('tag', '--list')).toBe('');
  }, 15_000);
});
