// STUB — Agent P owns this file. Replace entirely with the real Jest JSON parser (PLAN §4, §13).
import type { ReportParser } from '../types.js';

export const jestParser: ReportParser = {
  name: 'jest',
  sniff(_content: string): boolean {
    return false;
  },
  parse(_content: string, _sourcePath: string): { results: never[]; warnings: string[] } {
    return { results: [], warnings: ['jest parser stub'] };
  },
};
