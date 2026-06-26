# Pratima Image Engine

A self-hosted, multi-tenant image processing engine for your VPS.  
Upload images from your frontend, get back optimised WebP served with per-tenant token auth, hotlink protection, RAM caching, and malware scanning — all managed through a single CLI.

---

## Features

- **Multi-tenant** — isolate images, quotas, and tokens per project or client
- **Per-tenant API tokens** — every tenant gets a 64-char secret token; requests without it are rejected
- **Origin protection** — link each tenant to its frontend URL; requests from other origins are blocked
- **WebP conversion** — all uploads are automatically converted and optimised with Sharp
- **RAM cache** — LRU in-memory cache with per-tenant and global size limits
- **Malware scanning** — ClamAV scans every upload before it is written to disk
- **Magic byte validation** — file content is verified against declared MIME type (no MIME spoofing)
- **HTTP + HTTPS** — HTTP for nginx proxy, optional built-in HTTPS for direct access
- **Security headers** — Helmet, CORS, rate limiting, request timeouts out of the box
- **Daily log rotation** — 14-day engine logs, 30-day error logs, auto-compressed
- **CLI management** — create tenants, set quotas, rotate tokens, run backups, check integrity

---

## Requirements

| Requirement | Version |
|---|---|
| Node.js | >= 20.9.0 |
| ClamAV daemon | Any recent |
| nginx | Any recent |
| OS | Ubuntu 22.04 / Debian 12 (recommended) |

---

## Quick Start

```
git clone https://your-repo/pratima-image-engine /opt/pratima
cd /opt/pratima
cp .env.example .env
npm install --omit=dev
```

Edit `.env` for your environment, then follow the full setup below.

---

## Full VPS Setup

### 1. Install system dependencies

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 pkg-config

# ClamAV
sudo apt install -y clamav clamav-daemon
sudo systemctl stop clamav-freshclam
sudo freshclam
sudo systemctl start clamav-freshclam clamav-daemon
sudo systemctl enable clamav-daemon

# nginx + Certbot
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Create the data directory

```bash
sudo useradd -r -s /bin/false pratima

sudo mkdir -p /var/pratima/{tenants,cache,config,logs,tmp,exports,imports}
sudo chown -R pratima:pratima /var/pratima
sudo chmod 750 /var/pratima
```

### 3. Install the engine

```bash
sudo chown -R pratima:pratima /opt/pratima
cd /opt/pratima
sudo -u pratima npm install --omit=dev
```

### 4. Configure environment

```bash
cp .env.example .env
nano .env          # review defaults — usually no changes needed for a standard setup
```

### 5. Systemd service

Create `/etc/systemd/system/pratima.service`:

```ini
[Unit]
Description=Pratima Image Engine
After=network.target clamav-daemon.service
Requires=clamav-daemon.service

[Service]
Type=simple
User=pratima
Group=pratima
WorkingDirectory=/opt/pratima
EnvironmentFile=/opt/pratima/.env
ExecStart=/usr/bin/node lib/server.js
Restart=always
RestartSec=5

NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/pratima /opt/pratima
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pratima
sudo systemctl status pratima
```

### 6. Nginx configuration

Create `/etc/nginx/sites-available/pratima`:

```nginx
server {
    listen 80;
    server_name img.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name img.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/img.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/img.yourdomain.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    client_max_body_size 12M;

    location / {
        proxy_pass          http://127.0.0.1:3001;
        proxy_http_version  1.1;
        proxy_set_header    Host              $host;
        proxy_set_header    X-Real-IP         $remote_addr;
        proxy_set_header    X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header    X-Forwarded-Proto $scheme;
        proxy_read_timeout  35s;
    }

    location ~* ^/image/ {
        proxy_pass          http://127.0.0.1:3001;
        proxy_http_version  1.1;
        proxy_set_header    Host              $host;
        proxy_set_header    X-Real-IP         $remote_addr;
        proxy_set_header    X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header    X-Forwarded-Proto $scheme;
        add_header          Cache-Control "public, max-age=31536000, immutable";
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/pratima /etc/nginx/sites-enabled/pratima
sudo certbot --nginx -d img.yourdomain.com
sudo nginx -t && sudo systemctl reload nginx
```

