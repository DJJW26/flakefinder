import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitlabEnvFromProcess, upsertMrNote } from './gitlab.js';

const ENV: NodeJS.ProcessEnv = {
  GITLAB_CI: 'true',
  CI_API_V4_URL: 'https://gitlab.example/api/v4',
  CI_PROJECT_ID: '42',
  CI_MERGE_REQUEST_IID: '7',
  GITLAB_TOKEN: 'glpat-test',
};

afterEach(() => vi.restoreAllMocks());

describe('gitlabEnvFromProcess', () => {
  it('returns null off GitLab CI', () => {
    expect(gitlabEnvFromProcess({})).toBeNull();
  });
  it('returns null when any required variable is missing', () => {
    expect(gitlabEnvFromProcess({ GITLAB_CI: 'true' })).toBeNull();
    expect(gitlabEnvFromProcess({ ...ENV, GITLAB_TOKEN: '' })).toBeNull();
    expect(gitlabEnvFromProcess({ ...ENV, CI_MERGE_REQUEST_IID: undefined })).toBeNull();
  });
  it('parses the full environment', () => {
    expect(gitlabEnvFromProcess(ENV)).toEqual({
      apiV4: 'https://gitlab.example/api/v4',
      projectId: '42',
      mrIid: '7',
      token: 'glpat-test',
    });
  });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), { status: ok ? status : 403 });
}

describe('upsertMrNote', () => {
  const gl = gitlabEnvFromProcess(ENV)!;
  const URL = 'https://gitlab.example/api/v4/projects/42/merge_requests/7/notes?per_page=100';

  it('creates a note when none exists', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) return jsonResponse([{ id: 1, body: 'other bot' }]);
      return jsonResponse({ id: 2 }, true, 201);
    }) as typeof fetch;
    const verdict = await upsertMrNote(gl, '<!-- flakefinder:report -->\nhi', impl);
    expect(verdict).toBe('created');
    expect(calls[0]!.url).toBe(URL);
    expect(calls[1]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[1]!.init?.body)).body).toContain('flakefinder:report');
  });

  it('updates the existing flakefinder note (marker-scoped)', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1) {
        return jsonResponse([
          { id: 1, body: 'unrelated' },
          { id: 9, body: 'x <!-- flakefinder:report --> y' },
        ]);
      }
      return jsonResponse({ id: 9 });
    }) as typeof fetch;
    const verdict = await upsertMrNote(gl, 'new body', impl);
    expect(verdict).toBe('updated');
    expect(calls[1]!.url).toContain('/notes/9');
    expect(calls[1]!.init?.method).toBe('PUT');
  });

  it('returns unavailable (never throws) on API errors or network failures', async () => {
    const failing = (async () => jsonResponse([], false, 403)) as unknown as typeof fetch;
    expect(await upsertMrNote(gl, 'x', failing)).toBe('unavailable');
    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await upsertMrNote(gl, 'x', throwing)).toBe('unavailable');
  });
});
