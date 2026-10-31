import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import { detectCodeState, parsePorcelainZ } from './git-state.js';
import { runLive } from './wrap.js';

const hasGit = spawnSync('git', ['--version']).status === 0;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  vi.restoreAllMocks();
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-git-'));
  dirs.push(dir);
  git(dir, 'init', '-q');
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), c, 'utf8');
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('parsePorcelainZ', () => {
  it('reads modified paths and skips the original path of renames', () => {
    const out = ' M src/a.ts\0R  new.ts\0old.ts\0D  gone.ts\0MM both.ts\0';
    expect(parsePorcelainZ(out)).toEqual(['src/a.ts', 'new.ts', 'gone.ts', 'both.ts']);
    expect(parsePorcelainZ('')).toEqual([]);
  });
});

describe.skipIf(!hasGit)('detectCodeState (QA RUN-11)', () => {
  it('outside git → no sha', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-nogit-'));
    dirs.push(dir);
    expect(detectCodeState(dir).commitSha).toBeUndefined();
  });

  it('clean tree → HEAD; untracked files do not make it dirty', () => {
    const dir = repo({ 'src.js': 'a' });
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'counter.txt'), '1');
    expect(detectCodeState(dir)).toEqual({ commitSha: head, dirtyFiles: [] });
  });

  it('a tracked edit → <sha>-dirty-<hash>, stable for the same content, new for new content', () => {
    const dir = repo({ 'src.js': 'a' });
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(dir, 'src.js'), 'b');
    const s1 = detectCodeState(dir);
    expect(s1.commitSha).toMatch(new RegExp(`^${head}-dirty-[0-9a-f]{12}$`));
    expect(s1.dirtyFiles).toEqual(['src.js']);
    expect(detectCodeState(dir).commitSha).toBe(s1.commitSha);
    writeFileSync(path.join(dir, 'src.js'), 'c');
    expect(detectCodeState(dir).commitSha).not.toBe(s1.commitSha);
    writeFileSync(path.join(dir, 'src.js'), 'a'); // edit reverted → clean again
    expect(detectCodeState(dir).commitSha).toBe(head);
  });

  it("flakefinder's own files (store, quarantine, reports) are ignored, also from a subdir", () => {
    const dir = repo({
      'app/flakefinder.quarantine.json': '{}',
      'app/.flakefinder/history.jsonl': '',
      'app/junit.xml': '<x/>',
      'app/src.js': 'a',
    });
    const app = path.join(dir, 'app');
    const head = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(path.join(app, 'flakefinder.quarantine.json'), '{"x":1}');
    writeFileSync(path.join(app, '.flakefinder/history.jsonl'), '{}\n');
    writeFileSync(path.join(app, 'junit.xml'), '<y/>');
    const exclude = ['.flakefinder', 'flakefinder.quarantine.json', path.join(app, 'junit.xml')];
    expect(detectCodeState(app, exclude).commitSha).toBe(head);
    // a change elsewhere in the repo still counts (code identity is repo-wide)
    writeFileSync(path.join(dir, 'README'), 'x');
    git(dir, 'add', 'README');
    expect(detectCodeState(app, exclude).dirtyFiles).toEqual(['README']);
  });

  it('runLive: a failure at HEAD then an uncommitted fix is NOT flaky-confirmed', async () => {
    const script = `
const fs = require('fs');
const ok = fs.readFileSync('impl.txt', 'utf8').trim() === 'fixed';
fs.writeFileSync('out.json', JSON.stringify({ testResults: [{ name: 't.js', status: ok ? 'passed' : 'failed', assertionResults: [
  { title: 'adds', fullName: 'adds', status: ok ? 'passed' : 'failed', ancestorTitles: [], duration: 1, failureMessages: ok ? [] : ['bug'] },
] }] }));
process.exit(ok ? 0 : 1);
`;
    const dir = repo({ 'impl.txt': 'buggy\n', 'script.js': script, '.gitignore': 'out.json\n' });
    const cfg = resolveConfig({ reports: ['out.json'], storeDir: '.ffstore', minRuns: 1 });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { retries: 0, cwd: dir, applyQuarantine: false };
    const first = await runLive(['node', 'script.js'], cfg, opts);
    expect(first.verdicts[0]!.classification).toBe('failing');
    writeFileSync(path.join(dir, 'impl.txt'), 'fixed\n'); // the local, uncommitted fix
    const second = await runLive(['node', 'script.js'], cfg, opts);
    const v = second.verdicts[0]!;
    expect(v.sameShaFlips).toBe(0);
    expect(v.classification).toBe('passing');
    expect(second.attempts[0]!.commitSha).toMatch(/-dirty-[0-9a-f]{12}$/);
    expect(log.mock.calls.flat().join('\n')).toMatch(/uncommitted changes \(1 file\(s\)\)/);
  }, 60_000);
});
