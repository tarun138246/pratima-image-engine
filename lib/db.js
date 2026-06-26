const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs-extra');

const DB_PATH = '/var/pratima/cache/ram-index.db';

fs.ensureDirSync(path.dirname(DB_PATH));
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
    name           TEXT PRIMARY KEY,
    limits         TEXT NOT NULL DEFAULT '{}',
    api_token      TEXT,
    allowed_origin TEXT,
    created_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id            TEXT PRIMARY KEY,
    tenant        TEXT NOT NULL,
    original_name TEXT,
    alt           TEXT,
    title         TEXT,
    size          INTEGER,
    mime_type     TEXT,
    width         INTEGER,
    height        INTEGER,
    created_at    TEXT,
    last_accessed TEXT,
    FOREIGN KEY (tenant) REFERENCES tenants(name) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_images_tenant      ON images(tenant);
  CREATE INDEX IF NOT EXISTS idx_images_created_at  ON images(tenant, created_at DESC);

  CREATE TABLE IF NOT EXISTS stats (
    tenant          TEXT PRIMARY KEY,
    image_count     INTEGER NOT NULL DEFAULT 0,
    storage_used_mb REAL    NOT NULL DEFAULT 0,
    bandwidth_mb    REAL    NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant) REFERENCES tenants(name) ON DELETE CASCADE
  );
