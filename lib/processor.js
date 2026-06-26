const sharp = require('sharp');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { queue } = require('fastq');
const clamav = require('node-clamav')();
const db = require('./db');
const cache = require('./cache');
const { logger } = require('./utils');

const PRATIMA_ROOT = '/var/pratima';
const TMP_DIR = path.join(PRATIMA_ROOT, 'tmp');

const workers = {};
const MAX_QUEUE = 500;

function clampQuality(val) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) return 85;
  return Math.max(1, Math.min(100, n));
}

/** Strip path separators, null bytes, and dangerous characters from filenames. */
function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'unknown';
  return path.basename(name).replace(/[^\w.\-]/g, '_').slice(0, 255);
}

/**
 * Scan a buffer with ClamAV. Returns true = clean, false = infected / error.
 * Temp file uses a UUID to prevent race conditions between concurrent scans.
 */
async function scanBuffer(buffer) {
  await fs.ensureDir(TMP_DIR);
  const tempFile = path.join(TMP_DIR, `scan_${uuidv4()}`);
  try {
    await fs.writeFile(tempFile, buffer);
    const result = await clamav.scanFile(tempFile);
    return result.isClean === true;
  } catch (err) {
    logger.error('ClamAV scan error', { message: err.message });
    if (process.env.PRATIMA_CLAMAV_OPTIONAL === '1') {
      logger.warn('ClamAV unavailable — accepting upload (fail-open mode)');
      return true;
    }
    return false;
  } finally {
    await fs.remove(tempFile).catch(() => {});
  }
}

/**
 * Generate a unique, URL-safe image ID.
 * Format: pratima-<3-char prefix>-<14-char timestamp>-<8-char hex>
 */
function generateImageId(tenantName) {
  const prefix = tenantName.substring(0, 3).toLowerCase();
  const ts     = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand   = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `pratima-${prefix}-${ts}-${rand}`;
}

/**
 * Process one image job:
 *  - Auto-rotate from EXIF, convert to WebP, strip all metadata
 *  - Save to disk
 *  - Record in DB with dimensions + custom metadata from the form
 *  - Replace raw buffer in cache with the processed WebP
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

    // Swap raw upload buffer with the final WebP in cache
    cache.set(tenant, imageId, webpBuffer, 'image/webp');

    logger.info('image processed', { tenant, imageId, width, height, bytes: webpBuffer.length });
  } catch (err) {
    logger.error('image processing failed', { tenant, imageId, message: err.message });
    cache.delete(tenant, imageId);
  }
}

/**
 * Enqueue a processing job with per-tenant concurrency control.
 * Returns false if the queue is full (caller should respond 503).
 */
function enqueue(job) {
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
    if (err) logger.error('queue job error', { tenant: t, message: err.message });
  });
  return true;
}

module.exports = { scanBuffer, generateImageId, sanitizeFilename, enqueue };
