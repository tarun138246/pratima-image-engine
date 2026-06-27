const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');
const config = require('./config');
const tenant = require('./tenant');
const backup = require('./backup');
const { version } = require('../package.json');

const PRATIMA_ROOT = '/var/pratima';
const API_BASE = `http://127.0.0.1:${process.env.PRATIMA_PORT || 3001}`;

// ── Bounds for tenant limit options ───────────────────────────────────────

const LIMIT_BOUNDS = {
  maxRamUseMB:              { min: 1,    max: 65536   },
  maxStorageUseMB:          { min: 1,    max: 1048576 },
  maxImgLimit:              { min: 1,    max: 10000000 },
  maxImgPerMin:             { min: 1,    max: 10000   },
  bandwidthLimitMB:         { min: 1,    max: 1048576 },
  maxConcurrentProcessing:  { min: 1,    max: 20      },
  compressionQuality:       { min: 1,    max: 100     }
};

function clampInt(val, key) {
  const { min, max } = LIMIT_BOUNDS[key];
  const n = parseInt(val, 10);
  if (!Number.isFinite(n)) {
    console.error(`  ✗  ${key}: "${val}" is not a valid integer — ignoring`);
    return null;
  }
  if (n < min || n > max) {
    console.error(`  ✗  ${key}: ${n} is out of range [${min}, ${max}] — ignoring`);
    return null;
  }
  return n;
}

