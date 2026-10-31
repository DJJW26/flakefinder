import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { computeNewFlakes } from '../action/diff.js';
import {
  CONFIG_FILE_NAME,
  detectRunner,
  loadConfig,
  readConfigFile,
  resolveConfig,
  TIMEOUT_MAX_SECONDS,
} from '../config.js';
import { runDoctor } from '../doctor.js';
import { classifyAll } from '../engine/classify.js';
import { detectParser, unrecognizedReason } from '../parsers/index.js';
import { exclusionArgs, QuarantineManager } from '../quarantine/manager.js';
import { gitlabEnvFromProcess, upsertMrNote } from '../report/gitlab.js';
import { renderDashboard } from '../report/html.js';
import { renderJson } from '../report/json.js';
import { buildPrComment, renderMarkdown } from '../report/markdown.js';
import { renderTerminal } from '../report/terminal.js';
import { escapeControlChars } from '../report/text.js';
import { runLive } from '../runner/wrap.js';
import { HistoryStore, snapshotPath, subscribeStoreWarnings } from '../store/history-store.js';
import type {
  FlakefinderConfig,
  ResolvedConfig,
  RunnerKind,
  RunRecord,
  TestVerdict,
} from '../types.js';
import { FLAKEFINDER_VERSION } from '../types.js';
import { matchGlobs } from '../util/glob.js';
import { readTextFile } from '../util/read-text.js';
import { redact } from '../util/redact.js';
import { parseStrictInt } from '../util/strict-int.js';
import { shouldColor } from './color.js';
import { openInBrowser } from './open.js';

interface Globals {
  config?: string;
  cwd: string;
  color: boolean;
}

const PROBLEM_ALWAYS: string[] = ['flaky-confirmed', 'flaky-retry', 'failing', 'new-failure'];

function resolveCfg(g: Globals, overrides: Partial<FlakefinderConfig> = {}): ResolvedConfig {
  if (g.config) {
    // --config is relative to --cwd, like every other path argument (CLI-25)
    return resolveConfig(readConfigFile(path.resolve(g.cwd, g.config)), overrides);
  }
  const { config } = loadConfig(g.cwd);
  return resolveConfig(config, overrides);
}

/**
 * --cwd must name an existing directory: a typo used to make `report` print
 * "no history yet" (exit 0) and `init`/`ingest` die with a raw ENOENT.
 */
function checkCwd(dir: string): void {
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    throw new Error(`--cwd ${dir} does not exist`);
  }
  if (!isDir) throw new Error(`--cwd ${dir} is not a directory`);
}

function gitSha(cwd: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

const SHA_RE = /^[0-9a-f]{7,64}$/i;

/**
 * Commit sha for `ci` (QA ACT-18): the CI system's own variable wins —
 * GitHub's GITHUB_SHA, GitLab's CI_COMMIT_SHA — because a CI checkout may be
 * shallow, detached, or have no git at all, and HEAD can differ from the sha
 * the pipeline is reporting on. Falls back to `git rev-parse HEAD`.
 */
function ciCommitSha(
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  for (const key of ['GITHUB_SHA', 'CI_COMMIT_SHA']) {
    const v = env[key]?.trim();
    if (v && SHA_RE.test(v)) return v.toLowerCase();
  }
  return gitSha(cwd);
}

/**
 * The previous verdict snapshot for the new-flake diff, or null when there is
 * none. A corrupt or wrongly-shaped snapshot is ignored WITH a warning (QA
 * CLI-29): silently treating it as "no baseline" made every flake NEW, and a
 * non-array crashed the diff with a TypeError. Entries that are not
 * verdict-shaped are dropped.
 */
function readSnapshot(file: string): TestVerdict[] | null {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn(
      `flakefinder: ignoring unreadable verdict snapshot ${file} (${(err as Error).message}) — no baseline this run, every current flake counts as new; it is rewritten below`,
    );
    return null;
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      `flakefinder: ignoring verdict snapshot ${file}: expected an array — no baseline this run, every current flake counts as new; it is rewritten below`,
    );
    return null;
  }
  return parsed.filter(
    (v): v is TestVerdict =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as TestVerdict).testId === 'string' &&
      typeof (v as TestVerdict).classification === 'string',
  );
}

function storeFor(g: Globals, cfg: ResolvedConfig): HistoryStore {
  return new HistoryStore(path.resolve(g.cwd, cfg.storeDir));
}

/**
 * Store problems (unreadable file, corrupt lines, newer format) go to stderr:
 * otherwise a broken store reads as "no history yet". Call after a read.
 */
