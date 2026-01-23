/**
 * Origin fetching with timeout, redirects, and security validation
 *
 * PHILOSOPHY: Transparent CDN identity over WAF evasion
 * - Use honest User-Agent identifying the service
 * - Minimal headers, no browser fingerprint spoofing
 * - Rely on caching to minimize origin requests
 * - Let customers whitelist if their origin blocks us
 *
 * SECURITY: Validates redirects to prevent SSRF attacks.
 */

import type { Env } from './types';
import { validateUrlForFetch } from './validation';

/**
 * Fallback headers when user headers aren't available
 *
 * Used for non-browser requests (bots, curl, monitoring).
 * Identifies us honestly as a CDN service.
 */
const FALLBACK_HEADERS = {
  'User-Agent': 'ImgPro/1.0 (+https://img.pro/cdn)',
  'Accept': 'image/*, video/*, audio/*, application/vnd.apple.mpegurl',
} as const;

/**
 * Minimal headers to forward from user requests
 *
 * PHILOSOPHY: Forward real user data, don't fabricate.
 * - User-Agent: Real browser (natural variety)
 * - Accept: Content negotiation (what formats they support)
 * - Accept-Language: Language preference
 * - Referer: Where the image is embedded (helps bypass anti-hotlinking)
 *
 * NOT forwarded (by design):
 * - sec-ch-*: Client hints (WAF evasion territory)
 * - sec-fetch-*: Fetch metadata (inaccurate - we're a proxy)
 * - Cookie/Auth: Security risk
 *
 * NOTE: Use Pascal-Case to match FALLBACK_HEADERS. The Headers API
 * (request.headers.get) is case-insensitive, so this works for reading.
 * Using consistent casing prevents duplicate keys when objects are merged.
 */
const FORWARDED_HEADERS = [
  'User-Agent',
  'Accept',
  'Accept-Language',
  'Referer',  // Where the image is embedded (anti-hotlinking bypass)
] as const;

/**
 * Headers that must NEVER be forwarded (security)
 */
const BLOCKED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'host',
  'connection',
  'upgrade',
  'te',
  'transfer-encoding',
]);

/**
 * Extract minimal headers from client request
 *
 * Returns real user headers when available, empty object otherwise.
 */
function getForwardedHeaders(clientRequest?: Request): Record<string, string> {
  if (!clientRequest) {
    return {};
  }

  const forwarded: Record<string, string> = {};

  for (const header of FORWARDED_HEADERS) {
    const value = clientRequest.headers.get(header);
    if (value) {
      forwarded[header] = value;
    }
  }

  return forwarded;
}

export interface FetchResult {
  response: Response;
  blocked: boolean;
  blockReason?: string;
}

/**
 * Detect if response is a block/challenge page instead of actual content
 *
 * WAFs often return 200 OK with HTML challenge pages.
 * This detects common patterns to avoid caching garbage.
 *
 * @param response - The fetch response
 * @param expectedCategory - Expected media category ('image' | 'video' | 'audio' | 'media')
 */
function detectBlockedResponse(
  response: Response,
  expectedCategory: 'image' | 'video' | 'audio' | 'media' = 'media'
): {
  blocked: boolean;
  reason?: string;
} {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const contentLength = response.headers.get('content-length');

  // Check for common WAF block status codes first
  if (response.status === 403 || response.status === 401) {
    return { blocked: true, reason: `http_${response.status}` };
  }

  // Check for rate limiting
  if (response.status === 429) {
    return { blocked: true, reason: 'rate_limited' };
  }

  // HTML response = challenge/block page (for any media type)
  if (contentType.includes('text/html')) {
    if (contentLength && parseInt(contentLength, 10) < 50000) {
      return { blocked: true, reason: 'html_challenge_page' };
    }
    return { blocked: true, reason: 'html_instead_of_media' };
  }

  // Any text/* response is wrong for media
  if (contentType.startsWith('text/')) {
    return { blocked: true, reason: 'text_instead_of_media' };
  }

  // JSON response (common for API errors)
  if (contentType.includes('application/json')) {
    return { blocked: true, reason: 'json_instead_of_media' };
  }

  // Category-specific validation
  if (expectedCategory === 'image') {
    if (contentType && !contentType.startsWith('image/')) {
      return { blocked: true, reason: 'non_image_content_type' };
    }
  } else if (expectedCategory === 'video') {
    if (contentType && !contentType.startsWith('video/')) {
      return { blocked: true, reason: 'non_video_content_type' };
    }
  } else if (expectedCategory === 'audio') {
    if (contentType && !contentType.startsWith('audio/')) {
      return { blocked: true, reason: 'non_audio_content_type' };
    }
  }
  // 'media' category accepts image/*, video/*, audio/*, and HLS types

  return { blocked: false };
}

