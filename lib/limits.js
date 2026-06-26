const { RateLimiterMemory } = require('rate-limiter-flexible');

const limiters = new Map();

function clamp(val, min, max) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function getRateLimiter(tenantName) {
  if (!limiters.has(tenantName)) {
    const tenantLimits = require('./tenant').getLimits(tenantName);
    const points = clamp(tenantLimits.maxImgPerMin, 1, 10000) || 200;
    limiters.set(tenantName, new RateLimiterMemory({ points, duration: 60 }));
  }
  return limiters.get(tenantName);
}

/**
 * Returns true if the request is within rate limit, false if exceeded.
 * Uses rate-limiter-flexible's async consume() API.
 */
async function checkLimit(tenantName, key) {
  const limiter = getRateLimiter(tenantName);
  try {
    await limiter.consume(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove a tenant's limiter so it gets recreated with fresh config
 * after a limits update.
 */
function invalidateLimiter(tenantName) {
  limiters.delete(tenantName);
}

module.exports = { getRateLimiter, checkLimit, invalidateLimiter };
