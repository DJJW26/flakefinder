import type { ResolvedConfig, TestVerdict } from '../types.js';
import { FLAKEFINDER_VERSION } from '../types.js';
import { redact } from '../util/redact.js';

/**
 * Version of the JSON report's shape. Bumped only on a breaking change
 * (a field removed, renamed or retyped); new fields are added without a bump,
 * so consumers should ignore keys they do not know.
 */
export const JSON_SCHEMA_VERSION = 1;

export interface JsonResult {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  generatedAt: string;
  flakefinderVersion: string;
  config: ResolvedConfig;
  verdicts: TestVerdict[];
}

/**
 * Machine format (`report --format json`, `ci`'s flakefinder-report.json,
 * the Action's `report-json` output). Free-text fields are redacted — this
 * file routinely leaves the machine as a CI artifact.
 */
export function renderJson(verdicts: TestVerdict[], cfg: ResolvedConfig): string {
  const payload: JsonResult = {
    schemaVersion: JSON_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    flakefinderVersion: FLAKEFINDER_VERSION,
    config: cfg,
    verdicts: verdicts.map((v) => {
      const name = redact(v.name);
      const suite = redact(v.suite);
      const lastMessage = v.lastMessage ? redact(v.lastMessage) : v.lastMessage;
      if (name === v.name && suite === v.suite && lastMessage === v.lastMessage) return v;
      return { ...v, name, suite, lastMessage };
    }),
  };
  return JSON.stringify(payload, null, 2);
}