/**
 * Fetch image from origin with timeout, redirect support, and security validation
 *
 * @param url - The source URL to fetch
 * @param env - Environment bindings
 * @param clientRequest - Optional original client request (for safe header forwarding)
 * @param timeout - Optional custom timeout in ms
 * @param validateRedirect - Optional function to validate the final URL after redirects
 * @returns FetchResult with response and block detection
 * @throws Error if timeout, invalid redirect, or fetch fails
 */
export async function fetchFromOrigin(
  url: string,
  env: Env,
  clientRequest?: Request,
  timeout?: number,
  validateRedirect?: (finalUrl: string) => Promise<boolean>
): Promise<Response> {
  // Validate URL before fetch (SSRF protection)
  const urlValidation = validateUrlForFetch(url);
  if (!urlValidation.valid) {
    throw new Error(`Invalid URL: ${urlValidation.reason}`);
  }

  const fetchTimeout = timeout || parseInt(env.FETCH_TIMEOUT || '30000', 10);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);

  // Get minimal headers from user request
  const forwardedHeaders = getForwardedHeaders(clientRequest);

  // Build headers: fallbacks (for non-browser) + user headers (override if present)
  const headers: Record<string, string> = {
    ...FALLBACK_HEADERS,
    ...forwardedHeaders,
  };

  // Allow env override for User-Agent (for specific origin requirements)
  // This should be used sparingly and documented
  if (env.ORIGIN_USER_AGENT) {
    headers['User-Agent'] = env.ORIGIN_USER_AGENT;
  }

  // Optional: Forward client IP if explicitly enabled
  // Default: OFF (privacy + reduces proxy signals)
  if (env.FORWARD_CLIENT_IP === 'true' && clientRequest) {
    const clientIp = clientRequest.headers.get('cf-connecting-ip');
    if (clientIp) {
      headers['X-Forwarded-For'] = clientIp;
    }
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      redirect: 'follow',
    });

    // Security: Validate final URL after redirects
    const finalUrl = response.url;
    if (finalUrl && finalUrl !== url) {
      // URL changed due to redirect - validate the final destination
      const validation = validateUrlForFetch(finalUrl);

      if (!validation.valid) {
        throw new Error(`Redirect to invalid URL blocked: ${validation.reason}`);
      }

      // If custom validation provided (e.g., check against allowlist), use it
      if (validateRedirect) {
        const allowed = await validateRedirect(finalUrl);
        if (!allowed) {
          throw new Error(`Redirect to non-allowed origin blocked: ${finalUrl}`);
        }
      }
    }

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${fetchTimeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch and validate media from origin
 *
 * Combines fetch with block detection and content validation.
 * Returns structured result indicating success or block reason.
 */
export async function fetchMediaFromOrigin(
  url: string,
  env: Env,
  clientRequest?: Request,
  timeout?: number,
  validateRedirect?: (finalUrl: string) => Promise<boolean>
): Promise<FetchResult> {
  const response = await fetchFromOrigin(url, env, clientRequest, timeout, validateRedirect);

  // Detect if we got a block/challenge page
  const blockCheck = detectBlockedResponse(response, 'media');

  return {
    response,
    blocked: blockCheck.blocked,
    blockReason: blockCheck.reason,
  };
}

/**
 * Validate response size without consuming the body
 *
 * For streaming, we validate Content-Length header only.
 * The body stream is passed through without buffering.
 *
 * @param response - The fetch response
 * @param maxSize - Maximum allowed file size in bytes
 * @returns Validation result with size if available
 */
export function validateResponseSize(
  response: Response,
  maxSize: number
): { valid: boolean; size: number | null; reason?: string } {
  const contentLength = response.headers.get('content-length');

  if (!contentLength) {
    // No Content-Length header - allow but size unknown
    // Chunked transfer encoding won't have this header
    // Size will be enforced by createSizeLimitedStream() during streaming
    return { valid: true, size: null };
  }

  const size = parseInt(contentLength, 10);

  if (isNaN(size)) {
    return { valid: true, size: null };
  }

  if (size > maxSize) {
    return {
      valid: false,
      size,
      reason: `File too large: ${size} bytes (max ${maxSize} bytes)`
    };
  }

  return { valid: true, size };
}

/**
 * Create a byte counting stream wrapper
 *
 * Wraps a ReadableStream to count bytes as they pass through.
 * Does NOT enforce any size limit - use for cache hits where size
 * was already validated during caching.
 *
 * Key behavior: Resolves with actual bytes delivered even if client
 * disconnects early. This ensures accurate usage tracking.
 *
 * Uses direct reader/ReadableStream for minimal overhead (no TransformStream buffering).
 *
 * @param stream - The source ReadableStream
 * @returns Object with wrapped stream and a promise that resolves to bytes delivered
 */
export function createByteCountingStream(
  stream: ReadableStream<Uint8Array>
): {
  stream: ReadableStream<Uint8Array>;
  byteCount: Promise<number>;
} {
  let totalBytes = 0;
  let resolveByteCount: (count: number) => void;

  const byteCountPromise = new Promise<number>((resolve) => {
    resolveByteCount = resolve;
  });

  const reader = stream.getReader();

  const countedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          resolveByteCount(totalBytes);
          controller.close();
          return;
        }
        totalBytes += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        // Source stream errored - resolve with bytes counted so far
        // This ensures usage tracking completes even on errors
        resolveByteCount(totalBytes);
        controller.error(err);
      }
    },
    cancel() {
      resolveByteCount(totalBytes);
      // Return the promise to properly chain cancellation
      return reader.cancel();
    },
  });

  return {
    stream: countedStream,
    byteCount: byteCountPromise,
  };
}

