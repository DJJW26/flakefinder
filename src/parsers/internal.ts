/**
 * Shared helpers internal to src/parsers — not part of the frozen public contract.
 */

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
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Remove a leading UTF-8 BOM if present. */
export function stripBom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
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
