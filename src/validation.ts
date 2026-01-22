/**
 * URL parsing and validation functions
 *
 * ORIGIN_MODE controls how domains are validated:
 *   - "open"       : Allow all domains (development/testing)
 *   - "list"       : Allow only domains in ALLOWED_ORIGINS config
 *   - "registered" : Allow only domains with active KV records
 *
 * BLOCKED_ORIGINS is always checked regardless of mode.
 *
 * Non-allowed origins are redirected to the original URL (not blocked).
 * This ensures no service disruption while preventing CDN abuse.
 */

import type { Env, ParsedUrl, OriginValidationResult, DomainRecord } from './types';

/**
 * Normalize a path to prevent path traversal attacks
 *
 * SECURITY: Resolves ".." and "." segments to prevent cache key collisions
 * and potential SSRF via path manipulation.
 *
 * Example: "/a/../b/./c.jpg" -> "/b/c.jpg"
 */
function normalizePath(path: string): string {
  const segments = path.split('/').filter(s => s !== '');
  const normalized: string[] = [];

  for (const segment of segments) {
    if (segment === '..') {
      // Go up one directory (if possible)
      normalized.pop();
    } else if (segment !== '.') {
      // Skip "." (current directory), add everything else
      normalized.push(segment);
    }
  }

  return '/' + normalized.join('/');
}

/**
 * Parse URL to extract domain, path, cache key, and parameters
 */
export function parseUrl(url: URL): ParsedUrl {
  const decodedPathname = decodeURIComponent(url.pathname);
  const pathParts = decodedPathname.replace(/^\/+/, '').split('/');

  if (pathParts.length < 2) {
    throw new Error('Invalid URL format: /domain.com/path/to/image.jpg');
  }

  const domain = pathParts[0].toLowerCase();
  const rawPath = '/' + pathParts.slice(1).join('/');

  // SECURITY: Normalize path to prevent traversal attacks
  const path = normalizePath(rawPath);

  // Reject if path tries to escape (normalized to empty or root)
  if (path === '/' || path === '') {
    throw new Error('Invalid path: path traversal detected');
  }

  if (!isValidDomain(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }

  const encodedPath = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const sourceUrl = `https://${domain}${encodedPath}`;

  // SECURITY: Use normalized path in cache key to prevent collisions
  const cacheKey = `${domain}${path}`;

  const forceReprocess = url.searchParams.get('force') === 'true' ||
                         url.searchParams.get('force') === '1';

  const viewImage = url.searchParams.get('view') === 'true' ||
                    url.searchParams.get('view') === '1';

  return { domain, path, sourceUrl, cacheKey, forceReprocess, viewImage };
}

/**
 * Validate domain format
 *
 * SECURITY: Only allows valid domain names.
 * Blocks all IP addresses (IPv4, IPv6) and internal hostnames to prevent SSRF.
 */
export function isValidDomain(domain: string): boolean {
  // Block empty or whitespace-only
  if (!domain || !domain.trim()) {
    return false;
  }

  const lowerDomain = domain.toLowerCase();

  // Block localhost and common internal hostnames
  const blockedHostnames = [
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
  ];
  if (blockedHostnames.includes(lowerDomain)) {
    return false;
  }

  // Block IP addresses (IPv4) - validate each octet is 0-255
  const ipv4Match = domain.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    // Block all IPv4 addresses (valid or invalid octets)
    return false;
  }

  // Block IPv6 addresses (various formats including bracketed)
  if (domain.includes(':') || /^\[.*\]$/.test(domain)) {
    return false;
  }

  // Block internal/private domain patterns
  const internalPatterns = [
    /\.local$/i,
    /\.localhost$/i,
    /\.internal$/i,
    /\.lan$/i,
    /\.home$/i,
    /\.corp$/i,
    /\.private$/i,
    // Cloud provider metadata services
    /^metadata\.google\.internal$/i,
    /\.compute\.internal$/i,
    /\.ec2\.internal$/i,
    /^instance-data\./i,
    // Common metadata hostnames
    /^metadata\./i,
    /^169\.254\./,  // Link-local / metadata IP range as domain
  ];
  if (internalPatterns.some(pattern => pattern.test(lowerDomain))) {
    return false;
  }

  // Validate standard domain format:
  // - Must have at least one dot (TLD required)
  // - Each label: starts/ends with alphanumeric, can have hyphens in middle
  // - TLD must be at least 2 characters and alphabetic only
  const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
  return domainRegex.test(domain);
}

