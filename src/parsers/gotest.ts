// STUB — Agent P owns this file. Replace entirely with the real `go test -json` parser (PLAN §4, §13).
import type { ReportParser } from '../types.js';

export const goTestParser: ReportParser = {
  name: 'go',
  sniff(_content: string): boolean {
    return false;
  },
  parse(_content: string, _sourcePath: string): { results: never[]; warnings: string[] } {
    return { results: [], warnings: ['go parser stub'] };
  },
};
