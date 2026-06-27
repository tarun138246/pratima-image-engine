const fs = require('fs-extra');
const path = require('path');
const yazl = require('yazl');
const yauzl = require('yauzl');
const crypto = require('crypto');
const logger = require('./utils').logger;
const tenant = require('./tenant');

const PRATIMA_ROOT = '/var/pratima';

async function shift(opts = {}) {
  const tenants = tenant.list();
  const exportsDir = path.join(PRATIMA_ROOT, 'exports');
  await fs.ensureDir(exportsDir);

  for (const t of tenants) {
    const zipPath = path.join(exportsDir, `${t}.zip`);
    const manifest = [];

    const imagesDir = path.join(PRATIMA_ROOT, 'tenants', t, 'images');
    if (!await fs.pathExists(imagesDir)) continue;

    const files = await fs.readdir(imagesDir);
    const zipFile = new yazl.ZipFile();

    for (const file of files) {
      if (!file.endsWith('.webp')) continue;
      const fullPath = path.join(imagesDir, file);
      const buffer = await fs.readFile(fullPath);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      manifest.push({ filename: file, size: buffer.length, sha256: hash });
      zipFile.addBuffer(buffer, file);
    }

    zipFile.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');

    await new Promise((resolve, reject) => {
      const stream = fs.createWriteStream(zipPath);
      zipFile.outputStream.pipe(stream);
      zipFile.end();
      stream.on('finish', resolve);
      stream.on('error', reject);
    });

    const zipBuffer = await fs.readFile(zipPath);
    const zipHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
    await fs.writeFile(`${zipPath}.sha256`, zipHash);

    logger.info('tenant exported', { tenant: t, path: zipPath });

    if (opts.download) {
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(zipPath);
        readStream.pipe(process.stdout, { end: false });
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });
    }

    if (opts.url) {
      const response = await fetch(opts.url, {
        method: 'PUT',
        body: zipBuffer,
        headers: { 'Content-Type': 'application/zip' }
      });
      if (response.ok) {
        await fs.remove(zipPath);
        await fs.remove(`${zipPath}.sha256`);
        logger.info('ZIP uploaded and removed locally', { tenant: t, url: opts.url });
      } else {
        logger.error('ZIP upload failed', { tenant: t, status: response.status });
      }
    }
  }
}

async function receive(source) {
  const MAX_ZIP_BYTES = 10 * 1024 * 1024 * 1024;
  let zipBuffer;
  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_ZIP_BYTES) {
      throw new Error('ZIP file exceeds maximum allowed size (10 GB)');
    }
    zipBuffer = Buffer.from(await res.arrayBuffer());
  } else {
    const stat = await fs.stat(source);
    if (stat.size > MAX_ZIP_BYTES) {
      throw new Error('ZIP file exceeds maximum allowed size (10 GB)');
    }
    zipBuffer = await fs.readFile(source);
  }

  if (zipBuffer.length > MAX_ZIP_BYTES) {
    throw new Error('ZIP file exceeds maximum allowed size (10 GB)');
  }

  const importsDir = path.join(PRATIMA_ROOT, 'imports');
  await fs.ensureDir(importsDir);
  const extractDir = path.join(importsDir, `extract_${crypto.randomBytes(8).toString('hex')}`);
  await fs.ensureDir(extractDir);
  const resolvedExtractDir = path.resolve(extractDir);

  try {
    await new Promise((resolve, reject) => {
      yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        zipfile.readEntry();

        zipfile.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
            return;
          }

          const filePath = path.resolve(resolvedExtractDir, entry.fileName);
          if (!filePath.startsWith(resolvedExtractDir + path.sep)) {
            logger.error('ZIP path traversal blocked', { entry: entry.fileName });
            zipfile.readEntry();
            return;
          }

          fs.ensureDirSync(path.dirname(filePath));
          zipfile.openReadStream(entry, (streamErr, readStream) => {
            if (streamErr) return reject(streamErr);
            const writeStream = fs.createWriteStream(filePath);
            readStream.pipe(writeStream);
            writeStream.on('finish', () => zipfile.readEntry());
            writeStream.on('error', reject);
          });
        });

        zipfile.on('end', resolve);
        zipfile.on('error', reject);
      });
    });

    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!await fs.pathExists(manifestPath)) {
      throw new Error('manifest.json not found in ZIP archive');
    }

    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch {
      throw new Error('manifest.json is malformed');
    }

    if (!Array.isArray(manifest) || manifest.length === 0) {
      throw new Error('No images listed in manifest');
    }

    // Determine target tenant from manifest filename prefix
    // New format: pratima_<prefix>_<rest>.webp
    const firstFile = manifest[0]?.filename;
    const match = firstFile?.match(/^pratima[_\-]([a-z0-9]{1,4})[_\-]/i);
    if (!match) throw new Error('Cannot determine tenant from image filename format');
    const tenantPrefix = match[1].toLowerCase();
    const tenants = tenant.list();
    const tenantName = tenants.find(t => t.toLowerCase().startsWith(tenantPrefix));
    if (!tenantName) {
      throw new Error(`No tenant found matching prefix "${tenantPrefix}"`);
    }

    const imagesDir = path.join(PRATIMA_ROOT, 'tenants', tenantName, 'images');
    await fs.ensureDir(imagesDir);

    for (const item of manifest) {
      if (typeof item.filename !== 'string' || !item.filename.endsWith('.webp')) continue;
      const src = path.join(extractDir, item.filename);
      if (!await fs.pathExists(src)) {
        logger.warn('manifest entry missing in archive', { file: item.filename });
        continue;
      }
      if (item.sha256) {
        const buf = await fs.readFile(src);
        const actual = crypto.createHash('sha256').update(buf).digest('hex');
        if (actual !== item.sha256) {
          logger.error('SHA256 mismatch — skipping file', { file: item.filename });
          continue;
        }
      }
      const dest = path.join(imagesDir, path.basename(item.filename));
      await fs.move(src, dest, { overwrite: true });
    }

    logger.info('backup imported', { tenant: tenantName, count: manifest.length });
  } finally {
    await fs.remove(extractDir).catch(() => {});
  }
}

module.exports = { shift, receive };