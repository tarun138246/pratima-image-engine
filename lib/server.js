const http    = require('http');
const https   = require('https');
const express = require('express');
const helmet  = require('helmet');
const cors    = require('cors');
const multer  = require('multer');
const rateLimit = require('express-rate-limit');
const path    = require('path');
const fs      = require('fs-extra');
const FileType = require('file-type');

const cache     = require('./cache');
const db        = require('./db');
const tenant    = require('./tenant');
const processor = require('./processor');
const limits    = require('./limits');
const config    = require('./config');
const auth      = require('./auth');
const { logger } = require('./utils');

// ── Constants ──────────────────────────────────────────────────────────────

const PRATIMA_ROOT = '/var/pratima';

const HTTP_PORT  = parseInt(process.env.PRATIMA_PORT, 10)       || 3001;
const HTTP_HOST  = process.env.PRATIMA_HOST                     || '127.0.0.1';
const HTTPS_PORT = parseInt(process.env.PRATIMA_HTTPS_PORT, 10) || 3443;
const HTTPS_HOST = process.env.PRATIMA_HTTPS_HOST               || '0.0.0.0';
const TLS_CERT   = process.env.PRATIMA_TLS_CERT;
const TLS_KEY    = process.env.PRATIMA_TLS_KEY;

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_UPLOAD_BYTES   = (config.get('maxUploadSizeMB') || 10) * 1024 * 1024;

// Allowed text-field names that can come alongside the image in multipart
const ALLOWED_TEXT_FIELDS = new Set(['alt', 'title', 'imageId']);
const MAX_TEXT_FIELD_BYTES = 1024; // 1 KB per text field

// Custom image ID: letters, numbers, hyphens, underscores — 1 to 128 chars
const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

// ── App ────────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1); // trust first proxy (nginx)

// ── Security headers ───────────────────────────────────────────────────────

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // allow <img> from other origins
  contentSecurityPolicy: false
}));

// ── CORS ───────────────────────────────────────────────────────────────────
// Transport-level CORS reflects the request origin.
// Per-tenant origin enforcement happens inside auth middleware.
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization'],
  exposedHeaders: ['X-RateLimit-Remaining', 'X-Image-Id'],
  credentials: false,
  maxAge: 86400
}));

// ── Body parsing ───────────────────────────────────────────────────────────
// Only for non-multipart routes; multer handles multipart uploads.
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));

// ── Global rate limiter ────────────────────────────────────────────────────

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('global rate limit exceeded', { ip: req.ip });
    res.status(429).json({ error: 'Too many requests — try again shortly' });
  }
}));

// ── Request timeout ────────────────────────────────────────────────────────

app.use((req, res, next) => {
  res.setTimeout(30_000, () => {
    logger.warn('request timeout', { method: req.method, url: req.originalUrl });
    if (!res.headersSent) res.status(408).json({ error: 'Request timeout' });
  });
  next();
});

// ── Multer ─────────────────────────────────────────────────────────────────
//
// Accepts multipart/form-data with:
//   File fields  : "image" OR "file"   (1 file max)
//   Text fields  : alt, title, tags, folder  (optional metadata)
//
// The frontend can use either field name for the image binary:
//   formData.append('image', file)   ← preferred
//   formData.append('file', file)    ← also accepted
//
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize:   MAX_UPLOAD_BYTES,
    files:      1,                     // never accept more than 1 file at once
    fields:     ALLOWED_TEXT_FIELDS.size + 2, // text fields + possible extra
    fieldSize:  MAX_TEXT_FIELD_BYTES
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(Object.assign(
        new Error(`Unsupported file type "${file.mimetype}". Allowed: JPEG, PNG, WebP, GIF`),
        { code: 'INVALID_MIME', status: 415 }
      ));
    }
  }
}).fields([
  { name: 'image', maxCount: 1 }, // primary field name
  { name: 'file',  maxCount: 1 }  // alternative field name
]);

