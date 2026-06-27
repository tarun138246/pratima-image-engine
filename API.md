# Pratima Image Engine — API Reference

This document covers every HTTP endpoint available to tenant applications.  
Admin endpoints (`/status`, `/doctor`, `/repair`, `/stop`) are localhost-only and not listed here — they are accessible only via the CLI on the server.

---

## Base URL

```
https://img.yourdomain.com
```

Replace with your actual domain. All examples use this base URL.

---

## Authentication

Every tenant endpoint requires the **`X-API-Key`** header carrying the tenant's secret token.

```
X-API-Key: a3f9d2c8e1b047fabe0293d1...
```

The token is generated once when the tenant is created via `pratima create-tenant <name>`.  
If lost, regenerate it with `pratima token-regen <name>` — the old token stops working immediately.

### Origin enforcement

If the tenant has registered allowed origins (set via `pratima set-origin`), every request must also come from one of those origins:

- For **JavaScript fetch / XHR** — the browser sends an `Origin` header automatically.
- For **HTML `<img>` tags** — the browser sends a `Referer` header automatically.
- For **server-side requests** — pass `Origin: https://yourfrontend.com` manually.

Requests with a missing or mismatched origin are rejected with `403` even when the token is correct.

---

## Request format

Uploads use `multipart/form-data`.  
All other requests have no body.

---

## Response format

All responses are JSON except `GET /image/:tenant/:id` which returns the WebP binary.  
Error responses always follow this shape:

```json
{ "error": "Human-readable description of what went wrong" }
```

---

## Endpoints

---

### POST `/upload/:tenant`

Upload an image. The engine scans it with ClamAV, verifies the file content matches its declared type, converts it to WebP, and saves it. The response is returned immediately (HTTP 202) while conversion runs in the background — the image is already serveable from cache.

#### URL parameters

| Parameter | Type | Description |
|---|---|---|
| `tenant` | string | Your tenant name (alphanumeric, hyphens, underscores) |

#### Headers

| Header | Required | Value |
|---|---|---|
| `X-API-Key` | Yes | Your tenant API token |
| `Content-Type` | Yes | `multipart/form-data` (set automatically by the browser / fetch) |
| `Origin` | Conditional | Required if your tenant has an allowed origin configured |

#### Form fields

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `image` | File | Yes* | JPEG, PNG, WebP, GIF. Max size set by server (default 10 MB) | The image to upload. Use `file` if your form already uses that name |
| `file` | File | Yes* | Same as above | Alternative field name — either `image` or `file`, not both |
| `imageId` | Text | No | Letters, numbers, hyphens, underscores. Max 128 chars. Must be unique per tenant | Custom image ID. If omitted, Pratima auto-generates one |
| `alt` | Text | No | Max 500 characters | Alt text for accessibility and SEO |
| `title` | Text | No | Max 255 characters | Descriptive title for the image |

*One of `image` or `file` must be present.

#### Example — JavaScript (browser)

```js
const formData = new FormData();
formData.append('image',   fileInput.files[0]);
formData.append('alt',     'Handmade ceramic mug');
formData.append('title',   'Blue glaze product shot');
// Optional: pass your own ID (e.g. your DB record ID) — must be unique per tenant
// formData.append('imageId', 'product-42-hero');

const response = await fetch('https://img.yourdomain.com/upload/myshop', {
  method:  'POST',
  headers: { 'X-API-Key': 'YOUR_TOKEN_HERE' },
  body:    formData
});

const data = await response.json();
console.log(data.url); // ready to use in <img src>
console.log(data.id);  // auto-generated or your custom ID
```

#### Example — JavaScript (Node.js / server-side)

```js
import FormData from 'form-data';
import fetch from 'node-fetch';
import fs from 'fs';

const form = new FormData();
form.append('image', fs.createReadStream('./photo.jpg'), 'photo.jpg');
form.append('alt',   'Product front view');

const response = await fetch('https://img.yourdomain.com/upload/myshop', {
  method:  'POST',
  headers: {
    'X-API-Key': process.env.PRATIMA_TOKEN,
    'Origin':    'https://myshop.com',
    ...form.getHeaders()
  },
  body: form
});

const data = await response.json();
```

#### Example — cURL

```bash
curl -X POST https://img.yourdomain.com/upload/myshop \
  -H "X-API-Key: YOUR_TOKEN_HERE" \
  -H "Origin: https://myshop.com" \
  -F "image=@/path/to/photo.jpg" \
  -F "alt=Handmade ceramic mug" \
  -F "title=Blue glaze product shot"
```

