/**
 * `flakefinder doctor` (C3): one command that answers "is my setup wired?"
 * — config valid, runner detected, reports actually produced, history
 * alive, git metadata available, quarantine sane. Exit 1 on any FAIL.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { detectRunner, loadConfig, resolveConfig } from './config.js';
import { QuarantineManager } from './quarantine/manager.js';
import { HistoryStore } from './store/history-store.js';
import type { ResolvedConfig } from './types.js';
import { matchGlobs } from './util/glob.js';

export interface DoctorLine {
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  hint?: string;
}

export interface DoctorResult {
  lines: DoctorLine[];
  ok: boolean;
}

const DAY_MS = 86_400_000;

export function runDoctor(cwd: string): DoctorResult {
  const lines: DoctorLine[] = [];
  let ok = true;

  // 1. config
  let config: ResolvedConfig;
  try {
    const { config: cfg, path: configPath } = loadConfig(cwd);
    config = resolveConfig(cfg);
    lines.push({
      status: configPath ? 'ok' : 'info',
      message: configPath
        ? `config: ${configPath}`
        : `config: none found (defaults in effect) — create one with flakefinder init`,
    });
  } catch (err) {
    ok = false;
    lines.push({
      status: 'fail',
      message: `config: invalid — ${(err as Error).message}`,
      hint: 'fix flakefinder.config.json (doctor lists each problem above/below)',
    });
    return { lines, ok };
  }

  // 2. runner
  const runner = detectRunner(cwd);
  lines.push({
    status: 'info',
    message: `runner: detected "${runner}"${config.runner !== 'auto' ? ` (config pins "${config.runner}")` : ''}`,
  });

  // 3. reports
  const reportFiles = matchGlobs(cwd, config.reports);
  if (reportFiles.length === 0) {
    lines.push({
      status: 'warn',
      message: `reports: no files match ${config.reports.length > 0 ? config.reports.join(', ') : '(no globs configured)'}`,
      hint: 'make the test runner emit machine-readable reports, then set "reports" globs — run: flakefinder init',
    });
  } else {
    lines.push({
      status: 'ok',
      message: `reports: ${reportFiles.length} file(s) match (${reportFiles
        .slice(0, 3)
        .map((f) => path.basename(f))
        .join(', ')}${reportFiles.length > 3 ? ', …' : ''})`,
    });
  }

  // 4. history store
  const storeDir = path.resolve(cwd, config.storeDir);
  if (existsSync(new HistoryStore(storeDir).path)) {
    const store = new HistoryStore(storeDir);
    const runs = store.runs();
    const sizeKb = Math.round(statSync(store.path).size / 1024);
    lines.push({
      status: 'ok',
      message: `history: ${runs.length} run(s), ${sizeKb} KB${store.formatVersion ? `, format v${store.formatVersion}` : ' (legacy, no header)'}`,
    });
    if (store.warnings.length > 0) {
      lines.push({
        status: 'warn',
        message: `history: ${store.warnings.length}+ skipped/corrupt line(s)`,
        hint: 'history is tolerant, but repeated corruption suggests parallel writers — give each CI shard its own storeDir',
      });
    }
    if (runs.length > 0) {
      const last = runs[runs.length - 1]!.timestamp;
      const ageDays = (Date.now() - Date.parse(last)) / DAY_MS;
      if (Number.isFinite(ageDays) && ageDays > 7) {
        lines.push({
          status: 'warn',
          message: `history: last run ${Math.round(ageDays)} days ago`,
          hint: 'flakefinder only knows what it ingests — is CI actually calling it?',
        });
      }
    }
  } else {
    lines.push({
      status: 'warn',
      message: `history: empty (${config.storeDir}/history.jsonl does not exist yet)`,
      hint: 'run: flakefinder run -- <test command>  (or flakefinder ingest <report files>)',
    });
  }

  // 5. git metadata
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    if (r.status === 0) {
      lines.push({
        status: 'ok',
        message: 'git: commit SHAs available (same-commit flip detection works)',
      });
    } else {
      lines.push({
        status: 'warn',
        message: 'git: no commit SHA (not a repo or git missing)',
        hint: 'same-commit flip detection is disabled — flip-flop stats fall back to per-run buckets',
      });
    }
  } catch {
    lines.push({ status: 'warn', message: 'git: could not check' });
  }

  // 6. quarantine
  const qPath = path.resolve(cwd, config.quarantineFile);
  if (existsSync(qPath)) {
    const entries = new QuarantineManager(qPath).list();
    const unsupported = runner === 'go' || runner === 'generic';
    lines.push({
      status: unsupported ? 'warn' : 'ok',
      message: `quarantine: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}${unsupported ? ` — runner "${runner}" cannot auto-exclude them` : ''}`,
    });
  } else {
    lines.push({
      status: 'info',
      message: 'quarantine: none (flakefinder.quarantine.json absent)',
    });
  }

  return { lines, ok };
}
