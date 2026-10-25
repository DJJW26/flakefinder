// One deterministic always-failing test.
test('always-fail fails deterministically', () => {
  throw new Error('deterministic failure (fixture)');
});
