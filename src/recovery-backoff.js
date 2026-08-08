function calculateExponentialBackoff(attempt, baseMs, maxMs) {
  const safeAttempt = Math.max(1, Math.floor(Number(attempt) || 1));
  const safeBaseMs = Math.max(1, Number(baseMs) || 1);
  const safeMaxMs = Math.max(safeBaseMs, Number(maxMs) || safeBaseMs);
  const exponent = Math.min(safeAttempt - 1, 30);
  return Math.min(safeBaseMs * 2 ** exponent, safeMaxMs);
}

module.exports = {
  calculateExponentialBackoff,
};
