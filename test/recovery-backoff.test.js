const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateExponentialBackoff } = require('../src/recovery-backoff');

test('uses exponential recovery delays and caps at the configured maximum', () => {
  const minute = 60_000;
  const maximum = 30 * minute;

  assert.equal(calculateExponentialBackoff(1, minute, maximum), minute);
  assert.equal(calculateExponentialBackoff(2, minute, maximum), 2 * minute);
  assert.equal(calculateExponentialBackoff(3, minute, maximum), 4 * minute);
  assert.equal(calculateExponentialBackoff(5, minute, maximum), 16 * minute);
  assert.equal(calculateExponentialBackoff(6, minute, maximum), maximum);
  assert.equal(calculateExponentialBackoff(20, minute, maximum), maximum);
});

test('normalizes invalid attempt and maximum values', () => {
  assert.equal(calculateExponentialBackoff(0, 1000, 500), 1000);
  assert.equal(calculateExponentialBackoff(Number.NaN, 1000, 10_000), 1000);
});