`);

// ── Schema migrations for existing databases ───────────────────────────────
(function migrate() {
  const tenantCols = db.pragma('table_info(tenants)').map(c => c.name);
  if (!tenantCols.includes('api_token'))     db.exec('ALTER TABLE tenants ADD COLUMN api_token TEXT');
  if (!tenantCols.includes('allowed_origin')) db.exec('ALTER TABLE tenants ADD COLUMN allowed_origin TEXT');

  const imgCols = db.pragma('table_info(images)').map(c => c.name);
  if (!imgCols.includes('alt'))       db.exec('ALTER TABLE images ADD COLUMN alt TEXT');
  if (!imgCols.includes('title'))     db.exec('ALTER TABLE images ADD COLUMN title TEXT');
  if (!imgCols.includes('mime_type')) db.exec('ALTER TABLE images ADD COLUMN mime_type TEXT');
  if (!imgCols.includes('width'))     db.exec('ALTER TABLE images ADD COLUMN width INTEGER');
  if (!imgCols.includes('height'))    db.exec('ALTER TABLE images ADD COLUMN height INTEGER');
})();

// ── Prepared statements ────────────────────────────────────────────────────

const stmtInsertTenant  = db.prepare('INSERT OR REPLACE INTO tenants (name, limits, api_token, allowed_origin, created_at) VALUES (?, ?, ?, ?, ?)');
const stmtDeleteTenant  = db.prepare('DELETE FROM tenants WHERE name = ?');
const stmtGetTenant     = db.prepare('SELECT * FROM tenants WHERE name = ?');
const stmtGetByToken    = db.prepare('SELECT * FROM tenants WHERE api_token = ?');
const stmtListTenants   = db.prepare('SELECT name FROM tenants');
const stmtUpdateToken   = db.prepare('UPDATE tenants SET api_token = ? WHERE name = ?');
const stmtUpdateOrigin  = db.prepare('UPDATE tenants SET allowed_origin = ? WHERE name = ?');
const stmtUpdateLimits  = db.prepare('UPDATE tenants SET limits = ? WHERE name = ?');

const stmtInsertImage = db.prepare(`
  INSERT INTO images
    (id, tenant, original_name, alt, title, size, mime_type, width, height, created_at, last_accessed)
  VALUES
    (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtGetImage         = db.prepare('SELECT * FROM images WHERE id = ? AND tenant = ?');
const stmtGetImageById     = db.prepare('SELECT * FROM images WHERE id = ?');
const stmtDeleteImage      = db.prepare('DELETE FROM images WHERE id = ? AND tenant = ?');
const stmtCountForTenant   = db.prepare('SELECT COUNT(*) AS count FROM images WHERE tenant = ?');
const stmtCountAll         = db.prepare('SELECT COUNT(*) AS count FROM images');
const stmtListImages       = db.prepare('SELECT id, tenant FROM images');
const stmtUpdateLastAccess = db.prepare('UPDATE images SET last_accessed = ? WHERE id = ?');

const stmtUpsertStats = db.prepare(`
  INSERT INTO stats (tenant, image_count, storage_used_mb, bandwidth_mb)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(tenant) DO UPDATE SET
    image_count     = excluded.image_count,
    storage_used_mb = excluded.storage_used_mb,
    bandwidth_mb    = excluded.bandwidth_mb
`);
const stmtGetStats = db.prepare('SELECT * FROM stats WHERE tenant = ?');

// ── Tenant ─────────────────────────────────────────────────────────────────

function createTenant(name, token) {
  const now = new Date().toISOString();
  stmtInsertTenant.run(name, '{}', token || null, null, now);
  stmtUpsertStats.run(name, 0, 0, 0);
}

function removeTenant(name) {
  stmtDeleteTenant.run(name);
}

function getTenantRow(name)    { return stmtGetTenant.get(name); }
function listAllTenants()      { return stmtListTenants.all().map(r => r.name); }

function getTenantLimits(name) {
  const row = stmtGetTenant.get(name);
  if (!row) return null;
  try { return JSON.parse(row.limits); } catch { return {}; }
}

function setTenantLimits(name, limitsObj) {
  const row = stmtGetTenant.get(name);
  if (!row) return;
  let current = {};
  try { current = JSON.parse(row.limits); } catch { /* */ }
  stmtUpdateLimits.run(JSON.stringify({ ...current, ...limitsObj }), name);
}

// ── Token ──────────────────────────────────────────────────────────────────

function getTenantToken(name)    { return stmtGetTenant.get(name)?.api_token ?? null; }
function setTenantToken(name, t) { stmtUpdateToken.run(t, name); }
function getTenantByToken(token) { return stmtGetByToken.get(token)?.name ?? null; }

// ── Origin ─────────────────────────────────────────────────────────────────

function getTenantOrigin(name)        { return stmtGetTenant.get(name)?.allowed_origin ?? null; }
function setTenantOrigin(name, origin){ stmtUpdateOrigin.run(origin, name); }

// ── Images ─────────────────────────────────────────────────────────────────

function insertImageRecord(meta) {
  stmtInsertImage.run(
    meta.id,
    meta.tenant,
    meta.originalName ?? null,
    meta.alt          ?? null,
    meta.title        ?? null,
    meta.size         ?? null,
    meta.mimeType     ?? 'image/webp',
    meta.width        ?? null,
    meta.height       ?? null,
    meta.createdAt,
    meta.lastAccessed
  );
}

function getImageRecord(id, tenant) {
  return tenant ? stmtGetImage.get(id, tenant) : stmtGetImageById.get(id);
}

/**
 * List images for a tenant with pagination.
 * Returns { images, total, page, limit }.
 */
function listImages({ tenant, page = 1, limit = 20 }) {
  const safeLimit = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
  const safePage  = Math.max(1, parseInt(page, 10) || 1);
  const offset    = (safePage - 1) * safeLimit;

  const total = db.prepare('SELECT COUNT(*) AS count FROM images WHERE tenant = ?')
    .get(tenant)?.count ?? 0;

  const rows = db.prepare(
    `SELECT id, tenant, original_name, alt, title, size, mime_type, width, height, created_at, last_accessed
     FROM images
     WHERE tenant = ?
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).all(tenant, safeLimit, offset);

  return { images: rows, total, page: safePage, limit: safeLimit };
}

function deleteImageById(id, tenant) {
  const info = stmtDeleteImage.run(id, tenant);
  return info.changes > 0;
}

function touchLastAccessed(id) {
  stmtUpdateLastAccess.run(new Date().toISOString(), id);
}

function countImages(tenant) {
  if (tenant) return stmtCountForTenant.get(tenant)?.count ?? 0;
  return stmtCountAll.get()?.count ?? 0;
}

function getStorageUsed(tenant) {
  return stmtGetStats.get(tenant)?.storage_used_mb ?? 0;
}

function addStorageUsed(tenant, bytes) {
  const mb  = bytes / (1024 * 1024);
  const row = stmtGetStats.get(tenant);
  stmtUpsertStats.run(tenant, row?.image_count ?? 0, (row?.storage_used_mb ?? 0) + mb, row?.bandwidth_mb ?? 0);
}

function subtractStorageUsed(tenant, bytes) {
  const mb  = bytes / (1024 * 1024);
  const row = stmtGetStats.get(tenant);
  const current = row?.storage_used_mb ?? 0;
  stmtUpsertStats.run(tenant, row?.image_count ?? 0, Math.max(0, current - mb), row?.bandwidth_mb ?? 0);
}

function incrementImageCount(tenant) {
  const row = stmtGetStats.get(tenant);
  stmtUpsertStats.run(tenant, (row?.image_count ?? 0) + 1, row?.storage_used_mb ?? 0, row?.bandwidth_mb ?? 0);
}

function decrementImageCount(tenant) {
  const row = stmtGetStats.get(tenant);
  stmtUpsertStats.run(tenant, Math.max(0, (row?.image_count ?? 1) - 1), row?.storage_used_mb ?? 0, row?.bandwidth_mb ?? 0);
}

function getTenantStats(tenant) {
  return stmtGetStats.get(tenant) ?? null;
}

// ── Integrity ──────────────────────────────────────────────────────────────

function checkIntegrity() {
  const images = stmtListImages.all();
  const issues = [];
  for (const img of images) {
    const filePath = path.join('/var/pratima/tenants', img.tenant, 'images', `${img.id}.webp`);
    if (!fs.existsSync(filePath)) {
      issues.push(`Missing file for image ${img.id} in tenant ${img.tenant}`);
    }
  }
  return issues;
}

function repair() {
  const images = stmtListImages.all();
  let removed = 0;
  for (const img of images) {
    const filePath = path.join('/var/pratima/tenants', img.tenant, 'images', `${img.id}.webp`);
    if (!fs.existsSync(filePath)) {
      stmtDeleteImage.run(img.id, img.tenant);
      removed++;
    }
  }
  return { removed };
}

module.exports = {
  createTenant, removeTenant, getTenantRow, getTenantLimits, setTenantLimits, listAllTenants,
  getTenantToken, setTenantToken, getTenantByToken,
  getTenantOrigin, setTenantOrigin,
  insertImage: insertImageRecord,
  getImageRecord,
  listImages,
  deleteImageById,
  touchLastAccessed,
  countImages, getStorageUsed, addStorageUsed, subtractStorageUsed,
  incrementImageCount, decrementImageCount,
  getTenantStats, checkIntegrity, repair
};
