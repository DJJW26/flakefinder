import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../config.js';
import * as parsers from '../parsers/index.js';
import { ingestReports } from './ingest.js';

let dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const JUNIT =
  '<testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>';

describe('ingestReports survives parser exceptions (R5 #13)', () => {
  it('a throwing parser is reported as a warning; other files are still ingested', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-ingest-'));
    dirs.push(dir);
    const good = path.join(dir, 'good.xml');
    const bad = path.join(dir, 'bad.xml');
    writeFileSync(good, JUNIT, 'utf8');
    writeFileSync(bad, `${JUNIT}<!-- boom -->`, 'utf8');
    const real = parsers.detectParser;
    vi.spyOn(parsers, 'detectParser').mockImplementation((content: string) => {
      const p = real(content);
      if (!p || !content.includes('boom')) return p;
      return {
        ...p,
        parse: () => {
          throw new Error('stack overflow in parser');
        },
      };
    });
    const out = ingestReports([bad, good], resolveConfig({}), path.join(dir, '.ff'), {});
    expect(out.ingestedFiles).toEqual([good]);
    expect(out.warnings.some((w) => w.includes(bad) && w.includes('stack overflow'))).toBe(true);
    expect(out.store.runs()).toHaveLength(1);
  });
});

describe('ingestReports decodes UTF-16 reports (PAR-9)', () => {
  it('a UTF-16LE report with a BOM (PowerShell `>`) is parsed, not skipped', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ff-ingest-'));
    dirs.push(dir);
    const file = path.join(dir, 'utf16.xml');
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JUNIT, 'utf16le')]));
    const out = ingestReports([file], resolveConfig({}), path.join(dir, '.ff'), {});
    expect(out.ingestedFiles).toEqual([file]);
    expect(out.warnings).toEqual([]);
    expect(out.verdicts).toHaveLength(2);
  });
});
