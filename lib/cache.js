const config = require('./config');
const logger = require('./utils').logger;

const store = new Map();
const MAX_RAM_MB = config.get('maxRamMB') || 4096;
let currentRamMB = 0;

function set(tenant, imageId, buffer, mimetype) {
  const sizeMB = buffer.length / (1024 * 1024);
  if (currentRamMB + sizeMB > MAX_RAM_MB) {
    evict(tenant, sizeMB);
  }
  if (!store.has(tenant)) {
    store.set(tenant, new Map());
  }
  const tenantMap = store.get(tenant);
  const tenantLimits = require('./tenant').getLimits(tenant);
  const maxRam = tenantLimits.maxRamUseMB || 2048;
  let used = getTenantRamUsage(tenant);
  if (used + sizeMB > maxRam) {
    evictFromTenant(tenant, sizeMB);
  }
  tenantMap.set(imageId, {
    buffer,
    mimetype,
    hits: 0,
    lastAccess: Date.now(),
    sizeMB
  });
  currentRamMB += sizeMB;
}

function get(tenant, imageId) {
  const tenantMap = store.get(tenant);
  if (!tenantMap) return null;
  const entry = tenantMap.get(imageId);
  if (entry) {
    entry.hits++;
    entry.lastAccess = Date.now();
    return entry;
  }
  return null;
}

function del(tenant, imageId) {
  const tenantMap = store.get(tenant);
  if (tenantMap && tenantMap.has(imageId)) {
    const entry = tenantMap.get(imageId);
    currentRamMB -= entry.sizeMB;
    tenantMap.delete(imageId);
    if (tenantMap.size === 0) store.delete(tenant);
    return true;
  }
  return false;
}

function evict(tenant, neededMB) {
  let freed = 0;
  const allEntries = [];
  for (const [t, tMap] of store) {
    for (const [id, entry] of tMap) {
      const ageMinutes = (Date.now() - entry.lastAccess) / 60000;
      const score = entry.hits / (ageMinutes + 1);
      allEntries.push({ tenant: t, id, entry, score });
    }
  }
  allEntries.sort((a, b) => a.score - b.score);
  for (const item of allEntries) {
    if (freed >= neededMB) break;
    const size = item.entry.sizeMB;
    del(item.tenant, item.id);
    freed += size;
  }
  if (freed < neededMB) {
    logger.warn(`Could not free enough cache (needed ${neededMB}MB, freed ${freed}MB)`);
  }
}

function evictFromTenant(tenant, neededMB) {
  const tMap = store.get(tenant);
  if (!tMap) return;
  const entries = [];
  for (const [id, entry] of tMap) {
    const ageMinutes = (Date.now() - entry.lastAccess) / 60000;
    const score = entry.hits / (ageMinutes + 1);
    entries.push({ id, entry, score });
  }
  entries.sort((a, b) => a.score - b.score);
  let freed = 0;
  for (const item of entries) {
    if (freed >= neededMB) break;
    const size = item.entry.sizeMB;
    del(tenant, item.id);
    freed += size;
  }
}

function getTenantRamUsage(tenant) {
  const tMap = store.get(tenant);
  if (!tMap) return 0;
  let total = 0;
  for (const entry of tMap.values()) {
    total += entry.sizeMB;
  }
  return total;
}

function getStats() {
  const stats = {
    totalItems: 0,
    totalMB: currentRamMB,
    maxMB: MAX_RAM_MB,
    tenants: {}
  };
  for (const [tenant, tMap] of store) {
    stats.tenants[tenant] = {
      count: tMap.size,
      mb: getTenantRamUsage(tenant)
    };
    stats.totalItems += tMap.size;
  }
  return stats;
}

module.exports = {
  set,
  get,
  delete: del,
  promote: (tenant, id) => {},
  getStats,
  evict,
  evictFromTenant,
  getTenantRamUsage
};