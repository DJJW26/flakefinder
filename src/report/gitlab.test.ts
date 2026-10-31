import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitlabEnvFromProcess, MAX_NOTE_PAGES, upsertMrNote } from './gitlab.js';

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
  const URL = 'https://gitlab.example/api/v4/projects/42/merge_requests/7/notes';
  const ME = { id: 77, username: 'flakefinder-bot' };

  /** Routes GET /user and GET notes; everything else answers `write`. */
  function mock(
    notes: unknown,
    write: Response = jsonResponse({ id: 2 }, true, 201),
  ): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/api/v4/user')) return jsonResponse(ME);
      if (!init?.method || init.method === 'GET') return jsonResponse(notes);
      return write;
    }) as typeof fetch;
    return { impl, calls };
  }

  it('creates a note when none exists', async () => {
    const { impl, calls } = mock([{ id: 1, body: 'other bot', author: { id: 5 } }]);
    const verdict = await upsertMrNote(gl, '<!-- flakefinder:report -->\nhi', impl);
    expect(verdict).toBe('created');
    const post = calls.find((c) => c.init?.method === 'POST')!;
    expect(post.url).toBe(URL);
    expect(JSON.parse(String(post.init?.body)).body).toContain('flakefinder:report');
  });

  it('updates the existing flakefinder note (marker-scoped, own author)', async () => {
    const { impl, calls } = mock(
      [
        { id: 1, body: 'unrelated', author: { id: 77 } },
        { id: 9, body: 'x <!-- flakefinder:report --> y', author: { id: 77 } },
      ],
      jsonResponse({ id: 9 }),
    );
    const verdict = await upsertMrNote(gl, 'new body', impl);
    expect(verdict).toBe('updated');
    const put = calls.find((c) => c.init?.method === 'PUT')!;
    expect(put.url).toContain('/notes/9');
  });

  it("never updates a marker planted in someone else's note (R5 #10)", async () => {
    const { impl, calls } = mock([
      { id: 3, body: '<!-- flakefinder:report --> planted', author: { id: 1234 } },
    ]);
    expect(await upsertMrNote(gl, 'body', impl)).toBe('created');
    expect(calls.some((c) => c.init?.method === 'PUT')).toBe(false);
  });

  it('reports non-2xx writes with the HTTP status (R5 #10)', async () => {
    const warnings: string[] = [];
    const { impl } = mock([], new Response('nope', { status: 422 }));
    expect(await upsertMrNote(gl, 'b', impl, (m) => warnings.push(m))).toBe('unavailable');
    expect(warnings.join('\n')).toContain('HTTP 422');
  });

  it('returns unavailable (never throws) on API errors or network failures', async () => {
    const quiet = (): void => {};
    const failing = (async () => jsonResponse([], false, 403)) as unknown as typeof fetch;
    expect(await upsertMrNote(gl, 'x', failing, quiet)).toBe('unavailable');
    const throwing = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await upsertMrNote(gl, 'x', throwing, quiet)).toBe('unavailable');
  });
});

describe('GitLab API timeouts (QA ACT-6)', () => {
  it('a hung GitLab API returns unavailable after the timeout with a warning', async () => {
    const gl = gitlabEnvFromProcess(ENV)!;
    const hanging = (async (_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener('abort', () => reject(signal.reason));
      })) as typeof fetch;
    const warnings: string[] = [];
    const t0 = Date.now();
    expect(await upsertMrNote(gl, 'b', hanging, (m) => warnings.push(m), 50)).toBe('unavailable');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(warnings[0]).toContain('TimeoutError');
  }, 5000);
});

describe('GitLab token never follows redirects (QA ACT-11)', () => {
  it('requests use redirect: manual and a 302 is reported, not followed', async () => {
    const gl = gitlabEnvFromProcess(ENV)!;
    const inits: RequestInit[] = [];
    const urls: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      inits.push(init ?? {});
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } });
    }) as unknown as typeof fetch;
    const warnings: string[] = [];
    expect(await upsertMrNote(gl, 'b', impl, (m) => warnings.push(m))).toBe('unavailable');
    expect(inits.every((i) => i.redirect === 'manual')).toBe(true);
    expect(urls.some((u) => u.includes('evil.example'))).toBe(false);
    expect(warnings[0]).toContain('HTTP 302');
  });
});

