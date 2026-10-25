// Two deterministic always-passing tests.
test('stable pass one', () => {
  expect(1 + 1).toBe(2);
});

test('stable pass two', () => {
  expect('flake'.toUpperCase()).toBe('FLAKE');
});
