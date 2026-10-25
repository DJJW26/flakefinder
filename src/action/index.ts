import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as artifact from '@actions/artifact';
import * as cache from '@actions/cache';
import * as core from '@actions/core';
import { loadConfig, resolveConfig } from '../config.js';
import { renderDashboard } from '../report/html.js';
import { renderJson } from '../report/json.js';
import { buildPrComment, PR_COMMENT_MARKER } from '../report/markdown.js';
import { snapshotPath } from '../store/history-store.js';
import type { TestVerdict } from '../types.js';
import { FLAKEFINDER_VERSION } from '../types.js';
import { redact } from '../util/redact.js';
import { computeNewFlakes } from './diff.js';
import { ingestReports } from './ingest.js';

/**
 * GitHub context from the standard environment (no @actions/github — pulling
 * octokit into the bundle costs megabytes for three REST calls we make with
 * plain fetch). Env docs: https://docs.github.com/actions/learn-github-actions/variables
 */
export function githubEnv(): {
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  runId: string;
  isPr: boolean;
  prNumber: number | null;
  apiUrl: string;
} {
  const [owner = '', repo = ''] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
  const sha = process.env.GITHUB_SHA ?? '';
  const ref = process.env.GITHUB_REF ?? '';
  const runId = process.env.GITHUB_RUN_ID ?? '';
  const apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  let isPr = false;
  let prNumber: number | null = null;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath && existsSync(eventPath)) {
    try {
      const payload = JSON.parse(readFileSync(eventPath, 'utf8')) as {
        pull_request?: { number?: number };
      };
      if (payload.pull_request?.number != null) {
        isPr = true;
        prNumber = payload.pull_request.number;
      }
    } catch {
      // malformed event payload → treat as non-PR
    }
  }
  return { owner, repo, sha, ref, runId, isPr, prNumber, apiUrl };
}

interface GhComment {
  id: number;
  body?: string | null;
}

async function ghRest(
  apiUrl: string,
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  pathName: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; json: unknown; nextUrl: string | null }> {
  const res = await fetch(`${apiUrl}${pathName}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // 204s and empty bodies
  }
  const nextUrl = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  return { ok: res.ok, status: res.status, json, nextUrl };
}

/** Upsert the flakefinder PR comment (plain REST — marker-scoped, single comment). */
export async function upsertPrComment(
  token: string,
  body: string,
  ctx: ReturnType<typeof githubEnv>,
): Promise<void> {
  if (!ctx.isPr || ctx.prNumber === null) return;
  // collect all comment pages
  const comments: GhComment[] = [];
  let url: string | null =
    `${ctx.apiUrl}/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments?per_page=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) {
      core.warning(`listing PR comments failed: HTTP ${res.status}`);
      return;
    }
    comments.push(...((await res.json()) as GhComment[]));
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  }
  const existing = comments.find((c) => (c.body ?? '').includes(PR_COMMENT_MARKER));
  if (existing) {
    await ghRest(
      ctx.apiUrl,
      token,
      'PATCH',
      `/repos/${ctx.owner}/${ctx.repo}/issues/comments/${existing.id}`,
      { body },
    );
  } else {
    await ghRest(
      ctx.apiUrl,
      token,
      'POST',
      `/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.prNumber}/comments`,
      { body },
    );
  }
}

async function expandGlobs(patterns: string[], cwd: string): Promise<string[]> {
  const globModule = await import('@actions/glob');
  const globber = await globModule.create(patterns.join('\n'), { matchDirectories: false });
  const paths: string[] = await globber.glob();
  return paths.map((p: string) => path.resolve(cwd, p));
}