---

## CLI Reference

Add a shell alias on the server so you don't have to type the full path:

```bash
echo "alias pratima='sudo -u pratima node /opt/pratima/bin/pratima.js'" >> ~/.bashrc
source ~/.bashrc
```

---

### Tenant management

#### Create a tenant

```bash
pratima create tenant <name>
pratima create tenant <name> --origin https://yourfrontend.com
```

On creation the engine prints the API token **once**. Copy it immediately — it is not stored in plaintext anywhere you can retrieve it in full later.

```
  Tenant created: myshop

  ┌─────────────────────────────────────────────────────────────────┐
  │  API Token: a3f9d2c8e1b047fabe0293d1...                        │
  └─────────────────────────────────────────────────────────────────┘

  Save this token — it will not be shown again.
  Next step: pratima tenant set-origin myshop https://myshop.com
```

#### Set the allowed frontend origin

```bash
pratima tenant set-origin <name> <url>

# Example
pratima tenant set-origin myshop https://myshop.com
```

The engine checks the `Origin` and `Referer` headers on every request against this value. Requests from other origins are rejected with HTTP 403, even if the API token is correct.

#### List tenants

```bash
pratima list tenants
```

#### Delete a tenant

```bash
pratima delete tenant <name>
pratima delete tenant <name> --force    # skip confirmation
```

This permanently removes all images and DB records for the tenant.

---

### Token management

#### Show current token

```bash
pratima token show <tenant>
```

#### Regenerate token

```bash
pratima token regenerate <tenant>
pratima token regenerate <tenant> --force
```

The old token stops working **immediately**. Update your frontend app before regenerating in production.

---

### Quota management

```bash
pratima tenant limits set <tenant> [options]

Options:
  --max-storage-use <mb>          Disk storage cap in MB
  --max-img-limit <num>           Maximum total image count
  --max-img-per-min <num>         Image fetch rate limit (per minute)
  --max-ram-use <mb>              RAM cache cap for this tenant in MB
  --compression-quality <1-100>   WebP output quality (default: 85)
  --max-concurrent-processing <n> Parallel processing jobs (default: 3)
  --bandwidth-limit <mb>          Bandwidth cap in MB
```

Example:

```bash
pratima tenant limits set myshop \
  --max-storage-use 5120 \
  --max-img-limit 50000 \
  --max-img-per-min 500 \
  --compression-quality 82
```

---

### Global config

```bash
pratima config                          # view current config
pratima config --set compressionQuality=80
pratima config --set maxUploadSizeMB=20
pratima config --set logLevel=debug
```

Valid keys:

| Key | Type | Range / Values |
|---|---|---|
| `maxRamMB` | integer | 512 – 65536 |
| `maxUploadSizeMB` | integer | 1 – 100 |
| `compressionQuality` | integer | 1 – 100 |
| `logLevel` | enum | `error` `warn` `info` `debug` |
| `clamavHost` | string | hostname / IP |
| `clamavPort` | integer | 1 – 65535 |

---

### Operations

```bash
# Daemon health + tenant list + cache stats (localhost only)
pratima status

# Usage stats for a specific tenant
pratima stats <tenant>

# Follow today's log
pratima logs --tail

# View error log only
pratima logs --errors

# DB integrity check — lists images in DB with no file on disk
pratima doctor

# Remove orphaned DB records
pratima repair

# Export all tenants to /var/pratima/exports/<tenant>.zip
pratima backup

# Upload ZIPs to a remote URL (HTTP PUT)
pratima shift --url https://backup.yourdomain.com/upload

# Restore from a local ZIP
pratima restore /var/pratima/exports/myshop.zip

# Restore from a remote ZIP
pratima receive --url https://backup.yourdomain.com/myshop.zip

# Start daemon (used by systemd — prefer the service)
pratima start

# Graceful shutdown
pratima stop
```

---

## HTTP API Reference

All tenant endpoints require the `X-API-Key` header with the tenant's API token.  
Admin endpoints (`/status`, `/doctor`, `/repair`, `/stop`) are **localhost-only** — nginx does not forward them.

