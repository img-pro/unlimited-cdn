# Bandwidth Saver Worker

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange.svg)](https://workers.cloudflare.com/)

Cloudflare Worker that caches and serves WordPress images globally via CDN.

Part of the [Bandwidth Saver](https://wordpress.org/plugins/bandwidth-saver/) WordPress plugin.

## Overview

This worker acts as a caching CDN for WordPress images:

1. First request: Fetches image from WordPress, stores in R2, returns image
2. Future requests: Serves directly from R2 cache with long cache headers

**Single-domain architecture:** The worker IS your CDN. No separate R2 public bucket needed.

## Features

- **Origin Fetch** - Pull images from any WordPress site
- **R2 Caching** - Permanent storage in Cloudflare R2
- **Direct Serving** - Images served through the worker with year-long cache headers
- **CORS Support** - Configurable cross-origin resource sharing
- **Image Validation** - Verify content types and file sizes
- **Origin Allowlist** - KV-based domain validation for managed service
- **Graceful Fallback** - Redirects to origin on errors (no broken images)
- **Security Hardening** - Path traversal protection, SSRF prevention, redirect validation

## Security Features

The worker includes several security measures:

| Feature | Description |
|---------|-------------|
| **Path Normalization** | Prevents path traversal attacks (`../` sequences) |
| **SSRF Protection** | Blocks requests to internal IPs and localhost |
| **Redirect Validation** | Validates redirected URLs against allowlist |
| **Domain Validation** | IDN/punycode normalization to prevent homograph attacks |
| **No Information Disclosure** | Error responses redirect to origin without exposing internals |

## How It Works

```
Request Flow:
Browser → cdn.yoursite.com/example.com/wp-content/uploads/photo.jpg
              ↓
         [Worker]
              ↓
    ┌─────────┴─────────┐
    │                   │
Cache HIT           Cache MISS
    │                   │
    ↓                   ↓
Return from R2    Fetch from origin
                        ↓
                  Store in R2
                        ↓
                  Return image
```

Both cache hits and misses return images with `Cache-Control: public, max-age=31536000, immutable`.

**Error Handling:** If anything fails (origin down, not an image, file too large), the worker redirects to the original URL. The user sees the origin's response directly - no broken images.

## URL Structure

```
https://cdn.yoursite.com/{origin-domain}/{path-to-image}
```

**Example:**
```
Original:  https://example.com/wp-content/uploads/2024/photo.jpg
CDN URL:   https://cdn.yoursite.com/example.com/wp-content/uploads/2024/photo.jpg
```

## Quick Start

### Prerequisites

- Cloudflare account with a domain
- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`

### Setup (15 minutes)

```bash
# 1. Clone and install
git clone https://github.com/img-pro/bandwidth-saver-worker.git
cd bandwidth-saver-worker
npm install

# 2. Login to Cloudflare
wrangler login

# 3. Create R2 bucket
wrangler r2 bucket create imgpro-cdn

# 4. Configure
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml with your domain and bucket name

# 5. Deploy
npm run deploy
```

### Add Custom Domain

1. Go to **Cloudflare Dashboard → Workers & Pages → your-worker**
2. Click **Settings → Domains & Routes**
3. Click **Add → Custom Domain**
4. Enter your CDN domain (e.g., `cdn.yoursite.com`)
5. Cloudflare automatically configures DNS and SSL

## Configuration

### wrangler.toml

```toml
name = "bandwidth-saver-worker"
main = "src/index.ts"
compatibility_date = "2025-01-15"
compatibility_flags = ["nodejs_compat"]

# Your CDN domain
routes = [
  { pattern = "cdn.yoursite.com/*", zone_name = "yoursite.com" }
]

# R2 bucket (keep private - worker handles access)
[[r2_buckets]]
binding = "R2"
bucket_name = "imgpro-cdn"

[vars]
ORIGIN_MODE = "open"            # "open", "list", or "registered"
ALLOWED_ORIGINS = "*"           # For "list" mode: "site1.com,site2.com"
MAX_FILE_SIZE = "50MB"          # Maximum image size
FETCH_TIMEOUT = "30000"         # Origin timeout (ms)
DEBUG = "false"                 # Enable debug viewer (disable in production)
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ORIGIN_MODE` | Origin validation mode (see below) | `open` |
| `ALLOWED_ORIGINS` | For "list" mode: comma-separated domains | `*` |
| `BLOCKED_ORIGINS` | Domains to always block | - |
| `MAX_FILE_SIZE` | Max file size (`10MB`, `100MB`, etc.) | `50MB` |
| `FETCH_TIMEOUT` | Origin fetch timeout in ms | `30000` |
| `DEBUG` | Enable debug viewer (`true`/`false`) | `false` |

### Origin Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| `open` | Accept any origin domain | Self-hosted, single site |
| `list` | Only allow domains in `ALLOWED_ORIGINS` | Self-hosted, multi-site |
| `registered` | Validate against KV namespace | Managed service (SaaS) |

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/{domain}/{path}` | GET | Fetch/serve image |
| `/{domain}/{path}` | HEAD | Check if cached (no download) |
| `/{domain}/{path}?view=1` | GET | Debug viewer (requires `DEBUG=true`) |
| `/{domain}/{path}?force=1` | GET | Bypass cache, re-fetch from origin |
| `/health` | GET | Health check |
| `/stats` | GET | Basic statistics |

## Response Headers

| Header | Value | Description |
|--------|-------|-------------|
| `X-ImgPro-Status` | `hit`, `miss`, `redirect` | Cache status |
| `Cache-Control` | `public, max-age=31536000, immutable` | Browser caching |
| `ETag` | R2 object ETag | Conditional requests |

## WordPress Integration

This worker is designed for the [Bandwidth Saver](https://wordpress.org/plugins/bandwidth-saver/) plugin.

**The plugin automatically:**
- Rewrites image URLs to your CDN domain
- Falls back to origin if CDN fails
- Handles srcset and responsive images
- Encrypts API keys at rest
- Provides admin UI for configuration

**Manual integration (without plugin):**
```php
function cdn_rewrite_url($url) {
    if (preg_match('/\.(jpg|jpeg|png|gif|webp|avif|svg)$/i', $url)) {
        $parsed = parse_url($url);
        $path = $parsed['host'] . $parsed['path'];
        return 'https://cdn.yoursite.com/' . $path;
    }
    return $url;
}
add_filter('wp_get_attachment_url', 'cdn_rewrite_url');
```

## Development

```bash
# Local development
npm run dev
# Worker runs at http://localhost:8787

# Type checking
npm run typecheck

# View logs
wrangler tail

# Deploy to production
npm run deploy
```

## Cost Estimate

**Cloudflare Free Tier includes:**
- R2: 10 GB storage, 1M reads/month
- Workers: 100k requests/day
- Zero egress fees

**Typical costs:**
- Small site (100k views/month): **$0/month**
- Medium site (500k views/month): **$0-2/month**
- Large site (3M views/month): **<$1/month**

## Project Structure

```
bandwidth-saver-worker/
├── src/
│   ├── index.ts        # Main worker entry
│   ├── cache.ts        # R2 caching logic
│   ├── origin.ts       # Origin fetch with redirect validation
│   ├── validation.ts   # URL parsing, path normalization, domain validation
│   ├── analytics.ts    # Stats endpoint
│   ├── utils.ts        # Helpers (CORS, formatting)
│   ├── viewer.ts       # Debug HTML viewer
│   └── types.ts        # TypeScript types
├── wrangler.toml.example
├── package.json
└── README.md
```

## Known Limitations

| Limitation | Status | Notes |
|------------|--------|-------|
| No cache invalidation API | Planned | DELETE endpoint temporarily disabled |
| No usage metering | Planned | For managed service billing |
| No image transformation | Not planned | Focus is caching, not processing |

## Troubleshooting

### Images not caching

1. Check R2 bucket exists: `wrangler r2 bucket list`
2. Verify bucket name in wrangler.toml matches
3. Check worker logs: `wrangler tail`

### CORS errors

Set `ALLOWED_ORIGINS = "*"` or list your domains in `ORIGIN_MODE = "list"`.

### Origin timeouts

Increase `FETCH_TIMEOUT` (default 30000ms).

### Images redirect instead of caching

This is intentional for:
- Non-image content types
- Files larger than `MAX_FILE_SIZE`
- Origin errors (404, 500, etc.)
- Blocked or unregistered domains

Check `X-ImgPro-Status: redirect` header to confirm.

### Debug a specific image

Set `DEBUG = "true"` in wrangler.toml, then add `?view=1` to any image URL.

**Note:** Debug viewer is disabled by default in production to prevent information disclosure.

## License

MIT License - see [LICENSE](LICENSE)

## Links

- **WordPress Plugin:** [wordpress.org/plugins/bandwidth-saver](https://wordpress.org/plugins/bandwidth-saver/)
- **Plugin Source:** [github.com/img-pro/bandwidth-saver](https://github.com/img-pro/bandwidth-saver)
- **Issues:** [github.com/img-pro/bandwidth-saver-worker/issues](https://github.com/img-pro/bandwidth-saver-worker/issues)