// Promisify multer so we can use try/catch in async route handlers
function runMulter(req, res) {
  return new Promise((resolve, reject) => {
    upload(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ── Metadata helpers ───────────────────────────────────────────────────────

/** Pull the uploaded file from req.files regardless of field name used. */
function extractUploadedFile(req) {
  return req.files?.image?.[0] ?? req.files?.file?.[0] ?? null;
}

/** Sanitize and extract optional text metadata from the form body. */
function extractMeta(body = {}) {
  const clean = (v, max) =>
    typeof v === 'string' ? v.trim().slice(0, max) || null : null;
  return {
    alt:   clean(body.alt,   500),
    title: clean(body.title, 255)
  };
}

/** Build the full image URL from the current request host. */
function buildImageUrl(req, tenantName, imageId) {
  const proto = req.get('X-Forwarded-Proto') || req.protocol;
  const host  = req.get('X-Forwarded-Host')  || req.get('host');
  return `${proto}://${host}/image/${tenantName}/${imageId}`;
}

/** Verify file magic bytes match the declared MIME type. */
async function verifyMagicBytes(buffer, declaredMime) {
  try {
    const detected = await FileType.fromBuffer(buffer);
    if (!detected) return false;
    if (detected.mime === 'image/jpeg' && declaredMime === 'image/jpeg') return true;
    return detected.mime === declaredMime;
  } catch {
    return false;
  }
}

// ── Reusable middleware chains ─────────────────────────────────────────────

function tenantGuard(req, res, next) {
  if (!tenant.exists(req.params.tenant)) {
    return res.status(404).json({ error: 'Tenant not found' });
  }
  next();
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /status  — admin only (localhost)
app.get('/status', auth.requireLocalhost, (_req, res) => {
  res.json({
    engine:      'running',
    version:     require('../package.json').version,
    uptime:      process.uptime(),
    tenants:     tenant.list(),
    totalImages: db.countImages(),
    memory:      process.memoryUsage(),
    cache:       cache.getStats()
  });
});

// ── POST /upload/:tenant ───────────────────────────────────────────────────
//
// Accepts: multipart/form-data
//
// Required fields:
//   image  (or "file")  — the image binary
//   Header X-API-Key    — tenant API token
//
// Optional form fields:
//   imageId — custom image ID (letters/numbers/hyphens/underscores, max 128 chars)
//             if omitted, Pratima auto-generates one
//   alt     — alt text (max 500 chars)
//   title   — image title (max 255 chars)
//
// Response 202:
//   { success, id, url, alt, title, tags, folder }
//
app.post('/upload/:tenant',
  auth.requireValidTenantName,
  tenantGuard,
  auth.requireTenantAuth,
  async (req, res, next) => {
    // Upload route needs extra time: multipart receive + ClamAV scan + queuing.
    // Override the global 30s timeout for this route only.
    res.setTimeout(120_000);

    // Run multer inside try/catch so errors surface as JSON, not Express HTML
    try {
      await runMulter(req, res);
    } catch (err) {
      return next(err); // handled by global error handler below
    }

    const tenantName = req.params.tenant;
    const file       = extractUploadedFile(req);

    if (!file) {
      return res.status(400).json({
        error: 'No image received. Send the image as a multipart field named "image" or "file".'
      });
    }

    // Magic byte check
    const mimeOk = await verifyMagicBytes(file.buffer, file.mimetype);
    if (!mimeOk) {
      logger.warn('MIME spoofing attempt blocked', { tenant: tenantName, declared: file.mimetype, ip: req.ip });
      return res.status(415).json({ error: 'File content does not match its declared MIME type' });
    }

    const limitsObj = tenant.getLimits(tenantName);

    if (limitsObj.maxImgLimit && db.countImages(tenantName) >= limitsObj.maxImgLimit) {
      return res.status(429).json({ error: 'Image limit reached for this tenant' });
    }

    const fileSizeMB = file.size / (1024 * 1024);
    if (limitsObj.maxStorageUseMB && (db.getStorageUsed(tenantName) + fileSizeMB) > limitsObj.maxStorageUseMB) {
      return res.status(429).json({ error: 'Storage quota exceeded for this tenant' });
    }

    // ClamAV scan
    const isClean = await processor.scanBuffer(file.buffer);
    if (!isClean) {
      logger.warn('malware detected — upload rejected', { tenant: tenantName, ip: req.ip });
      return res.status(400).json({ error: 'Upload rejected by security scan' });
    }

    const meta = extractMeta(req.body);

    // Resolve image ID: use caller-supplied custom ID or generate one
    let imageId;
    const rawCustomId = typeof req.body.imageId === 'string' ? req.body.imageId.trim() : '';
    if (rawCustomId) {
      if (!CUSTOM_ID_RE.test(rawCustomId)) {
        return res.status(400).json({
          error: 'Invalid imageId. Use only letters, numbers, hyphens, and underscores (1–128 chars).'
        });
      }
      if (db.getImageRecord(rawCustomId, tenantName)) {
        return res.status(409).json({
          error: `Image ID "${rawCustomId}" already exists for this tenant.`
        });
      }
      imageId = rawCustomId;
    } else {
      imageId = processor.generateImageId(tenantName);
    }

    // Put raw buffer in cache immediately so image is serveable right away
    cache.set(tenantName, imageId, file.buffer, file.mimetype);

    const queued = processor.enqueue({
      tenant:       tenantName,
      imageId,
      buffer:       file.buffer,
      originalName: file.originalname,
      mimetype:     file.mimetype,
      limits:       limitsObj,
      meta
    });

    if (!queued) {
      cache.delete(tenantName, imageId);
      return res.status(503).json({ error: 'Processing queue is full — try again in a moment' });
    }

    const imageUrl = buildImageUrl(req, tenantName, imageId);

    // Return image ID immediately in header too (useful for redirecting XHR)
    res.set('X-Image-Id', imageId);
    res.status(202).json({
      success: true,
      id:      imageId,
      url:     imageUrl,
      tenant:  tenantName,
      alt:     meta.alt   ?? null,
      title:   meta.title ?? null
    });
  }
);

// ── GET /image/:tenant/:id ─────────────────────────────────────────────────
//
// Serves the processed WebP image.
// Authentication: valid X-API-Key OR matching Referer/Origin header.
//
app.get('/image/:tenant/:id',
  auth.requireValidTenantName,
  (req, res, next) => {
    if (!CUSTOM_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid image ID format' });
    }
    if (!tenant.exists(req.params.tenant)) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    next();
  },
  auth.requireAllowedOriginOrKey,
  async (req, res) => {
    const tenantName = req.params.tenant;
    const imageId    = req.params.id;

    // Per-tenant rate limit
    const allowed = await limits.checkLimit(tenantName, `img:${tenantName}:${req.ip}`);
    if (!allowed) {
      return res.status(429).json({ error: 'Rate limit exceeded — slow down requests for this tenant' });
    }

    // Touch last_accessed asynchronously (fire and forget)
    setImmediate(() => db.touchLastAccessed(imageId));

    // Cache hit
    const cached = cache.get(tenantName, imageId);
    if (cached) {
      res.set('Content-Type', cached.mimetype || 'image/webp');
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('X-Cache', 'HIT');
      return res.send(cached.buffer);
    }

    // Disk fallback
    const webpPath = path.join(PRATIMA_ROOT, 'tenants', tenantName, 'images', `${imageId}.webp`);
    if (await fs.pathExists(webpPath)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
      res.set('X-Cache', 'MISS');
      return res.sendFile(webpPath);
    }

    res.status(404).json({ error: 'Image not found' });
  }
);

// ── GET /info/:tenant/:id ──────────────────────────────────────────────────
//
// Returns image metadata as JSON (no binary, no auth needed beyond token).
// Useful for pre-populating forms, lightboxes, or admin panels.
//
app.get('/info/:tenant/:id',
  auth.requireValidTenantName,
  tenantGuard,
  auth.requireTenantAuth,
  (req, res) => {
    const { tenant: tenantName, id } = req.params;
    const record = db.getImageRecord(id, tenantName);
    if (!record) return res.status(404).json({ error: 'Image not found' });

    const imageUrl = buildImageUrl(req, tenantName, id);
    res.json({
      id:            record.id,
      tenant:        record.tenant,
      url:           imageUrl,
      original_name: record.original_name,
      alt:           record.alt,
      title:         record.title,
      size_bytes:    record.size,
      mime_type:     record.mime_type,
      width:         record.width,
      height:        record.height,
      created_at:    record.created_at,
      last_accessed: record.last_accessed
    });
  }
);

// ── GET /images/:tenant ────────────────────────────────────────────────────
//
// List images for a tenant with pagination and optional filters.
//
// Query params:
//   page    — page number (default: 1)
//   limit   — per page, max 100 (default: 20)
//   folder  — filter by folder
//   tag     — filter by a single tag
//
app.get('/images/:tenant',
  auth.requireValidTenantName,
  tenantGuard,
  auth.requireTenantAuth,
  (req, res) => {
    const tenantName = req.params.tenant;
    const { page, limit } = req.query;

    const result = db.listImages({ tenant: tenantName, page, limit });
    const proto  = req.get('X-Forwarded-Proto') || req.protocol;
    const host   = req.get('X-Forwarded-Host')  || req.get('host');

    const images = result.images.map(img => ({
      ...img,
      url: `${proto}://${host}/image/${tenantName}/${img.id}`
    }));

    res.json({
      tenant:      tenantName,
      page:        result.page,
      limit:       result.limit,
      total:       result.total,
      total_pages: Math.ceil(result.total / result.limit),
      images
    });
  }
);

// ── DELETE /image/:tenant/:id ──────────────────────────────────────────────
//
// Permanently delete an image from cache, disk, and DB.
// Requires: X-API-Key + matching origin.
//
app.delete('/image/:tenant/:id',
  auth.requireValidTenantName,
  (req, res, next) => {
    if (!CUSTOM_ID_RE.test(req.params.id)) {
      return res.status(400).json({ error: 'Invalid image ID format' });
    }
    if (!tenant.exists(req.params.tenant)) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    next();
  },
  auth.requireTenantAuth,
  async (req, res) => {
    const tenantName = req.params.tenant;
    const imageId    = req.params.id;

    // Fetch record before deleting so we know the file size for stats update
    const record = db.getImageRecord(imageId, tenantName);
    if (!record) return res.status(404).json({ error: 'Image not found' });

    // 1. Remove from RAM cache
    cache.delete(tenantName, imageId);

    // 2. Remove from disk
    const webpPath = path.join(PRATIMA_ROOT, 'tenants', tenantName, 'images', `${imageId}.webp`);
    await fs.remove(webpPath).catch(() => {}); // don't fail if file already gone

    // 3. Remove from DB + update stats
    const deleted = db.deleteImageById(imageId, tenantName);
    if (deleted && record.size) {
      db.subtractStorageUsed(tenantName, record.size);
      db.decrementImageCount(tenantName);
    }

    logger.info('image deleted', { tenant: tenantName, imageId });
    res.json({ success: true, id: imageId });
  }
);

// ── GET /stats/:tenant ─────────────────────────────────────────────────────

app.get('/stats/:tenant',
  auth.requireValidTenantName,
  tenantGuard,
  auth.requireTenantAuth,
  (req, res) => {
    res.json(db.getTenantStats(req.params.tenant));
  }
);

// ── Admin endpoints (localhost only) ──────────────────────────────────────

app.get('/status',  auth.requireLocalhost, (_req, res) => {
  res.json({
    engine: 'running', version: require('../package.json').version,
    uptime: process.uptime(), tenants: tenant.list(),
    totalImages: db.countImages(), memory: process.memoryUsage(), cache: cache.getStats()
  });
});

app.get('/doctor',  auth.requireLocalhost, (_req, res) => {
  const issues = db.checkIntegrity();
  res.json({ issues, count: issues.length });
});

app.post('/repair', auth.requireLocalhost, (_req, res) => {
  res.json(db.repair());
});

app.post('/stop',   auth.requireLocalhost, (_req, res) => {
  res.json({ message: 'Shutting down' });
  setImmediate(() => process.kill(process.pid, 'SIGTERM'));
});

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ───────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  // ── Multer-specific errors ─────────────────────────────────────────────
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      error: `File is too large. Maximum allowed size is ${config.get('maxUploadSizeMB')} MB.`
    });
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      error: 'Only one file per upload is allowed. Send it as the "image" or "file" form field.'
    });
  }
  if (err.code === 'LIMIT_FIELD_COUNT') {
    return res.status(400).json({ error: 'Too many form fields in the request.' });
  }
  if (err.code === 'LIMIT_FIELD_VALUE') {
    return res.status(400).json({ error: `A form field value is too long (max ${MAX_TEXT_FIELD_BYTES} bytes).` });
  }
  if (err.code === 'LIMIT_PART_COUNT') {
    return res.status(400).json({ error: 'Multipart request has too many parts.' });
  }
  if (err.code === 'INVALID_MIME' || err.status === 415) {
    return res.status(415).json({
      error: err.message || 'Unsupported file type. Allowed: JPEG, PNG, WebP, GIF'
    });
  }

  // ── Generic ────────────────────────────────────────────────────────────
  logger.error('unhandled express error', { message: err.message, stack: err.stack });
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