### POST `/upload/:tenant`

Upload an image. The file is ClamAV-scanned, magic-byte-verified, then converted to WebP asynchronously.

**Headers**

| Header | Required | Value |
|---|---|---|
| `X-API-Key` | Yes | Tenant API token |
| `Origin` | Yes (if origin is set) | Must match tenant's registered origin |
| `Content-Type` | Yes | `multipart/form-data` |

**Form field:** `image` — the image file (JPEG, PNG, WebP, GIF)

**Response `202`**

```json
{
  "success": true,
  "id": "pratima-mys-20240626143012-A3F9D2C8",
  "url": "/image/myshop/pratima-mys-20240626143012-A3F9D2C8"
}
```

**Error responses**

| Code | Reason |
|---|---|
| 400 | No file, or upload rejected by malware scan |
| 401 | Missing `X-API-Key` header |
| 403 | Invalid token or origin mismatch |
| 404 | Tenant does not exist |
| 413 | File exceeds `maxUploadSizeMB` |
| 415 | Unsupported file type or MIME spoofing detected |
| 429 | Image limit or storage quota exceeded |
| 503 | Processing queue full |

---

### GET `/image/:tenant/:id`

Serve a processed WebP image.

**Authentication** — one of:
- Valid `X-API-Key` header (programmatic / server-side access)
- `Referer` or `Origin` header matching the tenant's registered origin (browser image tag)

If the tenant has no `allowed_origin` set, all requests are rejected until one is configured.

**Response `200`** — image bytes with `Content-Type: image/webp`

---

### GET `/stats/:tenant`

Returns image count, storage used, and bandwidth for the tenant.

**Headers:** `X-API-Key` required + origin check if set.

**Response `200`**

```json
{
  "tenant": "myshop",
  "image_count": 142,
  "storage_used_mb": 87.4,
  "bandwidth_mb": 1240.0
}
```

---

## Frontend Integration

### Upload (JavaScript / Node.js)

```js
async function uploadImage(file) {
  const form = new FormData();
  form.append('image', file);

  const res = await fetch('https://img.yourdomain.com/upload/myshop', {
    method: 'POST',
    headers: { 'X-API-Key': process.env.PRATIMA_TOKEN },
    body: form
  });

  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  return res.json(); // { success, id, url }
}
```

> Keep the API token in a server-side environment variable. Never expose it in browser JavaScript.

### Display an image

```html
<!-- Browser sends Referer automatically — no token needed in the URL -->
<img
  src="https://img.yourdomain.com/image/myshop/pratima-mys-20240626143012-A3F9D2C8"
  alt="Product photo"
  loading="lazy"
/>
```

### React example

```jsx
function ProductImage({ imageId }) {
  const src = `https://img.yourdomain.com/image/myshop/${imageId}`;
  return <img src={src} alt="Product" loading="lazy" />;
}
```

---

## Security Model

```
Internet
   │
   ▼
nginx :443  ←─── TLS termination, client_max_body_size
   │
   │  proxy_pass (loopback only — 127.0.0.1:3001)
   ▼
Pratima daemon
   ├── Helmet (security headers)
   ├── CORS (reflects origin, tenant auth validates it)
   ├── Global rate limiter (500 req/min per IP)
   ├── Request timeout (30 s)
   │
   ├── /upload/:tenant ─── requireValidTenantName
   │                    ─── requireTenantAuth (token + origin)
   │                    ─── multer (MIME pre-filter)
   │                    ─── magic byte check (file-type)
   │                    ─── ClamAV scan
   │                    ─── quota checks
   │
   ├── /image/:tenant/:id ── requireValidTenantName
   │                      ── requireAllowedOriginOrKey
   │                      ── per-tenant rate limiter (async)
   │
   ├── /stats/:tenant ───── requireValidTenantName
   │                     ── requireTenantAuth (token + origin)
   │
   └── /status /doctor /repair /stop
                         ── requireLocalhost (socket addr check)
                            nginx never proxies these — admin CLI only
