/**
 * Parser registry + format auto-detection.
 *
 * Detection order (first match wins):
 * 1. junit — trimmed content starts with '<' and contains '<testsuit'
 * 2. jest  — whole document parses as a JSON object with testResults[].assertionResults
 * 3. mocha — whole document parses as JSON with (results/tests + stats) or (passes + failures)
 * 4. go    — first non-empty line parses as JSON carrying both Action and Package keys
 * 5. otherwise null. Never throws.
 */
import type { ReportParser } from '../types.js';
import { goTestParser } from './gotest.js';
import { jestParser } from './jest.js';
import { junitParser } from './junit.js';
import { mochaParser } from './mocha.js';

export const parsers: ReportParser[] = [junitParser, jestParser, mochaParser, goTestParser];

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
