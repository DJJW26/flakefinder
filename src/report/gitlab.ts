/**
 * GitLab MR note support (D4) for `flakefinder ci` — the GitLab counterpart
 * of the GitHub Action's PR comment. Driven entirely by GitLab CI
 * environment variables, so it only activates on GitLab with the user's
 * variables set:
 *
 *   GITLAB_CI           — set by GitLab runners
 *   CI_API_V4_URL       — e.g. https://gitlab.com/api/v4
 *   CI_PROJECT_ID       — numeric project id
 *   CI_MERGE_REQUEST_IID — present on merge-request pipelines
 *   GITLAB_TOKEN        — a project/personal access token with api scope
 *                         (a custom CI variable the user adds)
 *
 * One note per MR, upserted via a hidden marker (same pattern as GitHub) —
 * but only a note authored by the token's own user is ever updated: anyone
 * can paste the marker into a note of their own.
 * Failures are warnings, never CI failures.
 */
import { PR_COMMENT_MARKER } from '../report/markdown.js';

export interface GitLabEnv {
  apiV4: string;
  projectId: string;
  mrIid: string;
  token: string;
}

export function gitlabEnvFromProcess(env: NodeJS.ProcessEnv = process.env): GitLabEnv | null {
  if (env.GITLAB_CI !== 'true') return null;
  const apiV4 = env.CI_API_V4_URL;
  const projectId = env.CI_PROJECT_ID;
  const mrIid = env.CI_MERGE_REQUEST_IID;
  const token = env.GITLAB_TOKEN;
  if (!apiV4 || !projectId || !mrIid || !token) return null;
  return { apiV4, projectId, mrIid, token };
}

interface MrNote {
  id: number;
  body?: string;
  author?: { id?: number } | null;
}

export async function upsertMrNote(
  gl: GitLabEnv,
  body: string,
  fetchImpl: typeof fetch = fetch,
  warn: (message: string) => void = (m) => console.warn(`flakefinder: ${m}`),
  timeoutMs = 15_000,
): Promise<'created' | 'updated' | 'unavailable'> {
  // per-request timeout: a hung API must not block the job. redirect:
  // 'manual': following a redirect (e.g. a 302 to another origin) would
  // resend PRIVATE-TOKEN — a 3xx is reported like any other non-2xx
  const call = (url: string, init: RequestInit = {}): Promise<Response> =>
    fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  const headers = {
    'PRIVATE-TOKEN': gl.token,
    'Content-Type': 'application/json',
  };
  const mrUrl = `${gl.apiV4}/projects/${encodeURIComponent(gl.projectId)}/merge_requests/${encodeURIComponent(gl.mrIid)}`;
  const notesUrl = `${mrUrl}/notes`;

  try {
    // the token's own user: only notes it authored are candidates for update
    const userRes = await call(`${gl.apiV4}/user`, { headers });
    if (!userRes.ok) {
      warn(`GitLab: resolving the token's user failed: HTTP ${userRes.status}`);
      return 'unavailable';
    }
    const me = (await userRes.json()) as { id?: unknown };
    if (typeof me.id !== 'number') return 'unavailable';

    // find an existing flakefinder note — across ALL pages (an MR with
    // >100 notes hid ours on a later page, so a duplicate was posted)
    const existing = await findOwnNote(call, headers, notesUrl, me.id, warn);
    if (existing === 'unavailable') return 'unavailable';
    if (existing) {
      const res = await call(`${mrUrl}/notes/${existing.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ body }),
      });
      if (res.ok) return 'updated';
      warn(`GitLab: updating MR note ${existing.id} failed: HTTP ${res.status}`);
      return 'unavailable';
    }
    const res = await call(notesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body }),
    });
    if (res.ok) return 'created';
    warn(`GitLab: creating MR note failed: HTTP ${res.status}`);
    return 'unavailable';
  } catch (err) {
    // network errors and timeouts must never fail the CI job
    const e = err as Error;
    warn(`GitLab: MR note request failed (${e.name}: ${e.message})`);
    return 'unavailable';
  }
}

/** Notes fetched per page (GitLab's maximum). */
const NOTES_PER_PAGE = 100;
/** Pagination cap: 50 pages = 5000 notes; past that we stop looking. */
export const MAX_NOTE_PAGES = 50;

/**
 * Walk the MR's notes, oldest first, until our marker note is found.
 * Pages are requested by number on OUR OWN notes URL (never by following a
 * server-supplied `Link`), so the token can't be steered to another origin.
 * `X-Next-Page` ends the walk; without it, a short page does.
 */
async function findOwnNote(
  call: (url: string, init?: RequestInit) => Promise<Response>,
  headers: Record<string, string>,
  notesUrl: string,
  myId: number,
  warn: (message: string) => void,
): Promise<MrNote | undefined | 'unavailable'> {
  for (let page = 1; page <= MAX_NOTE_PAGES; ) {
    const url = `${notesUrl}?order_by=created_at&sort=asc&per_page=${NOTES_PER_PAGE}&page=${page}`;
    const res = await call(url, { headers });
    if (!res.ok) {
      warn(`GitLab: listing MR notes failed: HTTP ${res.status}`);
      return 'unavailable';
    }
    const notes = (await res.json()) as unknown;
    if (!Array.isArray(notes)) return 'unavailable';
    const hit = (notes as MrNote[]).find(
      (n) => n?.author?.id === myId && (n.body ?? '').includes(PR_COMMENT_MARKER),
    );
    if (hit) return hit;
    const nextHeader = res.headers.get('x-next-page');
    let next: number | null;
    if (nextHeader === null) {
      next = notes.length >= NOTES_PER_PAGE ? page + 1 : null;
    } else {
      const n = Number.parseInt(nextHeader, 10);
      next = Number.isInteger(n) && n > page ? n : null;
    }
    if (next === null) return undefined;
    page = next;
  }
  warn(
    `GitLab: no flakefinder note in the first ${MAX_NOTE_PAGES * NOTES_PER_PAGE} MR notes — posting a new one`,
  );
  return undefined;
}
