import assert from 'node:assert';
import { describe, test } from 'node:test';

describe('math', () => {
  test('adds numbers', () => {
    assert.equal(1 + 1, 2);
  });
  test('subtracts badly', () => {
    assert.equal(1 - 1, 2, 'subtraction is broken');
  });
  describe('inner', () => {
    test('nested multiply', () => {
      assert.equal(2 * 3, 6);
    });
    test('skipped one', { skip: 'not ready yet' }, () => {});
  });
});
test('root level pass', () => {});
test('todo probe', { todo: true }, () => {
  assert.equal(1, 2);
});