#### Success response — `202 Accepted`

| Header | Value |
|---|---|
| `X-Image-Id` | The image ID (same as `id` in the body) — useful for intercepting before parsing JSON |

```json
{
  "success": true,
  "id":      "product-42-hero",
  "url":     "https://img.yourdomain.com/image/myshop/product-42-hero",
  "tenant":  "myshop",
  "alt":     "Handmade ceramic mug",
  "title":   "Blue glaze product shot"
}
```

> **202 vs 200** — The engine returns 202 because WebP conversion is asynchronous. The image is immediately serveable from RAM cache; the final WebP file is written to disk within seconds.

> **Custom IDs** — If you pass `imageId` in the form, the `id` in the response will be exactly what you sent. If you omit it, Pratima auto-generates one in the format `pratima_<first-4-of-tenant>_<first-4-of-filename>` (e.g. `pratima_mysh_prod`). A short random hex suffix is appended if a collision is detected (e.g. `pratima_mysh_prod_a3f9d2c8`).

#### Error responses

| Status | Condition |
|---|---|
| `400` | No image field found in the form |
| `400` | `imageId` contains invalid characters or exceeds 128 chars |
| `400` | File rejected by malware scan (ClamAV) |
| `401` | `X-API-Key` header is missing |
| `403` | Token is wrong or origin does not match the tenant's allowed origin |
| `404` | Tenant name does not exist |
| `409` | The provided `imageId` already exists for this tenant |
| `413` | File exceeds the server's maximum upload size |
| `415` | File type not allowed, or file content does not match its declared MIME type |
| `429` | Tenant has reached its image count limit or storage quota |
| `503` | Server processing queue is full — retry after a short delay |

---

### GET `/image/:tenant/:id`

Serve the processed WebP image. This is the URL you put in `<img src>`, CSS `background-image`, or anywhere an image URL is needed.

#### URL parameters

| Parameter | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |
| `id` | string | Image ID returned by the upload endpoint |

#### Authentication

No `X-API-Key` needed in the URL. Authentication works one of two ways:

- **Browser `<img>` / `<picture>` tag** — the browser sends `Referer` automatically. As long as the page is served from the tenant's registered origin, the image loads.
- **Programmatic access** — send `X-API-Key` as a header.

#### Example — HTML

```html
<img
  src="https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8"
  alt="Handmade ceramic mug"
  loading="lazy"
  width="800"
  height="600"
/>
```

#### Example — CSS

```css
.hero {
  background-image: url('https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8');
}
```

#### Example — JavaScript fetch

```js
const response = await fetch(
  'https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8',
  { headers: { 'X-API-Key': 'YOUR_TOKEN_HERE' } }
);
const blob = await response.blob();
const objectUrl = URL.createObjectURL(blob);
```

#### Success response — `200 OK`

Raw WebP image bytes.

| Header | Value |
|---|---|
| `Content-Type` | `image/webp` |
| `Cache-Control` | `public, max-age=31536000, immutable` |
| `X-Cache` | `HIT` (served from RAM) or `MISS` (served from disk) |

#### Error responses

| Status | Condition |
|---|---|
| `400` | Image ID format is invalid |
| `403` | No `X-API-Key` provided and `Referer`/`Origin` does not match the tenant's allowed origin |
| `403` | Tenant has no allowed origin configured yet |
| `404` | Tenant or image not found |
| `429` | Per-tenant image fetch rate limit exceeded |

---

### GET `/info/:tenant/:id`

Returns the stored metadata for a single image as JSON. Does not return the image binary. Useful for admin panels, edit forms, lightboxes, or anywhere you need to display or edit image details.

#### URL parameters

| Parameter | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |
| `id` | string | Image ID |

#### Headers

| Header | Required |
|---|---|
| `X-API-Key` | Yes |

#### Example — cURL

```bash
curl https://img.yourdomain.com/info/myshop/pratima_mysh_prod_a3f9d2c8 \
  -H "X-API-Key: YOUR_TOKEN_HERE"
```

#### Example — JavaScript

```js
const response = await fetch(
  'https://img.yourdomain.com/info/myshop/pratima_mysh_prod_a3f9d2c8',
  { headers: { 'X-API-Key': 'YOUR_TOKEN_HERE' } }
);
const info = await response.json();

console.log(info.width, info.height);  // dimensions in pixels
console.log(info.size_bytes);          // final WebP file size
console.log(info.url);                 // ready-to-use image URL
```

