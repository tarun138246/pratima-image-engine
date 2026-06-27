const sharp = require('sharp');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const { Readable } = require('stream');
const queue = require('fastq');
const NodeClam = require('clamscan');
const db = require('./db');
const cache = require('./cache');
const { logger } = require('./utils');
const config = require('./config');

const PRATIMA_ROOT = '/var/pratima';

const workers = {};
const MAX_QUEUE = 500;

// ── ClamAV — lazy-initialised singleton ───────────────────────────────────
let _scannerPromise = null;

function getScanner() {
  if (!_scannerPromise) {
    _scannerPromise = new NodeClam().init({
      preference: 'clamdscan',
      clamdscan: {
        socket:  config.get('clamavSocket') || '/var/run/clamav/clamd.ctl',
        host:    config.get('clamavHost')   || null,
        port:    config.get('clamavPort')   || null,
        active:  true,
        timeout: 60000
      }
    }).catch((err) => {
      _scannerPromise = null;
      throw err;
    });
  }
  return _scannerPromise;
}

function clampQuality(val) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return 85;
  return Math.max(1, Math.min(100, n));
}

/** Strip path separators and dangerous characters from user-supplied filenames. */
function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'unknown';
  return path.basename(name).replace(/[^\w.\-]/g, '_').slice(0, 255);
}

/**
 * Scan a buffer with ClamAV using scanStream.
 * Returns true  = clean.
 * Returns false = infected, or scanner unavailable (fail-closed by default).
 */
async function scanBuffer(buffer) {
  try {
    const scanner = await getScanner();
    const stream = Readable.from(buffer);
    const { isInfected } = await scanner.scanStream(stream);
    return isInfected === false;
  } catch (err) {
    logger.error('ClamAV scan error', { message: err.message });
    if (process.env.PRATIMA_CLAMAV_OPTIONAL === '1') {
      logger.warn('ClamAV unavailable — accepting upload (fail-open mode enabled)');
      return true;
    }
    return false;
  }
}

/**
 * Generate a unique, URL-safe image ID in the new format:
 *   pratima_<first-4-letters-of-tenant>_<first-4-letters-of-original-name>[_<random>]
 *
 * If the base ID would collide, a short random hex suffix is appended.
 */
function generateImageId(tenantName, originalName) {
  const tenantPrefix = tenantName.substring(0, 4).toLowerCase();
  // Get first 4 alphanumeric characters from the sanitised original name
  const sanitized = sanitizeFilename(originalName || 'img').toLowerCase();
  const imgPart = sanitized.replace(/[^a-z0-9]/g, '').slice(0, 4) || 'img0';

  let base = `pratima_${tenantPrefix}_${imgPart}`;
  let candidate = base;
  let attempts = 0;
  // Ensure uniqueness within the tenant (DB check)
  while (db.getImageRecord(candidate, tenantName)) {
    attempts++;
    // After a few attempts, add a 2‑byte random hex to guarantee uniqueness
    const suffix = crypto.randomBytes(2).toString('hex');
    candidate = `${base}_${suffix}`;
    if (attempts > 5) {
      // Fallback to fully random if somehow still colliding
      const rand = crypto.randomBytes(4).toString('hex');
      candidate = `pratima_${tenantPrefix}_${rand}`;
      break;
    }
  }
  return candidate;
}

/**
 * Process one image job:
 *  - Auto-rotate from EXIF, convert to WebP, strip all metadata
 *  - Save to disk
 *  - Record in DB with dimensions + custom metadata
 *  - Does NOT add to RAM cache (cache is only populated on request)
 */
async function processImage(job) {
  const { tenant, imageId, buffer, originalName, mimetype, limits, meta } = job;

  try {
    const quality = clampQuality(limits.compressionQuality ?? 85);

    const sharpInstance = sharp(buffer).rotate(); // honour EXIF orientation first
    const { width, height } = await sharpInstance.clone().metadata();

    const webpBuffer = await sharpInstance
      .webp({ quality, lossless: false })
      .toBuffer();

    const imagesDir = path.join(PRATIMA_ROOT, 'tenants', tenant, 'images');
    await fs.ensureDir(imagesDir);
    await fs.writeFile(path.join(imagesDir, `${imageId}.webp`), webpBuffer);

    db.insertImage({
      id:           imageId,
      tenant,
      originalName: sanitizeFilename(originalName),
      alt:          meta?.alt   ?? null,
      title:        meta?.title ?? null,
      size:         webpBuffer.length,
      mimeType:     'image/webp',
      width:        width  ?? null,
      height:       height ?? null,
      createdAt:    new Date().toISOString(),
      lastAccessed: new Date().toISOString()
    });

    db.incrementImageCount(tenant);
    db.addStorageUsed(tenant, webpBuffer.length);

    // Intentionally NOT calling cache.set() – the image will be cached
    // only when it is actually served via GET /image

    logger.info('image processed', { tenant, imageId, width, height, bytes: webpBuffer.length });
  } catch (err) {
    logger.error('image processing failed', { tenant, imageId, message: err.message });
    // Clean up any half‑written file
    const filePath = path.join(PRATIMA_ROOT, 'tenants', tenant, 'images', `${imageId}.webp`);
    await fs.remove(filePath).catch(() => {});
    throw err; // Reject the job so the caller knows
  }
}

/**
 * Enqueue a processing job with per‑tenant concurrency control.
 * Accepts an optional callback that is called on completion (err or void).
 * Returns true if the job was accepted, false if the queue is full.
 */
function enqueue(job, callback) {
  const t = job.tenant;
  if (!workers[t]) {
    const concurrency = Math.max(1, Math.min(20, parseInt(job.limits.maxConcurrentProcessing, 10) || 3));
    workers[t] = queue(processImage, concurrency);
  }
  if (workers[t].length() >= MAX_QUEUE) {
    logger.warn('processing queue full — dropping job', { tenant: t, imageId: job.imageId });
    return false;
  }
  workers[t].push(job, (err) => {
    if (err) {
      logger.error('queue job error', { tenant: t, message: err.message });
    }
    if (callback) callback(err);
  });
  return true;
}

module.exports = { scanBuffer, generateImageId, sanitizeFilename, enqueue };