async function actionMain(): Promise<void> {
  const workingDirectory = core.getInput('working-directory') || '.';
  const cwd = path.resolve(process.cwd(), workingDirectory);
  process.chdir(cwd);
  const gh = githubEnv();

  const { config } = loadConfig(cwd);
  const reportsInput = core.getInput('reports');
  const historyMaxRuns = Number.parseInt(core.getInput('history-max-runs') || '300', 10);
  const cfg = resolveConfig(
    config,
    reportsInput
      ? { reports: reportsInput.split(',').map((s) => s.trim()), maxRuns: historyMaxRuns }
      : { maxRuns: historyMaxRuns },
  );
  const storeDir = path.resolve(cwd, cfg.storeDir);

  // 1. restore history cache (best-effort — miss on first run is normal)
  const primaryKey = `flakefinder-history-${gh.sha}`;
  const restoreKeys = ['flakefinder-history-'];
  try {
    await cache.restoreCache([storeDir], primaryKey, restoreKeys);
  } catch (err) {
    core.warning(`history cache restore failed (continuing): ${(err as Error).message}`);
  }

  // 2. read the previous verdict snapshot BEFORE ingesting today's runs
  const snap = snapshotPath(storeDir);
  let previous: TestVerdict[] | null = null;
  if (existsSync(snap)) {
    try {
      previous = JSON.parse(readFileSync(snap, 'utf8')) as TestVerdict[];
    } catch {
      core.warning('previous verdict snapshot unreadable — treating this as a first run');
    }
  }

  // 3. ingest report files
  const patterns = cfg.reports;
  if (patterns.length === 0) {
    core.setFailed(
      'flakefinder: no report globs configured. Add "reports" to flakefinder.config.json or set the `reports` input. See flakefinder init.',
    );
    return;
  }
  const files = await expandGlobs(patterns, cwd);
  if (files.length === 0 && storeDirFiles(storeDir) === 0) {
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
  writeFileSync(snap, JSON.stringify(verdicts), 'utf8');

  // 5. save history cache (immutable keys: only the first save on a sha sticks)
  try {
    await cache.saveCache([storeDir], primaryKey);
  } catch {
    // races on the same sha or cache-not-available are expected; history is restored via restore-keys
  }

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

  await core.summary
    .addHeading('flakefinder')
    .addRaw(
      `**${flakyCount} flaky** (${newFlakes.length} new) · ${failingCount} failing · ${verdicts.length} tracked\n`,
    )
    .addTable([
      [
        { data: 'Test', header: true },
        { data: 'Class', header: true },
        { data: 'Score', header: true },
      ],
      ...verdicts
        .filter((v) => v.classification.startsWith('flaky-'))
        .sort((a, b) => b.flakeScore - a.flakeScore)
        .slice(0, 20)
        .map((v) => [
          `${redact(v.suite)} :: ${redact(v.name)}`,
          v.classification,
          String(v.flakeScore),
        ]),
    ])
    .write();

  // 7. PR comment
  if (core.getBooleanInput('comment') && gh.isPr) {
    const token = core.getInput('github-token');
    try {
      await upsertPrComment(token, buildPrComment(verdicts, previous), gh);
    } catch (err) {
      core.warning(`PR comment failed (check token permissions): ${(err as Error).message}`);
    }
  }

  // 8. dashboard artifact
  if (core.getBooleanInput('upload-dashboard')) {
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
        generatedAt: new Date().toISOString(),
        flakefinderVersion: FLAKEFINDER_VERSION,
        verdicts,
        runs,
      });
      const htmlPath = path.resolve(cwd, 'flakefinder-dashboard.html');
      writeFileSync(htmlPath, html, 'utf8');
      const client = new artifact.DefaultArtifactClient();
      await client.uploadArtifact('flakefinder-dashboard', [htmlPath], cwd, {
        retentionDays: 30,
      });
    } catch (err) {
      core.warning(`dashboard upload failed: ${(err as Error).message}`);
    }
  }

  // 9. fail gate
  if (core.getBooleanInput('fail-on-new-flakes') && newFlakes.length > 0) {
    const names = newFlakes
      .map((v) => `  • ${v.suite} :: ${v.name} (score ${v.flakeScore})`)
      .join('\n');
    core.setFailed(`flakefinder: ${newFlakes.length} NEW flaky test(s):\n${names}`);
  }
}

function storeDirFiles(storeDir: string): number {
  try {
    return readFileSync(path.join(storeDir, 'history.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

actionMain().catch((err: Error) => {
  core.setFailed(`flakefinder action: ${err.message}`);
});
