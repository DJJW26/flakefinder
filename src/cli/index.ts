import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Command } from 'commander';
import {
  CONFIG_FILE_NAME,
  detectRunner,
  loadConfig,
  resolveConfig,
  stripJsonComments,
} from '../config.js';
import { classifyAll } from '../engine/classify.js';
import { detectParser } from '../parsers/index.js';
import { QuarantineManager, exclusionArgs } from '../quarantine/manager.js';
import { renderJson } from '../report/json.js';
import { renderTerminal } from '../report/terminal.js';
import { renderDashboard } from '../report/html.js';
import { renderMarkdown } from '../report/markdown.js';
import { runLive } from '../runner/wrap.js';
import { HistoryStore, snapshotPath } from '../store/history-store.js';
import { FLAKEFINDER_VERSION } from '../types.js';
import type { FlakefinderConfig, ResolvedConfig, RunRecord, RunnerKind, TestVerdict } from '../types.js';
import { matchGlobs } from '../util/glob.js';

interface Globals {
  config?: string;
  cwd: string;
  color: boolean;
}

const PROBLEM_ALWAYS: string[] = ['flaky-confirmed', 'flaky-retry', 'failing', 'new-failure'];

function resolveCfg(g: Globals, overrides: Partial<FlakefinderConfig> = {}): ResolvedConfig {
  if (g.config) {
    let raw: string;
    try {
      raw = readFileSync(g.config, 'utf8');
    } catch (err) {
      throw new Error(`cannot read config ${g.config}: ${(err as Error).message}`);
    }
    let parsed: FlakefinderConfig;
    try {
      parsed = JSON.parse(stripJsonComments(raw)) as FlakefinderConfig;
    } catch (err) {
      throw new Error(`invalid config ${g.config}: ${(err as Error).message}`);
    }
    return resolveConfig(parsed, overrides);
  }
  const { config } = loadConfig(g.cwd);
  return resolveConfig(config, overrides);
}

function gitSha(cwd: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function storeFor(g: Globals, cfg: ResolvedConfig): HistoryStore {
  return new HistoryStore(path.resolve(g.cwd, cfg.storeDir));
}

function filterVerdicts(
  verdicts: TestVerdict[],
  opts: { all?: boolean; threshold?: number },
  cfg: ResolvedConfig,
): TestVerdict[] {
  if (opts.all) return verdicts;
  const threshold = opts.threshold ?? cfg.flakeScoreThreshold;
  return verdicts.filter((v) => {
    if (PROBLEM_ALWAYS.includes(v.classification)) return true;
    if (v.classification === 'flaky-suspected') return v.flakeScore >= threshold;
    return false;
  });
}

function defaultReportsFor(runner: RunnerKind): string[] {
  switch (runner) {
    case 'pytest':
      return ['junit*.xml'];
    case 'jest':
      return ['junit.xml', 'test-results/junit*.xml'];
    case 'mocha':
      return ['test-results/report.json', 'mocha-report.json'];
    case 'go':
      return ['test-output.jsonl'];
    default:
      return [];
  }
}

function printSetupHints(runner: RunnerKind): void {
  const hint: Record<RunnerKind, string> = {
    auto: '  configure "reports" globs in flakefinder.config.json',
    pytest: `  pytest: ensure reports are written, e.g. in pytest.ini:\n    [pytest]\n    addopts = --junitxml=junit.xml`,
    jest: `  jest: add the jest-junit reporter (npm i -D jest-junit), jest.config:\n    reporters: ['default', ['jest-junit', { outputDirectory: '.', outputName: 'junit.xml' }]]`,
    mocha: `  mocha: emit JSON reports:\n    mocha --reporter json --reporter-options output=test-results/report.json`,
    go: `  go: write the JSON stream to the expected file:\n    go test -json ./... > test-output.jsonl`,
    generic: '  configure "reports" globs in flakefinder.config.json',
  };
  console.log(`\nnext step — make your runner emit machine-readable reports:\n${hint[runner] ?? hint.generic}`);
}

function openInBrowser(file: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      spawn('open', [file], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [file], { detached: true, stdio: 'ignore' });
    }
  } catch {
    // opening is best-effort
  }
}

