import type { Classification, TestVerdict } from '../types.js';
import { redact } from '../util/redact.js';
import { escapeControlChars } from './text.js';

interface ClassMeta {
  label: string;
  colorCode: string;
}

const CLASS_META: Record<Classification, ClassMeta> = {
  'flaky-confirmed': { label: 'FLAKY (confirmed)', colorCode: '31' },
  'flaky-retry': { label: 'FLAKY (retry-rescued)', colorCode: '33' },
  'flaky-suspected': { label: 'FLAKY (suspected)', colorCode: '33' },
  failing: { label: 'FAILING', colorCode: '31' },
  'new-failure': { label: 'NEW FAILURE', colorCode: '35' },
  passing: { label: 'PASSING', colorCode: '32' },
  skipped: { label: 'SKIPPED', colorCode: '90' },
  gone: { label: 'GONE', colorCode: '90' },
};

const PROBLEM_CLASSES: Classification[] = [
  'flaky-confirmed',
  'flaky-retry',
  'flaky-suspected',
  'failing',
  'new-failure',
];

function makeColor(enabled: boolean) {
  return (code: string, s: string): string => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** Middle-truncate by code point, so a surrogate pair (emoji…) is never split. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s; // UTF-16 length ≥ code points
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${cps.slice(0, half).join('')}…${cps.slice(cps.length - half).join('')}`;
}

/**
 * Terminal report. Sections per problem classification, a summary line for
 * healthy tests, and actionable next steps. ANSI only when opts.color.
 * Receives the FULL verdict set — filtering by class would make the
 * "N tracked / ok:" numbers lie. `threshold` (when provided) drops
 * flaky-suspected rows below the score, matching the md report's behavior;
 * confirmed/retry flakes and failures always show.
 */
export function renderTerminal(
  allVerdicts: TestVerdict[],
  opts: { color: boolean; flakesOnly: boolean; allRows?: boolean; threshold?: number },
): string {
  const color = makeColor(opts.color);
  const bold = (s: string): string => color('1', s);
  const dim = (s: string): string => color('2', s);
  const lines: string[] = [];

  const beforeFilter = allVerdicts.length;
  const verdicts =
    opts.threshold == null
      ? allVerdicts
      : allVerdicts.filter(
          (v) => v.classification !== 'flaky-suspected' || v.flakeScore >= opts.threshold!,
        );
  const hiddenBelowThreshold = beforeFilter - verdicts.length;

  const byClass = new Map<Classification, TestVerdict[]>();
  for (const v of verdicts) {
    const list = byClass.get(v.classification) ?? [];
    list.push(v);
    byClass.set(v.classification, list);
  }
  // untrusted strings: secrets redacted (CI logs leave the machine), control
  // characters rendered visibly (no raw ESC/CR/LF)
  const safe = (s: string): string => escapeControlChars(redact(s));
  for (const [, list] of byClass) {
    list.sort((a, b) => b.flakeScore - a.flakeScore || a.name.localeCompare(b.name));
  }

  const problemCount = PROBLEM_CLASSES.reduce((n, c) => n + (byClass.get(c)?.length ?? 0), 0);
  if (allVerdicts.length === 0) {
    lines.push(
      `${bold('flakefinder')} — no test history yet.`,
      '',
      'Collect history first:',
      `  ${color('36', 'flakefinder run -- <test command>')}    run with retry-based flake detection`,
      `  ${color('36', 'flakefinder ingest <report files>')}    ingest existing report files`,
    );
    return lines.join('\n');
  }

  lines.push(
    // "tracked" is the whole history — it must not change with --threshold;
    // only the "need attention" rows are filtered (and the hidden ones counted)
    bold(`flakefinder — ${allVerdicts.length} tracked test(s), ${problemCount} need attention`),
    '',
  );
  if (hiddenBelowThreshold > 0) {
    lines.push(
      dim(
        `${hiddenBelowThreshold} flaky-suspected test(s) hidden below score ${opts.threshold} — show them with --all or a lower --threshold`,
      ),
      '',
    );
  }

  for (const cls of PROBLEM_CLASSES) {
    const list = byClass.get(cls);
    if (!list || list.length === 0) continue;
    const meta = CLASS_META[cls];
    lines.push(color(meta.colorCode, bold(`${meta.label} — ${list.length}`)));
    for (const v of list) {
      const score = String(v.flakeScore).padStart(3);
      const conf = `${v.confidence}%`.padStart(4);
      const runs = String(v.runsObserved).padStart(3);
      const pass = `${Math.round(v.passRate * 100)}%`.padStart(4);
      const med = fmtMs(v.medianDurationMs).padStart(6);
      const tags = v.tags.length > 0 ? dim(` [${safe(v.tags.join(', '))}]`) : '';
      lines.push(
        `  ${color(meta.colorCode, score)}  conf ${conf}  runs ${runs}  pass ${pass}  med ${med}  ${safe(v.suite)} ${dim('::')} ${bold(truncateMiddle(safe(v.name), 48))}${tags}`,
      );
    }
    lines.push('');
  }

  if (opts.allRows) {
    for (const cls of ['passing', 'skipped', 'gone'] as Classification[]) {
      const list = byClass.get(cls);
      if (!list || list.length === 0) continue;
      const meta = CLASS_META[cls];
      lines.push(dim(`${meta.label} — ${list.length}`));
      const shown = cls === 'passing' ? list.slice(0, 20) : list;
      for (const v of shown) {
        const med = fmtMs(v.medianDurationMs).padStart(6);
        const tags = v.tags.length > 0 ? dim(` [${safe(v.tags.join(', '))}]`) : '';
        lines.push(
          `  ${dim(String(v.flakeScore).padStart(3))}  runs ${String(v.runsObserved).padStart(3)}  med ${med}  ${safe(v.suite)} ${dim('::')} ${truncateMiddle(safe(v.name), 48)}${tags}`,
        );
      }
      if (cls === 'passing' && list.length > 20) lines.push(dim(`  …and ${list.length - 20} more`));
      lines.push('');
    }
  }

  if (!opts.flakesOnly) {
    const passing = byClass.get('passing')?.length ?? 0;
    const skipped = byClass.get('skipped')?.length ?? 0;
    const gone = byClass.get('gone')?.length ?? 0;
    lines.push(
      dim(`ok: ${passing} passing · ${skipped} skipped · ${gone} gone from recent runs`),
      '',
    );
  }

  const flaky = PROBLEM_CLASSES.slice(0, 3).reduce((n, c) => n + (byClass.get(c)?.length ?? 0), 0);
  if (flaky > 0) {
    const worst = [...byClass.entries()]
      .flatMap(([c, vs]) => (PROBLEM_CLASSES.slice(0, 3).includes(c) ? vs : []))
      .sort((a, b) => b.flakeScore - a.flakeScore)[0];
    lines.push('next steps:');
    if (worst) {
      lines.push(`  ${dim('•')} quarantine the worst offender:`);
      lines.push(`      ${color('36', `flakefinder quarantine add ${safe(worst.testId)}`)}`);
    }
    lines.push(`  ${dim('•')} full interactive report: ${color('36', 'flakefinder html')}`);
  }
  return lines.join('\n');
}
