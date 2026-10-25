// STUB — Agent P owns this file. Replace entirely with the real Mocha JSON parser (PLAN §4, §13).
import type { ReportParser } from '../types.js';

export const mochaParser: ReportParser = {
  name: 'mocha',
  sniff(_content: string): boolean {
    return false;
  },
  parse(_content: string, _sourcePath: string): { results: never[]; warnings: string[] } {
    return { results: [], warnings: ['mocha parser stub'] };
  },
};