function printStoreWarnings(store: HistoryStore): void {
  for (const w of store.warnings) console.warn(`flakefinder: ${w}`);
}

/**
 * Validates an integer flag (QA A7/A8). On failure prints an error naming the
 * flag and the accepted range and returns null — the caller sets exit 2. Runs
 * BEFORE resolveConfig so a bad override is blamed on the flag, not the config.
 */
function flagInt(flag: string, value: string, min: number, max: number, unit = ''): number | null {
  const n = parseStrictInt(value, min, max);
  if (n === null) {
    console.error(`flakefinder: ${flag} must be an integer ${min}–${max}${unit} (got ${value})`);
  }
  return n;
}

/**
 * --run-id: a UUID, a CI run number (`$GITHUB_RUN_ID`, `$CI_PIPELINE_ID`) or a
 * composed id like `1234567890-2`. Must start with a letter or digit, so an
 * all-punctuation id (`----------`) is rejected; capped at 128 characters.
 */
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Engine/config bounds the flags share (config.ts validates the same ranges). */
const RETRIES_MAX = 10;

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
  console.log(
    `\nnext step — make your runner emit machine-readable reports:\n${hint[runner] ?? hint.generic}`,
  );
}

/** Untrusted text (test names, ids, reasons) made safe for a terminal line. */
const esc = escapeControlChars;

/**
 * True unless argv holds nothing but the value-taking global options and
 * --no-color. Anything else (a command, -h/-V, an unknown flag) is left to
 * commander.
 */