```

**What each check does**

| Check | What it prevents |
|---|---|
| `requireLocalhost` | External access to admin endpoints even if nginx misconfigured |
| `requireTenantAuth` | Unauthorized uploads and API access |
| `requireAllowedOriginOrKey` | Hotlinking images from other websites |
| Magic byte check | MIME type spoofing (e.g. renaming `.php` to `.jpg`) |
| ClamAV scan | Malware uploaded as an image |
| Constant-time compare | Timing-based token enumeration |
| Tenant name regex | Path traversal via URL parameter |
| ZIP path resolve check | Directory traversal during backup restore |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | — | Set to `production` to disable console logs |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `PRATIMA_PORT` | `3001` | HTTP listen port |
| `PRATIMA_HOST` | `127.0.0.1` | HTTP bind address |
| `PRATIMA_HTTPS_PORT` | `3443` | HTTPS listen port (when TLS enabled) |
| `PRATIMA_HTTPS_HOST` | `0.0.0.0` | HTTPS bind address |
| `PRATIMA_TLS_CERT` | — | Absolute path to `fullchain.pem` — enables HTTPS |
| `PRATIMA_TLS_KEY` | — | Absolute path to `privkey.pem` — enables HTTPS |
| `PRATIMA_CLAMAV_OPTIONAL` | `0` | `1` = allow uploads when ClamAV is unreachable |

---

## Directory Layout

```
/var/pratima/
├── config/
│   └── config.json          Global config (written by CLI)
├── tenants/
│   └── <name>/
│       ├── images/          Processed WebP files
│       ├── metadata/        Reserved for future use
│       └── temp/            Per-tenant temp space
├── cache/
│   └── ram-index.db         SQLite — tenant, image, and stats records
├── logs/
│   ├── engine-YYYY-MM-DD.log
│   └── errors-YYYY-MM-DD.log
├── tmp/                     ClamAV scan temp files (UUID-named, auto-deleted)
├── exports/                 pratima backup output ZIPs
└── imports/                 pratima restore working directory
```

---

## Logs

Logs rotate daily. Engine logs are kept for 14 days; error logs for 30 days. Old files are gzip-compressed automatically.

```bash
# Follow today's log in real time
pratima logs --tail

# Show only errors
pratima logs --errors

# Read a specific date directly
cat /var/pratima/logs/engine-2024-06-20.log

# All-time error search
zcat /var/pratima/logs/errors-*.log.gz | grep "tenant myshop"
```

---

## Backup and Restore

```bash
# Export all tenants to /var/pratima/exports/
pratima backup

# Export and upload to a remote storage endpoint (HTTP PUT)
pratima shift --url https://s3.yourdomain.com/backups/

# Restore from a local file
pratima restore /var/pratima/exports/myshop.zip

# Restore from a remote URL
pratima receive --url https://s3.yourdomain.com/backups/myshop.zip
```

Each ZIP contains a `manifest.json` with SHA256 hashes. The restore process verifies every file's hash before writing it to disk. Malformed paths inside ZIPs are blocked (path traversal protection).

---

## Troubleshooting

**Daemon won't start**
```bash
sudo journalctl -u pratima -n 50
# Most common: /var/pratima not writable by pratima user
sudo chown -R pratima:pratima /var/pratima
```

**Uploads rejected — ClamAV error**
```bash
sudo systemctl status clamav-daemon
sudo systemctl restart clamav-daemon
# To allow uploads when ClamAV is down: set PRATIMA_CLAMAV_OPTIONAL=1 in .env
```

**403 on upload — origin mismatch**
```bash
# Check what origin is registered for the tenant
pratima stats myshop
# Update it
pratima tenant set-origin myshop https://correct-origin.com
```

**413 on upload from nginx**
```nginx
# In your nginx server block — must be >= maxUploadSizeMB + 2
client_max_body_size 12M;
```

**Image shows 403 (hotlink blocked)**  
The request had no matching `Referer` or `Origin` header. Either:
- Send a valid `X-API-Key` header in the request, or
- Make sure the page loading the image is served from the registered origin

**DB out of sync with disk**
```bash
pratima doctor      # shows missing files
pratima repair      # removes the orphaned DB records
```

---

## License

MIT
