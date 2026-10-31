import { randomUUID } from 'node:crypto';
import { classifyAll } from '../engine/classify.js';
import { detectParser, unrecognizedReason } from '../parsers/index.js';
import { HistoryStore } from '../store/history-store.js';
import type { ResolvedConfig, RunRecord, TestVerdict } from '../types.js';
import { readTextFile } from '../util/read-text.js';

export interface IngestContext {
  commitSha?: string;
  branch?: string;
  ciRunId?: string;
}

export interface IngestOutcome {
  store: HistoryStore;
  verdicts: TestVerdict[];
  ingestedFiles: string[];
  warnings: string[];
}

/**
 * Action-side ingest: expand report globs (already-resolved file list is
 * injected for testability), parse each file into one RunRecord per file
 * (shared runId, attempt 1), append + prune + classify.
 */
export function ingestReports(
  files: string[],
  cfg: ResolvedConfig,
  storeDir: string,
  ctx: IngestContext,
): IngestOutcome {
  const store = new HistoryStore(storeDir);
  const warnings: string[] = [];
  const ingestedFiles: string[] = [];
  const runId = randomUUID();

  for (const file of files) {
    let content: string;
    try {
      content = readTextFile(file);
    } catch (err) {
      warnings.push(`cannot read ${file}: ${(err as Error).message}`);
      continue;
    }
    const parser = detectParser(content);
    if (!parser) {
      warnings.push(`${unrecognizedReason(content)} — skipped ${file}`);
      continue;
    }
    let parsed: ReturnType<typeof parser.parse>;
    try {
      parsed = parser.parse(content, file);
    } catch (err) {
      // one malformed report must not abort the whole action
      warnings.push(
        `${parser.name}: failed to parse ${file} — skipped (${(err as Error).message})`,
      );
      continue;
    }
    warnings.push(...parsed.warnings);
    const record: RunRecord = {
      runId,
      timestamp: new Date().toISOString(),
      source: 'action',
      parsedFrom: parser.name,
      attempt: 1,
      commitSha: ctx.commitSha,
      branch: ctx.branch,
      ciRunId: ctx.ciRunId,
      results: parsed.results,
    };
    store.append(record);
    ingestedFiles.push(file);
  }

  store.prune(cfg.maxRuns);
  return { store, verdicts: classifyAll(store.runs(), cfg), ingestedFiles, warnings };
}
