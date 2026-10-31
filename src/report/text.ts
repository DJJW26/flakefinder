/**
 * Text helpers for report surfaces that render untrusted strings (test
 * names, suites, tags and messages come from report files, which anyone who
 * can open a PR controls).
 */

/**
 * C0 controls (incl. ESC, CR, LF, TAB), DEL, C1 controls (incl. the 8-bit
 * CSI/OSC introducers), Unicode line/paragraph separators and bidi
 * embedding/override/isolate characters.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Make an untrusted string safe for a terminal or a CI log: every control
 * character is replaced by a visible escape (`\x1b`, `\x0a`, `\u202e`…).
 * Without this, a test named `x\n::error::…` printed a bare GitHub workflow
 * command (`::add-mask::`, `::stop-commands::` worked the same way), and
 * OSC/CSI sequences could retitle, clear or hyperlink-spoof the terminal.
 * The result is always a single line, so no line of ours can start with `::`.
 */
export function escapeControlChars(s: string): string {
  return s.replace(CONTROL, visibleEscape);
}

/**
 * Like escapeControlChars, but keeps TAB and line breaks (LF, CRLF): for
 * multi-line text such as failure messages shown in a `<pre>`. Bidi
 * overrides/isolates, lone CRs and every other control still become
 * visible escapes.
 */
export function escapeControlCharsMultiline(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(CONTROL, (c) => (c === '\n' || c === '\t' ? c : visibleEscape(c)));
}

function visibleEscape(c: string): string {
  const code = c.charCodeAt(0);
  return code < 0x100
    ? `\\x${code.toString(16).padStart(2, '0')}`
    : `\\u${code.toString(16).padStart(4, '0')}`;
}

/** First `max` code points (never splits a surrogate pair), with `…` when cut. */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s; // UTF-16 length ≥ code points: nothing to cut
  const cps = Array.from(s);
  return cps.length <= max ? s : `${cps.slice(0, max - 1).join('')}…`;
}
