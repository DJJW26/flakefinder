// Deterministic flake: a counter FILE drives the parity protocol, so e2e
// results never depend on timing or randomness.
//
//   run 1 → counter 1 (odd)  → FAIL
//   run 2 → counter 2 (even) → PASS
//   run 3 → counter 3 (odd)  → FAIL   … and so on
const fs = require('node:fs');
const path = require('node:path');

const COUNTER = path.join(process.cwd(), 'counter.txt');

function bumpCounter() {
  let n = 0;
  try {
    n = Number.parseInt(fs.readFileSync(COUNTER, 'utf8').trim(), 10);
  } catch {
    n = 0; // missing file → 0
  }
  if (!Number.isFinite(n)) n = 0;
  n += 1;
  fs.writeFileSync(COUNTER, String(n), 'utf8');
  return n;
}

test('flaky-counter fails on odd counts', () => {
  const n = bumpCounter();
  if (n % 2 !== 0) throw new Error(`flaky-counter saw odd count ${n}`);
});
