import { describe, expect, it } from 'vitest';
import { PR_COMMENT_MARKER } from '../report/markdown.js';
import { type GithubContext, githubEnv, MAX_COMMENT_PAGES, upsertPrComment } from './github.js';

const ctx: GithubContext = {
  owner: 'o',
  repo: 'r',
  sha: 'abc',
  ref: 'refs/pull/5/merge',
  runId: '100',
  runAttempt: '1',
  job: 'test',
  isPr: true,
  prNumber: 5,
  apiUrl: 'https://api.example',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Call {
  url: string;
  method: string;
}

/** Routes: GET /user → `user`, GET comments → `comments`, writes → `write(method)`. */
function mockFetch(opts: {
  comments: unknown[];
  user?: Response;
  write?: (method: string) => Response;
}): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: String(url), method });
    if (String(url).endsWith('/user')) return opts.user ?? json({ message: 'nope' }, 403);
    if (method === 'GET') return json(opts.comments);
    return opts.write?.(method) ?? json({ id: 1 }, method === 'POST' ? 201 : 200);
  }) as typeof fetch;
  return { impl, calls };
}

const marker = `${PR_COMMENT_MARKER}\nold`;

describe('githubEnv', () => {
  it('reads run id, attempt and job', () => {
    const g = githubEnv({ GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '3', GITHUB_JOB: 'unit' });
    expect([g.runId, g.runAttempt, g.job]).toEqual(['9', '3', 'unit']);
    expect(githubEnv({}).runAttempt).toBe('1');
  });
});

