// A slow-but-stable test (~120 ms, comfortably over the fixture's 50 ms
// slowThresholdMs) so the `slow` tag has something to tag. Atomics.wait
// instead of timers: no fake-timer interference, works on the main thread
// in Node.
test('slow pass takes about 120ms', () => {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, 120);
  expect(ia[0]).toBe(0);
});