// ── Process-level safety nets ──────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', { reason: String(reason) });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException', { message: err.message, stack: err.stack });
  process.exit(1);
});

// ── Startup directory check ────────────────────────────────────────────────
[PRATIMA_ROOT, 'tenants', 'cache', 'logs', 'tmp', 'exports', 'imports'].forEach(d => {
  const full = d === PRATIMA_ROOT ? d : path.join(PRATIMA_ROOT, d);
  try { fs.ensureDirSync(full); } catch (err) {
    logger.error(`Cannot create required directory: ${full}`, { message: err.message });
    process.exit(1);
  }
});

// ── Start HTTP ─────────────────────────────────────────────────────────────
const httpServer = http.createServer(app);
httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  logger.info(`Pratima HTTP listening on ${HTTP_HOST}:${HTTP_PORT}`);
});

// ── Start HTTPS (optional) ─────────────────────────────────────────────────
let httpsServer = null;
if (TLS_CERT && TLS_KEY) {
  try {
    httpsServer = https.createServer({
      cert:       fs.readFileSync(TLS_CERT),
      key:        fs.readFileSync(TLS_KEY),
      minVersion: 'TLSv1.2',
      ciphers: [
        'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256', 'ECDHE-RSA-AES256-GCM-SHA384'
      ].join(':')
    }, app);
    httpsServer.listen(HTTPS_PORT, HTTPS_HOST, () => {
      logger.info(`Pratima HTTPS listening on ${HTTPS_HOST}:${HTTPS_PORT}`);
    });
  } catch (err) {
    logger.error('HTTPS startup failed — check cert/key paths', { message: err.message });
  }
} else {
  logger.info('HTTPS disabled (set PRATIMA_TLS_CERT + PRATIMA_TLS_KEY to enable)');
}

// ── Graceful shutdown ──────────────────────────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} — shutting down gracefully`);
  httpServer.close(() => process.exit(0));
  if (httpsServer) httpsServer.close();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

module.exports = app;