function ghEscape(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export async function main(argv: string[]): Promise<number> {
  let exitCode = 0;
  const program = new Command();

  program
    .name('flakefinder')
    .description('Detect, track, and quarantine flaky tests — locally and in CI.')
    .version(FLAKEFINDER_VERSION)
    .option('--config <path>', 'explicit path to flakefinder.config.json')
    .option('--cwd <dir>', 'working directory (where config/reports live)', process.cwd())
    .option('--no-color', 'disable ANSI colors')
    .exitOverride();

  const globals = (): Globals => {
    const o = program.opts<{ config?: string; cwd: string; color?: boolean }>();
    return { config: o.config, cwd: o.cwd ?? process.cwd(), color: o.color !== false };
  };

  program
    .command('init')
    .description('detect your test runner and create flakefinder.config.json')
    .option('--force', 'overwrite an existing config')
    .option('--runner <runner>', 'explicit runner: pytest|jest|mocha|go|generic')
    .action((opts: { force?: boolean; runner?: RunnerKind }) => {
      const g = globals();
      const runner: RunnerKind | undefined = opts.runner ?? detectRunner(g.cwd);
      if (!runner || (runner === 'generic' && !opts.runner)) {
        console.error(
          'flakefinder: could not detect a test runner — re-run with --runner <pytest|jest|mocha|go|generic>',
        );
        exitCode = 2;
        return;
      }
      const configPath = path.join(g.cwd, CONFIG_FILE_NAME);
      if (existsSync(configPath) && !opts.force) {
        console.error(`flakefinder: ${configPath} already exists (use --force to overwrite)`);
        exitCode = 2;
        return;
      }
      const cfg: FlakefinderConfig = { reports: defaultReportsFor(runner), runner };
      writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      console.log(`created ${configPath} (runner: ${runner})`);
      printSetupHints(runner);
    });

  program
    .command('run')
    .description('run a test command with automatic retry-based flake detection')
    .allowUnknownOption()
    .option('-R, --retries <n>', 'extra attempts after the first (default: config.liveRetries)')
    .option('--fail-on-flake', 'exit non-zero when flakes (not just failures) are detected')
    .option('--no-quarantine', 'run everything, ignoring the quarantine list')
    .argument('<command...>', 'the test command, placed after --')
    .action(async (command: string[], opts: { retries?: string; failOnFlake?: boolean; quarantine?: boolean }) => {
      const g = globals();
      const retries = opts.retries != null ? Number.parseInt(opts.retries, 10) : undefined;
      if (opts.retries != null && (Number.isNaN(retries) || retries! < 0)) {
        console.error('flakefinder: --retries must be a non-negative integer');
        exitCode = 2;
        return;
      }
      const overrides: Partial<FlakefinderConfig> = {};
      if (opts.failOnFlake) overrides.failOnFlakes = true;
      if (retries != null) overrides.liveRetries = retries;
      const cfg = resolveCfg(g, overrides);
      const result = await runLive(command, cfg, {
        retries: retries ?? cfg.liveRetries,
        cwd: g.cwd,
        applyQuarantine: opts.quarantine !== false,
      });
      console.log(
        renderTerminal(result.verdicts, {
          color: g.color && process.stdout.isTTY === true,
          flakesOnly: false,
        }),
      );
      exitCode = result.finalExitCode;
    });

  program
    .command('ingest')
    .description('parse report files into the history store')
    .argument('[files...]', 'report files (omit to use configured globs)')
    .option('--attempt <n>', 'attempt number to record', '1')
    .option('--source <source>', 'live | report | action', 'report')
    .action((files: string[], opts: { attempt: string; source: string }) => {
      const g = globals();
      const cfg = resolveCfg(g);
      const attempt = Number.parseInt(opts.attempt, 10) || 1;
      if (!['live', 'report', 'action'].includes(opts.source)) {
        console.error(`flakefinder: --source must be live|report|action (got ${opts.source})`);
        exitCode = 2;
        return;
      }
      const targets =
        files.length > 0 ? files.map((f) => path.resolve(g.cwd, f)) : matchGlobs(g.cwd, cfg.reports);
      if (targets.length === 0) {
        console.error(
          'flakefinder: no report files matched — pass files explicitly or set "reports" globs (see flakefinder init)',
        );
        exitCode = 2;
        return;
      }
      const runId = randomUUID();
      const store = storeFor(g, cfg);
      let total = 0;
      let used = 0;
      let warnings = 0;
      for (const file of targets) {
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch (err) {
          console.warn(`flakefinder: cannot read ${file}: ${(err as Error).message}`);
          warnings++;
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: unrecognized report format — skipped ${file}`);
          warnings++;
          continue;
        }
        const parsed = parser.parse(content, file);
        warnings += parsed.warnings.length;
        for (const w of parsed.warnings) console.warn(`flakefinder: ${parser.name}: ${w}`);
        const record: RunRecord = {
          runId,
          timestamp: new Date().toISOString(),
          source: opts.source as RunRecord['source'],
          parsedFrom: parser.name,
          attempt,
          commitSha: gitSha(g.cwd),
          results: parsed.results,
        };
        store.append(record);
        total += parsed.results.length;
        used++;
      }
      store.prune(cfg.maxRuns);
      console.log(
        `ingested ${total} test result(s) from ${used}/${targets.length} file(s) (${warnings} warning(s)) → ${store.path}`,
      );
    });

  program
    .command('report')
    .description('show flake verdicts from accumulated history')
    .option('--format <fmt>', 'table | json | md', 'table')
    .option('--flakes-only', 'problem classes only')
    .option('--all', 'include passing/skipped/gone entries')
    .option('--threshold <n>', 'minimum score for suspected flakes', undefined)
    .action((opts: { format: string; flakesOnly?: boolean; all?: boolean; threshold?: string }) => {
      const g = globals();
      const cfg = resolveCfg(g);
      const verdicts = classifyAll(storeFor(g, cfg).runs(), cfg);
      const threshold = opts.threshold != null ? Number.parseInt(opts.threshold, 10) : undefined;
      if (opts.format === 'json') {
        console.log(renderJson(verdicts, cfg));
        return;
      }
      if (opts.format === 'md') {
        console.log(
          renderMarkdown(filterVerdicts(verdicts, { all: opts.all, threshold }, cfg), {
            flakesOnly: !opts.all,
          }),
        );
        return;
      }
      if (opts.format !== 'table') {
        console.error(`flakefinder: unknown format "${opts.format}" (table|json|md)`);
        exitCode = 2;
        return;
      }
      console.log(
        renderTerminal(filterVerdicts(verdicts, { all: opts.all, threshold }, cfg), {
          color: g.color && process.stdout.isTTY === true,
          flakesOnly: opts.flakesOnly === true,
        }),
      );
    });

  program
    .command('html')
    .description('generate the self-contained HTML dashboard')
    .option('-o, --out <file>', 'output file', 'flakefinder-report.html')
    .option('--open', 'open the dashboard in your browser')
    .action((opts: { out: string; open?: boolean }) => {
      const g = globals();
      const cfg = resolveCfg(g);
      const store = storeFor(g, cfg);
      const verdicts = classifyAll(store.runs(), cfg);
      const runs = store.runs().slice(-50).map((r) => ({
        runId: r.runId,
        timestamp: r.timestamp,
        commitSha: r.commitSha,
        passCount: r.results.filter((t) => t.status === 'pass').length,
        failCount: r.results.filter((t) => t.status === 'fail' || t.status === 'error').length,
      }));
      const html = renderDashboard({
        generatedAt: new Date().toISOString(),
        flakefinderVersion: FLAKEFINDER_VERSION,
        verdicts,
        runs,
      });
      const out = path.resolve(g.cwd, opts.out);
      writeFileSync(out, html, 'utf8');
      console.log(`dashboard written → ${out} (${verdicts.length} tests, ${runs.length} runs)`);
      if (opts.open) openInBrowser(out);
    });

  program
    .command('quarantine')
    .description('manage the quarantine list (tests excluded from runs)')
    .argument('<action>', 'list | add | remove | prune')
    .argument('[testId]', 'testId for add/remove')
    .option('--reason <text>', 'reason recorded with the entry', 'flaky')
    .action((action: string, testId: string | undefined, opts: { reason: string }) => {
      const g = globals();
      const cfg = resolveCfg(g);
      const qPath = path.resolve(g.cwd, cfg.quarantineFile);
      const qm = new QuarantineManager(qPath);

      if (action === 'list') {
        const entries = qm.list();
        if (entries.length === 0) {
          console.log('quarantine is empty');
          return;
        }
        console.log(`${entries.length} quarantined test(s):`);
        for (const e of entries) {
          console.log(`  ${e.testId}  ${e.suite} :: ${e.name}  (score ${e.flakeScore}, ${e.reason})`);
        }
        const runner = cfg.runner === 'auto' ? detectRunner(g.cwd) : cfg.runner;
        if (runner === 'go' || runner === 'generic') {
          console.log(`note: runner "${runner}" has no per-test exclusion — entries are informational only`);
        } else {
          console.log(`next run will add: ${exclusionArgs(runner as Exclude<RunnerKind, 'auto'>, entries).join(' ')}`);
        }
        return;
      }

      if (action === 'add') {
        if (!testId) {
          console.error('flakefinder: quarantine add requires a testId (see flakefinder report)');
          exitCode = 2;
          return;
        }
        const verdicts = classifyAll(storeFor(g, cfg).runs(), cfg);
        const v = verdicts.find((x) => x.testId === testId);
        if (!v) {
          console.error(`flakefinder: testId ${testId} not in history — run "flakefinder report --format json" to list testIds`);
          exitCode = 2;
          return;
        }
        qm.add({
          testId,
          suite: v.suite,
          name: v.name,
          reason: opts.reason,
          quarantinedAt: new Date().toISOString(),
          flakeScore: v.flakeScore,
        });
        qm.save();
        console.log(`quarantined ${v.suite} :: ${v.name} (${v.classification}, score ${v.flakeScore})`);
        console.log(`quarantine list: ${qPath}`);
        return;
      }

      if (action === 'remove') {
        if (!testId) {
          console.error('flakefinder: quarantine remove requires a testId');
          exitCode = 2;
          return;
        }
        if (qm.remove(testId)) {
          qm.save();
          console.log(`removed ${testId} from quarantine`);
        } else {
          console.error(`flakefinder: ${testId} is not quarantined`);
          exitCode = 2;
        }
        return;
      }

      if (action === 'prune') {
        const verdicts = classifyAll(storeFor(g, cfg).runs(), cfg);
        const removed = qm.prune(verdicts);
        qm.save();
        if (removed.length === 0) console.log('nothing to prune');
        else {
          console.log(`pruned ${removed.length} entr(y/ies):`);
          for (const e of removed) console.log(`  ${e.suite} :: ${e.name}`);
        }
        return;
      }

      console.error(`flakefinder: unknown quarantine action "${action}" (list|add|remove|prune)`);
      exitCode = 2;
    });

  program
    .command('ci')
    .description('CI one-shot: ingest configured reports, report, GitHub annotations, snapshot diff')
    .option('--fail-on-new-flakes', 'exit 1 when flakes appear that were not flaky in the previous snapshot')
    .action((opts: { failOnNewFlakes?: boolean }) => {
      const g = globals();
      const cfg = resolveCfg(g);
      const targets = matchGlobs(g.cwd, cfg.reports);
      if (targets.length === 0) {
        console.error(
          'flakefinder ci: no report files matched — configure "reports" globs (flakefinder init)',
        );
        exitCode = 2;
        return;
      }
      const store = storeFor(g, cfg);
      const runId = randomUUID();
      const commitSha = gitSha(g.cwd);
      for (const file of targets) {
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch (err) {
          console.warn(`flakefinder: cannot read ${file}: ${(err as Error).message}`);
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: unrecognized report format — skipped ${file}`);
          continue;
        }
        const parsed = parser.parse(content, file);
        for (const w of parsed.warnings) console.warn(`flakefinder: ${parser.name}: ${w}`);
        store.append({
          runId,
          timestamp: new Date().toISOString(),
          source: 'action',
          parsedFrom: parser.name,
          attempt: 1,
          commitSha,
          results: parsed.results,
        });
      }
      store.prune(cfg.maxRuns);
      const verdicts = classifyAll(store.runs(), cfg);

      console.log(renderTerminal(verdicts, { color: false, flakesOnly: false }));

      for (const v of verdicts.filter((x) => x.classification.startsWith('flaky-'))) {
        console.log(
          `::warning title=flakefinder::${ghEscape(`${v.suite} :: ${v.name} (${v.classification}, score ${v.flakeScore})`)}`,
        );
      }

      const reportPath = path.resolve(g.cwd, 'flakefinder-report.json');
      writeFileSync(reportPath, renderJson(verdicts, cfg), 'utf8');
      console.log(`json report → ${reportPath}`);

      const snap = snapshotPath(path.resolve(g.cwd, cfg.storeDir));
      let previous: TestVerdict[] | null = null;
      if (existsSync(snap)) {
        try {
          previous = JSON.parse(readFileSync(snap, 'utf8')) as TestVerdict[];
        } catch {
          previous = null;
        }
      }
      const prevFlaky = new Set(
        (previous ?? []).filter((v) => v.classification.startsWith('flaky-')).map((v) => v.testId),
      );
      const newFlakes = verdicts.filter(
        (v) => v.classification.startsWith('flaky-') && !prevFlaky.has(v.testId),
      );
      writeFileSync(snap, JSON.stringify(verdicts), 'utf8');

      if (opts.failOnNewFlakes && newFlakes.length > 0) {
        console.error(`flakefinder ci: ${newFlakes.length} NEW flake(s):`);
        for (const v of newFlakes) console.error(`  ${v.suite} :: ${v.name} (score ${v.flakeScore})`);
        exitCode = 1;
      }
    });

  program
    .command('version')
    .description('print the flakefinder version')
    .action(() => {
      console.log(FLAKEFINDER_VERSION);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === 'commander.help' || e.code === 'commander.version' || e.code === 'commander.helpDisplayed') {
      return 0;
    }
    console.error(`flakefinder: ${e.message ?? 'unknown error'}`);
    return 2;
  }
  return exitCode;
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err: Error) => {
    console.error(`flakefinder: ${err.message}`);
    process.exitCode = 2;
  });