/**
 * Check if a domain matches a pattern
 *
 * Patterns:
 * - "example.com" = exact match only
 * - "*.example.com" = any subdomain of example.com (NOT example.com itself)
 *
 * SECURITY: Proper subdomain matching prevents "attacker-example.com"
 * from matching "*.example.com"
 */
export function matchesDomainPattern(domain: string, pattern: string): boolean {
  const lowerDomain = domain.toLowerCase();
  const lowerPattern = pattern.toLowerCase().trim();

  if (!lowerPattern) {
    return false;
  }

  // Wildcard subdomain pattern: *.example.com
  if (lowerPattern.startsWith('*.')) {
    const baseDomain = lowerPattern.substring(2); // "example.com"

    // Must end with ".baseDomain" (proper subdomain)
    // e.g., "sub.example.com" ends with ".example.com"
    return lowerDomain.endsWith('.' + baseDomain);
  }

  // Exact match
  return lowerDomain === lowerPattern;
}

/**
 * Check if domain matches any pattern in a comma-separated list
 */
export function matchesDomainList(domain: string, list: string): boolean {
  if (!list || list.trim() === '') {
    return false;
  }

  const patterns = list.split(',').map(p => p.trim()).filter(p => p !== '');
  return patterns.some(pattern => matchesDomainPattern(domain, pattern));
}

/**
 * Get domain records from KV
 *
 * KV Structure (M:N model):
 *   Key: domain (e.g., "example.com")
 *   Value: JSON DomainRecord[] - Array of { site_id, status }
 *
 * Same domain can belong to multiple sites (e.g., shared agency CDN)
 */
async function getDomainRecords(
  domain: string,
  kv: KVNamespace
): Promise<DomainRecord[]> {
  try {
    const value = await kv.get(domain);
    if (!value) return [];

    const parsed = JSON.parse(value);
    // Value should always be array from billing service
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('KV domain lookup failed:', error);
    return [];
  }
}

/**
 * Validate origin based on ORIGIN_MODE
 *
 * Modes:
 *   - "open"       : Allow all domains (check blocklist only)
 *   - "list"       : Allow only domains in ALLOWED_ORIGINS config
 *   - "registered" : Allow only domains with active KV records
 *
 * BLOCKED_ORIGINS is always checked first, regardless of mode.
 */
export async function validateOrigin(
  domain: string,
  env: Env
): Promise<OriginValidationResult> {
  const mode = env.ORIGIN_MODE || 'open';

  // Always check blocklist first (any mode)
  const configBlocked = env.BLOCKED_ORIGINS || '';

  // Kill switch: block everything
  if (configBlocked === '*') {
    return { allowed: false, reason: 'blocked', source: 'config' };
  }

  // Check if domain is in config blocklist
  if (configBlocked && matchesDomainList(domain, configBlocked)) {
    return { allowed: false, reason: 'blocked', source: 'config' };
  }

  // Mode: open - allow all (blocklist already checked)
  // BUT still lookup KV for usage tracking if available
  if (mode === 'open') {
    // Try to get domain records for usage tracking (non-blocking)
    let domain_records: DomainRecord[] | undefined;
    if (env.ORIGINS_KV) {
      try {
        domain_records = await getDomainRecords(domain, env.ORIGINS_KV);
      } catch (e) {
        // Silently fail - tracking is optional in open mode
        console.warn('[validateOrigin] KV lookup failed in open mode:', e);
      }
    }
    return { allowed: true, reason: 'allowed', source: 'default', domain_records };
  }

  // Mode: list - check ALLOWED_ORIGINS config
  if (mode === 'list') {
    const configAllowed = env.ALLOWED_ORIGINS || '';

    if (!configAllowed) {
      // Empty list = reject all
      return { allowed: false, reason: 'not_in_allowlist', source: 'config' };
    }

    if (matchesDomainList(domain, configAllowed)) {
      // Lookup domain records for usage tracking (non-blocking)
      let domain_records: DomainRecord[] | undefined;
      if (env.ORIGINS_KV) {
        try {
          domain_records = await getDomainRecords(domain, env.ORIGINS_KV);
        } catch (e) {
          // Silently fail - tracking is optional in list mode
          console.warn('[validateOrigin] KV lookup failed in list mode:', e);
        }
      }
      return { allowed: true, reason: 'allowed', source: 'config', domain_records };
    }

    return { allowed: false, reason: 'not_in_allowlist', source: 'config' };
  }

  // Mode: registered - check KV for domain records (M:N model)
  if (mode === 'registered') {
    if (!env.ORIGINS_KV) {
      console.error('ORIGIN_MODE is "registered" but ORIGINS_KV is not bound');
      return { allowed: false, reason: 'not_in_allowlist', source: 'kv' };
    }

    const records = await getDomainRecords(domain, env.ORIGINS_KV);

    if (records.length === 0) {
      return { allowed: false, reason: 'not_in_allowlist', source: 'kv' };
    }

    // Check if at least one record is active
    const hasActive = records.some(r => r.status === 'active');

    if (hasActive) {
      return { allowed: true, reason: 'allowed', source: 'kv', domain_records: records };
    }

    // All records are blocked or suspended
    return { allowed: false, reason: 'blocked', source: 'kv', domain_records: records };
  }

  // Unknown mode - default to rejecting
  console.error(`Unknown ORIGIN_MODE: ${mode}`);
  return { allowed: false, reason: 'not_in_allowlist', source: 'config' };
}

