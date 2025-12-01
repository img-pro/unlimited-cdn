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
 * Parse URL to extract domain, path, cache key, and parameters
 */
export function parseUrl(url: URL): ParsedUrl {
  const decodedPathname = decodeURIComponent(url.pathname);
  const pathParts = decodedPathname.replace(/^\/+/, '').split('/');

  if (pathParts.length < 2) {
    throw new Error('Invalid URL format: /domain.com/path/to/image.jpg');
  }

  const domain = pathParts[0].toLowerCase();
  const path = '/' + pathParts.slice(1).join('/');

  if (!isValidDomain(domain)) {
    throw new Error(`Invalid domain: ${domain}`);
  }

  const encodedPath = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const sourceUrl = `https://${domain}${encodedPath}`;

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

  // Block IP addresses (IPv4)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(domain)) {
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
    /^metadata\.google\.internal$/i,
    /\.compute\.internal$/i,
    /\.ec2\.internal$/i,
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
 * Get domain record from KV
 *
 * KV Structure:
 *   Key: domain (e.g., "example.com")
 *   Value: JSON DomainRecord { status: "active" | "blocked" | "suspended" }
 */
async function getDomainRecord(
  domain: string,
  kv: KVNamespace
): Promise<DomainRecord | null> {
  try {
    const value = await kv.get(domain);
    if (!value) return null;

    return JSON.parse(value) as DomainRecord;
  } catch (error) {
    console.error('KV domain lookup failed:', error);
    return null;
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
  if (mode === 'open') {
    return { allowed: true, reason: 'allowed', source: 'default' };
  }

  // Mode: list - check ALLOWED_ORIGINS config
  if (mode === 'list') {
    const configAllowed = env.ALLOWED_ORIGINS || '';

    if (!configAllowed) {
      // Empty list = reject all
      return { allowed: false, reason: 'not_in_allowlist', source: 'config' };
    }

    if (matchesDomainList(domain, configAllowed)) {
      return { allowed: true, reason: 'allowed', source: 'config' };
    }

    return { allowed: false, reason: 'not_in_allowlist', source: 'config' };
  }

  // Mode: registered - check KV for domain record
  if (mode === 'registered') {
    if (!env.ORIGINS_KV) {
      console.error('ORIGIN_MODE is "registered" but ORIGINS_KV is not bound');
      return { allowed: false, reason: 'not_in_allowlist', source: 'kv' };
    }

    const record = await getDomainRecord(domain, env.ORIGINS_KV);

    if (!record) {
      return { allowed: false, reason: 'not_in_allowlist', source: 'kv' };
    }

    if (record.status === 'active') {
      return { allowed: true, reason: 'allowed', source: 'kv', domain_record: record };
    }

    // blocked or suspended
    return { allowed: false, reason: 'blocked', source: 'kv', domain_record: record };
  }

  // Unknown mode - default to rejecting
  console.error(`Unknown ORIGIN_MODE: ${mode}`);
  return { allowed: false, reason: 'not_in_allowlist', source: 'config' };
}

/**
 * Validate a URL's domain (used for redirect validation)
 * Extracts domain from URL and validates it
 */
export function validateUrlDomain(url: string): { valid: boolean; domain: string | null } {
  try {
    const parsed = new URL(url);
    const domain = parsed.hostname.toLowerCase();

    if (!isValidDomain(domain)) {
      return { valid: false, domain: null };
    }

    return { valid: true, domain };
  } catch {
    return { valid: false, domain: null };
  }
}

/**
 * Check if content type is an image
 */
export function isImageContentType(contentType: string): boolean {
  // Handle missing content-type
  if (!contentType) return false;

  const imageTypes = [
    'image/jpeg', 'image/jpg', 'image/png', 'image/gif',
    'image/webp', 'image/avif', 'image/svg+xml',
    'image/bmp', 'image/tiff', 'image/x-icon',
    'image/heic', 'image/heif', 'image/jxl'
  ];

  return imageTypes.some(type => contentType.toLowerCase().includes(type));
}

// =============================================================================
// REMOVED (2024-11-30): isAllowedOrigin() - deprecated legacy function
// Use validateOrigin() instead for async mode-based origin validation
// =============================================================================
