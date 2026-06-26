const fs = require('fs-extra');
const path = require('path');

const CONFIG_PATH = '/var/pratima/config/config.json';

const DEFAULTS = {
  maxRamMB: 4096,
  maxUploadSizeMB: 10,
  compressionQuality: 85,
  logLevel: 'info',
  clamavHost: 'localhost',
  clamavPort: 3310
};

// Allowed keys and their validators: [min, max] for numbers, regex for strings
const VALIDATORS = {
  maxRamMB:          { type: 'int',    min: 512,   max: 65536  },
  maxUploadSizeMB:   { type: 'int',    min: 1,     max: 100    },
  compressionQuality:{ type: 'int',    min: 1,     max: 100    },
  logLevel:          { type: 'enum',   values: ['error', 'warn', 'info', 'debug'] },
  clamavHost:        { type: 'string', pattern: /^[a-zA-Z0-9.\-]+$/ },
  clamavPort:        { type: 'int',    min: 1,     max: 65535  }
};

let configCache = null;

function load() {
  if (configCache) return configCache;
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf8');
    configCache = { ...DEFAULTS, ...JSON.parse(data) };
  } catch {
    configCache = { ...DEFAULTS };
    save(configCache);
  }
  return configCache;
}

function save(cfg) {
  fs.ensureDirSync(path.dirname(CONFIG_PATH));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  configCache = cfg;
}

function get(key) {
  const cfg = load();
  return cfg[key] !== undefined ? cfg[key] : DEFAULTS[key];
}

/**
 * Validate and coerce a single key=value pair.
 * Returns { ok, value, error }.
 */
function validate(key, rawValue) {
  const rule = VALIDATORS[key];
  if (!rule) {
    return { ok: false, error: `Unknown config key "${key}". Allowed: ${Object.keys(VALIDATORS).join(', ')}` };
  }

  if (rule.type === 'int') {
    const n = parseInt(rawValue, 10);
    if (!Number.isFinite(n)) return { ok: false, error: `${key} must be an integer` };
    if (n < rule.min || n > rule.max) return { ok: false, error: `${key} must be between ${rule.min} and ${rule.max}` };
    return { ok: true, value: n };
  }

  if (rule.type === 'enum') {
    if (!rule.values.includes(rawValue)) {
      return { ok: false, error: `${key} must be one of: ${rule.values.join(', ')}` };
    }
    return { ok: true, value: rawValue };
  }

  if (rule.type === 'string') {
    if (rule.pattern && !rule.pattern.test(rawValue)) {
      return { ok: false, error: `${key} contains invalid characters` };
    }
    return { ok: true, value: rawValue };
  }

  return { ok: false, error: 'Unknown validator type' };
}

/**
 * Set a validated key in the persisted config.
 * Returns { ok, error }.
 */
function set(key, rawValue) {
  const result = validate(key, rawValue);
  if (!result.ok) return result;
  const cfg = load();
  cfg[key] = result.value;
  save(cfg);
  return { ok: true, value: result.value };
}

module.exports = { load, save, get, set, validate, VALIDATORS, DEFAULTS };
