// STUB — Agent D owns this file. Replace entirely with the full dashboard (PLAN §11).
import type { DashboardData } from '../types.js';

export function renderDashboard(data: DashboardData): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>flakefinder dashboard</title></head><body><pre>flakefinder dashboard stub — ${data.verdicts.length} verdicts</pre></body></html>`;
}
