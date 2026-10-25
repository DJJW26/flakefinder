import assert from 'node:assert';
import { test } from 'node:test';

test('failing parent', async (t) => {
  await t.test('inner fail', () => {
    assert.equal(1, 2, 'boom');
  });
});
test('passing parent', async (t) => {
  await t.test('inner ok', () => {
    assert.ok(true);
  });
});
