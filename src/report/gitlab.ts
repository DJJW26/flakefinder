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
 * One note per MR, upserted via a hidden marker (same pattern as GitHub).
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

export async function upsertMrNote(
  gl: GitLabEnv,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'created' | 'updated' | 'unavailable'> {
  const headers = {
    'PRIVATE-TOKEN': gl.token,
    'Content-Type': 'application/json',
  };
  const notesUrl = `${gl.apiV4}/projects/${encodeURIComponent(gl.projectId)}/merge_requests/${encodeURIComponent(gl.mrIid)}/notes?per_page=100`;

  try {
    // find an existing flakefinder note (first page of 100 is plenty in practice)
    const listRes = await fetchImpl(notesUrl, { headers });
    if (!listRes.ok) {
      return 'unavailable';
    }
    const notes = (await listRes.json()) as Array<{ id: number; body?: string }>;
    if (!Array.isArray(notes)) return 'unavailable';
    const existing = notes.find((n) => (n.body ?? '').includes(PR_COMMENT_MARKER));
    if (existing) {
      const res = await fetchImpl(
        `${gl.apiV4}/projects/${encodeURIComponent(gl.projectId)}/merge_requests/${encodeURIComponent(gl.mrIid)}/notes/${existing.id}`,
        { method: 'PUT', headers, body: JSON.stringify({ body }) },
      );
      return res.ok ? 'updated' : 'unavailable';
    }
    const res = await fetchImpl(notesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({ body }),
    });
    return res.ok ? 'created' : 'unavailable';
  } catch {
    return 'unavailable'; // network errors must never fail the CI job
  }
}
