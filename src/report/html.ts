/**
 * flakefinder — self-contained HTML dashboard (Agent D).
 *
 * renderDashboard() returns ONE complete HTML document: inline CSS, inline vanilla
 * JS, and the report data embedded in a `<script id="ff-data" type="application/json">`
 * block. No network requests, no CDN, no external fonts — the file works when
 * double-clicked from file:// on Chrome/Edge/Firefox.
 *
 * Implementation notes:
 * - All template pieces use String.raw (single consistent approach). The embedded
 *   JS deliberately uses NO template literals and NO backslash sequences other than
 *   the one reversal regex, so nothing needs escaping inside the TS template.
 * - User-derived strings (suite, name, testId, messages, shas) only ever enter the
 *   DOM via textContent/createElement — never innerHTML. Colors are applied through
 *   class-name lookup maps, never built color strings.
 * - Data safety escapes: every "</script" (case-insensitive) becomes "<\/script"
 *   (still valid JSON) and every "<!--" becomes "<\!--" (reversed by the reader
 *   before JSON.parse; "\!" can never occur in valid JSON text, so the reversal
 *   is unambiguous).
 * - TestVerdict carries no per-observation data, so the detail drawer shows a
 *   compact stats panel (score bar, confidence bar, pass-rate donut, counters)
 *   instead of an observation timeline / duration sparkline.
 */

import type { DashboardData } from '../types.js';
import { redact } from '../util/redact.js';
import { escapeControlChars, escapeControlCharsMultiline } from './text.js';

/**
 * The dashboard is uploaded as a CI artifact — redact credential-shaped
 * strings from every free-text field (failure messages AND test names/suites,
 * which can embed leaked tokens) before embedding. The raw store remains the
 * unredacted source of truth on the user's machine.
 *
 * Names, suites, messages and shas also get their control and bidi
 * characters made visible (`\u202e`…), as in the terminal and markdown: a
 * test name with a right-to-left override could otherwise render as a
 * different, harmless-looking name. Messages keep their line breaks. The
 * testId stays raw (the copy buttons must yield the real id); the page
 * escapes it for display.
 */
function redactData(data: DashboardData): DashboardData {
  return {
    ...data,
    verdicts: data.verdicts.map((v) => {
      const name = escapeControlChars(redact(v.name));
      const suite = escapeControlChars(redact(v.suite));
      const lastMessage = v.lastMessage
        ? escapeControlCharsMultiline(redact(v.lastMessage))
        : v.lastMessage;
      if (name === v.name && suite === v.suite && lastMessage === v.lastMessage) return v;
      return { ...v, name, suite, lastMessage };
    }),
    runs: data.runs.map((r) =>
      r.commitSha === undefined ? r : { ...r, commitSha: escapeControlChars(r.commitSha) },
    ),
  };
}

/**
 * Serialize the payload and neutralize HTML parser break-outs inside the data
 * script. Bidi controls and line/paragraph separators left in the data (raw
 * testIds) are written as JSON `\uXXXX` escapes: same value after
 * JSON.parse, but the HTML file itself never carries a raw override.
 */
function embedJson(data: DashboardData): string {
  return JSON.stringify(data)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/<!--/g, '<\\!--')
    .replace(
      /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16)}`,
    );
}

export function renderDashboard(data: DashboardData): string {
  const safeData = redactData(data);
  const json = embedJson(safeData);
  const hasVerdicts = safeData.verdicts.length > 0;
  const hasRuns = safeData.runs.length > 0;

  // light palette: used for the explicit toggle AND for prefers-color-scheme: light
  const lightTokens = String.raw`
    color-scheme: light;
    --bg: #f6f8fa;
    --bg-elev: #ffffff;
    --bg-inset: #f6f8fa;
    --border: #d0d7de;
    --border-soft: #eaeef2;
    --text: #1f2328;
    --text-dim: #59636e;
    --text-faint: #818b98;
    --brand: #cf4b36;
    --accent: #0969da;
    --pass: #1a7f37;
    --fail: #cf222e;
    --fail-deep: #a40e26;
    --error: #82071e;
    --skip: #57606a;
    --warn: #9a6700;
    --suspect: #bf8700;
    --info: #1b7c83;
    --fixed: #0f766e;
    --violet: #8250df;
    --pink: #bf3989;
    --shadow: 0 1px 3px rgba(31,35,40,.1), 0 8px 24px rgba(31,35,40,.07);
