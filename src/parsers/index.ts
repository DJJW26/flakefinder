/**
 * Parser registry + format auto-detection.
 *
 * Detection order (first match wins):
 * 1. junit — trimmed content starts with '<' and contains '<testsuit'
 * 2. jest  — whole document parses as a JSON object with testResults[] that is empty or has
 *            an entry with assertionResults
 * 3. mocha — whole document parses as JSON with (results/tests + stats) or (passes + failures)
 * 4. go    — one of the first 50 non-empty lines is a JSON event with Action plus Package or
 *            ImportPath (leading stderr text / go 1.24 build events are tolerated)
 * 5. tap   — first non-empty line is `TAP version N`, or headerless TAP12 that opens with a
 *            plan / numbered assertion and whose first 50 lines are all TAP-shaped
 * 6. trx   — trimmed content starts with '<' and contains a `<TestRun` element
 * 7. playwright  — JSON object with suites[] and a config object (Playwright JSON reporter)
 * 8. pytest-json — JSON object with a summary object, a numeric exitcode and tests[] or
 *                  collectors[] (pytest-json-report)
 * 9. otherwise null. Never throws. `unrecognizedReason` says why.
 *
 * A leading byte-order mark (U+FEFF — a UTF-8 BOM, or what remains of a UTF-16 one after
 * decoding) is stripped here, centrally, before any parser sniffs or parses the content.
 */
import type { ReportParser } from '../types.js';
import { goTestParser } from './gotest.js';
import { parseJson, stripBom } from './internal.js';
import { jestParser } from './jest.js';
import { junitParser } from './junit.js';
import { mochaParser } from './mocha.js';
import { playwrightParser } from './playwright.js';
import { pytestJsonParser } from './pytest-json.js';
import { tapParser } from './tap.js';
import { trxParser } from './trx.js';

/** The parser with BOM stripping in front of sniff and parse. */
function bomTolerant(parser: ReportParser): ReportParser {
  return {
    name: parser.name,
    sniff: (content) => parser.sniff(stripBom(content)),
    parse: (content, sourcePath) => parser.parse(stripBom(content), sourcePath),
  };
}

export const parsers: ReportParser[] = [
  junitParser,
  jestParser,
  mochaParser,
  goTestParser,
  tapParser,
  trxParser,
  playwrightParser,
  pytestJsonParser,
].map(bomTolerant);

export function detectParser(content: string): ReportParser | null {
  for (const parser of parsers) {
    try {
      if (parser.sniff(content)) return parser;
    } catch {
      // sniff is contractually non-throwing; be defensive anyway and keep probing.
    }
  }
  return null;
}

/**
 * Why `detectParser` returned null for this content, as a short phrase for the
 * "… — skipped <file>" message: truncated/invalid JSON, a gzip-compressed
 * file, undecoded UTF-16 / binary content, an empty file, XML that is neither
 * JUnit nor TRX, or (otherwise) "unrecognized report format". Never throws.
 */
export function unrecognizedReason(content: string): string {
  const body = stripBom(content);
  if (body.trim() === '') return 'empty report file';
  // gzip magic 1f 8b: read as UTF-8 the 0x8b becomes U+FFFD; as latin1 it stays
  if (
    body.charCodeAt(0) === 0x1f &&
    (body.charCodeAt(1) === 0xfffd || body.charCodeAt(1) === 0x8b)
  ) {
    return 'gzip-compressed report — decompress it first (e.g. gunzip)';
  }
  if (body.slice(0, 512).includes('\u0000')) {
    return 'binary or undecoded UTF-16 content (NUL characters) — save the report as UTF-8';
  }
  const trimmed = body.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed);
    if ('error' in parsed) {
      const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() !== '');
      const jsonLines =
        lines.length > 1 &&
        lines.every((l) => l.trimStart().startsWith('{')) &&
        'doc' in parseJson(lines[0]!);
      if (!jsonLines) return `truncated/invalid JSON (${parsed.error})`;
      return 'unrecognized report format (JSON lines, but not go test -json or node:test events)';
    }
    return 'unrecognized report format (valid JSON, but no supported report shape)';
  }
  if (trimmed.startsWith('<')) {
    return 'unrecognized report format (XML without <testsuite>/<testsuites> or <TestRun>)';
  }
  return 'unrecognized report format';
}
