import { existsSync, readFileSync } from 'node:fs';
import * as core from '@actions/core';
import { PR_COMMENT_MARKER } from '../report/markdown.js';

export interface GithubContext {
  owner: string;
  repo: string;
  sha: string;
  ref: string;
  runId: string;
  /** GITHUB_RUN_ATTEMPT — 1 on the first attempt, incremented on every re-run. */
  runAttempt: string;
  /** GITHUB_JOB — the job id from the workflow file. */
  job: string;
  isPr: boolean;
  prNumber: number | null;
  apiUrl: string;
}

/**
 * GitHub context from the standard environment (no @actions/github — pulling
 * octokit into the bundle costs megabytes for three REST calls we make with
 * plain fetch). Env docs: https://docs.github.com/actions/learn-github-actions/variables
 */
export function githubEnv(env: NodeJS.ProcessEnv = process.env): GithubContext {
  const [owner = '', repo = ''] = (env.GITHUB_REPOSITORY ?? '/').split('/');
  const sha = env.GITHUB_SHA ?? '';
  const ref = env.GITHUB_REF ?? '';
  const runId = env.GITHUB_RUN_ID ?? '';
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? '1';
  const job = env.GITHUB_JOB ?? '';
  const apiUrl = env.GITHUB_API_URL ?? 'https://api.github.com';
  let isPr = false;
  let prNumber: number | null = null;
  const eventPath = env.GITHUB_EVENT_PATH;
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
  return { owner, repo, sha, ref, runId, runAttempt, job, isPr, prNumber, apiUrl };
}

interface GhComment {
  id: number;
  body?: string | null;
  user?: { login?: string; type?: string } | null;
}

export interface UpsertDeps {
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
  /** Per-request timeout; a hung API must not block the job (default 15 s). */
  timeoutMs?: number;
}

/** Pagination cap for listing PR comments: 50 pages = 5000 comments. */
export const MAX_COMMENT_PAGES = 50;

/** Per-request timeout for GitHub/GitLab API calls. */
export const API_TIMEOUT_MS = 15_000;

type Call = (url: string, init?: RequestInit) => Promise<Response>;

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/**
 * Login of the token's identity, or null when the token cannot read /user —
 * the default GITHUB_TOKEN and GitHub App installation tokens get 403 there;
 * their comments are authored by a Bot account.
 */
async function tokenLogin(apiUrl: string, token: string, call: Call): Promise<string | null> {
  try {
    const res = await call(`${apiUrl}/user`, { headers: ghHeaders(token) });
    if (!res.ok) return null;
    const user = (await res.json()) as { login?: unknown };
    return typeof user.login === 'string' ? user.login : null;
  } catch {
    return null;
  }
}

/**
 * Is this one of OUR comments? It must carry the marker AND be authored by
 * the token's identity — or, when that identity is unknowable (GITHUB_TOKEN /
 * App tokens), by a Bot account. Anyone can paste the marker into a comment
 * of their own; matching on the marker alone let them redirect our update.
 */
function isOurComment(c: GhComment, login: string | null): boolean {
  if (!(c.body ?? '').includes(PR_COMMENT_MARKER)) return false;
  if (login !== null) return c.user?.login === login;
  return c.user?.type === 'Bot';
}

/**
 * Upsert the flakefinder PR comment (plain REST — marker-scoped, single
 * comment, owned by us). Non-2xx responses, network errors and timeouts are
 * reported via `warn`, never thrown; returns what happened.
 */
export async function upsertPrComment(
  token: string,
  body: string,
  ctx: GithubContext,
  deps: UpsertDeps = {},
): Promise<'created' | 'updated' | 'skipped' | 'failed'> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const warn = deps.warn ?? ((m: string) => core.warning(m));
  const timeoutMs = deps.timeoutMs ?? API_TIMEOUT_MS;
  if (!ctx.isPr || ctx.prNumber === null) return 'skipped';
  // redirect: 'manual' — a redirect (even to another origin) would resend
  // the Authorization header; a 3xx is handled like any other non-2xx
  const call: Call = (url, init = {}) =>
    fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  try {
    return await upsert(call, warn, token, body, ctx);
  } catch (err) {
    const e = err as Error;
    warn(`PR comment request failed (${e.name}: ${e.message})`);
    return 'failed';
  }
}

async function upsert(
  call: Call,
  warn: (message: string) => void,
  token: string,
  body: string,
  ctx: GithubContext,
): Promise<'created' | 'updated' | 'failed'> {
  const repoPath = `${ctx.apiUrl}/repos/${ctx.owner}/${ctx.repo}`;

  // collect all comment pages (capped: a Link loop must not spin forever)
  const comments: GhComment[] = [];
  let url: string | null = `${repoPath}/issues/${ctx.prNumber}/comments?per_page=100`;
  for (let pages = 0; url; pages++) {
    if (pages >= MAX_COMMENT_PAGES) {
      warn(
        `PR has more than ${MAX_COMMENT_PAGES * 100} comments — stopped looking for the flakefinder comment`,
      );
      break;
    }
    const res = await call(url, { headers: ghHeaders(token) });
    if (!res.ok) {
      warn(`listing PR comments failed: HTTP ${res.status}`);
      return 'failed';
    }
    const page = (await res.json()) as unknown;
    if (Array.isArray(page)) comments.push(...(page as GhComment[]));
    url = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    // never follow pagination to another origin with our token
    if (url !== null && !sameOrigin(url, ctx.apiUrl)) {
      warn(`PR comment pagination points to another origin — not followed: ${url}`);
      return 'failed';
    }
  }

  const login = await tokenLogin(ctx.apiUrl, token, call);
  const existing = comments.find((c) => isOurComment(c, login));
  if (existing) {
    const res = await call(`${repoPath}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      headers: ghHeaders(token),
      body: JSON.stringify({ body }),
    });
    if (res.ok) return 'updated';
    warn(
      `updating PR comment ${existing.id} failed: HTTP ${res.status} — posting a new comment instead`,
    );
  }
  const res = await call(`${repoPath}/issues/${ctx.prNumber}/comments`, {
    method: 'POST',
    headers: ghHeaders(token),
    body: JSON.stringify({ body }),
  });
  if (res.ok) return 'created';
  warn(
    `posting PR comment failed: HTTP ${res.status} (needs pull-requests: write; fork PRs get a read-only token)`,
  );
  return 'failed';
}