describe('upsertPrComment ownership (R5 #10)', () => {
  it('ignores a marker planted in a USER comment and posts its own (GITHUB_TOKEN)', async () => {
    const { impl, calls } = mockFetch({
      comments: [{ id: 1, body: marker, user: { login: 'mallory', type: 'User' } }],
    });
    const r = await upsertPrComment('t', 'new', ctx, { fetchImpl: impl, warn: () => {} });
    expect(r).toBe('created');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('updates the bot-authored marker comment (GITHUB_TOKEN → github-actions[bot])', async () => {
    const { impl, calls } = mockFetch({
      comments: [
        { id: 1, body: marker, user: { login: 'mallory', type: 'User' } },
        { id: 2, body: marker, user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });
    expect(await upsertPrComment('t', 'new', ctx, { fetchImpl: impl })).toBe('updated');
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://api.example/repos/o/r/issues/comments/2');
  });

  it('with a PAT, only the token user’s own comment is updated', async () => {
    const { impl, calls } = mockFetch({
      user: json({ login: 'ci-user' }),
      comments: [
        { id: 1, body: marker, user: { login: 'some-bot[bot]', type: 'Bot' } },
        { id: 3, body: marker, user: { login: 'ci-user', type: 'User' } },
      ],
    });
    expect(await upsertPrComment('t', 'new', ctx, { fetchImpl: impl })).toBe('updated');
    expect(calls.find((c) => c.method === 'PATCH')!.url).toMatch(/comments\/3$/);
  });

  it('warns on non-2xx PATCH and falls back to a new comment', async () => {
    const warnings: string[] = [];
    const { impl, calls } = mockFetch({
      comments: [{ id: 2, body: marker, user: { type: 'Bot' } }],
      write: (m) => (m === 'PATCH' ? json({}, 403) : json({ id: 9 }, 201)),
    });
    const r = await upsertPrComment('t', 'new', ctx, {
      fetchImpl: impl,
      warn: (m) => warnings.push(m),
    });
    expect(r).toBe('created');
    expect(warnings.join('\n')).toContain('HTTP 403');
    expect(calls.map((c) => c.method)).toContain('POST');
  });

  it('warns on non-2xx POST instead of discarding the failure', async () => {
    const warnings: string[] = [];
    const { impl } = mockFetch({ comments: [], write: () => json({}, 403) });
    const r = await upsertPrComment('t', 'new', ctx, {
      fetchImpl: impl,
      warn: (m) => warnings.push(m),
    });
    expect(r).toBe('failed');
    expect(warnings[0]).toContain('posting PR comment failed: HTTP 403');
  });

  it('does nothing off PRs', async () => {
    const { impl, calls } = mockFetch({ comments: [] });
    expect(await upsertPrComment('t', 'b', { ...ctx, isPr: false }, { fetchImpl: impl })).toBe(
      'skipped',
    );
    expect(calls).toEqual([]);
  });
});

describe('API timeouts (QA ACT-6)', () => {
  /** Never answers; rejects only when the request's AbortSignal fires. */
  const hanging = (async (_url: string | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // no signal → would hang forever (the bug)
      signal.addEventListener('abort', () => reject(signal.reason));
    })) as typeof fetch;

  it('a hung GitHub API is abandoned after the timeout with a warning', async () => {
    const warnings: string[] = [];
    const t0 = Date.now();
    const r = await upsertPrComment('t', 'b', ctx, {
      fetchImpl: hanging,
      warn: (m) => warnings.push(m),
      timeoutMs: 50,
    });
    expect(r).toBe('failed');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(warnings[0]).toMatch(/PR comment request failed \(TimeoutError/);
  }, 5000);
});

describe('tokens never leave the API origin (QA ACT-11)', () => {
  it('every request is sent with redirect: manual', async () => {
    const inits: RequestInit[] = [];
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      inits.push(init ?? {});
      return init?.method ? json({ id: 1 }, 201) : json([]);
    }) as typeof fetch;
    await upsertPrComment('t', 'b', ctx, { fetchImpl: impl, warn: () => {} });
    expect(inits.length).toBeGreaterThan(0);
    for (const i of inits) expect(i.redirect).toBe('manual');
  });

  it('a 302 is a failure, not followed', async () => {
    const warnings: string[] = [];
    const impl = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example/steal' },
      })) as unknown as typeof fetch;
    const r = await upsertPrComment('t', 'b', ctx, {
      fetchImpl: impl,
      warn: (m) => warnings.push(m),
    });
    expect(r).toBe('failed');
    expect(warnings[0]).toContain('HTTP 302');
  });

  it('a cross-origin Link: next is not followed with the token', async () => {
    const urls: string[] = [];
    const warnings: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      if (init?.method) return json({ id: 1 }, 201);
      return new Response('[]', {
        status: 200,
        headers: { link: '<https://evil.example/page2>; rel="next"' },
      });
    }) as typeof fetch;
    const r = await upsertPrComment('t', 'b', ctx, {
      fetchImpl: impl,
      warn: (m) => warnings.push(m),
    });
    expect(r).toBe('failed');
    expect(urls.some((u) => u.includes('evil.example'))).toBe(false);
    expect(warnings[0]).toContain('another origin');
  });

  it('a same-origin Link: next is still followed', async () => {
    const urls: string[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url));
      if (init?.method) return json({ id: 1 }, 201);
      if (String(url).endsWith('/user')) return json({}, 403);
      if (String(url).includes('page=2')) return json([]);
      return new Response('[]', {
        status: 200,
        headers: { link: '<https://api.example/repos/o/r/issues/5/comments?page=2>; rel="next"' },
      });
    }) as typeof fetch;
    expect(await upsertPrComment('t', 'b', ctx, { fetchImpl: impl, warn: () => {} })).toBe(
      'created',
    );
    expect(urls.some((u) => u.includes('page=2'))).toBe(true);
  });
});

describe('PR comment pagination is capped', () => {
  it('a Link: next that never ends stops at the cap, warns, and still posts', async () => {
    let gets = 0;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/user')) return json({}, 403);
      if ((init?.method ?? 'GET') !== 'GET') return json({ id: 1 }, 201);
      gets++;
      return new Response('[]', {
        status: 200,
        headers: {
          link: `<https://api.example/repos/o/r/issues/5/comments?page=${gets + 1}>; rel="next"`,
        },
      });
    }) as typeof fetch;
    const warnings: string[] = [];
    expect(
      await upsertPrComment('t', 'b', ctx, { fetchImpl: impl, warn: (m) => warnings.push(m) }),
    ).toBe('created');
    expect(gets).toBe(MAX_COMMENT_PAGES);
    expect(warnings.join('\n')).toContain('more than 5000 comments');
  });
});
