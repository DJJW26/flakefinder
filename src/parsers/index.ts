// STUB — Agent P owns this file. Replace entirely (PLAN §4: parsers[] + detectParser).
import type { ReportParser } from '../types.js';
import { goTestParser } from './gotest.js';
import { jestParser } from './jest.js';
import { junitParser } from './junit.js';
import { mochaParser } from './mocha.js';

export const parsers: ReportParser[] = [junitParser, jestParser, mochaParser, goTestParser];

export function detectParser(_content: string): ReportParser | null {
  return null;
}
