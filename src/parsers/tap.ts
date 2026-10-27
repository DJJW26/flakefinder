/**
 * TAP parser — covers `node --test --test-reporter=tap` (verified against
 * node 22 output) and plain TAP14.
 *
 * Grammar notes from real output:
 * - `TAP version 13` header; `# Subtest: NAME` declares a test at its
 *   nesting level; the assertion (`ok N - NAME` / `not ok N - NAME`) closes
 *   it — for suites the aggregate assertion repeats the suite name AFTER its
 *   children and carries `type: 'suite'` in the YAML block.
 * - Suite aggregates are NOT emitted (their children already carry the
 *   results — emitting both would double-count failures in the engine).
 * - Directives: `# SKIP reason` → skip, `# TODO` → skip.
 * - YAML blocks between --- and ... carry diagnostics: `error:` → message,
 *   `stack: |-` → stack.
 * - Identity: suite = ancestor chain joined by ' > '; root-level tests get
 *   suite 'node:test' (TAP carries no file names).
 *
 * Never throws.
 */
import type { ReportParser, TestCaseResult, TestStatus } from '../types.js';
import { makeTestId } from '../util/test-id.js';
import { errorMessage, stripBom, trimTo } from './internal.js';

const ROOT_SUITE = 'node:test';
const MESSAGE_MAX_CHARS = 2000;

interface YamlBlock {
  error?: string;
  stack?: string;
  isSuite: boolean;
}

export const tapParser: ReportParser = {
  name: 'tap',

  sniff(content: string): boolean {
    const first = stripBom(content)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '');
    return first !== undefined && /^TAP version \d+\s*$/i.test(first);
  },

  parse(content: string, sourcePath: string): { results: TestCaseResult[]; warnings: string[] } {
    const results: TestCaseResult[] = [];
    const warnings: string[] = [];
    const body = stripBom(content);
    if (body.trim() === '') {
      warnings.push(`tap: ${sourcePath}: file is empty`);
      return { results, warnings };
    }

    const lines = body.split(/\r?\n/);
    // ancestry of the currently open `# Subtest:` declarations
    const ancestors: Array<{ name: string; children: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      const sub = line.match(/^\s*# Subtest: (.+?)\s*$/);
      if (sub) {
        ancestors.push({ name: sub[1]!, children: 0 });
        continue;
      }

      const assertion = line.match(
        /^\s*(not ok|ok)\s+\d+\s+-\s+(.+?)(?:\s+#\s*([A-Za-z]+)\b(.*))?$/,
      );
      if (assertion) {
        const [, verdict, rawName, directive, directiveText] = assertion;
        const name = rawName!.trim();
        // In node:test TAP, EVERY test's assertion repeats its own `# Subtest:`
        // name (children first, then the parent suite's aggregate). A true
        // suite aggregate carries `type: 'suite'` in its YAML block — pop it
        // without emitting (its children already carry the results); anything
        // else is a leaf: emit, then pop its own declaration.
        let yaml: YamlBlock = { isSuite: false };
        if (lines[i + 1]?.trim() === '---') {
          let j = i + 2;
          const block: string[] = [];
          while (j < lines.length && lines[j]!.trim() !== '...') {
            block.push(lines[j]!);
            j++;
          }
          yaml = parseYamlBlock(block, sourcePath, warnings);
        }
        const ownDeclaration =
          ancestors.length > 0 && ancestors[ancestors.length - 1]!.name === name;
        const isAggregate =
          ownDeclaration && (yaml.isSuite || ancestors[ancestors.length - 1]!.children > 0);
        if (isAggregate) {
          const popped = ancestors.pop()!;
          // the popped suite is itself a child of the next level up
          if (ancestors.length > 0) ancestors[ancestors.length - 1]!.children++;
          continue;
        }
        // suite = ancestors WITHOUT the leaf's own declaration
        const chain = ownDeclaration ? ancestors.slice(0, -1) : ancestors;
        const suite = chain.length > 0 ? chain.map((a) => a.name).join(' > ') : ROOT_SUITE;
        let status: TestStatus = verdict === 'not ok' ? 'fail' : 'pass';
        let message = yaml.error;
        // TAP spec: directives are case-insensitive (# SKIP, # skip, # Skip …)
        const directiveKind = directive?.toUpperCase();
        if (directiveKind === 'SKIP' || directiveKind === 'TODO') {
          status = 'skip';
          const reason = directiveText?.replace(/^\s*-\s*/, '').trim();
          if (reason) message = reason;
        }
        const result: TestCaseResult = {
          testId: makeTestId(suite, name),
          suite,
          name,
          status,
          durationMs: null,
        };
        if (message !== undefined && message !== '')
          result.message = trimTo(message, MESSAGE_MAX_CHARS);
        if (status === 'fail' && yaml.stack !== undefined) {
          result.stack = trimTo(yaml.stack, 1000);
        }
        results.push(result);
        if (ownDeclaration) {
          ancestors.pop();
          // the emitted leaf counts as a child of its PARENT (the new top),
          // not of its own (now-popped) declaration
          if (ancestors.length > 0) ancestors[ancestors.length - 1]!.children++;
        }
      }
      // 'TAP version', plans (1..N), summary comments, diagnostics comments — ignored
    }

    // unterminated Subtest declarations (truncated stream): the deepest
    // pending ancestors never closed — nothing to emit for them, but warn.
    if (ancestors.length > 0) {
      warnings.push(
        `tap: ${sourcePath}: ${ancestors.length} subtest(s) never reported a result (truncated stream?)`,
      );
    }
    return { results, warnings };
  },
};

/** Minimal YAML diagnostics extraction for node:test's blocks (flat keys + `key: |-` scalars). */
function parseYamlBlock(block: string[], sourcePath: string, warnings: string[]): YamlBlock {
  const out: YamlBlock = { isSuite: false };
  try {
    for (let k = 0; k < block.length; k++) {
      const line = block[k]!;
      const errorMatch = line.match(/^\s*error:\s*(.+)$/);
      if (errorMatch && out.error === undefined) {
        out.error = unquote(errorMatch[1]!);
        continue;
      }
      const typeMatch = line.match(/^\s*type:\s*'suite'/);
      if (typeMatch) out.isSuite = true;
      const stackMatch = line.match(/^\s*stack:\s*\|[-+]?\s*$/);
      if (stackMatch) {
        const stackLines: string[] = [];
        let m = k + 1;
        const baseIndent = block[m]?.match(/^\s*/)?.[0].length ?? 0;
        while (
          m < block.length &&
          (block[m]!.trim() === '' || (block[m]!.match(/^\s*/)?.[0].length ?? 0) >= baseIndent)
        ) {
          stackLines.push(block[m]!.slice(baseIndent));
          m++;
        }
        out.stack = stackLines.join('\n').trimEnd();
        k = m - 1;
      }
    }
  } catch (err) {
    warnings.push(`tap: ${sourcePath}: diagnostic block parse skipped (${errorMessage(err)})`);
  }
  return out;
}

function unquote(s: string): string {
  const m = s.match(/^'(.*)'$/);
  return m !== null ? m[1]!.replace(/\\'/g, "'") : s;
}
