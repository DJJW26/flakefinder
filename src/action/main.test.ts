import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PR_COMMENT_MARKER } from '../report/markdown.js';
import { snapshotPath } from '../store/history-store.js';
import type { CacheApi } from './history-cache.js';
import { type ActionDeps, inputFromEnv, runAction } from './main.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function workspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ff-action-'));
  dirs.push(dir);
  return dir;
}

const junit = (status: 'pass' | 'fail') =>
  `<testsuites><testsuite name="s"><testcase classname="s" name="stable"/><testcase classname="s" name="wobbly">${
    status === 'fail' ? '<failure message="boom">boom</failure>' : ''
  }</testcase></testsuite></testsuites>`;

interface Recorder {
  failed: string[];
  warnings: string[];
  infos: string[];
  outputs: Record<string, string | number>;
  summaries: string[];
  uploads: string[][];
  requests: Array<{ url: string; method: string; body?: string }>;
}

/** GitHub REST fake: GET comments → `comments`, /user → 403 (GITHUB_TOKEN), writes → 2xx. */
function fakeFetch(rec: Recorder, comments: unknown[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    rec.requests.push({ url: String(url), method, body: init?.body as string | undefined });
    if (String(url).endsWith('/user')) return new Response('{}', { status: 403 });
    if (method === 'GET') return new Response(JSON.stringify(comments), { status: 200 });
    return new Response('{"id":1}', { status: method === 'POST' ? 201 : 200 });
  }) as typeof fetch;
}

const noCache: CacheApi = {
  isFeatureAvailable: () => false,
  restoreCache: async () => undefined,
  saveCache: async () => -1,
};

function deps(
  baseDir: string,
  env: NodeJS.ProcessEnv,
  opts: { comments?: unknown[]; cache?: CacheApi } = {},
): { deps: ActionDeps; rec: Recorder } {
  const rec: Recorder = {
    failed: [],
    warnings: [],
    infos: [],
    outputs: {},
    summaries: [],
    uploads: [],
    requests: [],
  };
  return {
    rec,
    deps: {
      env: {
        GITHUB_REPOSITORY: 'o/r',
        GITHUB_SHA: 'abc123',
        GITHUB_JOB: 'test',
        GITHUB_API_URL: 'https://api.example',
        'INPUT_GITHUB-TOKEN': 'ghs_token',
        ...env,
      },
      baseDir,
      core: {
        info: (m) => rec.infos.push(m),
        warning: (m) => rec.warnings.push(m),
        setFailed: (m) => rec.failed.push(m),
        setOutput: (k, v) => {
          rec.outputs[k] = v;
        },
        writeSummary: async (html) => {
          rec.summaries.push(html);
        },
      },
      cache: opts.cache ?? noCache,
      uploadArtifact: async (_name, files) => {
        rec.uploads.push(files);
      },
      // literal file names only — enough for these tests
      glob: async (patterns, cwd) =>
        patterns.map((p) => path.resolve(cwd, p)).filter((f) => existsSync(f)),
      fetchImpl: fakeFetch(rec, opts.comments),
      chdir: () => {},
      now: () => new Date('2026-01-01T00:00:00Z'),
    },
  };
}

function prEvent(dir: string, number = 5): string {
  const file = path.join(dir, 'event.json');
  writeFileSync(file, JSON.stringify({ pull_request: { number } }), 'utf8');
  return file;
}

describe('inputFromEnv', () => {
  it('mirrors @actions/core getInput (INPUT_<NAME>, trimmed)', () => {
    expect(inputFromEnv({ 'INPUT_HISTORY-KEY': '  x ' }, 'history-key')).toBe('x');
    expect(inputFromEnv({}, 'comment')).toBe('');
  });
});

