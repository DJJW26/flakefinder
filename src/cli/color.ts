/**
 * One rule for ANSI color across every command (QA CLI-13/CLI-14): color only
 * when `--no-color` was not given, `NO_COLOR` is unset or empty
 * (https://no-color.org), and the stream is a terminal.
 */
export function shouldColor(
  flag: boolean,
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!flag) return false;
  const noColor = env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  return stream.isTTY === true;
}