#### Success response — `200 OK`

```json
{
  "id":            "pratima_mysh_prod_a3f9d2c8",
  "tenant":        "myshop",
  "url":           "https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8",
  "original_name": "product_photo.jpg",
  "alt":           "Handmade ceramic mug",
  "title":         "Blue glaze product shot",
  "size_bytes":    84320,
  "mime_type":     "image/webp",
  "width":         1200,
  "height":        800,
  "created_at":    "2024-06-26T14:30:12.000Z",
  "last_accessed": "2024-06-26T15:10:05.000Z"
}
```

#### Response field reference

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique image identifier |
| `tenant` | string | Tenant this image belongs to |
| `url` | string | Full URL to serve the image |
| `original_name` | string | Sanitized original filename from the upload |
| `alt` | string \| null | Alt text set at upload time |
| `title` | string \| null | Title set at upload time |
| `size_bytes` | number | Final WebP file size in bytes |
| `mime_type` | string | Always `image/webp` after processing |
| `width` | number \| null | Width in pixels after conversion |
| `height` | number \| null | Height in pixels after conversion |
| `created_at` | ISO 8601 | When the image was first uploaded |
| `last_accessed` | ISO 8601 | When the image was last served |

#### Error responses

| Status | Condition |
|---|---|
| `401` | Missing `X-API-Key` |
| `403` | Wrong token or origin mismatch |
| `404` | Tenant or image not found |

---

### GET `/images/:tenant`

List all images for a tenant, sorted by upload date (newest first), with pagination.

#### URL parameters

| Parameter | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |

#### Headers

| Header | Required |
|---|---|
| `X-API-Key` | Yes |

#### Query parameters

| Parameter | Type | Default | Max | Description |
|---|---|---|---|---|
| `page` | integer | `1` | — | Page number |
| `limit` | integer | `20` | `100` | Images per page |

#### Example — cURL

```bash
curl "https://img.yourdomain.com/images/myshop?page=1&limit=20" \
  -H "X-API-Key: YOUR_TOKEN_HERE"
```

#### Example — JavaScript with pagination

```js
async function getImages(tenant, token, page = 1) {
  const url = `https://img.yourdomain.com/images/${tenant}?page=${page}&limit=20`;
  const res = await fetch(url, {
    headers: { 'X-API-Key': token }
  });
  return res.json();
}

const result = await getImages('myshop', 'YOUR_TOKEN_HERE');

result.images.forEach(img => {
  console.log(img.id, img.url, img.alt, img.width, img.height);
});

// Paginate
if (result.page < result.total_pages) {
  const nextPage = await getImages('myshop', 'YOUR_TOKEN_HERE', result.page + 1);
}
```

#### Success response — `200 OK`

```json
{
  "tenant":      "myshop",
  "page":        1,
  "limit":       20,
  "total":       142,
  "total_pages": 8,
  "images": [
    {
      "id":            "pratima_mysh_prod_a3f9d2c8",
      "tenant":        "myshop",
      "url":           "https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8",
      "original_name": "product_photo.jpg",
      "alt":           "Handmade ceramic mug",
      "title":         "Blue glaze product shot",
      "size":          84320,
      "mime_type":     "image/webp",
      "width":         1200,
      "height":        800,
      "created_at":    "2024-06-26T14:30:12.000Z",
      "last_accessed": "2024-06-26T15:10:05.000Z"
    }
  ]
}
```

#### Response field reference

| Field | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |
| `page` | number | Current page |
| `limit` | number | Items per page |
| `total` | number | Total image count across all pages |
| `total_pages` | number | Total number of pages |
| `images` | array | Array of image objects. Same fields as `/info` except file size is returned as `size` (number of bytes) instead of `size_bytes` |

#### Error responses

| Status | Condition |
|---|---|
| `401` | Missing `X-API-Key` |
| `403` | Wrong token or origin mismatch |
| `404` | Tenant not found |

---

### DELETE `/image/:tenant/:id`

Permanently delete an image. Removes it from the RAM cache, disk, and database. Storage usage statistics are updated immediately. This action cannot be undone.

#### URL parameters

| Parameter | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |
| `id` | string | Image ID to delete |

#### Headers

| Header | Required |
|---|---|
| `X-API-Key` | Yes |

#### Example — cURL

```bash
curl -X DELETE \
  https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8 \
  -H "X-API-Key: YOUR_TOKEN_HERE"
