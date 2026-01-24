/**
 * R2 cache operations with streaming and range request support for media files
 */

import type { Env } from './types';
import type { RangeInfo } from './range';
import { getCORSHeaders } from './utils';

/**
 * Get cached media from R2
 */
export async function getFromCache(
  env: Env,
  cacheKey: string
): Promise<R2ObjectBody | null> {
  return await env.R2.get(cacheKey);
}

/**
 * Get cache metadata without downloading the full object
 */
export async function getCacheHead(
  env: Env,
  cacheKey: string
): Promise<R2Object | null> {
  return await env.R2.head(cacheKey);
}

/**
 * Delete media from cache
 */
export async function deleteFromCache(
  env: Env,
  cacheKey: string
): Promise<void> {
  await env.R2.delete(cacheKey);
}

/**
 * Check ETag for conditional requests
 */
export function handleConditionalRequest(
  request: Request,
  etag: string
): Response | null {
  const ifNoneMatch = request.headers.get('If-None-Match');

  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      headers: {
        'ETag': etag,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...getCORSHeaders(),
      },
    });
  }

  return null;
}

/**
 * Get cached object with optional range
 *
 * @param env - Environment bindings
 * @param cacheKey - Cache key
 * @param range - Optional range info for partial content
 */
export async function getFromCacheWithRange(
  env: Env,
  cacheKey: string,
  range?: RangeInfo
): Promise<R2ObjectBody | null> {
  if (range) {
    return await env.R2.get(cacheKey, {
      range: {
        offset: range.start,
        length: range.length,
      },
    });
  }
  return await env.R2.get(cacheKey);
}

/**
 * Store media in cache using streaming (no memory buffering)
 *
 * @param env - Environment bindings
 * @param cacheKey - Cache key
 * @param body - ReadableStream from origin response
 * @param contentType - MIME type
 * @param contentLength - Size in bytes (optional, for metadata)
 * @param sourceUrl - Original source URL
 * @param domain - Origin domain
 */
export async function storeInCacheStream(
  env: Env,
  cacheKey: string,
  body: ReadableStream,
  contentType: string,
  contentLength: number | null,
  sourceUrl: string,
  domain: string
): Promise<void> {
  // R2.put() requires streams with known length.
  // Skip caching for chunked responses (no Content-Length) to avoid:
  // 1. Memory exhaustion from buffering potentially large files
  // 2. Cloudflare Workers memory limits (typically 128MB)
  // Most media files have Content-Length; chunked is rare for static content.
  if (contentLength === null) {
    console.log(`[R2 CACHE] Skipping cache for chunked response: ${cacheKey}`);
    // Consume and discard the stream to avoid memory leaks
    await body.cancel();
    return;
  }

  const cachedAt = new Date().toISOString();

  // Wrap in FixedLengthStream for known-length streams
  const { readable, writable } = new FixedLengthStream(contentLength);
  body.pipeTo(writable).catch(() => {
    // Stream error - will be caught by R2.put
  });
  const uploadBody = readable;

  await env.R2.put(cacheKey, uploadBody, {
    httpMetadata: {
      contentType: contentType,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      sourceUrl: sourceUrl,
      domain: domain,
      cachedAt: cachedAt,
      ...(contentLength !== null ? { contentLength: contentLength.toString() } : {}),
    },
  });
}
