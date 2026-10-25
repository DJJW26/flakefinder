import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { QuarantineEntry, RunnerKind, TestVerdict } from '../types.js';

interface QuarantineFile {
  version: 1;
  entries: QuarantineEntry[];
}

const EMPTY: QuarantineFile = { version: 1, entries: [] };

/**
 * Manages flakefinder.quarantine.json — the list of tests excluded from runs.
 * Quarantine never edits test source files; exclusion happens via runner
 * flags (see exclusionArgs).
 */
export class QuarantineManager {
  private filePath: string;
  private file: QuarantineFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.file = this.load();
  }

  private load(): QuarantineFile {
    if (!existsSync(this.filePath)) return { ...EMPTY, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as QuarantineFile;
      if (!Array.isArray(parsed.entries)) throw new Error('missing "entries" array');
      return { version: 1, entries: parsed.entries };
    } catch (err) {
      throw new Error(`invalid quarantine file ${this.filePath}: ${(err as Error).message}`);
    }
  }

  list(): QuarantineEntry[] {
    return [...this.file.entries];
  }

  /** Add or replace an entry (same testId). */
  add(entry: QuarantineEntry): void {
    this.file.entries = this.file.entries.filter((e) => e.testId !== entry.testId);
    this.file.entries.push(entry);
  }

  remove(testId: string): boolean {
    const before = this.file.entries.length;
    this.file.entries = this.file.entries.filter((e) => e.testId !== testId);
    return this.file.entries.length < before;
  }

  /**
   * Drop entries that no longer deserve quarantine. Deliberately
   * conservative: quarantined tests are excluded from runs, so "not seen
   * lately" is NOT evidence of health (that would silently un-quarantine
   * everything). An entry leaves quarantine only on positive evidence —
   * the test ran (quarantine disabled or full-suite run) and passed stably —
   * or when the entry is older than 90 days and the test is gone from
   * history. Returns the removed entries.
   */
  prune(verdicts: TestVerdict[], maxAgeDays = 90): QuarantineEntry[] {
    if (verdicts.length === 0) return [];
    const byId = new Map(verdicts.map((v) => [v.testId, v]));
    const removed: QuarantineEntry[] = [];
    const kept: QuarantineEntry[] = [];
    for (const entry of this.file.entries) {
      const v = byId.get(entry.testId);
      const healthy = v !== undefined && v.classification === 'passing' && v.runsObserved >= 10;
      const quarantinedMs = Date.parse(entry.quarantinedAt);
      const agedOut =
        v?.classification === 'gone' &&
        !Number.isNaN(quarantinedMs) &&
        Date.now() - quarantinedMs > maxAgeDays * 86_400_000;
      if (healthy || agedOut) removed.push(entry);
      else kept.push(entry);
    }
    this.file.entries = kept;
    return removed;
  }

  save(): void {
    writeFileSync(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, 'utf8');
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Runner flags that exclude the quarantined tests from the next run.
 * go/generic have no per-test exclusion — callers must warn.
 */
export function exclusionArgs(
  runner: Exclude<RunnerKind, 'auto'>,
  entries: QuarantineEntry[],
): string[] {
  if (entries.length === 0) return [];
  switch (runner) {
    case 'pytest': {
      // --deselect takes a nodeid prefix: <file/module>::<test>
      const args: string[] = [];
      for (const e of entries) args.push('--deselect', `${e.suite}::${e.name}`);
      return args;
    }
    case 'jest':
    case 'mocha': {
      // -t/--grep with a negative lookahead that skips any matching test name
      const names = [...new Set(entries.map((e) => escapeRegExp(e.name)))];
      const flag = runner === 'jest' ? '-t' : '--grep';
      return [flag, `^(?!.*(?:${names.join('|')}))`];
    }
    case 'go':
    case 'generic':
    default:
      return [];
  }
}

export function quarantinePathFor(cwd: string, quarantineFile: string): string {
  return path.resolve(cwd, quarantineFile);
}
