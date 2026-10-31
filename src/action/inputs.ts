import { statSync } from 'node:fs';
import path from 'node:path';
import { parseStrictInt } from '../util/strict-int.js';

export interface ActionInputs {
  /** Absolute working directory (validated to exist). */
  cwd: string;
  /** Explicit report globs, or null to use the config file's. */
  reports: string[] | null;
  historyMaxRuns: number;
  comment: boolean;
  uploadDashboard: boolean;
  failOnNewFlakes: boolean;
  githubToken: string;
  /** Extra cache-stream discriminator (e.g. the matrix values). */
  historyKey: string;
  /** working-directory relative to the base dir, posix separators. */
  workingDirectoryRel: string;
}

/** Thrown with EVERY invalid input listed; nothing has been done yet. */
export class InputError extends Error {}

// the YAML 1.2 core-schema booleans @actions/core accepts
const TRUE = new Set(['true', 'True', 'TRUE']);
const FALSE = new Set(['false', 'False', 'FALSE']);

/**
 * Read and validate every action input BEFORE any side effect. Previously
 * `comment: yes` failed at step 7, after the cache was saved and outputs
 * set; `history-max-runs: abc`/`0` was blamed on the config file and
 * `300abc` was accepted as 300; a missing working-directory died with a raw
 * chdir ENOENT.
 */
export function readInputs(get: (name: string) => string, baseDir: string): ActionInputs {
  const problems: string[] = [];
  const raw = (name: string, fallback: string): string => {
    const v = get(name).trim();
    return v === '' ? fallback : v;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const v = raw(name, String(fallback));
    if (TRUE.has(v)) return true;
    if (FALSE.has(v)) return false;
    problems.push(`${name}: expected true or false, got "${v}"`);
    return fallback;
  };

  const wd = raw('working-directory', '.');
  const cwd = path.resolve(baseDir, wd);
  try {
    if (!statSync(cwd).isDirectory()) problems.push(`working-directory: not a directory: ${wd}`);
  } catch {
    problems.push(`working-directory: does not exist: ${wd}`);
  }

  const maxRunsRaw = raw('history-max-runs', '300');
  const historyMaxRuns = parseStrictInt(maxRunsRaw, 1, 100_000);
  if (historyMaxRuns === null) {
    problems.push(`history-max-runs: expected an integer 1–100000, got "${maxRunsRaw}"`);
  }

  const reportsRaw = get('reports').trim();
  const reports =
    reportsRaw === ''
      ? null
      : reportsRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== '');
  if (reports !== null && reports.length === 0) {
    problems.push('reports: no globs given (only commas/whitespace)');
  }

  const inputs: ActionInputs = {
    cwd,
    reports,
    historyMaxRuns: historyMaxRuns ?? 300,
    comment: bool('comment', true),
    uploadDashboard: bool('upload-dashboard', true),
    failOnNewFlakes: bool('fail-on-new-flakes', false),
    githubToken: get('github-token'),
    historyKey: normalizeHistoryKey(get('history-key')),
    workingDirectoryRel: path.relative(baseDir, cwd).split(path.sep).join('/') || '.',
  };
  if (problems.length > 0) {
    throw new InputError(`invalid action input(s):\n  - ${problems.join('\n  - ')}`);
  }
  return inputs;
}

/**
 * The `history-key` input defaults to `${{ toJSON(matrix) }}` (action.yml),
 * so matrix legs get separate history streams without any configuration.
 * Outside a matrix that evaluates to `null` — treated as no key, so
 * non-matrix jobs keep the stream they always had. A JSON object is
 * re-serialized with sorted keys and no whitespace, so the stream does not
 * change if the runner's JSON formatting or key order does.
 */
export function normalizeHistoryKey(raw: string): string {
  const v = raw.trim();
  if (v === '' || v === 'null' || v === '{}') return '';
  if (!v.startsWith('{')) return v;
  try {
    const parsed = JSON.parse(v) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return v;
    return canonicalJson(parsed);
  } catch {
    return v;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
