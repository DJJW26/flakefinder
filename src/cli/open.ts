import { type SpawnOptions, spawn } from 'node:child_process';

/** Environment variable carrying the path to cmd.exe (see browserCommand). */
export const OPEN_PATH_ENV = 'FLAKEFINDER_OPEN_PATH';

export interface BrowserCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/**
 * The command that opens `file` with the OS default handler.
 *
 * Windows: `start` is a cmd.exe builtin, and cmd.exe treats `&`, `|`, `^`, …
 * in an UNQUOTED argument as operators — an `-o "a&b.html"` used to run `b.html`
 * as a command. The path is therefore never put on the command line: it is
 * passed in an environment variable and referenced as `"%VAR%"`. cmd expands
 * it before parsing operators, but inside double quotes those characters are
 * literal, and a Windows path cannot itself contain `"`. Expanded text is not
 * expanded again, `/v:off` rules out `!` expansion, and `/d` skips AutoRun.
 */
export function browserCommand(file: string, platform: NodeJS.Platform): BrowserCommand {
  const base: SpawnOptions = { detached: true, stdio: 'ignore' };
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/d', '/v:off', '/c', `start "" "%${OPEN_PATH_ENV}%"`],
      options: {
        ...base,
        windowsHide: true,
        windowsVerbatimArguments: true,
        env: { ...process.env, [OPEN_PATH_ENV]: file },
      },
    };
  }
  if (platform === 'darwin') return { command: 'open', args: [file], options: base };
  return { command: 'xdg-open', args: [file], options: base };
}

/**
 * Best-effort: open `file` in the default browser. A missing opener
 * (no xdg-open on a headless box) emits an asynchronous 'error' event, which
 * used to crash the CLI with a stack trace — it is now a one-line warning.
 */
export function openInBrowser(
  file: string,
  warn: (msg: string) => void = (m) => console.warn(m),
  platform: NodeJS.Platform = process.platform,
): void {
  const { command, args, options } = browserCommand(file, platform);
  const hint = `open ${file} manually`;
  try {
    const child = spawn(command, args, options);
    child.on('error', (err) => {
      warn(`flakefinder: could not open a browser (${command}: ${err.message}) — ${hint}`);
    });
    child.unref();
  } catch (err) {
    warn(`flakefinder: could not open a browser (${(err as Error).message}) — ${hint}`);
  }
}
