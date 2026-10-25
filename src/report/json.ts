// STUB — Agent C owns this file. Replace/refine entirely (PLAN §12).

import type { ResolvedConfig, TestVerdict } from '../types.js';
import { FLAKEFINDER_VERSION } from '../types.js';

export interface JsonResult {
  generatedAt: string;
  flakefinderVersion: string;
  config: ResolvedConfig;
  verdicts: TestVerdict[];
}

export function renderJson(verdicts: TestVerdict[], cfg: ResolvedConfig): string {
  const payload: JsonResult = {
    generatedAt: new Date().toISOString(),
    flakefinderVersion: FLAKEFINDER_VERSION,
    config: cfg,
    verdicts,
  };
  return JSON.stringify(payload, null, 2);
}
