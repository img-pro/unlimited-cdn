# Edge Image Proxy

A self-hosted image CDN powered by Cloudflare Workers and R2. Cache and serve images from any origin with zero egress fees.

```
https://cdn.yourdomain.com/origin.com/path/to/image.jpg
        └──────┬───────┘ └────┬────┘
         Your CDN       Origin server
```

## Why Use This?

| Problem | Solution |
|---------|----------|
| **High bandwidth costs** | R2 has zero egress fees—serve unlimited images for free |
| **Slow image loading** | Images served from 300+ edge locations worldwide |
| **Origin server load** | First request hits origin; all others served from cache |
| **Vendor lock-in** | Self-hosted, open source, runs on your Cloudflare account |

**Compare to:** imgix, Cloudinary, KeyCDN, BunnyCDN—but self-hosted and with zero egress fees.

## Use Cases

Works with **any origin server** that serves images over HTTPS:

- **Static sites** — Gatsby, Hugo, Eleventy, Astro, Jekyll
- **JavaScript frameworks** — Next.js, Nuxt, SvelteKit, Remix
- **E-commerce** — Shopify, WooCommerce, Magento, custom stores
- **CMS platforms** — WordPress, Ghost, Strapi, Contentful, Sanity
- **Web applications** — Rails, Django, Laravel, Express, any backend
- **Mobile app backends** — Serve optimized images to iOS/Android apps

## Quick Start

**Prerequisites:** Cloudflare account with a domain, Node.js 18+

### 1. Install and Configure

```bash
npm install -g wrangler
wrangler login

git clone https://github.com/img-pro/unlimited-cdn.git
cd unlimited-cdn-worker
npm install

cp wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml`:
- Replace `YOUR_ACCOUNT_ID` with your Cloudflare account ID
- Replace `example.com` with your domain

| Setting | Purpose | Example |
|---------|---------|---------|
| `cdn.example.com` (routes) | Your CDN endpoint | `cdn.mysite.com` |
| `example.com` (zone_name) | Your Cloudflare zone | `mysite.com` |
| `ALLOWED_ORIGINS` | Origin servers to cache from | `mysite.com,www.mysite.com` |

### 2. Create R2 Bucket and Deploy

```bash
wrangler r2 bucket create unlimited-cdn-cache
npm run deploy
```

### 3. Add Custom Domain

1. **Cloudflare Dashboard → Workers & Pages → unlimited-cdn**
2. **Settings → Domains & Routes → Add → Custom Domain**
3. Enter your CDN domain (e.g., `cdn.example.com`)

### 4. Test It

```bash
curl -I "https://cdn.example.com/origin.com/images/photo.jpg"
```

Check `X-Cache-Status` header:
- `miss` — Fetched from origin, now cached
- `hit` — Served from R2 cache

## How It Works

```
Browser requests: cdn.example.com/origin.com/images/photo.jpg
                              ↓
                         [Worker]
                              ↓
                 ┌────────────┴────────────┐
                 │                         │
            Cache HIT                 Cache MISS
                 │                         │
                 ↓                         ↓
          Return from R2          Fetch from origin
          (< 50ms globally)              ↓
                                   Store in R2
                                         ↓
                                   Return image
```

**URL format:** `https://[cdn-domain]/[origin-domain]/[path]`

## Integration Examples

### Any Platform

Rewrite image URLs from:
```
https://origin.com/images/photo.jpg
```
To:
```
https://cdn.example.com/origin.com/images/photo.jpg
```

How you do this depends on your stack—typically a middleware, helper function, or template filter.

### WordPress

Install the [Unlimited CDN](https://wordpress.org/plugins/bandwidth-saver/) plugin for automatic URL rewriting:

1. **Plugins → Add New** → Search "Unlimited CDN"
2. **Settings → Unlimited CDN → Self-Host tab**
3. Enter your CDN domain and enable

### Next.js / Nuxt / React

```javascript
// next.config.js
module.exports = {
  images: {
    loader: 'custom',
    loaderFile: './image-loader.js',
  },
}

// image-loader.js
export default function cloudflareLoader({ src, width, quality }) {
  const origin = new URL(src).host;
  const path = new URL(src).pathname;
  return `https://cdn.example.com/${origin}${path}`;
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ORIGIN_MODE` | `open` | `list` = allowlist only, `open` = any origin |
| `ALLOWED_ORIGINS` | — | Comma-separated origin domains (supports `*.example.com` wildcards) |
| `BLOCKED_ORIGINS` | — | Domains to block; `*` blocks everything (kill switch) |
| `MAX_FILE_SIZE` | `50MB` | Larger files redirect to origin |
| `FETCH_TIMEOUT` | `30000` | Origin timeout in milliseconds |
| `DEBUG` | `false` | Enable `?view=1` debug mode |

### Origin Modes

**`list` (production):** Only cache from allowed origins
```toml
ORIGIN_MODE = "list"
ALLOWED_ORIGINS = "example.com,www.example.com,images.example.com"
```

**`open` (development):** Cache from any origin
```toml
ORIGIN_MODE = "open"
```

## API Reference

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `/{origin}/{path}` | Proxy and cache image |
| `/{origin}/{path}?force=1` | Bypass cache, fetch fresh |
| `/{origin}/{path}?view=1` | Debug info (requires `DEBUG=true`) |
| `/health` | Health check |
| `/stats` | Service info |

### Response Headers

| Header | Values |
|--------|--------|
| `X-Cache-Status` | `hit`, `miss`, `redirect` |
| `Cache-Control` | `public, max-age=31536000, immutable` |

## Cost

Cloudflare's free tier covers most use cases:

| Resource | Free Tier | Typical Usage |
|----------|-----------|---------------|
| R2 Storage | 10 GB | 1-5 GB |
| R2 Operations | 10M reads, 1M writes/mo | ~100k reads/mo |
| Worker Requests | 100k/day | ~5k/day |
| **Egress** | **Unlimited** | — |

**Estimated costs:**
- Under 1M pageviews/month: **$0**
- 1-10M pageviews/month: **$0-5**

The key savings: R2 egress is free. Traditional CDNs charge $0.02-0.08/GB.

## Security

| Feature | Description |
|---------|-------------|
| Domain allowlist | Only proxy approved origins |
| SSRF protection | Blocks internal IPs, localhost, cloud metadata |
| Path traversal prevention | Normalizes `../` sequences |
| Content validation | Only caches valid images |

## FAQ

**Q: Can I use this with multiple origin servers?**
Yes. Add all domains to `ALLOWED_ORIGINS`: `"site1.com,www.site1.com,site2.com,www.site2.com"`

**Q: How do I invalidate cached images?**
Use `?force=1` to bypass cache, or delete directly from R2. Bulk invalidation requires R2 API.

**Q: What image formats are supported?**
JPG, PNG, GIF, WebP, AVIF, SVG, ICO, BMP, TIFF.

**Q: What happens if the origin is down?**
Cached images continue serving. Uncached images return the origin's error.

**Q: Does this do image transformation/optimization?**
No. This is a caching proxy only. For transformations, consider [Cloudflare Images](https://developers.cloudflare.com/images/) or add a transformation layer.

## Development

```bash
npm run dev      # Local development
npm run build    # Type checking
npm run deploy   # Deploy to Cloudflare
npm run tail     # View production logs
```

## Links

- [Unlimited CDN WordPress Plugin](https://wordpress.org/plugins/bandwidth-saver/) — Automatic integration for WordPress
- [img.pro](https://img.pro) — Managed service (no setup required)
- [GitHub Issues](https://github.com/img-pro/unlimited-cdn/issues)

## License

MIT
