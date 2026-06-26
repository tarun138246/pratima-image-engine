const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const db = require('./db');
const logger = require('./utils').logger;

const PRATIMA_ROOT = '/var/pratima';
const TENANT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex token
}

/**
 * Create a new tenant directory structure, a DB record, and a fresh API token.
 * Returns the generated token so the CLI can display it once.
 */
function create(name) {
  if (!TENANT_NAME_RE.test(name)) {
    throw new Error('Tenant name must be alphanumeric with underscores or dashes only');
  }
  const tenantDir = path.join(PRATIMA_ROOT, 'tenants', name);
  if (fs.existsSync(tenantDir)) {
    throw new Error(`Tenant "${name}" already exists`);
  }
  fs.ensureDirSync(path.join(tenantDir, 'images'));
  fs.ensureDirSync(path.join(tenantDir, 'metadata'));
  fs.ensureDirSync(path.join(tenantDir, 'temp'));

  const token = generateToken();
  db.createTenant(name, token);
  logger.info('tenant created', { tenant: name });
  return token;
}

function remove(name) {
  const tenantDir = path.join(PRATIMA_ROOT, 'tenants', name);
  if (!fs.existsSync(tenantDir)) {
    throw new Error(`Tenant "${name}" does not exist`);
  }
  db.removeTenant(name);
  fs.removeSync(tenantDir);
  logger.info('tenant removed', { tenant: name });
}

function exists(name) {
  if (!TENANT_NAME_RE.test(name)) return false;
  return fs.existsSync(path.join(PRATIMA_ROOT, 'tenants', name));
}

function list() {
  return db.listAllTenants();
}

function getLimits(name) {
  return db.getTenantLimits(name) || {};
}

function setLimits(name, limits) {
  db.setTenantLimits(name, limits);
}

function getToken(name) {
  return db.getTenantToken(name);
}

/**
 * Regenerate the API token for a tenant.
 * Old token is immediately invalidated.
 */
function regenerateToken(name) {
  if (!exists(name)) throw new Error(`Tenant "${name}" does not exist`);
  const token = generateToken();
  db.setTenantToken(name, token);
  logger.info('tenant token regenerated', { tenant: name });
  return token;
}

function setOrigin(name, origin) {
  if (!exists(name)) throw new Error(`Tenant "${name}" does not exist`);
  // Normalize — strip trailing slash
  const normalized = origin.replace(/\/+$/, '');
  db.setTenantOrigin(name, normalized);
  logger.info('tenant origin updated', { tenant: name, origin: normalized });
}

function getOrigin(name) {
  return db.getTenantOrigin(name);
}

module.exports = {
  create,
  remove,
  exists,
  list,
  getLimits,
  setLimits,
  getToken,
  regenerateToken,
  setOrigin,
  getOrigin
};
