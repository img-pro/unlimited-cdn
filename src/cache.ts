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
 * Handle HEAD request for cached media
 */
export async function handleHeadRequest(
  env: Env,
  cacheKey: string
): Promise<Response> {
  const cached = await getCacheHead(env, cacheKey);

  if (cached) {
    return new Response(null, {
      status: 200,
      headers: {
        'Content-Type': cached.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Length': cached.size.toString(),
        'Accept-Ranges': 'bytes',
        'ETag': cached.etag,
        'Last-Modified': cached.uploaded.toUTCString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-ImgPro-Status': 'cached',
        'X-ImgPro-Cached-At': cached.customMetadata?.cachedAt || '',
        ...getCORSHeaders(),
      },
    });
  }

  return new Response(null, {
    status: 404,
    headers: getCORSHeaders(),
  });
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
  const cachedAt = new Date().toISOString();

  // R2.put() requires streams with known length.
  // Use FixedLengthStream when Content-Length is available.
  // For chunked responses (no Content-Length), buffer the entire content.
  let uploadBody: ReadableStream | ArrayBuffer;

  if (contentLength !== null) {
    // Wrap in FixedLengthStream for known-length streams
    const { readable, writable } = new FixedLengthStream(contentLength);
    body.pipeTo(writable).catch(() => {
      // Stream error - will be caught by R2.put
    });
    uploadBody = readable;
  } else {
    // For unknown length (chunked), we must buffer
    // This is less efficient but necessary for R2
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalLength += value.byteLength;
    }

    // Combine chunks into single ArrayBuffer
    const buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    uploadBody = buffer.buffer;
  }

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
