import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(q.hint).toContain('a `run` would also fail');
  });
});