```

#### Example — JavaScript

```js
const response = await fetch(
  'https://img.yourdomain.com/image/myshop/pratima_mysh_prod_a3f9d2c8',
  {
    method:  'DELETE',
    headers: { 'X-API-Key': 'YOUR_TOKEN_HERE' }
  }
);

if (response.ok) {
  const { id } = await response.json();
  console.log(`Deleted: ${id}`);
}
```

#### Success response — `200 OK`

```json
{
  "success": true,
  "id":      "pratima_mysh_prod_a3f9d2c8"
}
```

#### Error responses

| Status | Condition |
|---|---|
| `400` | Image ID format is invalid |
| `401` | Missing `X-API-Key` |
| `403` | Wrong token or origin mismatch |
| `404` | Tenant or image not found |

---

### GET `/stats/:tenant`

Returns usage statistics for a tenant. Useful for dashboards, quota displays, or billing integrations.

#### URL parameters

| Parameter | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |

#### Headers

| Header | Required |
|---|---|
| `X-API-Key` | Yes |

#### Example — cURL

```bash
curl https://img.yourdomain.com/stats/myshop \
  -H "X-API-Key: YOUR_TOKEN_HERE"
```

#### Example — JavaScript

```js
const res = await fetch('https://img.yourdomain.com/stats/myshop', {
  headers: { 'X-API-Key': 'YOUR_TOKEN_HERE' }
});
const stats = await res.json();

console.log(`${stats.image_count} images, ${stats.storage_used_mb.toFixed(1)} MB used`);
```

#### Success response — `200 OK`

```json
{
  "tenant":          "myshop",
  "image_count":     142,
  "storage_used_mb": 87.4,
  "bandwidth_mb":    1240.0
}
```

#### Response field reference

| Field | Type | Description |
|---|---|---|
| `tenant` | string | Tenant name |
| `image_count` | number | Total images currently stored |
| `storage_used_mb` | number | Total disk space used in MB |
| `bandwidth_mb` | number | Cumulative bandwidth served in MB |

#### Error responses

| Status | Condition |
|---|---|
| `401` | Missing `X-API-Key` |
| `403` | Wrong token or origin mismatch |
| `404` | Tenant not found |

---

## Error code reference

| Code | Name | When it occurs |
|---|---|---|
| `400` | Bad Request | Missing file, malware detected, invalid image ID format |
| `401` | Unauthorized | `X-API-Key` header is missing entirely |
| `403` | Forbidden | Token is wrong; or `Origin`/`Referer` does not match the tenant's registered URL; or no origin is configured for the tenant |
| `404` | Not Found | Tenant name or image ID does not exist |
| `408` | Request Timeout | Request took longer than the route timeout (30 s for most routes, 120 s for uploads) |
| `413` | Payload Too Large | File exceeds the configured maximum upload size |
| `415` | Unsupported Media Type | File type is not JPEG/PNG/WebP/GIF, or the file content does not match its declared type |
| `429` | Too Many Requests | Global rate limit (500 req/min per IP), per-tenant image fetch limit, image count quota, or storage quota exceeded |
| `503` | Service Unavailable | Processing queue is full — the server is under heavy load; retry after a short delay |

---

## Quick reference

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/upload/:tenant` | Token + Origin | Upload an image |
| `GET` | `/image/:tenant/:id` | Token or Referer | Serve the WebP image |
| `GET` | `/info/:tenant/:id` | Token | Get image metadata as JSON |
| `GET` | `/images/:tenant` | Token | List all images (paginated) |
| `DELETE` | `/image/:tenant/:id` | Token | Permanently delete an image |
| `GET` | `/stats/:tenant` | Token | Get tenant usage statistics |

---

## Integration checklist

- [ ] Store your API token in a server-side environment variable — never in frontend JavaScript or HTML source
- [ ] Set the allowed origin with `pratima set-origin <name> https://yourfrontend.com` before going live
- [ ] Use `<img>` tags with the returned URL directly — no token needed in the URL
- [ ] Make upload calls from your backend (or a trusted edge function) so the token is not exposed
- [ ] Save the returned `id` in your own database alongside whatever record the image belongs to
- [ ] Use `GET /info` to retrieve dimensions if you need to set `width`/`height` attributes on `<img>` tags
- [ ] Use `GET /images` for building admin panels or media library UIs
- [ ] Use `DELETE` when a record is removed from your database to keep storage clean