/**
 * Create a size-limited transform stream
 *
 * Wraps a ReadableStream and enforces a maximum size limit.
 * If the stream exceeds maxSize, it aborts with an error.
 * This enables size enforcement for chunked transfer encoding
 * where Content-Length is not available upfront.
 *
 * @param stream - The source ReadableStream
 * @param maxSize - Maximum allowed size in bytes
 * @returns Object with wrapped stream and a promise that resolves to final byte count
 */
export function createSizeLimitedStream(
  stream: ReadableStream<Uint8Array>,
  maxSize: number
): {
  stream: ReadableStream<Uint8Array>;
  byteCount: Promise<number>;
} {
  let totalBytes = 0;
  let resolveByteCount: (count: number) => void;
  let rejectByteCount: (error: Error) => void;

  const byteCountPromise = new Promise<number>((resolve, reject) => {
    resolveByteCount = resolve;
    rejectByteCount = reject;
  });

  const transformStream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      totalBytes += chunk.byteLength;

      if (totalBytes > maxSize) {
        const error = new Error(`Stream exceeded max size: ${totalBytes} bytes (max ${maxSize} bytes)`);
        rejectByteCount(error);
        controller.error(error);
        return;
      }

      controller.enqueue(chunk);
    },
    flush() {
      resolveByteCount(totalBytes);
    },
    cancel(reason) {
      // Stream was cancelled (e.g., client disconnected, upstream error)
      // Reject the promise so waitUntil doesn't hang
      rejectByteCount(new Error(`Stream cancelled: ${reason || 'unknown'}`));
    },
  });

  return {
    stream: stream.pipeThrough(transformStream),
    byteCount: byteCountPromise,
  };
}
