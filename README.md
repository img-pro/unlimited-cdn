# Bandwidth Saver Worker

A Cloudflare Worker that caches and serves WordPress images globally via R2 storage.

**What it does:** Intercepts image requests, caches them in Cloudflare R2, and serves them with year-long cache headers. First request fetches from WordPress; all subsequent requests serve from the edge.

**Why use it:**
- Reduce bandwidth costs (R2 has zero egress fees)
- Faster image loading (served from Cloudflare's global network)
- Reduce load on your WordPress server

## Quick Start

**Time:** 10-15 minutes
**Cost:** Free (Cloudflare free tier includes 10GB R2 storage + 100k worker requests/day)

### Prerequisites

- A Cloudflare account with a domain
- Node.js 18 or later
- A WordPress site you want to accelerate

### Step 1: Install Wrangler CLI

```bash
npm install -g wrangler
wrangler login
```

### Step 2: Download and Configure

```bash
# Download the worker
git clone https://github.com/img-pro/bandwidth-saver-worker.git
cd bandwidth-saver-worker
npm install

# Create your config
cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml` and replace these values:

| Placeholder | Replace with | Example |
|-------------|--------------|---------|
| `YOUR_ACCOUNT_ID` | Your Cloudflare account ID | `abc123def456` |
| `YOUR_DOMAIN.com` | Your CDN subdomain | `cdn.example.com` |
| `YOUR_WORDPRESS_DOMAIN.com` | Your WordPress site domain | `example.com,www.example.com` |

**Finding your account ID:** Run `wrangler whoami` or look at your Cloudflare dashboard URL.

### Step 3: Create R2 Bucket

```bash
wrangler r2 bucket create bandwidth-saver-cache
```

### Step 4: Deploy

```bash
npm run deploy
```

You should see output like:
```
Uploaded bandwidth-saver (2.5 sec)
Deployed bandwidth-saver triggers
  cdn.example.com/*
```

### Step 5: Add Custom Domain

1. Go to **Cloudflare Dashboard → Workers & Pages → bandwidth-saver**
2. Click **Settings → Domains & Routes**
3. Click **Add → Custom Domain**
4. Enter your CDN domain (e.g., `cdn.example.com`)
5. Click **Add Domain**

Cloudflare automatically configures DNS and provisions an SSL certificate. Wait 1-2 minutes for it to activate.

### Step 6: Test It

Open your browser and try:

```
https://cdn.example.com/YOUR_WORDPRESS_DOMAIN.com/wp-content/uploads/any-image.jpg
```

You should see the image. Check the response headers:
- `X-ImgPro-Status: miss` (first request - fetched from WordPress)
- `X-ImgPro-Status: hit` (subsequent requests - served from R2)

## WordPress Integration

### Option A: Use the Plugin (Recommended)

Install the [Bandwidth Saver](https://wordpress.org/plugins/bandwidth-saver/) plugin:

1. In WordPress admin, go to **Plugins → Add New**
2. Search for "Bandwidth Saver"
3. Install and activate
4. Go to **Settings → Bandwidth Saver**
5. Click the **Self-Host** tab
6. Enter your CDN domain (e.g., `cdn.example.com`)
7. Click **Add Domain**, then **Enable CDN**

The plugin automatically rewrites all image URLs to use your CDN.

### Option B: Manual Integration

Add this to your theme's `functions.php`:

```php
/**
 * Rewrite image URLs to use CDN
 */
function cdn_rewrite_url($url) {
    // Only rewrite image URLs
    if (!preg_match('/\.(jpg|jpeg|png|gif|webp|avif|svg)(\?.*)?$/i', $url)) {
        return $url;
    }

    // Your CDN domain
    $cdn_domain = 'cdn.example.com';

    // Parse the URL
    $parsed = parse_url($url);
    if (!$parsed || empty($parsed['host'])) {
        return $url;
    }

    // Build CDN URL: https://cdn.example.com/original-domain.com/path
    $path = $parsed['host'] . ($parsed['path'] ?? '');
    if (!empty($parsed['query'])) {
        $path .= '?' . $parsed['query'];
    }

    return 'https://' . $cdn_domain . '/' . $path;
}

// Apply to WordPress image functions
add_filter('wp_get_attachment_url', 'cdn_rewrite_url');
add_filter('wp_get_attachment_image_src', function($image) {
    if ($image && !empty($image[0])) {
        $image[0] = cdn_rewrite_url($image[0]);
    }
    return $image;
});
```

## How It Works

```
Browser requests: cdn.example.com/example.com/wp-content/uploads/photo.jpg
                              ↓
                         [Worker]
                              ↓
                 ┌────────────┴────────────┐
                 │                         │
            Cache HIT                 Cache MISS
                 │                         │
                 ↓                         ↓
          Return from R2          Fetch from WordPress
          (< 50ms globally)              ↓
                                   Store in R2
                                         ↓
                                   Return image
```

**URL Structure:**
```
https://[cdn-domain]/[wordpress-domain]/[path-to-image]
```

**Example:**
```
Original:  https://example.com/wp-content/uploads/2024/photo.jpg
CDN URL:   https://cdn.example.com/example.com/wp-content/uploads/2024/photo.jpg
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `ORIGIN_MODE` | `open` | `list` = only allow ALLOWED_ORIGINS, `open` = allow any domain |
| `ALLOWED_ORIGINS` | - | Comma-separated domains for `list` mode (supports wildcards) |
| `BLOCKED_ORIGINS` | - | Domains to always block; use `*` as kill switch |
| `MAX_FILE_SIZE` | `50MB` | Max file size to cache; larger files redirect to origin |
| `FETCH_TIMEOUT` | `30000` | Origin fetch timeout in milliseconds |
| `DEBUG` | `false` | Enable `?view=1` debug parameter |

### Origin Modes

**`list` (recommended for production):**
```toml
ORIGIN_MODE = "list"
ALLOWED_ORIGINS = "YOUR_WORDPRESS_DOMAIN.com,www.YOUR_WORDPRESS_DOMAIN.com"
```
Only specified domains can use your CDN. Others redirect to origin.

**ALLOWED_ORIGINS examples:**
| Pattern | Matches |
|---------|---------|
| `example.com` | `example.com` only |
| `example.com,www.example.com` | Both domains |
| `*.example.com` | All subdomains (but NOT `example.com` itself) |

**`open` (for testing):**
```toml
ORIGIN_MODE = "open"
```
Any domain can use your CDN. Only use for development.

## Special Endpoints

| Endpoint | Description |
|----------|-------------|
| `/health` | Health check - returns `{"status": "healthy"}` |
| `/stats` | Basic service info |
| `/{domain}/{path}?force=1` | Bypass cache, fetch fresh from origin |
| `/{domain}/{path}?view=1` | Debug viewer (requires `DEBUG=true`) |

## Response Headers

| Header | Values | Meaning |
|--------|--------|---------|
| `X-ImgPro-Status` | `hit` | Served from R2 cache |
| | `miss` | Fetched from origin, now cached |
| | `redirect` | Redirected to origin (blocked, too large, or not an image) |
| `Cache-Control` | `public, max-age=31536000, immutable` | Browser caches for 1 year |

## Troubleshooting

### "Invalid domain" or images redirect instead of caching

1. Check `ORIGIN_MODE` in wrangler.toml
2. If using `list` mode, verify `ALLOWED_ORIGINS` includes your domain
3. Remember: `ALLOWED_ORIGINS` is comma-separated, no spaces: `"example.com,www.example.com"`

### Images show "redirect" status

This is intentional for:
- Domains not in your allowlist
- Non-image files (HTML, CSS, JS, etc.)
- Files larger than `MAX_FILE_SIZE`
- Origin errors (404, 500, etc.)

The CDN redirects to the original URL so the browser fetches directly from WordPress.

### R2 bucket not found

```bash
# Check bucket exists
wrangler r2 bucket list

# Bucket name in wrangler.toml must match exactly
```

### Custom domain not working

1. Wait 2-3 minutes after adding (DNS propagation)
2. Check Workers & Pages → your worker → Settings → Domains
3. Ensure the domain shows "Active" status

### Debug a specific image

1. Set `DEBUG = "true"` in wrangler.toml
2. Deploy: `npm run deploy`
3. Open: `https://cdn.example.com/example.com/path/to/image.jpg?view=1`
4. See detailed processing info

**Important:** Set `DEBUG = "false"` in production to prevent information disclosure.

## Cost Estimate

Cloudflare's free tier is generous:

| Resource | Free Tier | Typical Small Site |
|----------|-----------|-------------------|
| R2 Storage | 10 GB | 1-5 GB |
| R2 Reads | 10M/month | ~100k/month |
| R2 Writes | 1M/month | ~10k/month |
| Worker Requests | 100k/day | ~5k/day |
| **Egress** | **Unlimited, free** | N/A |

**Typical costs:**
- Small blog (50k pageviews/month): **$0/month**
- Medium site (200k pageviews/month): **$0/month**
- Large site (1M+ pageviews/month): **$0-5/month**

The main cost savings come from R2's zero egress fees. If you're currently paying for CDN bandwidth, this can reduce costs significantly.

## Security Features

| Feature | Description |
|---------|-------------|
| **Domain Allowlist** | Only serve images from approved domains |
| **SSRF Protection** | Blocks requests to internal IPs, localhost, metadata services |
| **Path Traversal Prevention** | Normalizes `../` sequences to prevent directory escape |
| **Content Validation** | Only caches actual images, not HTML error pages |
| **Redirect Validation** | Validates redirected URLs against allowlist |

## Development

```bash
# Local development (uses local R2 simulator)
npm run dev

# Type checking
npm run build

# View production logs
npm run tail

# Deploy
npm run deploy
```

## Project Structure

```
bandwidth-saver-worker/
├── src/
│   ├── index.ts        # Main request handler
│   ├── types.ts        # TypeScript types
│   ├── validation.ts   # URL parsing, domain validation
│   ├── cache.ts        # R2 operations
│   ├── origin.ts       # Fetch from WordPress
│   ├── analytics.ts    # /stats endpoint
│   ├── viewer.ts       # Debug HTML viewer
│   └── utils.ts        # Helpers
├── wrangler.toml.example
├── package.json
└── README.md
```

## FAQ

**Q: Can I use this with multiple WordPress sites?**
A: Yes. Add all domains to `ALLOWED_ORIGINS`: `"site1.com,site2.com,site3.com"`

**Q: How do I clear the cache for a specific image?**
A: Currently, cache invalidation requires manually deleting from R2. Use `?force=1` to bypass cache for testing.

**Q: Does this work with image optimization plugins?**
A: Yes. The CDN caches whatever WordPress serves, including optimized images from plugins like ShortPixel, Imagify, etc.

**Q: What happens if my WordPress site goes down?**
A: Cached images continue to be served from R2. New images that aren't cached will fail (redirect to origin, user sees WordPress error).

**Q: Can I use this without WordPress?**
A: Yes. The worker caches any image URL. Just configure `ALLOWED_ORIGINS` with your domain.

## Links

- **WordPress Plugin:** [wordpress.org/plugins/bandwidth-saver](https://wordpress.org/plugins/bandwidth-saver/)
- **Managed Service:** [img.pro](https://img.pro) (no setup required)
- **Issues:** [GitHub Issues](https://github.com/img-pro/bandwidth-saver-worker/issues)

## License

MIT License - see [LICENSE](LICENSE)