module.exports = (program) => {
  program
    .name('pratima')
    .description('Pratima Image Engine CLI')
    .version(version);

  // ── status ──────────────────────────────────────────────────────────────
  program
    .command('status')
    .description('Check daemon health')
    .action(async () => {
      try {
        const data = await apiGet('/status');
        console.log(JSON.stringify(data, null, 2));
      } catch {
        console.error('Daemon is not responding. Start it with: pratima start');
      }
    });

  // ── config ───────────────────────────────────────────────────────────────
  program
    .command('config')
    .description('View or set global configuration')
    .option('-s, --set <key=value>', 'Set a validated config key')
    .action((opts) => {
      if (opts.set) {
        const eqIdx = opts.set.indexOf('=');
        if (eqIdx < 1) {
          console.error('Usage: --set key=value');
          process.exit(1);
        }
        const key = opts.set.slice(0, eqIdx).trim();
        const val = opts.set.slice(eqIdx + 1).trim();
        const result = config.set(key, val);
        if (!result.ok) {
          console.error(`  ✗  ${result.error}`);
          process.exit(1);
        }
        console.log(`  ✓  ${key} = ${result.value}`);
      } else {
        console.log(JSON.stringify(config.load(), null, 2));
      }
    });

  // ── create tenant ────────────────────────────────────────────────────────
  program
    .command('create tenant <name>')
    .description('Create a new tenant and display its API token')
    .option('--origin <url>', 'Set the allowed frontend origin immediately (e.g. https://mysite.com)')
    .action((name, opts) => {
      try {
        const token = tenant.create(name);
        console.log('');
        console.log(`  Tenant created: ${name}`);
        console.log('');
        console.log('  ┌─────────────────────────────────────────────────────────────────┐');
        console.log(`  │  API Token: ${token}  │`);
        console.log('  └─────────────────────────────────────────────────────────────────┘');
        console.log('');
        console.log('  Save this token — it will not be shown again.');
        console.log('  Include it as the X-API-Key header in every request from your app.');
        console.log('');
        if (opts.origin) {
          tenant.setOrigin(name, opts.origin);
          const stored = opts.origin.split(/[\s,]+/).filter(Boolean).join(', ');
          console.log(`  Allowed origins set: ${stored}`);
        } else {
          console.log(`  Next step — set the allowed frontend URL(s):`);
          console.log(`    pratima set-origin ${name} https://your-frontend.com http://localhost:5173`);
        }
        console.log('');
      } catch (err) {
        console.error(`  ✗  ${err.message}`);
        process.exit(1);
      }
    });

  // ── list tenants ─────────────────────────────────────────────────────────
  program
    .command('list tenants')
    .description('List all tenants')
    .action(() => {
      const tenants = tenant.list();
      if (tenants.length === 0) {
        console.log('No tenants yet. Create one with: pratima create tenant <name>');
      } else {
        console.log(tenants.join('\n'));
      }
    });

  // ── delete tenant ─────────────────────────────────────────────────────────
  program
    .command('delete tenant <name>')
    .description('Delete a tenant and all its data')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (name, opts) => {
      if (!opts.force) {
        const answer = await prompt(`Delete tenant "${name}" and ALL its images? This cannot be undone. (y/N) `);
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
      }
      try {
        tenant.remove(name);
        console.log(`  ✓  Tenant "${name}" deleted.`);
      } catch (err) {
        console.error(`  ✗  ${err.message}`);
        process.exit(1);
      }
    });

  // ── set-limits ───────────────────────────────────────────────────────────
  program
    .command('set-limits <tenant>')
    .description('Set quotas and limits for a tenant')
    .option('--max-ram-use <mb>',             'Max RAM cache in MB')
    .option('--max-storage-use <mb>',         'Max disk storage in MB')
    .option('--max-img-limit <num>',          'Max total image count')
    .option('--max-img-per-min <num>',        'Max image fetches per minute')
    .option('--bandwidth-limit <mb>',         'Bandwidth cap in MB')
    .option('--max-concurrent-processing <n>','Max parallel processing jobs')
    .option('--compression-quality <num>',    'WebP quality 1–100')
    .action((tenantName, opts) => {
      if (!tenant.exists(tenantName)) {
        console.error(`  ✗  Tenant "${tenantName}" does not exist`);
        process.exit(1);
      }
      const updates = {};

      const add = (optVal, key) => {
        if (optVal !== undefined) {
          const v = clampInt(optVal, key);
          if (v !== null) updates[key] = v;
        }
      };

      add(opts.maxRamUse,              'maxRamUseMB');
      add(opts.maxStorageUse,          'maxStorageUseMB');
      add(opts.maxImgLimit,            'maxImgLimit');
      add(opts.maxImgPerMin,           'maxImgPerMin');
      add(opts.bandwidthLimit,         'bandwidthLimitMB');
      add(opts.maxConcurrentProcessing,'maxConcurrentProcessing');
      add(opts.compressionQuality,     'compressionQuality');

      if (Object.keys(updates).length === 0) {
        console.log('No valid limits provided — nothing changed.');
        return;
      }
      tenant.setLimits(tenantName, updates);
      // Invalidate cached rate limiter so new maxImgPerMin takes effect
      require('./limits').invalidateLimiter(tenantName);
      console.log(`  ✓  Limits updated for "${tenantName}":`, updates);
    });

  // ── set-origin ───────────────────────────────────────────────────────────
  // Accepts one or more URLs as space-separated rest args.
  // Example: pratima set-origin alnikaah https://alnikaah.in http://localhost:5173
  program
    .command('set-origin <name> [urls...]')
    .description('Set allowed frontend origins for a tenant (space-separated, multiple allowed)')
    .action((name, urls) => {
      if (!urls || urls.length === 0) {
        console.error('  ✗  Provide at least one URL. Example: pratima set-origin mysite https://mysite.com');
        process.exit(1);
      }
      // Validate each URL before saving
      for (const u of urls) {
        try { new URL(u); } catch {
          console.error(`  ✗  Invalid URL: "${u}"`);
          process.exit(1);
        }
      }
      try {
        tenant.setOrigin(name, urls);
        console.log(`  ✓  Allowed origins for "${name}":`);
        urls.forEach(u => console.log(`       ${u}`));
      } catch (err) {
        console.error(`  ✗  ${err.message}`);
        process.exit(1);
      }
    });

  // ── token show ───────────────────────────────────────────────────────────
  program
    .command('token show <tenant>')
    .description('Display the current API token for a tenant')
    .action((name) => {
      if (!tenant.exists(name)) {
        console.error(`  ✗  Tenant "${name}" does not exist`);
        process.exit(1);
      }
      const token = tenant.getToken(name);
      if (!token) {
        console.error(`  ✗  No token set for "${name}" — try: pratima token regenerate ${name}`);
        process.exit(1);
      }
      console.log('');
      console.log(`  Tenant: ${name}`);
      console.log(`  Token:  ${token}`);
      console.log('');
    });

  // ── token regenerate ─────────────────────────────────────────────────────
  program
    .command('token regenerate <tenant>')
    .description('Issue a new API token (immediately invalidates the old one)')
    .option('-f, --force', 'Skip confirmation prompt')
    .action(async (name, opts) => {
      if (!opts.force) {
        const answer = await prompt(`Regenerate token for "${name}"? The old token stops working immediately. (y/N) `);
        if (answer.toLowerCase() !== 'y') {
          console.log('Aborted.');
          return;
        }
      }
      try {
        const token = tenant.regenerateToken(name);
        console.log('');
        console.log(`  ✓  New token for "${name}":`);
        console.log(`     ${token}`);
        console.log('');
      } catch (err) {
        console.error(`  ✗  ${err.message}`);
        process.exit(1);
      }
    });

  // ── stats ─────────────────────────────────────────────────────────────────
  program
    .command('stats <tenant>')
    .description('Show usage stats for a tenant (reads DB directly)')
    .action((tenantName) => {
      if (!tenant.exists(tenantName)) {
        console.error(`  ✗  Tenant "${tenantName}" does not exist`);
        process.exit(1);
      }
      const db = require('./db');
      const stats = db.getTenantStats(tenantName);
      const origins = (tenant.getOrigin(tenantName) || '').split(',').filter(Boolean);
      console.log(JSON.stringify({ ...stats, allowedOrigins: origins.length ? origins : '(not set)' }, null, 2));
    });

  // ── logs ──────────────────────────────────────────────────────────────────
  program
    .command('logs')
    .description('View or tail logs')
    .option('--tail', 'Follow log output')
    .option('--errors', 'Show error log only')
    .action((opts) => {
      // Use date-stamped log for today since we now use daily rotation
      const today = new Date().toISOString().slice(0, 10);
      const logFile = opts.errors
        ? path.join(PRATIMA_ROOT, 'logs', `errors-${today}.log`)
        : path.join(PRATIMA_ROOT, 'logs', `engine-${today}.log`);

      if (!fs.existsSync(logFile)) {
        console.log(`No log file found for today: ${logFile}`);
        return;
      }
      if (opts.tail) {
        execSync(`tail -f "${logFile}"`, { stdio: 'inherit' });
      } else {
        console.log(fs.readFileSync(logFile, 'utf8'));
      }
    });

  // ── doctor ────────────────────────────────────────────────────────────────
  program
    .command('doctor')
    .description('Run DB consistency checks')
    .action(async () => {
      try {
        const data = await apiGet('/doctor');
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('Error:', err.message);
      }
    });

  // ── repair ────────────────────────────────────────────────────────────────
  program
    .command('repair')
    .description('Remove DB records for missing image files')
    .action(async () => {
      try {
        const data = await apiPost('/repair');
        console.log(JSON.stringify(data, null, 2));
      } catch (err) {
        console.error('Error:', err.message);
      }
    });

  // ── backup / shift ────────────────────────────────────────────────────────
  program
    .command('backup')
    .description('Export all tenants to ZIP archives (alias for shift)')
    .action(() => backup.shift());

  program
    .command('shift')
    .description('Export tenant images to ZIP archives')
    .option('--url <url>',  'Upload ZIPs to this URL via HTTP PUT')
    .option('--download',   'Stream ZIP to stdout')
    .action((opts) => backup.shift(opts));

  // ── restore / receive ─────────────────────────────────────────────────────
  program
    .command('restore <backup.zip>')
    .description('Restore from a local backup ZIP file')
    .action((zipFile) => backup.receive(zipFile));

  program
    .command('receive')
    .description('Import a ZIP archive from a URL')
    .option('--url <url>', 'URL to download the ZIP from (required)')
    .action((opts) => {
      if (!opts.url) { console.error('--url is required'); process.exit(1); }
      backup.receive(opts.url);
    });

  // ── start ─────────────────────────────────────────────────────────────────
  program
    .command('start')
    .description('Start the Pratima daemon (usually managed by systemd)')
    .action(() => require('./server'));

  // ── stop ──────────────────────────────────────────────────────────────────
  program
    .command('stop')
    .description('Gracefully stop the daemon')
    .action(async () => {
      try {
        await apiPost('/stop');
        console.log('  ✓  Daemon stopping.');
      } catch {
        console.error('Daemon is not responding or is already stopped.');
      }
    });

  // ── Internal helpers ───────────────────────────────────────────────────────

  async function apiGet(endpoint) {
    const res = await fetch(API_BASE + endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(endpoint, body) {
    const res = await fetch(API_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function prompt(question) {
    return new Promise((resolve) => {
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    });
  }
};
