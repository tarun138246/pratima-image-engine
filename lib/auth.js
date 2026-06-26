const crypto = require('crypto');
const db = require('./db');
const logger = require('./utils').logger;

const TENANT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

// Constant-time comparison — prevents timing-based token enumeration
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Always compare fixed-length buffers to avoid length leak
  const bufA = Buffer.alloc(64);
  const bufB = Buffer.alloc(64);
  bufA.write(a.slice(0, 64));
  bufB.write(b.slice(0, 64));
  const same = crypto.timingSafeEqual(bufA, bufB);
  return same && a.length === b.length;
}

// Validate origin/referer matches the tenant's registered allowed_origin prefix
function originMatches(req, allowedOrigin) {
  const origin  = (req.headers['origin']  || '').trim();
  const referer = (req.headers['referer'] || '').trim();
  return origin.startsWith(allowedOrigin) || referer.startsWith(allowedOrigin);
}

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * Reject requests with a tenant name that doesn't match the safe pattern.
 * Must be placed before any route that reads req.params.tenant.
 */
function requireValidTenantName(req, res, next) {
  const name = req.params.tenant;
  if (!name || !TENANT_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid tenant name' });
  }
  next();
}

/**
 * Full tenant auth:
 *   1. X-API-Key header must be present and match the tenant's stored token.
 *   2. If the tenant has an allowed_origin set, Origin or Referer must match.
 *
 * Used for write operations (upload) and API calls (stats).
 */
function requireTenantAuth(req, res, next) {
  const tenantName = req.params.tenant;
  const apiKey = (req.headers['x-api-key'] || '').trim();

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-API-Key header' });
  }

  const storedToken = db.getTenantToken(tenantName);
  if (!storedToken || !safeEqual(apiKey, storedToken)) {
    logger.warn('auth: invalid token', { tenant: tenantName, ip: req.socket.remoteAddress });
    return res.status(403).json({ error: 'Invalid API key' });
  }

  const allowedOrigin = db.getTenantOrigin(tenantName);
  if (allowedOrigin && !originMatches(req, allowedOrigin)) {
    const origin  = req.headers['origin']  || '(none)';
    const referer = req.headers['referer'] || '(none)';
    logger.warn('auth: origin mismatch', { tenant: tenantName, origin, referer });
    return res.status(403).json({ error: 'Origin not allowed for this tenant' });
  }

  next();
}

/**
 * Hotlink protection for image serving (GET /image/:tenant/:id).
 *
 * Priority:
 *   1. Valid X-API-Key → pass through (programmatic / server-side access).
 *   2. Tenant has allowed_origin set → Origin or Referer must match.
 *   3. No allowed_origin set → block (force explicit configuration).
 */
function requireAllowedOriginOrKey(req, res, next) {
  const tenantName = req.params.tenant;

  // Allow if a valid API key is present
  const apiKey = (req.headers['x-api-key'] || '').trim();
  if (apiKey) {
    const storedToken = db.getTenantToken(tenantName);
    if (storedToken && safeEqual(apiKey, storedToken)) {
      return next();
    }
    // Key provided but wrong — reject outright instead of falling through to origin check
    logger.warn('auth: bad token on image request', { tenant: tenantName, ip: req.socket.remoteAddress });
    return res.status(403).json({ error: 'Invalid API key' });
  }

  const allowedOrigin = db.getTenantOrigin(tenantName);
  if (!allowedOrigin) {
    return res.status(403).json({ error: 'Tenant has no allowed origin configured — set one with: pratima tenant set-origin' });
  }

  if (!originMatches(req, allowedOrigin)) {
    const origin  = req.headers['origin']  || '(none)';
    const referer = req.headers['referer'] || '(none)';
    logger.warn('auth: hotlink blocked', { tenant: tenantName, origin, referer });
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

/**
 * Admin-only endpoints (doctor, repair, stop, status).
 * Accepts only connections from the loopback interface —
 * req.socket.remoteAddress bypasses trust-proxy so nginx forwarding
 * does NOT allow external IPs to reach admin routes.
 */
function requireLocalhost(req, res, next) {
  const addr = req.socket.remoteAddress;
  if (addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1') {
    return next();
  }
  logger.warn('auth: admin endpoint accessed from non-localhost', { addr });
  return res.status(403).json({ error: 'Admin endpoints are accessible from localhost only' });
}

module.exports = {
  requireValidTenantName,
  requireTenantAuth,
  requireAllowedOriginOrKey,
  requireLocalhost,
  safeEqual
};
