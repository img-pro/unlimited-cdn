/**
 * Environment bindings and configuration
 */
export interface Env {
  R2: R2Bucket;
  ORIGINS_KV?: KVNamespace;
  ORIGIN_MODE?: 'open' | 'list' | 'registered';
  ALLOWED_ORIGINS?: string;
  BLOCKED_ORIGINS?: string;
  DEBUG?: string;
  MAX_FILE_SIZE?: string;
  FETCH_TIMEOUT?: string;
  ORIGIN_USER_AGENT?: string;
}

/**
 * Origin validation result
 */
export interface OriginValidationResult {
  allowed: boolean;
  reason: 'allowed' | 'blocked' | 'not_in_allowlist' | 'invalid_domain';
  source: 'config' | 'kv' | 'default';
  domain_record?: DomainRecord;
}

/**
 * Domain record stored in KV
 *
 * Key: domain name (e.g., "example.com", "www.example.com")
 * Value: JSON-encoded DomainRecord
 *
 * Single KV read per request. Additional fields can be added as needed.
 */
export interface DomainRecord {
  status: 'active' | 'blocked' | 'suspended';
}

/**
 * Parsed URL information
 */
export interface ParsedUrl {
  domain: string;
  path: string;
  sourceUrl: string;
  cacheKey: string;
  forceReprocess: boolean;
  viewImage: boolean;
}

// REMOVED (2024-11-30): CacheStats interface - never used
// Metrics tracking not yet implemented; add back when needed

/**
 * Log entry for debugging
 */
export interface LogEntry {
  time: string;
  action: string;
  details?: string;
}

/**
 * HTML viewer options
 */
export interface HtmlViewerOptions {
  imageData: ArrayBuffer;
  contentType: string;
  status: string;
  imageSize: number;
  sourceUrl: string;
  cdnUrl: string;
  cacheKey: string;
  cachedAt?: string;
  processingTime: number;
  logs: LogEntry[];
  env: Env;
}
