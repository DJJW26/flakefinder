/**
 * TAP parser — covers `node --test --test-reporter=tap` (verified against
 * node 20 and node 22 output) and plain TAP13/TAP14.
 *
 * Grammar notes from real output:
 * - `TAP version 13` header. Headerless TAP12 (Perl Test::More, prove, bats) is also
 *   detected when it opens with a plan (`1..N`) or a numbered assertion and its first
 *   50 lines are all TAP-shaped (assertion/plan/comment/Bail out!/indented). Assertions are `ok`/`not ok`, optionally followed
 *   by a number, optionally by ` - `, then the description (TAP13/14 make
 *   both optional): `ok 1 - name`, `ok 1 name`, `ok - name`, `ok`. A missing
 *   description becomes `(test N)` (N = the given or implied number).
 * - Nesting is by INDENTATION: a subtest's lines are indented deeper than the
 *   assertion that closes its parent, and that parent assertion comes AFTER
 *   its children. `# Subtest: NAME` headers (node always writes them) are
 *   optional — only used to name never-closed parents of a truncated stream.
 * - Parents (node `describe` suites with `type: 'suite'`, and `t.test()`
 *   parents — QA B-F7) are NOT emitted: their children already carry the
 *   results, and emitting both would double-count failures. Exception: a
 *   parent that is `not ok` while none of its descendants failed (it threw
 *   after its children passed, an after-hook failed, a describe callback threw
 *   before declaring tests) IS emitted, since that failure exists nowhere else.
 * - Directives: `# SKIP reason` → skip, `# TODO` → skip (case-insensitive).
 * - YAML blocks between --- and ... carry diagnostics: `error:` → message,
 *   `stack:` → stack, `duration_ms:` → durationMs (rounded). Values may be
 *   plain/quoted scalars or block scalars (`|`, `|-`, `>`, `>-` …) — node
 *   writes multi-line assertion diffs as `error: |-` + indented lines. YAML
 *   lines are consumed with their assertion, never re-scanned as assertions.
 * - Names: node escapes `#` as `\#` and `\` as `\\`; both are unescaped.
 * - Identity: suite = ancestor chain joined by ' > '; root-level tests get
 *   suite 'node:test' (TAP carries no file names).
 *
 * Never throws.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, stripBom, trimTo } from './internal.js';

const ROOT_SUITE = 'node:test';
/** Lines a headerless-TAP sniff checks for TAP shape. */
const SNIFF_MAX_LINES = 50;
/**
 * A TAP-shaped line: assertion, plan, comment/diagnostic, Bail out!, pragma,
 * version, or anything indented (subtests, YAML blocks).
 */