`;

  const css = String.raw`
  *, *::before, *::after { box-sizing: border-box; }
  :root, [data-theme='dark'] {
    color-scheme: dark;
    --bg: #0d1117;
    --bg-elev: #161b22;
    --bg-inset: #010409;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --text-faint: #6e7681;
    --brand: #f78166;
    --accent: #4493f8;
    --pass: #3fb950;
    --fail: #f85149;
    --fail-deep: #da3633;
    --error: #b62324;
    --skip: #8b949e;
    --warn: #d29922;
    --suspect: #e3b341;
    --info: #39c5cf;
    --fixed: #2dd4bf;
    --violet: #a371f7;
    --pink: #db61a2;
    --mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
    --shadow: 0 1px 3px rgba(1,4,9,.45), 0 8px 24px rgba(1,4,9,.35);
  }
  [data-theme='light'] {
${lightTokens}  }
  /* no explicit choice: follow the OS (dark stays the default otherwise) */
  @media (prefers-color-scheme: light) {
    :root:not([data-theme='dark']) {
${lightTokens}    }
  }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
    min-height: 100vh;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
      radial-gradient(1100px 480px at 18% -8%, color-mix(in srgb, var(--brand) 7%, transparent), transparent 62%),
      radial-gradient(900px 420px at 92% -10%, color-mix(in srgb, var(--accent) 6%, transparent), transparent 58%);
  }
  h1, h2, h3, p { margin: 0; }
  button { font: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  code, kbd {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 2px 6px;
    color: var(--text);
  }
  kbd { font-size: 11px; border-bottom-width: 2px; color: var(--text-dim); padding: 0 5px; }
  .page { max-width: 1280px; margin: 0 auto; padding: 0 28px 56px; }

  /* ---------- header ---------- */
  .ff-header {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
    padding: 14px 0 12px;
    margin-bottom: 4px;
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    border-bottom: 1px solid var(--border-soft);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .logo {
    font-size: 22px;
    line-height: 1;
    color: var(--brand);
    text-shadow: 0 0 20px color-mix(in srgb, var(--brand) 55%, transparent);
  }
  .wordmark {
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.03em;
    background: linear-gradient(115deg, var(--text) 30%, var(--brand));
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .ver {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 9px;
  }
  .spacer { flex: 1 1 auto; }
  .meta { text-align: right; color: var(--text-dim); font-size: 12.5px; }
  .meta b { color: var(--text); font-weight: 600; }

  /* ---------- buttons ---------- */
  .btn {
    font-size: 12.5px;
    font-weight: 600;
    color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: border-color .15s, color .15s, background .15s;
  }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn:active { transform: translateY(1px); }
  .btn.copied { color: var(--pass); border-color: var(--pass); }
  .btn.sm { padding: 4px 10px; font-size: 12px; }
  #ff-toggle { display: inline-flex; align-items: center; gap: 7px; border-radius: 999px; padding: 6px 14px; }
  .icon-btn {
    font-size: 15px;
    line-height: 1;
    color: var(--text-dim);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .icon-btn:hover { color: var(--text); border-color: var(--text-dim); }

  /* ---------- cards & sections ---------- */
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow);
  }
  .section-head { display: flex; align-items: baseline; gap: 12px; margin: 26px 2px 10px; flex-wrap: wrap; }
  .section-title {
    font-size: 12.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .08em;
    color: var(--text-dim);
  }
  .section-sub { color: var(--text-faint); font-size: 12px; }
  .dim-note { color: var(--text-dim); font-size: 13px; margin: 4px 2px 0; }

  /* ---------- chips ---------- */
  .chips { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 12px 14px; margin-top: 18px; }
  .chip {
    --bc: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 5px 12px 5px 11px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg);
    color: var(--text);
    cursor: pointer;
    transition: border-color .15s, background .15s;
  }
  .chip::before {
    content: '';
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--bc);
    box-shadow: 0 0 8px color-mix(in srgb, var(--bc) 55%, transparent);
    flex: none;
  }
  .chip:hover { border-color: color-mix(in srgb, var(--bc) 55%, transparent); }
  .chip .cnt { font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
  .chip .lbl { color: var(--text-dim); font-size: 12.5px; }
  .chip.active { border-color: var(--bc); background: color-mix(in srgb, var(--bc) 13%, transparent); }
  .chip.active .lbl { color: var(--text); }
  .chip-sep { width: 1px; height: 22px; background: var(--border); margin: 0 4px; flex: none; }
  .k-total { --bc: var(--accent); }
  .k-confirmed { --bc: var(--fail); }
  .k-retry { --bc: var(--warn); }
  .k-suspected { --bc: var(--suspect); }
  .k-failing { --bc: var(--fail-deep); }
  .k-newfail { --bc: var(--pink); }
  .k-passing { --bc: var(--pass); }
  .k-skipped { --bc: var(--skip); }
  .k-gone { --bc: var(--text-faint); }
  .k-slow { --bc: var(--info); }
  .k-fixed { --bc: var(--fixed); }
  .k-long { --bc: var(--violet); }

  /* ---------- runs strip ---------- */
  .legend { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); font-size: 12px; }
  .legend .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-left: 6px; }
  .legend .dot:first-child { margin-left: 0; }
  .dot.pass { background: var(--pass); }
  .dot.fail { background: var(--fail); }
  .strip-card { padding: 18px 18px 12px; }
  .runs { display: flex; align-items: flex-end; gap: 3px; height: 148px; }
  .run-col {
    position: relative;
    flex: 1 1 0;
    min-width: 3px;
    max-width: 26px;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    border-radius: 4px;
    padding: 0 1px;
  }
  .run-col:hover { background: color-mix(in srgb, var(--text) 6%, transparent); }
  .run-bar {
    width: 100%;
    border-radius: 3px 3px 0 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 5px;
    transition: filter .12s;
  }
  .run-col:hover .run-bar { filter: brightness(1.3) saturate(1.1); }
  .seg { width: 100%; }
  .seg-pass { flex: 1 1 auto; background: var(--pass); }
  .seg-fail {
    background: var(--fail);
    min-height: 3px;
    box-shadow: 0 0 8px color-mix(in srgb, var(--fail) 55%, transparent);
  }
  .axis {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    color: var(--text-faint);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: .09em;
  }
  .tip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%);
    background: var(--bg-inset);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow);
    padding: 8px 10px;
    font-size: 12px;
    white-space: nowrap;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity .12s ease .04s;
    z-index: 40;
    text-align: left;
  }
  .run-col:hover .tip { opacity: 1; visibility: visible; }
  .run-col:first-child .tip { left: 0; transform: none; }
  .run-col:last-child .tip { left: auto; right: 0; transform: none; }
  .tip-ts { font-weight: 600; }
  .tip-sha { color: var(--text-dim); font-family: var(--mono); font-size: 11.5px; margin: 1px 0 2px; }
  .tip-counts { display: flex; gap: 8px; }
  .tc-pass { color: var(--pass); font-weight: 600; }
  .tc-fail { color: var(--fail); font-weight: 600; }
  .tc-ok { color: var(--text-dim); }

  /* ---------- table ---------- */
  .toolbar { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .filter {
    flex: 1 1 220px;
    max-width: 380px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 12px;
    color: var(--text);
    font: inherit;
    font-size: 13px;
    transition: border-color .15s, box-shadow .15s;
  }
  .filter::placeholder { color: var(--text-faint); }
  .filter:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }
  .toolbar-hint { margin-left: auto; color: var(--text-faint); font-size: 12px; }
  .tbl-wrap { max-height: 620px; overflow: auto; border-radius: 0 0 11px 11px; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; min-width: 940px; }
  thead th {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg-elev);
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .05em;
    text-align: left;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    user-select: none;
  }
  thead th.sortable { cursor: pointer; }
  thead th.sortable:hover { color: var(--text); }
  thead th .arrow { display: inline-block; width: 14px; color: var(--accent); font-size: 11px; }
  th.num-h { text-align: right; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--border-soft); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr { cursor: pointer; transition: background .1s; }
  tbody tr:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  tbody tr.selected { background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .score-cell { display: inline-flex; align-items: center; gap: 8px; }
  .score-num { font-weight: 700; min-width: 22px; }
  .score-bar, .rate-bar {
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--text) 10%, transparent);
    overflow: hidden;
  }
  .score-bar { width: 52px; }
  .rate-bar { width: 56px; }
  .score-bar i, .rate-bar i, .hbar-fill { display: block; height: 100%; border-radius: 3px; }
  .s-hi { background: var(--fail); }
  .s-mid { background: var(--warn); }
  .s-lo { background: var(--pass); }
  .s-conf { background: var(--accent); }
  .rate-cell { display: inline-flex; align-items: center; gap: 8px; }
  .rate-num { color: var(--text-dim); min-width: 34px; }
  .td-name { max-width: 460px; }
  .tname { display: flex; align-items: baseline; gap: 6px; white-space: nowrap; overflow: hidden; max-width: 460px; }
  .tname .suite { color: var(--text-dim); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .tname .nm { font-weight: 600; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .td-tags { white-space: nowrap; }
  .tag {
    display: inline-block;
    font-size: 11px;
    line-height: 1.6;
    padding: 0 8px;
    margin: 1px 3px 1px 0;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-dim);
    white-space: nowrap;
  }
  .tag-slow { color: var(--info); border-color: color-mix(in srgb, var(--info) 40%, transparent); background: color-mix(in srgb, var(--info) 9%, transparent); }
  .tag-fixed { color: var(--fixed); border-color: color-mix(in srgb, var(--fixed) 40%, transparent); background: color-mix(in srgb, var(--fixed) 9%, transparent); }
  .tag-long { color: var(--violet); border-color: color-mix(in srgb, var(--violet) 40%, transparent); background: color-mix(in srgb, var(--violet) 9%, transparent); }
  .tag.none { border-color: transparent; color: var(--text-faint); }

  /* ---------- badges (classification / status lookups) ---------- */
  .badge {
    --bc: var(--text-dim);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 1px 9px 1px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.7;
    color: var(--bc);
    background: color-mix(in srgb, var(--bc) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--bc) 35%, transparent);
    white-space: nowrap;
  }
  .badge::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--bc); flex: none; }
  .badge.ghost { background: transparent; border-color: var(--border); --bc: var(--text-dim); }
  .c-confirmed { --bc: var(--fail); }
  .c-retry { --bc: var(--warn); }
  .c-suspected { --bc: var(--suspect); }
  .c-failing { --bc: var(--fail-deep); }
  .c-newfail { --bc: var(--pink); }
  .c-passing { --bc: var(--pass); }
  .c-skipped { --bc: var(--skip); }
  .c-gone { --bc: var(--text-faint); }
  .st-pass { --bc: var(--pass); }
  .st-fail { --bc: var(--fail); }
  .st-error { --bc: var(--error); }
  .st-skip { --bc: var(--skip); }

  /* ---------- drawer ---------- */
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, #010409 55%, transparent);
    opacity: 0;
    pointer-events: none;
    transition: opacity .2s ease;
    z-index: 60;
  }
  .backdrop.open { opacity: 1; pointer-events: auto; }
  #ff-drawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(460px, 92vw);
    z-index: 70;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    box-shadow: -16px 0 48px color-mix(in srgb, #010409 55%, transparent);
    transform: translateX(103%);
    transition: transform .28s cubic-bezier(.2, .8, .25, 1);
  }
  #ff-drawer.open { transform: translateX(0); }
  .dr-head {
    --bc: var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 16px 20px 13px;
    border-bottom: 1px solid var(--border);
    border-top: 3px solid var(--bc);
  }
  .dr-title { font-size: 15px; font-weight: 700; }
  .dr-hint { color: var(--text-faint); font-size: 11.5px; margin-top: 3px; }
  .dr-body { flex: 1 1 auto; overflow-y: auto; padding: 18px 20px 24px; }
  .dr-suite { color: var(--text-dim); font-size: 12px; font-family: var(--mono); word-break: break-all; }
  .dr-name { margin: 3px 0 12px; font-size: 16.5px; line-height: 1.35; word-break: break-word; }
  .dr-idrow { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  #ff-dr-id {
    flex: 1;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text-dim);
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 6px 10px;
    word-break: break-all;
  }
  .dr-badges { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; align-items: center; }
  .stats-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    background: color-mix(in srgb, var(--bg-inset) 55%, var(--bg-elev));
  }
  .stats-top { display: flex; align-items: center; gap: 18px; }
  .donut { flex: none; }
  .donut-bg { fill: none; stroke: color-mix(in srgb, var(--text) 10%, transparent); stroke-width: 5; }
  .donut-fg { fill: none; stroke: var(--pass); stroke-width: 5; stroke-linecap: round; transition: stroke-dasharray .4s ease; }
  .donut-fg.warn { stroke: var(--suspect); }
  .donut-fg.bad { stroke: var(--fail); }
  .donut-num { fill: var(--text); font-size: 11px; font-weight: 700; text-anchor: middle; }
  .donut-lbl { fill: var(--text-faint); font-size: 6.5px; text-anchor: middle; letter-spacing: .08em; text-transform: uppercase; }
  .bars { flex: 1; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .bar-row { display: grid; grid-template-columns: 84px 1fr 28px; align-items: center; gap: 8px; font-size: 12px; }
  .bar-lbl { color: var(--text-dim); }
  .hbar { height: 7px; border-radius: 4px; background: color-mix(in srgb, var(--text) 9%, transparent); overflow: hidden; }
  .hbar-fill { border-radius: 4px; transition: width .35s ease; }
  .bar-val { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
  .tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 16px; }
  .tile { border: 1px solid var(--border-soft); border-radius: 10px; padding: 9px 10px 7px; background: var(--bg-elev); }
  .tile span { display: block; color: var(--text-faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; }
  .tile b { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .tile.hot { border-color: color-mix(in srgb, var(--hot, var(--fail)) 45%, transparent); }
  .tile.hot b { color: var(--hot, var(--fail)); }
  .tile.accent-red { --hot: var(--fail); }
  .tile.accent-orange { --hot: var(--warn); }
  .tile.accent-yellow { --hot: var(--suspect); }
  .dr-msg-block h3 { margin: 18px 0 8px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-dim); }
  #ff-dr-msg {
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-left: 3px solid var(--fail);
    border-radius: 8px;
    padding: 12px 14px;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.55;
    color: var(--text-dim);
  }
  .dr-foot { border-top: 1px solid var(--border); padding: 14px 20px 16px; }
  .dr-foot-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--text-faint); margin-bottom: 7px; }
  .dr-foot-row { display: flex; gap: 8px; align-items: stretch; }
  #ff-dr-cmd {
    flex: 1;
    font-family: var(--mono);
    font-size: 11.5px;
    color: var(--text);
    background: var(--bg-inset);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 7px 10px;
    word-break: break-all;
    align-self: center;
  }

  /* ---------- empty state / footer ---------- */
  .empty-wrap { display: flex; justify-content: center; padding-top: 9vh; }
  .empty-card { max-width: 560px; text-align: center; padding: 52px 44px; }
  .empty-logo {
    font-size: 44px;
    color: var(--brand);
    text-shadow: 0 0 30px color-mix(in srgb, var(--brand) 50%, transparent);
    margin-bottom: 14px;
  }
  .empty-card h2 { margin-bottom: 10px; font-size: 21px; letter-spacing: -0.01em; }
  .empty-card p { color: var(--text-dim); margin-bottom: 10px; }
  .ff-foot {
    margin-top: 34px;
    padding-top: 14px;
    border-top: 1px solid var(--border-soft);
    color: var(--text-faint);
    font-size: 12px;
    display: flex;
    justify-content: space-between;
    gap: 10px;
    flex-wrap: wrap;
  }
  .tbl-wrap, .dr-body, #ff-dr-msg { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }

  @media (max-width: 768px) {
    .page { padding: 0 14px 48px; }
    #ff-drawer { width: 100vw; border-left: none; }
    .stats-top { flex-direction: column; }
    .tbl-wrap { max-height: 65vh; }
    .meta { text-align: left; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { transition: none !important; }
  }
`;

  const chips = String.raw`
<nav id="ff-chips" class="chips card" aria-label="Summary filters">
  <button type="button" class="chip k-total" data-clear="1" aria-pressed="false"><span class="cnt" id="cnt-total">0</span><span class="lbl">Tests tracked</span></button>
  <button type="button" class="chip k-confirmed" data-cls="flaky-confirmed" aria-pressed="false"><span class="cnt" id="cnt-flaky-confirmed">0</span><span class="lbl">Flaky (confirmed)</span></button>
  <button type="button" class="chip k-retry" data-cls="flaky-retry" aria-pressed="false"><span class="cnt" id="cnt-flaky-retry">0</span><span class="lbl">Flaky (retry-rescued)</span></button>
  <button type="button" class="chip k-suspected" data-cls="flaky-suspected" aria-pressed="false"><span class="cnt" id="cnt-flaky-suspected">0</span><span class="lbl">Flaky (suspected)</span></button>
  <button type="button" class="chip k-failing" data-cls="failing" aria-pressed="false"><span class="cnt" id="cnt-failing">0</span><span class="lbl">Failing</span></button>
  <button type="button" class="chip k-newfail" data-cls="new-failure" aria-pressed="false"><span class="cnt" id="cnt-new-failure">0</span><span class="lbl">New failure</span></button>
  <button type="button" class="chip k-passing" data-cls="passing" aria-pressed="false"><span class="cnt" id="cnt-passing">0</span><span class="lbl">Passing</span></button>
  <button type="button" class="chip k-skipped" data-cls="skipped" aria-pressed="false"><span class="cnt" id="cnt-skipped">0</span><span class="lbl">Skipped</span></button>
  <button type="button" class="chip k-gone" data-cls="gone" aria-pressed="false"><span class="cnt" id="cnt-gone">0</span><span class="lbl">Gone</span></button>
  <span class="chip-sep" aria-hidden="true"></span>
  <button type="button" class="chip k-slow" data-tag="slow" aria-pressed="false"><span class="cnt" id="cnt-slow">0</span><span class="lbl">Slow</span></button>
  <button type="button" class="chip k-fixed" data-tag="recently-fixed" aria-pressed="false"><span class="cnt" id="cnt-recently-fixed">0</span><span class="lbl">Recently fixed</span></button>
  <button type="button" class="chip k-long" data-tag="long-unseen" aria-pressed="false"><span class="cnt" id="cnt-long-unseen">0</span><span class="lbl">Long unseen</span></button>
</nav>
`;

  const stripCard = String.raw`
<div class="card strip-card">
  <div id="ff-runs" class="runs" role="img" aria-label="Pass and fail counts per run, oldest to newest"></div>
  <div class="axis"><span>oldest</span><span>latest</span></div>
</div>
`;

  const runsNote = String.raw`
<p class="dim-note">No runs recorded yet — the run history chart appears once flakefinder has ingested CI runs.</p>
`;

  const runsSection = String.raw`
<section class="ff-section" aria-label="Run history">
  <div class="section-head">
    <h2 class="section-title">Run history</h2>
    <span class="section-sub" id="ff-runs-sub"></span>
    <span class="legend"><i class="dot pass"></i>pass<i class="dot fail"></i>fail</span>
  </div>
  ${hasRuns ? stripCard : runsNote}
</section>
`;

  const tableSection = String.raw`
<section class="ff-section" aria-label="Tests">
  <div class="section-head">
    <h2 class="section-title">Tests</h2>
    <span class="section-sub" id="ff-showing"></span>
  </div>
  <div class="card">
    <div class="toolbar">
      <input id="ff-filter" class="filter" type="search" placeholder="Filter by suite or test name&hellip;" aria-label="Filter tests" autocomplete="off" spellcheck="false">
      <button type="button" id="ff-clear" class="btn sm" hidden>Clear filters</button>
      <span class="toolbar-hint">Click a row for details</span>
    </div>
    <div class="tbl-wrap">
      <table id="ff-table">
        <thead>
          <tr>
            <th class="sortable num-h" data-key="score" scope="col">Score<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="conf" scope="col">Conf %<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="runs" scope="col">Runs<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="pass" scope="col">Pass rate<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable num-h" data-key="median" scope="col">Median<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable" data-key="class" scope="col">Class<span class="arrow" aria-hidden="true"></span></th>
            <th class="sortable" data-key="name" scope="col">Test<span class="arrow" aria-hidden="true"></span></th>
            <th scope="col">Tags</th>
          </tr>
        </thead>
        <tbody id="ff-tbody"></tbody>
      </table>
    </div>
  </div>
</section>
`;

  const drawerMarkup = String.raw`
<div id="ff-backdrop" class="backdrop" aria-hidden="true"></div>
<aside id="ff-drawer" role="dialog" aria-modal="true" aria-label="Test detail" aria-hidden="true">
  <div class="dr-head">
    <div>
      <div class="dr-title">Test detail</div>
      <div class="dr-hint"><kbd>Esc</kbd> close &middot; <kbd>&larr;</kbd><kbd>&rarr;</kbd> move between tests</div>
    </div>
    <button type="button" id="ff-dr-close" class="icon-btn" aria-label="Close details">&#10005;</button>
  </div>
  <div class="dr-body">
    <div class="dr-suite" id="ff-dr-suite"></div>
    <h2 class="dr-name" id="ff-dr-name"></h2>
    <div class="dr-idrow">
      <code id="ff-dr-id" title="test id"></code>
      <button type="button" class="btn sm" id="ff-dr-copy-id">Copy ID</button>
    </div>
    <div class="dr-badges">
      <span class="badge" id="ff-dr-cls"></span>
      <span class="badge" id="ff-dr-status"></span>
      <span class="badge ghost" id="ff-dr-seen"></span>
    </div>
    <div class="stats-card">
      <div class="stats-top">
        <svg class="donut" viewBox="0 0 48 48" width="84" height="84" aria-hidden="true">
          <circle class="donut-bg" cx="24" cy="24" r="19"></circle>
          <circle class="donut-fg" id="ff-dr-donut" cx="24" cy="24" r="19" transform="rotate(-90 24 24)"></circle>
          <text class="donut-num" id="ff-dr-donut-v" x="24" y="27">&ndash;</text>
          <text class="donut-lbl" x="24" y="37">pass rate</text>
        </svg>
        <div class="bars">
          <div class="bar-row">
            <span class="bar-lbl">Flake score</span>
            <div class="hbar"><i class="hbar-fill s-lo" id="ff-dr-score-bar"></i></div>
            <b class="bar-val" id="ff-dr-score-v">0</b>
          </div>
          <div class="bar-row">
            <span class="bar-lbl">Confidence</span>
            <div class="hbar"><i class="hbar-fill s-conf" id="ff-dr-conf-bar"></i></div>
            <b class="bar-val" id="ff-dr-conf-v">0</b>
          </div>
        </div>
      </div>
      <div class="tiles">
        <div class="tile"><span>Runs</span><b id="ff-dr-runs">0</b></div>
        <div class="tile"><span>Median</span><b id="ff-dr-med">&ndash;</b></div>
        <div class="tile"><span>P95</span><b id="ff-dr-p95">&ndash;</b></div>
        <div class="tile accent-red"><span>Same-SHA flips</span><b id="ff-dr-flips">0</b></div>
        <div class="tile accent-orange"><span>Retry rescues</span><b id="ff-dr-resc">0</b></div>
        <div class="tile accent-yellow"><span>Direction &Delta;</span><b id="ff-dr-dirs">0</b></div>
      </div>
    </div>
    <div class="dr-msg-block" id="ff-dr-msg-block">
      <h3>Last failure message</h3>
      <pre id="ff-dr-msg"></pre>
    </div>
  </div>
  <div class="dr-foot">
    <div class="dr-foot-lbl">Quarantine this test</div>
    <div class="dr-foot-row">
      <code id="ff-dr-cmd"></code>
      <button type="button" class="btn sm" id="ff-dr-copy-cmd">Copy</button>
    </div>
  </div>
</aside>
`;

  const emptyState = String.raw`
<div class="empty-wrap">
  <div class="card empty-card">
    <div class="empty-logo" aria-hidden="true">&#10052;</div>
    <h2>No test history yet</h2>
    <p>flakefinder learns your suite's health as runs accumulate — this dashboard fills in automatically.</p>
    <p class="empty-hint">Run <code>npx flakefinder run -- npm test</code> a few times locally or in CI, then regenerate with <code>npx flakefinder html</code>.</p>
  </div>
</div>
`;

  const appJs = String.raw`
(function () {
  'use strict';

  // ---------- embedded data ----------
  function readData() {
    var node = document.getElementById('ff-data');
    var text = node ? (node.textContent || '') : '{}';
    // Undo the safety escape applied by renderDashboard before parsing.
    // The escaped end-tag form is already valid JSON and needs no reversal.
    return JSON.parse(text.replace(/<\\!/g, '<!'));
  }

  var data = readData();
  var verdicts = Array.isArray(data.verdicts) ? data.verdicts : [];
  var runs = Array.isArray(data.runs) ? data.runs : [];

  // ---------- lookup maps ----------
  var CLS = {
    'flaky-confirmed': { label: 'Flaky (confirmed)', short: 'Flaky', color: 'confirmed' },
    'flaky-retry': { label: 'Flaky (retry-rescued)', short: 'Retry-rescued', color: 'retry' },
    'flaky-suspected': { label: 'Flaky (suspected)', short: 'Suspected', color: 'suspected' },
    'failing': { label: 'Failing', short: 'Failing', color: 'failing' },
    'new-failure': { label: 'New failure', short: 'New failure', color: 'newfail' },
    'passing': { label: 'Passing', short: 'Passing', color: 'passing' },
    'skipped': { label: 'Skipped', short: 'Skipped', color: 'skipped' },
    'gone': { label: 'Gone', short: 'Gone', color: 'gone' }
  };
  var RANK = { 'flaky-confirmed': 0, 'flaky-retry': 1, 'flaky-suspected': 2, 'failing': 3, 'new-failure': 4, 'passing': 5, 'skipped': 6, 'gone': 7 };
  var TAG_CLS = { slow: 'tag-slow', 'recently-fixed': 'tag-fixed', 'long-unseen': 'tag-long' };
  var STATUS_CLS = { pass: 'st-pass', fail: 'st-fail', error: 'st-error', skip: 'st-skip' };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  // control/bidi characters made visible, as in src/report/text.ts — for
  // testIds, which stay raw in the data so the copy buttons yield the real id
  function visible(s) {
    return String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, function (c) {
      var code = c.charCodeAt(0);
      return code < 256 ? '\\x' + ('0' + code.toString(16)).slice(-2) : '\\u' + ('000' + code.toString(16)).slice(-4);
    });
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function fmtDateTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtDur(ms) {
    if (ms === null || ms === undefined || !isFinite(ms)) return '\u2014';
    if (ms < 1000) return Math.round(ms) + ' ms';
    if (ms < 60000) {
      var s = ms / 1000;
      var str = s >= 100 ? s.toFixed(0) : (s >= 10 ? s.toFixed(1) : s.toFixed(2));
      return str + ' s';
    }
    var m = Math.floor(ms / 60000);
    if (m >= 60) {
      var h = Math.floor(m / 60);
      return h + 'h ' + (m % 60) + 'm';
    }
    return m + 'm ' + Math.round((ms - m * 60000) / 1000) + 's';
  }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function clamp01(x) { return Math.max(0, Math.min(1, isFinite(x) ? x : 0)); }
  function clamp100(x) { return Math.max(0, Math.min(100, isFinite(x) ? x : 0)); }
  function scoreCls(n) { return n >= 70 ? 's-hi' : (n >= 40 ? 's-mid' : 's-lo'); }
  function rateCls(r) { return r >= 0.9 ? 's-lo' : (r >= 0.5 ? 's-mid' : 's-hi'); }
  function confCls(n) { return n >= 70 ? 's-conf' : (n >= 40 ? 's-mid' : 's-hi'); }
  function midTrunc(s, max) {
    s = String(s);
    if (s.length <= max) return s;
    // by code point: slicing UTF-16 units would split surrogate pairs (emoji)
    var cps = Array.from(s);
    if (cps.length <= max) return s;
    var keep = max - 1;
    var head = Math.ceil(keep / 2);
    var tail = keep - head;
    return cps.slice(0, head).join('') + '\u2026' + cps.slice(cps.length - tail).join('');
  }
  function shortSha(s) { if (!s) return ''; s = String(s); var d = s.indexOf('-dirty'); return d >= 0 ? s.slice(0, 7) + ' (dirty)' : s.slice(0, 7); }

  // ---------- theme toggle ----------
  var themeBtn = $('ff-toggle');
  // an explicit choice (stored) wins; otherwise follow prefers-color-scheme,
  // dark when the OS has no preference
  var lightQuery = null;
  try { lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null; } catch (err) { lightQuery = null; }
  var stored = null;
  try {
    stored = window.localStorage && window.localStorage.getItem('ff-theme');
  } catch (err) { /* storage unavailable (private mode / file origin) */ }
  var explicitTheme = stored === 'light' || stored === 'dark';
  var theme = explicitTheme ? stored : (lightQuery && lightQuery.matches ? 'light' : 'dark');
  if (lightQuery && lightQuery.addEventListener) {
    lightQuery.addEventListener('change', function (e) {
      if (explicitTheme) return;
      theme = e.matches ? 'light' : 'dark';
      applyTheme();
    });
  }
  function applyTheme() {
    document.documentElement.setAttribute('data-theme', theme);
    if (!themeBtn) return;
    var ico = $('ff-toggle-ico');
    var lbl = $('ff-toggle-lbl');
    if (ico) ico.textContent = theme === 'dark' ? '\u2600' : '\u263E';
    if (lbl) lbl.textContent = theme === 'dark' ? 'Light' : 'Dark';
    themeBtn.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' theme');
  }
  applyTheme();
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      theme = theme === 'dark' ? 'light' : 'dark';
      explicitTheme = true;
      try { window.localStorage.setItem('ff-theme', theme); } catch (err) { /* ignore */ }
      applyTheme();
    });
  }

  // ---------- header ----------
  var gen = $('ff-generated');
  if (gen) gen.textContent = fmtDateTime(data.generatedAt);
  var ver = $('ff-version');
  if (ver) ver.textContent = 'v' + (data.flakefinderVersion || '');

  // ---------- summary chip counts ----------
  var clsCounts = {};
  var tagCounts = {};
  var idx;
  for (idx = 0; idx < verdicts.length; idx++) {
    var item = verdicts[idx];
    clsCounts[item.classification] = (clsCounts[item.classification] || 0) + 1;
    var itemTags = item.tags || [];
    var t;
    for (t = 0; t < itemTags.length; t++) {
      tagCounts[itemTags[t]] = (tagCounts[itemTags[t]] || 0) + 1;
    }
  }
  function setCount(id, n) {
    var e = $(id);
    if (e) e.textContent = String(n);
  }
  setCount('cnt-total', verdicts.length);
  Object.keys(CLS).forEach(function (k) { setCount('cnt-' + k, clsCounts[k] || 0); });
  setCount('cnt-slow', tagCounts.slow || 0);
  setCount('cnt-recently-fixed', tagCounts['recently-fixed'] || 0);
  setCount('cnt-long-unseen', tagCounts['long-unseen'] || 0);

  // ---------- table state ----------
  var state = { q: '', cls: null, tag: null, sortKey: 'score', sortDir: 'desc' };
  var GETTERS = {
    score: function (x) { return x.flakeScore; },
    conf: function (x) { return x.confidence; },
    runs: function (x) { return x.runsObserved; },
    pass: function (x) { return clamp01(x.passRate); },
    median: function (x) { return x.medianDurationMs == null ? -1 : x.medianDurationMs; },
    'class': function (x) { return RANK[x.classification] !== undefined ? RANK[x.classification] : 99; },
    name: function (x) { return (x.suite + ' / ' + x.name).toLowerCase(); }
  };
  function currentRows() {
    var out = [];
    var j;
    for (j = 0; j < verdicts.length; j++) {
      var x = verdicts[j];
      if (state.cls && x.classification !== state.cls) continue;
      if (state.tag && (x.tags || []).indexOf(state.tag) === -1) continue;
      if (state.q) {
        var hay = (x.suite + ' ' + x.name).toLowerCase();
        if (hay.indexOf(state.q) === -1) continue;
      }
      out.push(x);
    }
    var getter = GETTERS[state.sortKey] || GETTERS.score;
    var dir = state.sortDir === 'asc' ? 1 : -1;
    out.sort(function (a, b) {
      var va = getter(a);
      var vb = getter(b);
      if (va < vb) return -dir;
      if (va > vb) return dir;
      var na = (a.suite + ' / ' + a.name).toLowerCase();
      var nb = (b.suite + ' / ' + b.name).toLowerCase();
      if (na < nb) return -1;
      if (na > nb) return 1;
      return 0;
    });
    return out;
  }

  // ---------- table rendering ----------
  var tbody = $('ff-tbody');
  var showingEl = $('ff-showing');
  var clearBtn = $('ff-clear');

  function rowEl(rows, v, rowIdx) {
    var tr = document.createElement('tr');
    tr.setAttribute('data-idx', String(rowIdx));
    tr.tabIndex = 0;
    var td;

    td = el('td', 'num');
    var scoreCell = el('div', 'score-cell');
    scoreCell.appendChild(el('span', 'score-num', String(Math.round(v.flakeScore))));
    var scoreBar = el('div', 'score-bar');
    var scoreFill = el('i', scoreCls(v.flakeScore));
    scoreFill.style.width = clamp100(v.flakeScore) + '%';
    scoreBar.appendChild(scoreFill);
    scoreCell.appendChild(scoreBar);
    td.appendChild(scoreCell);
    tr.appendChild(td);

    tr.appendChild(el('td', 'num', Math.round(v.confidence) + '%'));

    tr.appendChild(el('td', 'num', String(v.runsObserved)));

    td = el('td', 'num');
    var rate = clamp01(v.passRate);
    var rateCell = el('div', 'rate-cell');
    var rateBar = el('div', 'rate-bar');
    var rateFill = el('i', rateCls(rate));
    rateFill.style.width = Math.round(rate * 100) + '%';
    rateBar.appendChild(rateFill);
    rateCell.appendChild(rateBar);
    rateCell.appendChild(el('span', 'rate-num', pct(rate)));
    td.appendChild(rateCell);
    tr.appendChild(td);

    tr.appendChild(el('td', 'num', fmtDur(v.medianDurationMs)));

    var meta = CLS[v.classification] || CLS.passing;
    tr.appendChild(el('td', null)).appendChild(el('span', 'badge c-' + meta.color, meta.short));

    td = el('td', 'td-name');
    var nameDiv = el('div', 'tname');
    nameDiv.title = v.suite + ' :: ' + v.name;
    nameDiv.appendChild(el('span', 'suite', midTrunc(v.suite, 46) + ' ::'));
    nameDiv.appendChild(el('span', 'nm', midTrunc(v.name, 56)));
    td.appendChild(nameDiv);
    tr.appendChild(td);

    td = el('td', 'td-tags');
    var tags = v.tags || [];
    var k;
    for (k = 0; k < tags.length; k++) {
      td.appendChild(el('span', 'tag ' + (TAG_CLS[tags[k]] || ''), tags[k]));
    }
    if (!tags.length) td.appendChild(el('span', 'tag none', '\u2014'));
    tr.appendChild(td);

    tr.addEventListener('click', function () { openDrawer(rows, rowIdx); });
    tr.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDrawer(rows, rowIdx);
      }
    });
    return tr;
  }

  function updateSortHeads() {
    var heads = document.querySelectorAll('#ff-table thead th[data-key]');
    Array.prototype.forEach.call(heads, function (th) {
      var key = th.getAttribute('data-key');
      var arrow = th.querySelector('.arrow');
      var active = key === state.sortKey;
      if (arrow) arrow.textContent = active ? (state.sortDir === 'asc' ? '\u2191' : '\u2193') : '';
      if (active) th.setAttribute('aria-sort', state.sortDir === 'asc' ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    });
  }

  var RENDER_CAP = 500;
  var showAll = false;

  if (showingEl) {
    showingEl.style.cursor = 'pointer';
    showingEl.title = 'Click to toggle the render cap';
    showingEl.addEventListener('click', function () {
      showAll = !showAll;
      renderTable();
    });
  }
  if (clearBtn) clearBtn.hidden = true;

  function renderTable() {
    var rows = currentRows();
    var frag = document.createDocumentFragment();
    var limit = showAll ? rows.length : Math.min(rows.length, RENDER_CAP);
    var j;
    for (j = 0; j < limit; j++) frag.appendChild(rowEl(rows, rows[j], j));
    if (tbody) tbody.replaceChildren(frag);
    var hidden = rows.length - limit;
    var label = 'Showing ' + limit + ' of ' + verdicts.length + ' tests';
    if (hidden > 0) label += ' (' + hidden + ' hidden for speed — show all)';
    if (showingEl) showingEl.textContent = label;
    if (clearBtn) clearBtn.hidden = !(state.q || state.cls || state.tag);
    updateSortHeads();
  }

  function wireSort() {
    var heads = document.querySelectorAll('#ff-table thead th[data-key]');
    Array.prototype.forEach.call(heads, function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-key');
        if (state.sortKey === key) {
          state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          state.sortKey = key;
          state.sortDir = (key === 'name' || key === 'class') ? 'asc' : 'desc';
        }
        renderTable();
      });
    });
  }

  // ---------- filter input + chips ----------
  var filterInput = $('ff-filter');
  var debounceTimer = 0;
  if (filterInput) {
    filterInput.addEventListener('input', function () {
      window.clearTimeout(debounceTimer);
      var value = filterInput.value;
      debounceTimer = window.setTimeout(function () {
        state.q = value.trim().toLowerCase();
        renderTable();
      }, 150);
    });
  }
  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      state.q = '';
      state.cls = null;
      state.tag = null;
      if (filterInput) filterInput.value = '';
      syncChipActive();
      renderTable();
    });
  }

  function chipFilterOf(chip) {
    if (chip.getAttribute('data-clear') !== null) return { cls: null, tag: null };
    var c = chip.getAttribute('data-cls');
    if (c) return { cls: c, tag: null };
    var t = chip.getAttribute('data-tag');
    if (t) return { cls: null, tag: t };
    return null;
  }
  function syncChipActive() {
    var chips = document.querySelectorAll('#ff-chips .chip');
    Array.prototype.forEach.call(chips, function (chip) {
      var f = chipFilterOf(chip);
      var on = false;
      if (f) {
        if (f.cls) on = f.cls === state.cls && !state.tag;
        else if (f.tag) on = f.tag === state.tag && !state.cls;
        else on = !state.cls && !state.tag;
      }
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function wireChips() {
    var chips = document.querySelectorAll('#ff-chips .chip');
    Array.prototype.forEach.call(chips, function (chip) {
      chip.addEventListener('click', function () {
        var f = chipFilterOf(chip);
        if (!f) return;
        if (!f.cls && !f.tag) {
          state.cls = null;
          state.tag = null;
        } else if (f.cls && f.cls === state.cls && !state.tag) {
          state.cls = null;
        } else if (f.tag && f.tag === state.tag && !state.cls) {
          state.tag = null;
        } else {
          state.cls = f.cls;
          state.tag = f.tag;
        }
        syncChipActive();
        renderTable();
      });
    });
    syncChipActive();
  }

  // ---------- runs strip chart ----------
  function renderRuns() {
    var wrap = $('ff-runs');
    if (!wrap) return;
    var list = runs.slice().sort(function (a, b) {
      if (a.timestamp < b.timestamp) return -1;
      if (a.timestamp > b.timestamp) return 1;
      return 0;
    }).slice(-50);
    var sub = $('ff-runs-sub');
    if (sub) {
      sub.textContent = list.length + (list.length === 1 ? ' run' : ' runs') + (runs.length > 50 ? ' \u00B7 showing last 50' : '');
    }
    var max = 1;
    var j;
    for (j = 0; j < list.length; j++) {
      var total0 = list[j].passCount + list[j].failCount;
      if (total0 > max) max = total0;
    }
    for (j = 0; j < list.length; j++) {
      var r = list[j];
      var total = Math.max(1, r.passCount + r.failCount);
      var col = el('div', 'run-col');
      var bar = el('div', 'run-bar');
      bar.style.height = Math.max(6, Math.round((total / max) * 100)) + '%';
      if (r.failCount > 0) {
        var segFail = el('div', 'seg seg-fail');
        segFail.style.height = Math.max(6, Math.round((r.failCount / total) * 100)) + '%';
        bar.appendChild(segFail);
      }
      bar.appendChild(el('div', 'seg seg-pass'));
      col.appendChild(bar);

      var tip = el('div', 'tip');
      tip.appendChild(el('div', 'tip-ts', fmtDateTime(r.timestamp)));
      tip.appendChild(el('div', 'tip-sha', r.commitSha ? shortSha(r.commitSha) : 'no commit sha'));
      var counts = el('div', 'tip-counts');
      counts.appendChild(el('span', 'tc-pass', r.passCount + ' pass'));
      if (r.failCount > 0) counts.appendChild(el('span', 'tc-fail', r.failCount + ' fail'));
      else counts.appendChild(el('span', 'tc-ok', 'all green'));
      tip.appendChild(counts);
      col.appendChild(tip);
      wrap.appendChild(col);
    }
  }

  // ---------- detail drawer ----------
  var drawer = $('ff-drawer');
  var backdrop = $('ff-backdrop');
  var drawerRows = [];
  var drawerIdx = -1;
  var current = null;
  var DONUT_C = 2 * Math.PI * 19;

  function setHBar(barId, valId, n, cls) {
    var bar = $(barId);
    var val = $(valId);
    if (bar) {
      bar.style.width = clamp100(n) + '%';
      bar.className = 'hbar-fill ' + cls;
    }
    if (val) val.textContent = String(Math.round(n));
  }
  function tile(id, text, hot) {
    var e = $(id);
    if (e) {
      e.textContent = text;
      if (e.parentElement) e.parentElement.classList.toggle('hot', !!hot);
    }
  }

  function renderDrawer(v) {
    current = v;
    var meta = CLS[v.classification] || CLS.passing;

    var suiteEl = $('ff-dr-suite');
    if (suiteEl) { suiteEl.textContent = v.suite; suiteEl.title = v.suite; }
    var nameEl = $('ff-dr-name');
    if (nameEl) { nameEl.textContent = v.name; nameEl.title = v.name; }
    var idEl = $('ff-dr-id');
    if (idEl) idEl.textContent = visible(v.testId);

    var clsEl = $('ff-dr-cls');
    if (clsEl) { clsEl.textContent = meta.label; clsEl.className = 'badge c-' + meta.color; }
    var head = drawer ? drawer.querySelector('.dr-head') : null;
    if (head) head.className = 'dr-head c-' + meta.color;

    var stEl = $('ff-dr-status');
    if (stEl) {
      stEl.textContent = 'last: ' + v.lastStatus;
      stEl.className = 'badge ' + (STATUS_CLS[v.lastStatus] || 'st-pass');
    }
    var seenEl = $('ff-dr-seen');
    if (seenEl) seenEl.textContent = 'last seen ' + fmtDateTime(v.lastSeen);

    var rate = clamp01(v.passRate);
    var arc = $('ff-dr-donut');
    if (arc) {
      arc.setAttribute('stroke-dasharray', (rate * DONUT_C).toFixed(2) + ' ' + DONUT_C.toFixed(2));
      arc.setAttribute('class', 'donut-fg ' + (rate >= 0.9 ? 'ok' : (rate >= 0.5 ? 'warn' : 'bad')));
    }
    var donutVal = $('ff-dr-donut-v');
    if (donutVal) donutVal.textContent = pct(rate);

    setHBar('ff-dr-score-bar', 'ff-dr-score-v', v.flakeScore, scoreCls(v.flakeScore));
    setHBar('ff-dr-conf-bar', 'ff-dr-conf-v', v.confidence, confCls(v.confidence));

    tile('ff-dr-runs', String(v.runsObserved), false);
    tile('ff-dr-med', fmtDur(v.medianDurationMs), false);
    tile('ff-dr-p95', fmtDur(v.p95DurationMs), false);
    tile('ff-dr-flips', String(v.sameShaFlips || 0), (v.sameShaFlips || 0) > 0);
    tile('ff-dr-resc', String(v.retryRescues || 0), (v.retryRescues || 0) > 0);
    tile('ff-dr-dirs', String(v.directionChanges || 0), (v.directionChanges || 0) > 0);

    var msgBlock = $('ff-dr-msg-block');
    var msgPre = $('ff-dr-msg');
    if (msgBlock && msgPre) {
      if (v.lastMessage) {
        msgBlock.style.display = '';
        msgPre.textContent = v.lastMessage;
      } else {
        msgBlock.style.display = 'none';
      }
    }
    var cmd = $('ff-dr-cmd');
    if (cmd) cmd.textContent = 'flakefinder quarantine add ' + visible(v.testId);
  }

  function highlightDrawerRow() {
    if (!tbody) return;
    var prev = tbody.querySelector('tr.selected');
    if (prev) prev.classList.remove('selected');
    var cur = tbody.querySelector('tr[data-idx="' + drawerIdx + '"]');
    if (cur) cur.classList.add('selected');
  }
  function openDrawer(rows, rowIdx) {
    if (!drawer || !rows.length) return;
    drawerRows = rows;
    drawerIdx = rowIdx;
    renderDrawer(rows[rowIdx]);
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    if (backdrop) backdrop.classList.add('open');
    highlightDrawerRow();
    var closeBtn = $('ff-dr-close');
    if (closeBtn) closeBtn.focus();
  }
  function closeDrawer() {
    if (drawer) {
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }
    if (backdrop) backdrop.classList.remove('open');
    if (tbody) {
      var prev = tbody.querySelector('tr.selected');
      if (prev) prev.classList.remove('selected');
    }
  }
  function stepDrawer(delta) {
    if (!drawerRows.length) return;
    drawerIdx = (drawerIdx + delta + drawerRows.length) % drawerRows.length;
    renderDrawer(drawerRows[drawerIdx]);
    highlightDrawerRow();
  }
  function isTypingTarget(e) {
    var t = e.target;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable === true);
  }
  document.addEventListener('keydown', function (e) {
    var open = drawer && drawer.classList.contains('open');
    if (e.key === 'Escape') {
      if (open) closeDrawer();
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowRight' && !isTypingTarget(e)) { e.preventDefault(); stepDrawer(1); }
    else if (e.key === 'ArrowLeft' && !isTypingTarget(e)) { e.preventDefault(); stepDrawer(-1); }
  });

  // ---------- clipboard ----------
  function flashCopied(btn) {
    if (!btn) return;
    var original = btn.getAttribute('data-label') || btn.textContent;
    btn.setAttribute('data-label', original);
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    window.setTimeout(function () {
      btn.textContent = original;
      btn.classList.remove('copied');
    }, 1400);
  }
  function copyText(text, btn) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* ignore */ }
      document.body.removeChild(ta);
      flashCopied(btn);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flashCopied(btn); }, fallback);
    } else {
      fallback();
    }
  }
  function wireCopy(btnId, getText) {
    var btn = $(btnId);
    if (btn) btn.addEventListener('click', function () { copyText(getText(), btn); });
  }
  wireCopy('ff-dr-copy-id', function () { return current ? current.testId : ''; });
  wireCopy('ff-dr-copy-cmd', function () { return current ? 'flakefinder quarantine add ' + current.testId : ''; });
  var drClose = $('ff-dr-close');
  if (drClose) drClose.addEventListener('click', closeDrawer);
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  // ---------- init ----------
  if ($('ff-table')) {
    wireChips();
    wireSort();
    renderRuns();
    renderTable();
  }
})();
`;

  return String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark light">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="flakefinder">
<title>flakefinder dashboard</title>
<style>${css}</style>
</head>
<body>
<div class="page">
  <header class="ff-header">
    <div class="brand">
      <span class="logo" aria-hidden="true">&#10052;</span>
      <span class="wordmark">flakefinder</span>
      <span class="ver" id="ff-version"></span>
    </div>
    <div class="spacer"></div>
    <div class="meta">Generated <b id="ff-generated"></b></div>
    <button type="button" id="ff-toggle" class="btn" aria-label="Toggle color theme"><span id="ff-toggle-ico" aria-hidden="true"></span><span id="ff-toggle-lbl"></span></button>
  </header>
  ${hasVerdicts ? chips : ''}
  ${hasVerdicts ? runsSection : ''}
  ${hasVerdicts ? tableSection : ''}
  ${hasVerdicts ? '' : emptyState}
  <footer class="ff-foot">
    <span>Self-contained offline dashboard &mdash; data embedded at generation time, no network requests.</span>
    <span>flakefinder</span>
  </footer>
</div>
${hasVerdicts ? drawerMarkup : ''}
<script id="ff-data" type="application/json">${json}</script>
<script>${appJs}</script>
</body>
</html>`;
}
