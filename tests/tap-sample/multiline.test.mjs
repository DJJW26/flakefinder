import assert from 'node:assert';
import { test } from 'node:test';

test('strict equal objects', () => {
  assert.strictEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] });
});
test('deep strict equal', () => {
  assert.deepStrictEqual({ name: 'flake', tries: 3 }, { name: 'flake', tries: 4 });
});
test('strict equal strings', () => {
  assert.strictEqual('line one\nline two\nline three', 'line one\nline 2\nline three');
});
test('passes # with hash and back\\slash', () => {});
test('slow pass', async () => {
  await new Promise((r) => setTimeout(r, 25));
});
