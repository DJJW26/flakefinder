import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, resolveConfig } from '../config.js';
import { renderDashboard } from '../report/html.js';
import { renderJson } from '../report/json.js';
import { buildPrComment } from '../report/markdown.js';
import { snapshotPath } from '../store/history-store.js';
import { FLAKEFINDER_VERSION } from '../types.js';
import { cacheKeys, recordBaseline, resolveBaseline } from './baseline.js';
import { computeNewFlakes } from './diff.js';
import { githubEnv, upsertPrComment } from './github.js';
import { type CacheApi, cacheUsable, restoreHistory, saveHistory } from './history-cache.js';
import { ingestReports } from './ingest.js';
import { type ActionInputs, readInputs } from './inputs.js';
import { jobSummaryHtml, newFlakesFailure } from './output.js';

/** The slice of @actions/core the action uses. */
export interface ActionCore {
  info(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: string | number): void;
  writeSummary(html: string): Promise<void>;
}

/**
 * Everything the action touches outside the filesystem, injected so the
 * whole flow runs in tests without a runner, cache service or GitHub API.
 */
export interface ActionDeps {
  /** Process environment: GITHUB_* context and INPUT_* action inputs. */
  env: NodeJS.ProcessEnv;
  /** The workspace directory `working-directory` is resolved against. */
  baseDir: string;
  core: ActionCore;
  cache: CacheApi;
  uploadArtifact(name: string, files: string[], rootDirectory: string): Promise<unknown>;
  /** Expand report globs (relative to `cwd`) to absolute file paths. */
  glob(patterns: string[], cwd: string): Promise<string[]>;
  fetchImpl: typeof fetch;
  /** Switch the process into the working directory (a no-op in tests). */
  chdir(dir: string): void;
  now?: () => Date;
}

/** Same lookup as @actions/core getInput: `INPUT_<NAME>`, trimmed. */
export function inputFromEnv(env: NodeJS.ProcessEnv, name: string): string {
  return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

/** The action's whole flow. Failures go through `core.setFailed`; never throws on bad input. */
export async function runAction(deps: ActionDeps): Promise<void> {
  const { core, env } = deps;
  const now = deps.now ?? (() => new Date());

  // validate every input before doing anything (no half-done runs)
  let inputs: ActionInputs;
  try {
    inputs = readInputs((name) => inputFromEnv(env, name), deps.baseDir);
  } catch (err) {
    core.setFailed(`flakefinder: ${(err as Error).message}`);
    return;
  }
  const cwd = inputs.cwd;
  deps.chdir(cwd);
  const gh = githubEnv(env);

  const { config } = loadConfig(cwd);
  const cfg = resolveConfig(
    config,
    inputs.reports
      ? { reports: inputs.reports, maxRuns: inputs.historyMaxRuns }
      : { maxRuns: inputs.historyMaxRuns },
  );
  const storeDir = path.resolve(cwd, cfg.storeDir);

  // 1. restore history cache (best-effort — miss on first run is normal).
  // Saved per run attempt + job, restored by prefix: see baseline.ts.
  const { saveKey, restoreKeys } = cacheKeys(gh, {
    workingDirectory: inputs.workingDirectoryRel,
    historyKey: inputs.historyKey,
  });
  const useCache = cacheUsable(deps.cache, core);
  if (useCache) await restoreHistory(deps.cache, core, storeDir, saveKey, restoreKeys);

  // 2. pick the "previous verdicts" baseline BEFORE ingesting today's runs —
  // never this run's own earlier attempt (re-runs must not bypass the gate)
  const baseline = resolveBaseline(storeDir, gh.runId);
  for (const w of baseline.warnings) core.warning(w);
  if (baseline.source === 'earlier-attempt') {
    core.info('re-run detected: comparing against the baseline of this run’s first attempt');
  }
  const previous = baseline.previous;

  // 3. ingest report files
  const patterns = cfg.reports;
  if (patterns.length === 0) {
    core.setFailed(
      'flakefinder: no report globs configured. Add "reports" to flakefinder.config.json or set the `reports` input. See flakefinder init.',
    );
    return;
  }
  const files = await deps.glob(patterns, cwd);
  if (files.length === 0 && historyLines(storeDir) === 0) {
    core.setFailed(
      `flakefinder: no files matched ${patterns.join(', ')} and there is no history yet. Ensure your test step runs BEFORE this step and writes reports.`,
    );
    return;
  }
  const outcome = ingestReports(files, cfg, storeDir, {
    commitSha: gh.sha,
    branch: gh.ref.replace('refs/heads/', ''),
    ciRunId: gh.runId,
  });
  for (const w of outcome.warnings) core.warning(w);
  const verdicts = outcome.verdicts;

  // 4. new-flake diff, fresh snapshot
  const newFlakes = computeNewFlakes(verdicts, previous);
  // the store dir only exists once something was appended — a first run whose
  // matched reports all failed to parse must not die with ENOENT here
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(snapshotPath(storeDir), JSON.stringify(verdicts), 'utf8');
  recordBaseline(storeDir, gh.runId, previous);

  // 5. save history cache under this attempt's own key
  if (useCache) await saveHistory(deps.cache, core, storeDir, saveKey);

  // 6. outputs + summary
  const flakyCount = verdicts.filter((v) => v.classification.startsWith('flaky-')).length;
  const failingCount = verdicts.filter(
    (v) => v.classification === 'failing' || v.classification === 'new-failure',
  ).length;
  core.setOutput('flaky-count', flakyCount);
  core.setOutput('new-flaky-count', newFlakes.length);
  core.setOutput('failing-count', failingCount);
  const reportJsonPath = path.resolve(cwd, 'flakefinder-report.json');
  writeFileSync(reportJsonPath, renderJson(verdicts, cfg), 'utf8');
  core.setOutput('report-json', reportJsonPath);

  await core.writeSummary(jobSummaryHtml(verdicts, newFlakes.length, failingCount));

  // 7. dashboard artifact — BEFORE the comment, which only mentions it if
  // the upload actually happened
  let dashboardArtifact: string | undefined;
  if (inputs.uploadDashboard) {
    try {
      const runs = outcome.store
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
        generatedAt: now().toISOString(),
        flakefinderVersion: FLAKEFINDER_VERSION,
        verdicts,
        runs,
      });
      const htmlPath = path.resolve(cwd, 'flakefinder-dashboard.html');
      writeFileSync(htmlPath, html, 'utf8');
      await deps.uploadArtifact('flakefinder-dashboard', [htmlPath], cwd);
      dashboardArtifact = 'flakefinder-dashboard';
    } catch (err) {
      core.warning(`dashboard upload failed: ${(err as Error).message}`);
    }
  }

  // 8. PR comment
  if (inputs.comment && gh.isPr) {
    try {
      const result = await upsertPrComment(
        inputs.githubToken,
        buildPrComment(verdicts, previous, { dashboardArtifact }),
        gh,
        { fetchImpl: deps.fetchImpl, warn: (m) => core.warning(m) },
      );
      core.info(`PR comment: ${result}`);
    } catch (err) {
      core.warning(`PR comment failed (check token permissions): ${(err as Error).message}`);
    }
  }

  // 9. fail gate
  if (inputs.failOnNewFlakes && newFlakes.length > 0) {
    core.setFailed(newFlakesFailure(newFlakes));
  }
}

/** Number of runs already in the history store (0 when there is none). */
function historyLines(storeDir: string): number {
  try {
    return readFileSync(path.join(storeDir, 'history.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
