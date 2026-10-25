// STUB — Agent P owns this file. Replace entirely with the real JUnit XML parser (PLAN §4, §13).
import type { ReportParser } from '../types.js';

export const junitParser: ReportParser = {
  name: 'junit',
  sniff(_content: string): boolean {
    return false;
  },
  parse(_content: string, _sourcePath: string): { results: never[]; warnings: string[] } {
    return { results: [], warnings: ['junit parser stub'] };
  },
};