const TAP_LINE =
  /^(?:(?:not )?ok(?:\s|$)|1\.\.\d+(?:\s+#.*)?\s*$|#|Bail out!|pragma [+-]|TAP version \d+|\s)/;
const MESSAGE_MAX_CHARS = 2000;

interface YamlBlock {
  error?: string;
  stack?: string;
  durationMs?: number;
  isSuite: boolean;
}

/** One test awaiting output; its suite chain grows as enclosing parents close. */
interface Entry {
  /** Ancestor names, outermost first. */
  chain: string[];
  name: string;
  status: TestStatus;
  durationMs: number | null;
  message?: string;
  stack?: string;
}

/** A closed test (leaf or parent) whose own parent has not closed yet. */
interface Subtree {
  /** Indentation of the assertion that closed it. */
  indent: number;
  /** Emittable results in stream order (a suppressed parent contributes none). */
  entries: Entry[];
  /** Whether any emitted entry in it is a failure. */
  failed: boolean;
}

export const tapParser: ReportParser = {
  name: 'tap',

  sniff(content: string): boolean {
    const lines = stripBom(content).split(/\r?\n/);
    const first = lines.map((l) => l.trim()).find((l) => l !== '');
    if (first === undefined) return false;
    if (/^TAP version \d+\s*$/i.test(first)) return true;
    // Headerless TAP12 (Perl Test::More, prove, bats): must OPEN with a plan or a
    // NUMBERED assertion, and every line in the first SNIFF_MAX_LINES must be
    // TAP-shaped — so plain logs that happen to start with "ok" are not TAP.
    if (!/^1\.\.\d+(?:\s+#.*)?$/.test(first) && !/^(?:not )?ok \d+(?:\s|$)/.test(first)) {
      return false;
    }
    let seen = 0;
    for (const line of lines) {
      if (line.trim() === '') continue;
      if (++seen > SNIFF_MAX_LINES) break;
      if (!TAP_LINE.test(line)) return false;
    }
    return true;
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const body = stripBom(content);
    if (body.trim() === '') {
      warnings.push(`tap: ${sourcePath}: file is empty`);
      return { results, warnings };
    }

    const lines = body.split(/\r?\n/);
    // Closed subtrees waiting for the assertion that closes their parent
    // (always the top of the stack: deeper subtrees were closed later).
    const pending: Subtree[] = [];
    // `# Subtest:` declarations not yet closed by an assertion.
    const headers: Array<{ indent: number; name: string }> = [];
    // implied assertion numbers per indentation level
    const counters = new Map<number, number>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const indent = indentOf(line);

      const sub = line.match(/^\s*# Subtest: (.+?)\s*$/);
      if (sub) {
        while (headers.length > 0 && headers[headers.length - 1]!.indent >= indent) headers.pop();
        headers.push({ indent, name: unescapeName(sub[1]!) });
        continue;
      }

      const assertion = line.match(
        /^\s*(not ok|ok)(?=\s|$)(?:\s+(\d+)(?=\s|$))?\s*(?:-(?=\s|$)\s*)?(.*)$/,
      );
      if (!assertion) continue; // plans, comments, Bail out!, stray output
      const [, verdict, numberText, rest] = assertion;
      const [, rawName, directive, directiveText] = rest!.match(
        /^(.*?)(?:(?:^|\s+)#\s*([A-Za-z]+)\b(.*))?$/,
      )!;

      let num = numberText !== undefined ? Number.parseInt(numberText, 10) : undefined;
      num ??= (counters.get(indent) ?? 0) + 1;
      counters.set(indent, num);
      for (const level of [...counters.keys()]) if (level > indent) counters.delete(level);

      // unescape node's \# and \\ AFTER directive parsing (an escaped # is
      // not a directive marker — the raw stream stores it as \#)
      const name = unescapeName(rawName!.trim()) || `(test ${num})`;

      // consume the YAML diagnostics block so its lines are never re-scanned
      let yaml: YamlBlock = { isSuite: false };
      const opener = lines[i + 1];
      if (opener !== undefined && opener.trim() === '---') {
        const yamlIndent = indentOf(opener);
        let j = i + 2;
        while (
          j < lines.length &&
          !(lines[j]!.trim() === '...' && indentOf(lines[j]!) <= yamlIndent)
        )
          j++;
        yaml = parseYamlBlock(lines.slice(i + 2, j), sourcePath, warnings);
        i = j;
      }

      while (headers.length > 0 && headers[headers.length - 1]!.indent >= indent) headers.pop();

      let status: TestStatus = verdict === 'not ok' ? 'fail' : 'pass';
      let message = yaml.error;
      // TAP spec: directives are case-insensitive (# SKIP, # skip, # Skip …)
      const directiveKind = directive?.toUpperCase();
      if (directiveKind === 'SKIP' || directiveKind === 'TODO') {
        status = 'skip';
        const reason = directiveText?.replace(/^\s*-\s*/, '').trim();
        if (reason) message = reason;
      }
      const own: Entry = {
        chain: [],
        name,
        status,
        durationMs: yaml.durationMs ?? null,
        message:
          message !== undefined && message !== '' ? trimTo(message, MESSAGE_MAX_CHARS) : undefined,
        stack: status === 'fail' && yaml.stack !== undefined ? trimTo(yaml.stack, 1000) : undefined,
      };

      // everything deeper than this line, still pending, is this test's subtree
      const children: Subtree[] = [];
      while (pending.length > 0 && pending[pending.length - 1]!.indent > indent) {
        children.unshift(pending.pop()!);
      }
      if (children.length === 0 && !yaml.isSuite) {
        pending.push({ indent, entries: [own], failed: status === 'fail' });
        continue;
      }
      // a parent: prefix its name onto every descendant's suite chain
      const entries = children.flatMap((c) => c.entries);
      for (const e of entries) e.chain.unshift(name);
      const childFailed = children.some((c) => c.failed);
      const ownFailure = status === 'fail' && !childFailed;
      if (ownFailure) entries.push(own);
      pending.push({ indent, entries, failed: childFailed || ownFailure });
    }

    // unterminated Subtest declarations (truncated stream): their pending
    // children still belong to them — name them, and warn.
    for (let h = headers.length - 1; h >= 0; h--) {
      const header = headers[h]!;
      for (const subtree of pending) {
        if (subtree.indent > header.indent)
          for (const e of subtree.entries) e.chain.unshift(header.name);
      }
    }
    if (headers.length > 0) {
      warnings.push(
        `tap: ${sourcePath}: ${headers.length} subtest(s) never reported a result (truncated stream?)`,
      );
    }

    for (const e of pending.flatMap((p) => p.entries)) {
      const suite = e.chain.length > 0 ? e.chain.join(' > ') : ROOT_SUITE;
      const result: TestCaseResult = {
        testId: makeTestId(suite, e.name),
        suite,
        name: e.name,
        status: e.status,
        durationMs: e.durationMs,
      };
      if (e.message !== undefined) result.message = e.message;
      if (e.stack !== undefined) result.stack = e.stack;
      results.push(result);
    }
    return { results, warnings };
  },
};

/** node's TAP escapes: `\#` → `#`, `\\` → `\`. */
function unescapeName(raw: string): string {
  return raw.replace(/\\([\\#])/g, '$1');
}

/**
 * Minimal YAML diagnostics extraction for node:test's blocks: top-level
 * `key: value` scalars plus block scalars (`key: |`, `|-`, `|+`, `>`, `>-`, `>+`).
 * Nested mappings (node's `expected:`/`actual:` objects) are skipped whole.
 */
function parseYamlBlock(block: string[], sourcePath: string, warnings: string[]): YamlBlock {
  const out: YamlBlock = { isSuite: false };
  try {
    const keyIndent = Math.min(
      ...block.filter((l) => l.trim() !== '').map((l) => indentOf(l)),
      Number.POSITIVE_INFINITY,
    );
    for (let k = 0; k < block.length; k++) {
      const line = block[k]!;
      if (indentOf(line) !== keyIndent) continue;
      const keyMatch = line.match(/^\s*([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/);
      if (!keyMatch) continue;
      const [, key, rawValue = ''] = keyMatch;
      // the key's value continues on more-indented (or blank) lines
      let m = k + 1;
      while (m < block.length && (block[m]!.trim() === '' || indentOf(block[m]!) > keyIndent)) m++;
      const continuation = block.slice(k + 1, m);
      k = m - 1;

      let value: string | undefined;
      const scalar = rawValue.match(/^([|>])([-+]?)\d*$/);
      if (scalar) value = readBlockScalar(continuation, scalar[1] === '>');
      else if (rawValue !== '') value = unquote(rawValue);
      if (value === undefined) continue; // nested mapping / empty value

      if (key === 'error' && out.error === undefined) out.error = value;
      else if (key === 'stack' && out.stack === undefined) out.stack = value;
      else if (key === 'type' && value === 'suite') out.isSuite = true;
      else if (key === 'duration_ms') {
        const ms = Number.parseFloat(value);
        if (Number.isFinite(ms) && ms >= 0) out.durationMs = Math.round(ms);
      }
    }
  } catch (err) {
    warnings.push(`tap: ${sourcePath}: diagnostic block parse skipped (${errorMessage(err)})`);
  }
  return out;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Body of a YAML block scalar. Literal (`|`) keeps line breaks; folded (`>`)
 * joins adjacent non-blank lines with a space and keeps blank lines as breaks.
 * Chomping indicators only affect trailing newlines, which callers trim anyway.
 */
function readBlockScalar(lines: string[], folded: boolean): string {
  const firstContent = lines.find((l) => l.trim() !== '');
  if (firstContent === undefined) return '';
  const base = indentOf(firstContent);
  const body = lines.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(base, indentOf(l)))));
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  if (!folded) return body.join('\n');
  let text = '';
  for (let n = 0; n < body.length; n++) {
    const cur = body[n]!;
    if (n > 0) text += cur === '' || body[n - 1] === '' ? '\n' : ' ';
    text += cur;
  }
  return text.replace(/\n\n/g, '\n');
}

/**
 * Strip node's scalar quoting. node picks the quote that needs no escaping:
 * 'single', "double" (when the text has '), or `backtick` (when it has both).
 * YAML-style '' inside single quotes and backslash escapes are both undone.
 */
function unquote(s: string): string {
  const m = s.match(/^(['"`])(.*)\1$/);
  if (m === null) return s;
  const [, quote, inner] = m;
  const text = quote === "'" ? inner!.replace(/''/g, "'") : inner!;
  return text.replace(/\\(['"`\\])/g, '$1');
}
