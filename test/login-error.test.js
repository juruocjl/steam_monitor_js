const assert = require('node:assert/strict');
const test = require('node:test');
const {
  isConnectionLoginError,
  isCredentialLoginError,
  isRateLimitLoginError,
} = require('../src/login-error');

test('classifies rate limiting as recoverable cooldown rather than credential failure', () => {
  assert.equal(isRateLimitLoginError({ message: 'RateLimitExceeded' }), true);
  assert.equal(isRateLimitLoginError({ eresult: 84 }), true);
  assert.equal(isCredentialLoginError({ message: 'RateLimitExceeded' }), false);
  assert.equal(isCredentialLoginError({ eresult: 84 }), false);
});

test('keeps invalid credentials separate from transient failures', () => {
  assert.equal(isCredentialLoginError({ message: 'AccessDenied' }), true);
  assert.equal(isCredentialLoginError({ eresult: 15 }), true);
  assert.equal(isRateLimitLoginError({ message: 'AccessDenied' }), false);
});

test('recognizes Steam connection failures', () => {
  assert.equal(isConnectionLoginError({ message: 'NoConnection' }), true);
  assert.equal(isConnectionLoginError(null, 'login-timeout-reset'), true);
  assert.equal(isConnectionLoginError({ message: 'RateLimitExceeded' }), false);
});
