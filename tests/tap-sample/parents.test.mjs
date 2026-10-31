import { before, describe, it, test } from 'node:test';

test('it\'s quoted "double"', () => {
  throw new Error('it\'s broken: "x"');
});
test('parent throws after passing child', async (t) => {
  await t.test('child ok', () => {});
  throw new Error('parent own failure');
});
describe('suite with failing before', () => {
  before(() => {
    throw new Error('before hook failed');
  });
  it('child a', () => {});
});