function hasCommand(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--config' || a === '--cwd') {
      i++;
      continue;
    }
    if (a.startsWith('--config=') || a.startsWith('--cwd=') || a === '--no-color') continue;
    return true;
  }
  return false;
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
    .option('--cwd <dir>', 'working directory (where config/reports live; default: .)')
    .option(
      '--no-color',
      'disable ANSI colors (also off with NO_COLOR or when output is not a terminal)',
    )
    .exitOverride()
    // every command resolves paths against --cwd: validate it once, up front
    .hook('preAction', () => {
      checkCwd(globals().cwd);
    });

  const globals = (): Globals => {
    const o = program.opts<{ config?: string; cwd?: string; color?: boolean }>();
    return { config: o.config, cwd: path.resolve(o.cwd ?? '.'), color: o.color !== false };
  };

  program
    .command('init')
    .description('detect your test runner and create flakefinder.config.json')
    .option('--force', 'overwrite an existing config')
    .option(
      '--runner <runner>',
      'explicit runner: pytest|jest|mocha|go|generic (auto = detect, the default)',
    )
    .action((opts: { force?: boolean; runner?: RunnerKind }) => {
      const g = globals();
      const RUNNERS: readonly string[] = ['auto', 'pytest', 'jest', 'mocha', 'go', 'generic'];
      if (opts.runner != null && !RUNNERS.includes(opts.runner)) {
        console.error(
          `flakefinder: --runner must be one of ${RUNNERS.join('|')} (got "${opts.runner}")`,
        );
        exitCode = 2;
        return;
      }
      // `--runner auto` means "detect", exactly like omitting the flag — it
      // used to write runner "auto" with an empty reports list (QA CLI-28)
      const explicit = opts.runner === 'auto' ? undefined : opts.runner;
      const runner: RunnerKind = explicit ?? detectRunner(g.cwd);
      if (runner === 'generic' && !explicit) {
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
    .option(
      '--retry-mode <mode>',
      'auto (targeted re-runs when possible) | failed (force targeted) | full (always re-run everything)',
    )
    .option(
      '--timeout <seconds>',
      'kill the attempt after N seconds (default: config timeoutSeconds, itself unlimited)',
    )
    .argument('<command...>', 'the test command, placed after --')
    .action(
      async (
        command: string[],
        opts: {
          retries?: string;
          failOnFlake?: boolean;
          quarantine?: boolean;
          retryMode?: string;
          timeout?: string;
        },
      ) => {
        const g = globals();
        let retries: number | undefined;
        if (opts.retries != null) {
          const n = flagInt('run -R/--retries', opts.retries, 0, RETRIES_MAX);
          if (n === null) {
            exitCode = 2;
            return;
          }
          retries = n;
        }
        if (opts.retryMode != null && !['auto', 'failed', 'full'].includes(opts.retryMode)) {
          console.error(
            `flakefinder: --retry-mode must be auto|failed|full (got "${opts.retryMode}")`,
          );
          exitCode = 2;
          return;
        }
        const overrides: Partial<FlakefinderConfig> = {};
        if (opts.failOnFlake) overrides.failOnFlakes = true;
        if (retries != null) overrides.liveRetries = retries;
        if (opts.retryMode != null) {
          overrides.retryMode = opts.retryMode as FlakefinderConfig['retryMode'];
        }
        if (opts.timeout != null) {
          const seconds = flagInt(
            'run --timeout',
            opts.timeout,
            1,
            TIMEOUT_MAX_SECONDS,
            ' (seconds)',
          );
          if (seconds === null) {
            exitCode = 2;
            return;
          }
          overrides.timeoutSeconds = seconds;
        }
        const cfg = resolveCfg(g, overrides);
        // runLive keeps its HistoryStore private: collect what it warns about
        // (corrupt lines, busy prune skipped, …) and show it after the report
        const storeWarnings: string[] = [];
        const unsubscribe = subscribeStoreWarnings((w) => storeWarnings.push(w));
        let result: Awaited<ReturnType<typeof runLive>>;
        try {
          result = await runLive(command, cfg, {
            retries: retries ?? cfg.liveRetries,
            cwd: g.cwd,
            applyQuarantine: opts.quarantine !== false,
          });
        } finally {
          unsubscribe();
        }
        const printRunStoreWarnings = (): void => {
          for (const w of new Set(storeWarnings)) console.warn(`flakefinder: ${w}`);
        };
        if (result.finalExitCode === 2 && result.attempts.length === 0) {
          // the command could not be started — runLive already said why; a
          // "no test history yet" report here would only mislead
          printRunStoreWarnings();
          exitCode = 2;
          return;
        }
        console.log(
          renderTerminal(result.verdicts, {
            color: shouldColor(g.color, process.stdout),
            flakesOnly: false,
          }),
        );
        printRunStoreWarnings();
        exitCode = result.finalExitCode;
      },
    );

  program
    .command('ingest')
    .description('parse report files into the history store')
    .argument('[files...]', 'report files (omit to use configured globs)')
    .option('--attempt <n>', 'attempt number to record', '1')
    .option('--source <source>', 'live | report | action', 'report')
    .option(
      '--run-id <id>',
      'share a runId across ingests so fail→pass counts as a retry rescue (e.g. per CI job)',
    )
    .action((files: string[], opts: { attempt: string; source: string; runId?: string }) => {
      const g = globals();
      const attempt = flagInt('ingest --attempt', opts.attempt, 1, 1_000_000);
      if (attempt === null) {
        exitCode = 2;
        return;
      }
      const cfg = resolveCfg(g);
      if (!['live', 'report', 'action'].includes(opts.source)) {
        console.error(`flakefinder: --source must be live|report|action (got ${opts.source})`);
        exitCode = 2;
        return;
      }
      // resolve BEFORE dedupe: `r.xml ./r.xml` is one file, ingesting it
      // twice would double-count every result in the same run (QA A6)
      const targets =
        files.length > 0
          ? [...new Set(files.map((f) => path.resolve(g.cwd, f)))]
          : matchGlobs(g.cwd, cfg.reports);
      if (targets.length === 0) {
        console.error(
          'flakefinder: no report files matched — pass files explicitly or set "reports" globs (see flakefinder init)',
        );
        exitCode = 2;
        return;
      }
      let runId: string = randomUUID();
      if (opts.runId != null) {
        if (!RUN_ID_RE.test(opts.runId)) {
          console.error(
            `flakefinder: --run-id must be 1–128 characters of letters, digits, '.', '_' or '-', starting with a letter or digit — e.g. a UUID or "$GITHUB_RUN_ID" (got "${escapeControlChars(opts.runId)}")`,
          );
          exitCode = 2;
          return;
        }
        runId = opts.runId;
      }
      const store = storeFor(g, cfg);
      let total = 0;
      let used = 0;
      let warnings = 0;
      for (const file of targets) {
        let content: string;
        try {
          content = readTextFile(file); // UTF-8 or UTF-16 (PowerShell 5.1 `>`)
        } catch (err) {
          console.warn(`flakefinder: cannot read ${file}: ${(err as Error).message}`);
          warnings++;
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: ${unrecognizedReason(content)} — skipped ${file}`);
          warnings++;
          continue;
        }
        const parsed = parser.parse(content, file);
        warnings += parsed.warnings.length;
        for (const w of parsed.warnings) console.warn(`flakefinder: ${w}`);
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
      if (used === 0) {
        // nothing was recorded: every file was missing, empty or unparseable —
        // a success exit here would let a broken CI pipeline look healthy
        console.error(
          `flakefinder: none of the ${targets.length} report file(s) could be read and parsed — nothing ingested`,
        );
        exitCode = 2;
        return;
      }
      store.prune(cfg.maxRuns);
      printStoreWarnings(store);
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
      let threshold: number | undefined;
      if (opts.threshold != null) {
        const n = flagInt('report --threshold', opts.threshold, 0, 100);
        if (n === null) {
          exitCode = 2;
          return;
        }
        threshold = n;
      }
      const cfg = resolveCfg(g);
      const store = storeFor(g, cfg);
      const verdicts = classifyAll(store.runs(), cfg);
      printStoreWarnings(store);
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
        renderTerminal(verdicts, {
          color: shouldColor(g.color, process.stdout),
          flakesOnly: opts.flakesOnly === true,
          allRows: opts.all === true,
          // table and md now agree: threshold gates suspected flakes; --all shows everything
          threshold: opts.all === true ? undefined : (threshold ?? cfg.flakeScoreThreshold),
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
      if (opts.out.trim() === '') {
        console.error('flakefinder: html -o/--out needs a file path (got an empty string)');
        exitCode = 2;
        return;
      }
      const cfg = resolveCfg(g);
      const store = storeFor(g, cfg);
      const verdicts = classifyAll(store.runs(), cfg);
      printStoreWarnings(store);
      const runs = store
        .runs()
        .slice(-50)
        .map((r) => ({
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
      try {
        mkdirSync(path.dirname(out), { recursive: true }); // -o into a fresh directory just works
        writeFileSync(out, html, 'utf8');
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        console.error(
          `flakefinder: cannot write the dashboard to ${out}${e.code === 'EISDIR' ? ' — it is a directory' : ` (${e.code ?? e.message})`}`,
        );
        exitCode = 2;
        return;
      }
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
          // hand-edited files and --reason may carry ESC/CR/LF — never echo raw
          console.log(
            `  ${esc(e.testId)}  ${esc(e.suite)} :: ${esc(e.name)}  (score ${e.flakeScore}, ${esc(String(e.reason))})`,
          );
        }
        const runner = cfg.runner === 'auto' ? detectRunner(g.cwd) : cfg.runner;
        if (runner === 'go' || runner === 'generic') {
          console.log(
            `note: runner "${runner}" has no per-test exclusion — entries are informational only`,
          );
        } else {
          console.log(
            `next run will add: ${esc(exclusionArgs(runner as Exclude<RunnerKind, 'auto'>, entries).join(' '))}`,
          );
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
          // a lookup miss, not a usage error: exit 1 (documented)
          console.error(
            `flakefinder: testId ${esc(testId)} not in history — run "flakefinder report --format json" to list testIds`,
          );
          exitCode = 1;
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
        console.log(
          `quarantined ${esc(v.suite)} :: ${esc(v.name)} (${v.classification}, score ${v.flakeScore})`,
        );
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
          console.log(`removed ${esc(testId)} from quarantine`);
        } else {
          console.error(`flakefinder: ${esc(testId)} is not quarantined`);
          exitCode = 1;
        }
        return;
      }

      if (action === 'prune') {
        const verdicts = classifyAll(storeFor(g, cfg).runs(), cfg);
        const removed = qm.prune(verdicts);
        if (removed.length === 0) {
          // no write: an empty history must not create the quarantine file
          console.log('nothing to prune');
          return;
        }
        qm.save();
        console.log(`pruned ${removed.length} entr${removed.length === 1 ? 'y' : 'ies'}:`);
        for (const e of removed) console.log(`  ${esc(e.suite)} :: ${esc(e.name)}`);
        return;
      }

      console.error(
        `flakefinder: unknown quarantine action "${esc(action)}" (list|add|remove|prune)`,
      );
      exitCode = 2;
    });

  program
    .command('ci')
    .description(
      'CI one-shot: ingest configured reports, report, GitHub annotations, snapshot diff',
    )
    .option(
      '--fail-on-new-flakes',
      'exit 1 when flakes appear that were not flaky in the previous snapshot',
    )
    .action(async (opts: { failOnNewFlakes?: boolean }) => {
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
      const commitSha = ciCommitSha(g.cwd);
      for (const file of targets) {
        let content: string;
        try {
          content = readTextFile(file); // UTF-8 or UTF-16 (PowerShell 5.1 `>`)
        } catch (err) {
          console.warn(`flakefinder: cannot read ${file}: ${(err as Error).message}`);
          continue;
        }
        const parser = detectParser(content);
        if (!parser) {
          console.warn(`flakefinder: ${unrecognizedReason(content)} — skipped ${file}`);
          continue;
        }
        const parsed = parser.parse(content, file);
        for (const w of parsed.warnings) console.warn(`flakefinder: ${w}`);
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
      printStoreWarnings(store);

      console.log(renderTerminal(verdicts, { color: false, flakesOnly: false }));

      for (const v of verdicts.filter((x) => x.classification.startsWith('flaky-'))) {
        console.log(
          `::warning title=flakefinder::${ghEscape(escapeControlChars(`${redact(v.suite)} :: ${redact(v.name)} (${v.classification}, score ${v.flakeScore})`))}`,
        );
      }

      const reportPath = path.resolve(g.cwd, 'flakefinder-report.json');
      writeFileSync(reportPath, renderJson(verdicts, cfg), 'utf8');
      console.log(`json report → ${reportPath}`);

      const snap = snapshotPath(path.resolve(g.cwd, cfg.storeDir));
      const previous = readSnapshot(snap);
      // same semantics as the GitHub Action — one implementation (src/action/diff.ts)
      const newFlakes = computeNewFlakes(verdicts, previous);
      // nothing parsed on a first run → no store dir yet (QA ACT-5 / CLI-7)
      mkdirSync(path.dirname(snap), { recursive: true });
      writeFileSync(snap, JSON.stringify(verdicts), 'utf8');

      // GitLab MR note (D4): activates only on GitLab CI with the user's vars set
      const gl = gitlabEnvFromProcess();
      if (gl) {
        try {
          const noteVerdict = await upsertMrNote(gl, buildPrComment(verdicts, previous));
          if (noteVerdict === 'unavailable') {
            console.warn(
              'flakefinder: GitLab MR note could not be posted (check GITLAB_TOKEN scope)',
            );
          } else {
            console.log(`gitlab: MR note ${noteVerdict}`);
          }
        } catch (err) {
          console.warn(`flakefinder: GitLab MR note failed: ${(err as Error).message}`);
        }
      }

      if (opts.failOnNewFlakes && newFlakes.length > 0) {
        console.error(`flakefinder ci: ${newFlakes.length} NEW flake(s):`);
        for (const v of newFlakes)
          console.error(
            `  ${escapeControlChars(redact(v.suite))} :: ${escapeControlChars(redact(v.name))} (score ${v.flakeScore})`,
          );
        exitCode = 1;
      }
    });

  program
    .command('doctor')
    .description('check the setup: config, runner, reports, history, git, quarantine')
    .action(() => {
      const g = globals();
      const { lines, ok } = runDoctor(g.cwd, { configPath: g.config });
      const tag = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]', info: '[info]' };
      const color = shouldColor(g.color, process.stdout);
      for (const line of lines) {
        const code = line.status === 'fail' ? '31' : line.status === 'warn' ? '33' : null;
        const paint = (s: string): string => (color && code ? `\x1b[${code}m${s}\x1b[0m` : s);
        console.log(`${paint(tag[line.status])} ${line.message}`);
        if (line.hint) console.log(`        ${paint('→')} ${line.hint}`);
      }
      console.log(ok ? '' : 'doctor: problems found (see FAIL lines above)');
      exitCode = ok ? 0 : 1;
    });

  // explicit help command: commander's built-in one printed the general help
  // and exited 0 for `help nosuch`, hiding the typo (QA CLI-20)
  program.helpCommand(false);
  program
    .command('help')
    .description('display help for a command (or for flakefinder)')
    .argument('[command]', 'the command to describe')
    .action((name?: string) => {
      if (name == null) {
        program.outputHelp();
        return;
      }
      const sub = program.commands.find((c) => c.name() === name || c.aliases().includes(name));
      if (!sub) {
        console.error(
          `flakefinder: unknown command "${escapeControlChars(name)}" — run "flakefinder help" for the list`,
        );
        exitCode = 2;
        return;
      }
      sub.outputHelp();
    });

  program
    .command('version')
    .description('print the flakefinder version')
    .action(() => {
      console.log(FLAKEFINDER_VERSION);
    });

  // bare `flakefinder` (only global options): help on stdout, exit 0 — it is a
  // request for help, not a usage error (commander would print to stderr)
  if (!hasCommand(argv)) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (
      e.code === 'commander.help' ||
      e.code === 'commander.version' ||
      e.code === 'commander.helpDisplayed'
    ) {
      return 0;
    }
    // commander already printed its own `error: …` line for usage errors
    // (unknown command/option, missing argument) — printing again doubled it
    if (e.code?.startsWith('commander.')) return 2;
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
