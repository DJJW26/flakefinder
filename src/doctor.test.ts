import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDoctor } from './doctor.js';

let dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'ff-doc-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('runDoctor', () => {
  it('empty dir: no config, no reports, no history — warnings not failures', () => {
    const { lines, ok } = runDoctor(tmp());
    expect(ok).toBe(true);
    expect(lines.some((l) => l.message.startsWith('config: none found'))).toBe(true);
    expect(lines.some((l) => l.status === 'warn' && l.message.startsWith('reports:'))).toBe(true);
    expect(lines.some((l) => l.message.startsWith('history: empty'))).toBe(true);
  });

  it('invalid config: FAIL with the validation detail', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "runner": "Jest" }', 'utf8');
    const { lines, ok } = runDoctor(d);
    expect(ok).toBe(false);
    expect(lines[0]!.status).toBe('fail');
    expect(lines[0]!.message).toContain('did you mean "jest"?');
  });

  it('valid config + matching reports: ok, report count shown', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": ["junit.xml"] }', 'utf8');
    writeFileSync(
      path.join(d, 'junit.xml'),
      '<testsuites><testsuite name="s"><testcase name="t"/></testsuite></testsuites>',
      'utf8',
    );
    const { lines, ok } = runDoctor(d);
    expect(ok).toBe(true);
    expect(lines.some((l) => l.status === 'ok' && l.message.startsWith('reports: 1 file'))).toBe(
      true,
    );
  });

  it('config with globs but no matching files: WARN with a hint', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": ["junit.xml"] }', 'utf8');
    const { lines } = runDoctor(d);
    const reports = lines.find((l) => l.message.startsWith('reports:'))!;
    expect(reports.status).toBe('warn');
    expect(reports.hint).toContain('flakefinder init');
  });
});

describe('doctor resilience (QA round 4)', () => {
  it('reports a corrupt quarantine file as FAIL instead of crashing', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "reports": [] }', 'utf8');
    writeFileSync(path.join(d, 'flakefinder.quarantine.json'), '{ broken quarantine', 'utf8');
    const { lines, ok } = runDoctor(d);
    expect(ok).toBe(false);
    const q = lines.find((l) => l.message.startsWith('quarantine:'))!;
    expect(q.status).toBe('fail');
    expect(q.message).toContain('unreadable');
    // run only warns on a corrupt quarantine file — the hint must not claim it fails
    expect(q.hint).not.toContain('would also fail');
    expect(q.hint).toContain('excludes nothing');
    expect(q.hint).toContain(path.join(d, 'flakefinder.quarantine.json'));
  });
});

describe('doctor history section (QA A5)', () => {
  const run = (id: string) =>
    JSON.stringify({ runId: id, timestamp: new Date().toISOString(), results: [] });

  it('history.jsonl as a DIRECTORY: FAIL, ok=false (exit 1), no misleading "0 run(s)"', () => {
    const d = tmp();
    mkdirSync(path.join(d, '.flakefinder', 'history.jsonl'), { recursive: true });
    const { lines, ok } = runDoctor(d);
    expect(ok).toBe(false);
    const hist = lines.filter((l) => l.message.startsWith('history:'));
    expect(hist).toHaveLength(1);
    expect(hist[0]!.status).toBe('fail');
    expect(hist[0]!.message).toContain('unreadable — EISDIR');
    expect(hist[0]!.hint).toContain('readable regular file');
    // the remaining sections still ran
    expect(lines.some((l) => l.message.startsWith('quarantine:'))).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'unreadable regular file (EACCES): FAIL, not an ok "0 run(s)" + "parallel writers" warning',
    () => {
      const d = tmp();
      const file = path.join(d, '.flakefinder', 'history.jsonl');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${run('r1')}\n`, 'utf8');
      chmodSync(file, 0o000);
      try {
        const { lines, ok } = runDoctor(d);
        expect(ok).toBe(false);
        const hist = lines.filter((l) => l.message.startsWith('history:'));
        expect(hist).toHaveLength(1);
        expect(hist[0]!.status).toBe('fail');
        expect(hist[0]!.message).toContain('unreadable — EACCES');
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it('readable store: ok line with the run count', () => {
    const d = tmp();
    const file = path.join(d, '.flakefinder', 'history.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `{"version":1}\n${run('r1')}\n${run('r2')}\n`, 'utf8');
    const { lines, ok } = runDoctor(d);
    expect(ok).toBe(true);
    const hist = lines.find((l) => l.message.startsWith('history:'))!;
    expect(hist.status).toBe('ok');
    expect(hist.message).toMatch(/^history: 2 run\(s\), \d+ KB, format v1$/);
  });
});

describe('doctor --config (QA CLI-9)', () => {
  it('checks the explicit config file instead of discovering one', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{}', 'utf8');
    writeFileSync(path.join(d, 'bad.json'), '{ "maxRuns": "lots" }', 'utf8');
    const { lines, ok } = runDoctor(d, { configPath: 'bad.json' });
    expect(ok).toBe(false);
    expect(lines[0]!.status).toBe('fail');
    expect(lines[0]!.message).toContain('maxRuns');
    expect(lines[0]!.hint).toContain(path.join(d, 'bad.json'));
  });

  it('a missing --config file is a FAIL, not "none found"', () => {
    const d = tmp();
    const { lines, ok } = runDoctor(d, { configPath: 'missing.json' });
    expect(ok).toBe(false);
    expect(lines[0]!.message).toMatch(/cannot read config/);
  });

  it('a valid --config is reported as such and its settings are used', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'ff.json'), '{ "quarantineFile": "q/list.json" }', 'utf8');
    const { lines, ok } = runDoctor(d, { configPath: 'ff.json' });
    expect(ok).toBe(true);
    expect(lines[0]!.message).toBe(`config: ${path.join(d, 'ff.json')} (--config)`);
    expect(lines.find((l) => l.message.startsWith('quarantine:'))!.message).toContain(
      path.join(d, 'q', 'list.json'),
    );
  });
});

describe('doctor uses the configured quarantine file (QA CLI-31)', () => {
  it('reads quarantineFile from the config, not flakefinder.quarantine.json', () => {
    const d = tmp();
    writeFileSync(
      path.join(d, 'flakefinder.config.json'),
      '{ "quarantineFile": "custom-q.json", "runner": "jest" }',
      'utf8',
    );
    writeFileSync(path.join(d, 'custom-q.json'), '{ broken', 'utf8');
    const { lines, ok } = runDoctor(d);
    expect(ok).toBe(false);
    const q = lines.find((l) => l.message.startsWith('quarantine:'))!;
    expect(q.status).toBe('fail');
    expect(q.hint).toContain('custom-q.json');
  });

  it('judges auto-exclusion support by the pinned runner, not only the detected one', () => {
    const d = tmp();
    writeFileSync(path.join(d, 'flakefinder.config.json'), '{ "runner": "jest" }', 'utf8');
    writeFileSync(path.join(d, 'flakefinder.quarantine.json'), '{ "entries": [] }', 'utf8');
    const q = runDoctor(d).lines.find((l) => l.message.startsWith('quarantine:'))!;
    expect(q.status).toBe('ok');
  });
});
