function buildLoginErrorMessage(err, reason = '') {
  return `${err?.message || ''} ${reason}`;
}

function isCredentialLoginError(err, reason = '') {
  const message = buildLoginErrorMessage(err, reason);
  return Number(err?.eresult) === 15 || /AccessDenied/i.test(message);
}

function isRateLimitLoginError(err, reason = '') {
  const message = buildLoginErrorMessage(err, reason);
  return Number(err?.eresult) === 84 || /RateLimitExceeded/i.test(message);
}

function isConnectionLoginError(err, reason = '') {
  const message = buildLoginErrorMessage(err, reason);
  return /NoConnection|ServiceUnavailable|Request timed out|login-timeout|timed?\s*out|ECONN|ENET|EHOST|socket|network|WebSocket/i.test(
    message
  );
}

module.exports = {
  isConnectionLoginError,
  isCredentialLoginError,
  isRateLimitLoginError,
};