describe('GitLab note upsert paginates (QA ACT-10)', () => {
  const gl = gitlabEnvFromProcess(ENV)!;
  const ME = { id: 77 };
  const filler = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: from + i, body: 'chatter', author: { id: 1 } }));

  /** Serves `pages` by ?page=N; `nextHeader` decides whether X-Next-Page is sent. */
  function paged(pages: unknown[][], nextHeader = true) {
    const urls: string[] = [];
    const methods: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      methods.push(init?.method ?? 'GET');
      if (u.endsWith('/api/v4/user')) return jsonResponse(ME);
      if (init?.method && init.method !== 'GET') return jsonResponse({ id: 1 }, true, 200);
      const page = Number(new URL(u).searchParams.get('page') ?? '1');
      const headers: Record<string, string> = {};
      if (nextHeader) headers['x-next-page'] = page < pages.length ? String(page + 1) : '';
      return new Response(JSON.stringify(pages[page - 1] ?? []), { status: 200, headers });
    }) as typeof fetch;
    return { impl, urls, methods };
  }

  it('finds the marker note on page 3 and updates it (no duplicate)', async () => {
    const pages = [
      filler(1, 100),
      filler(101, 100),
      [{ id: 555, body: '<!-- flakefinder:report -->', author: { id: 77 } }],
    ];
    const { impl, urls, methods } = paged(pages);
    expect(await upsertMrNote(gl, 'b', impl)).toBe('updated');
    expect(urls.some((u) => u.endsWith('/notes/555'))).toBe(true);
    expect(methods).not.toContain('POST');
    const listed = urls.filter((u) => u.includes('/notes?'));
    expect(listed).toHaveLength(3);
    expect(listed[0]).toContain('sort=asc');
  });

  it('without X-Next-Page, a full page still advances and a short page stops', async () => {
    const pages = [
      filler(1, 100),
      [{ id: 9, body: 'x <!-- flakefinder:report -->', author: { id: 77 } }],
    ];
    const { impl, urls } = paged(pages, false);
    expect(await upsertMrNote(gl, 'b', impl)).toBe('updated');
    expect(urls.some((u) => u.endsWith('/notes/9'))).toBe(true);
  });

  it('stops at the page cap and posts a new note with a warning', async () => {
    // a server that always claims there is another page
    const urls: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith('/api/v4/user')) return jsonResponse(ME);
      if (init?.method === 'POST') return jsonResponse({ id: 1 }, true, 201);
      const page = Number(new URL(u).searchParams.get('page'));
      return new Response(JSON.stringify(filler(page * 100, 100)), {
        status: 200,
        headers: { 'x-next-page': String(page + 1) },
      });
    }) as typeof fetch;
    const warnings: string[] = [];
    expect(await upsertMrNote(gl, 'b', impl, (m) => warnings.push(m))).toBe('created');
    expect(urls.filter((u) => u.includes('/notes?'))).toHaveLength(MAX_NOTE_PAGES);
    expect(warnings.join('\n')).toContain('first 5000 MR notes');
  });

  it('pages are requested on our own origin — a Link header to elsewhere is ignored', async () => {
    const urls: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      urls.push(u);
      if (u.endsWith('/api/v4/user')) return jsonResponse(ME);
      if (init?.method === 'POST') return jsonResponse({ id: 1 }, true, 201);
      const page = Number(new URL(u).searchParams.get('page'));
      return new Response(JSON.stringify(page === 1 ? filler(1, 100) : []), {
        status: 200,
        headers: {
          link: '<https://evil.example/notes?page=2>; rel="next"',
          'x-next-page': page === 1 ? '2' : '',
        },
      });
    }) as typeof fetch;
    expect(await upsertMrNote(gl, 'b', impl)).toBe('created');
    expect(urls.every((u) => u.startsWith('https://gitlab.example/'))).toBe(true);
  });
});