describe('runAction (QA ACT-14)', () => {
  it('push event: ingests, sets outputs, writes report + summary + dashboard, no comment', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'junit.xml'), junit('pass'), 'utf8');
    const cacheCalls: string[] = [];
    const cache: CacheApi = {
      isFeatureAvailable: () => true,
      restoreCache: async (_p, key, restore) => {
        cacheCalls.push(`restore ${key} ${restore?.join(',')}`);
        return undefined;
      },
      saveCache: async (_p, key) => {
        cacheCalls.push(`save ${key}`);
        return 1;
      },
    };
    const { deps: d, rec } = deps(
      ws,
      { INPUT_REPORTS: 'junit.xml', GITHUB_RUN_ID: '1', GITHUB_REF: 'refs/heads/main' },
      { cache },
    );
    await runAction(d);
    expect(rec.failed).toEqual([]);
    expect(rec.outputs).toMatchObject({
      'flaky-count': 0,
      'new-flaky-count': 0,
      'failing-count': 0,
    });
    const reportJson = String(rec.outputs['report-json']);
    expect(reportJson).toBe(path.join(ws, 'flakefinder-report.json'));
    expect(JSON.parse(readFileSync(reportJson, 'utf8')).verdicts).toHaveLength(2);
    expect(rec.summaries[0]).toContain('No flaky tests detected');
    expect(rec.uploads).toEqual([[path.join(ws, 'flakefinder-dashboard.html')]]);
    expect(existsSync(snapshotPath(path.join(ws, '.flakefinder')))).toBe(true);
    expect(rec.requests).toEqual([]); // not a PR: no API calls
    expect(cacheCalls[0]).toMatch(/^restore flakefinder-history-[0-9a-f]{8}-abc123-1-1 /);
    expect(cacheCalls[1]).toMatch(/^save flakefinder-history-[0-9a-f]{8}-abc123-1-1$/);
  });

  it('PR event: creates the PR comment when none exists', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'junit.xml'), junit('fail'), 'utf8');
    const { deps: d, rec } = deps(ws, {
      INPUT_REPORTS: 'junit.xml',
      GITHUB_RUN_ID: '2',
      GITHUB_EVENT_PATH: prEvent(ws),
    });
    await runAction(d);
    expect(rec.failed).toEqual([]);
    const post = rec.requests.find((r) => r.method === 'POST');
    expect(post?.url).toBe('https://api.example/repos/o/r/issues/5/comments');
    const body = JSON.parse(post?.body ?? '{}').body as string;
    expect(body).toContain(PR_COMMENT_MARKER);
    expect(body).toContain('flakefinder-dashboard'); // the upload happened
    expect(rec.infos).toContain('PR comment: created');
  });

  it('PR event: updates our existing marker comment in place', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'junit.xml'), junit('pass'), 'utf8');
    const { deps: d, rec } = deps(
      ws,
      { INPUT_REPORTS: 'junit.xml', GITHUB_RUN_ID: '3', GITHUB_EVENT_PATH: prEvent(ws) },
      { comments: [{ id: 42, body: `${PR_COMMENT_MARKER}\nold`, user: { type: 'Bot' } }] },
    );
    await runAction(d);
    expect(rec.requests.filter((r) => r.method === 'POST')).toEqual([]);
    const patch = rec.requests.find((r) => r.method === 'PATCH');
    expect(patch?.url).toBe('https://api.example/repos/o/r/issues/comments/42');
    expect(rec.infos).toContain('PR comment: updated');
  });

  it('comment: false skips the API entirely on a PR', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'junit.xml'), junit('pass'), 'utf8');
    const { deps: d, rec } = deps(ws, {
      INPUT_REPORTS: 'junit.xml',
      INPUT_COMMENT: 'false',
      GITHUB_EVENT_PATH: prEvent(ws),
    });
    await runAction(d);
    expect(rec.requests).toEqual([]);
  });

  it('an unparsable report on a first run warns and completes (no crash, no failure)', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'junit.xml'), 'this is not a test report', 'utf8');
    const { deps: d, rec } = deps(ws, { INPUT_REPORTS: 'junit.xml', GITHUB_RUN_ID: '4' });
    await runAction(d);
    expect(rec.failed).toEqual([]);
    expect(rec.warnings.some((w) => w.includes('unrecognized report format'))).toBe(true);
    expect(rec.outputs).toMatchObject({ 'flaky-count': 0, 'new-flaky-count': 0 });
    expect(existsSync(snapshotPath(path.join(ws, '.flakefinder')))).toBe(true);
  });

  it('no matching report and no history fails with a hint', async () => {
    const ws = workspace();
    const { deps: d, rec } = deps(ws, { INPUT_REPORTS: 'missing.xml' });
    await runAction(d);
    expect(rec.failed[0]).toContain('no files matched missing.xml');
    expect(rec.outputs).toEqual({});
  });

  it('invalid inputs fail before any side effect', async () => {
    const ws = workspace();
    const { deps: d, rec } = deps(ws, { INPUT_COMMENT: 'yes', INPUT_REPORTS: 'junit.xml' });
    await runAction(d);
    expect(rec.failed[0]).toContain('comment: expected true or false');
    expect(existsSync(path.join(ws, '.flakefinder'))).toBe(false);
  });

  it('fail-on-new-flakes fails the job when a NEW flake appears, naming it', async () => {
    const ws = workspace();
    const env = { INPUT_REPORTS: 'junit.xml', 'INPUT_FAIL-ON-NEW-FLAKES': 'true' };
    // run 1: all green → baseline without flakes
    writeFileSync(path.join(ws, 'junit.xml'), junit('pass'), 'utf8');
    const first = deps(ws, { ...env, GITHUB_RUN_ID: '10' });
    await runAction(first.deps);
    expect(first.rec.failed).toEqual([]);
    // run 2, same commit: `wobbly` now fails → same-sha flip = confirmed flake, new
    writeFileSync(path.join(ws, 'junit.xml'), junit('fail'), 'utf8');
    const second = deps(ws, { ...env, GITHUB_RUN_ID: '11' });
    await runAction(second.deps);
    expect(second.rec.outputs['new-flaky-count']).toBe(1);
    expect(second.rec.failed).toHaveLength(1);
    expect(second.rec.failed[0]).toContain('1 NEW flaky test(s)');
    expect(second.rec.failed[0]).toContain('wobbly');
  });

  it('without fail-on-new-flakes a new flake is reported but does not fail', async () => {
    const ws = workspace();
    writeFileSync(path.join(ws, 'junit.xml'), junit('pass'), 'utf8');
    await runAction(deps(ws, { INPUT_REPORTS: 'junit.xml', GITHUB_RUN_ID: '20' }).deps);
    writeFileSync(path.join(ws, 'junit.xml'), junit('fail'), 'utf8');
    const second = deps(ws, { INPUT_REPORTS: 'junit.xml', GITHUB_RUN_ID: '21' });
    await runAction(second.deps);
    expect(second.rec.outputs['new-flaky-count']).toBe(1);
    expect(second.rec.failed).toEqual([]);
  });
});