/**
 * Validate a URL for SSRF safety
 *
 * SECURITY: Comprehensive URL validation to prevent SSRF attacks:
 * - Must be http or https scheme
 * - No username/password credentials in URL
 * - No fragments (shouldn't be in server-side URLs)
 * - Only standard ports (80, 443) or no port specified
 * - Valid, non-internal domain
 */
export function validateUrlForFetch(url: string): {
  valid: boolean;
  domain: string | null;
  reason?: string;
} {
  try {
    const parsed = new URL(url);

    // Must be http or https
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, domain: null, reason: 'invalid_scheme' };
    }

    // No credentials in URL
    if (parsed.username || parsed.password) {
      return { valid: false, domain: null, reason: 'credentials_in_url' };
    }

    // Only allow standard ports (or default)
    const port = parsed.port;
    if (port && port !== '80' && port !== '443') {
      return { valid: false, domain: null, reason: 'non_standard_port' };
    }

    const domain = parsed.hostname.toLowerCase();

    if (!isValidDomain(domain)) {
      return { valid: false, domain: null, reason: 'invalid_domain' };
    }

    return { valid: true, domain };
  } catch {
    return { valid: false, domain: null, reason: 'invalid_url' };
  }
}

/**
 * Check if content type is an image
 *
 * SECURITY: Uses startsWith() for proper MIME type matching instead of includes().
 * This prevents edge cases where a malformed Content-Type like "text/html; image/png"
 * could bypass validation. The Content-Type header format is: type/subtype[; params]
 */
export function isImageContentType(contentType: string): boolean {
  // Handle missing content-type
  if (!contentType) return false;

  // Normalize: lowercase and extract the MIME type (before any semicolon)
  const mimeType = contentType.toLowerCase().split(';')[0].trim();

  const imageTypes = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
    'image/webp', 'image/avif', 'image/svg+xml',
    'image/bmp', 'image/tiff', 'image/x-icon',
    'image/heic', 'image/heif', 'image/jxl'
  ];

  return imageTypes.includes(mimeType);
}

/**
 * Check if content type is video
 */
export function isVideoContentType(contentType: string): boolean {
  if (!contentType) return false;

  const mimeType = contentType.toLowerCase().split(';')[0].trim();

  const videoTypes = [
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'video/x-matroska',
    'video/x-m4v',
    'video/mp2t',  // HLS segments (.ts)
  ];

  return videoTypes.includes(mimeType);
}

/**
 * Check if content type is audio
 */
export function isAudioContentType(contentType: string): boolean {
  if (!contentType) return false;

  const mimeType = contentType.toLowerCase().split(';')[0].trim();

  const audioTypes = [
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/x-m4a',
    'audio/mp4',
    'audio/aac',
    'audio/flac',
  ];

  return audioTypes.includes(mimeType);
}

/**
 * Check if content type is HLS manifest
 */
export function isHLSContentType(contentType: string): boolean {
  if (!contentType) return false;

  const mimeType = contentType.toLowerCase().split(';')[0].trim();

  const hlsTypes = [
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'audio/mpegurl',
    'audio/x-mpegurl',
  ];

  return hlsTypes.includes(mimeType);
}

/**
 * Check if content type is any supported media (image, video, audio, HLS)
 */
export function isMediaContentType(contentType: string): boolean {
  return isImageContentType(contentType) ||
         isVideoContentType(contentType) ||
         isAudioContentType(contentType) ||
         isHLSContentType(contentType);
}

