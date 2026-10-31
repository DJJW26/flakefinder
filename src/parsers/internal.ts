/**
 * Shared helpers internal to src/parsers — not part of the frozen public contract.
 */
import type { TestStatus } from '../types.js';

/**
 * fast-xml-parser options shared by the XML parsers (junit, trx):
 * - parseTagValue/parseAttributeValue false: text stays text — otherwise
 *   `<failure>42</failure>` becomes the number 42 (and `007` becomes 7), which
 *   text extraction then drops.
 * - htmlEntities true: numeric character references (`&#65;`, `&#x41;`) in
 *   names and messages are decoded (the default only handles the five XML
 *   named entities). CDATA content is left verbatim.
 */
export const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
} as const;

/** True for a non-null, non-array object. */
export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Normalize an optional XML/JSON child to an array (fast-xml-parser collapses single children). */
export function toArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Trim a string value; undefined for non-strings, empty/whitespace-only values,
 * or after hard truncation to `max` characters.
 */
export function trimTo(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (t === '') return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/** Strip ANSI SGR escape sequences (`ESC[…m`) from text. */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ESC control character is the very thing being matched.
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Remove a leading byte-order mark (U+FEFF) if present — what a UTF-8 BOM, or
 * a UTF-16 BOM decoded as UTF-16, becomes in a JS string.
 */
export function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * A reported duration (already in ms) → integer ms, or null when it is not a
 * finite non-negative number. Every parser emits whole milliseconds (vitest and
 * Playwright report fractional ones).
 */
export function msOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/**
 * `attempts` for a test the reporter ran more than once: `failed` failing
 * attempts (status `failStatus`) followed by the final one. Undefined when the
 * test ran once. The last entry always equals `final` (the result's status).
 */
export function retryAttempts(
  failed: number,
  final: TestStatus,
  failStatus: TestStatus = 'fail',
): TestStatus[] | undefined {
  if (!Number.isInteger(failed) || failed <= 0) return undefined;
  return [...Array<TestStatus>(failed).fill(failStatus), final];
}

/** Single-entry cache so the JSON sniffers (jest, mocha, playwright, pytest-json) parse a document once. */
let jsonCache: { content: string; parsed: { doc: unknown } | { error: string } } | undefined;

/**
 * JSON.parse (BOM-tolerant) that never throws. The parsed document is shared
 * between callers with the same content — treat it as read-only.
 */
export function parseJson(content: string): { doc: unknown } | { error: string } {
  if (jsonCache !== undefined && jsonCache.content === content) return jsonCache.parsed;
  let parsed: { doc: unknown } | { error: string };
  try {
    parsed = { doc: JSON.parse(stripBom(content)) };
  } catch (err) {
    parsed = { error: errorMessage(err) };
  }
  jsonCache = { content, parsed };
  return parsed;
}

/** Readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First line that is not empty/whitespace-only, or null when there is none. */
export function firstNonEmptyLine(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() !== '') return line;
  }
  return null;
}

/** How many flaky test names one retry warning lists before summarising. */
const MAX_FLAKY_NAMES = 10;

/**
 * Message for a test that FAILED and then PASSED on a runner retry/rerun within
 * one report. The result stays 'pass' (the runner's verdict), and this note
 * keeps the failure visible; the per-attempt statuses go in
 * `TestCaseResult.attempts` (the engine collapses same-testId rows per run, so
 * extra 'fail' rows could not carry them). Shared by junit (Surefire,
 * pytest-rerunfailures), jest/vitest, mocha and playwright.
 */
export function flakyRetryMessage(
  failedAttempts: number,
  how: string,
  firstFailure: string | undefined,
  max: number,
): string | undefined {
  const header = `flaky: failed ${failedAttempts} of ${failedAttempts + 1} attempts before passing on ${how}`;
  const first = trimTo(firstFailure, max);
  return trimTo(first !== undefined ? `${header} — first failure: ${first}` : header, max);
}

/** One per-file warning naming the tests that only passed on a retry. */
export function flakyRetryWarning(
  format: string,
  sourcePath: string,
  how: string,
  names: string[],
): string {
  const shown = names.slice(0, MAX_FLAKY_NAMES).join(', ');
  const more = names.length > MAX_FLAKY_NAMES ? ` …and ${names.length - MAX_FLAKY_NAMES} more` : '';
  return `${format}: ${sourcePath}: ${names.length} test(s) FLAKY — failed, then passed on ${how} (recorded as pass with the failure in the message): ${shown}${more}`;
}
