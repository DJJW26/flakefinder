import { describe, expect, it } from 'vitest';
import { browserCommand, OPEN_PATH_ENV, openInBrowser } from './open.js';

describe('browserCommand (QA CLI-10 / ACT-18)', () => {
  it('Windows: the path never reaches the cmd.exe command line', () => {
    const file = 'C:\\reports\\a&b|c^d %PATH% !x!.html';
    const c = browserCommand(file, 'win32');
    expect(c.command).toBe('cmd.exe');
    expect(c.args).toEqual(['/d', '/v:off', '/c', `start "" "%${OPEN_PATH_ENV}%"`]);
    expect(c.args.join(' ')).not.toContain('a&b');
    expect(c.options.windowsVerbatimArguments).toBe(true);
    expect((c.options.env as Record<string, string>)[OPEN_PATH_ENV]).toBe(file);
  });

  it('macOS / Linux pass the path as a single argv entry', () => {
    expect(browserCommand('/tmp/a&b.html', 'darwin')).toMatchObject({
      command: 'open',
      args: ['/tmp/a&b.html'],
    });
    expect(browserCommand('/tmp/a&b.html', 'linux')).toMatchObject({
      command: 'xdg-open',
      args: ['/tmp/a&b.html'],
    });
  });
});

describe('openInBrowser without an opener (QA CLI-10)', () => {
  it('turns the async spawn error into a warning instead of an unhandled error', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent-ff-dir';
    const warnings: string[] = [];
    try {
      openInBrowser('/tmp/x.html', (m) => warnings.push(m), 'linux');
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.env.PATH = oldPath;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /could not open a browser \(xdg-open: .*ENOENT.*\) — open \/tmp\/x\.html manually/,
    );
  });
});
