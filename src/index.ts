/**
 * ImgPro - CDN Worker
 *
 * Single-domain CDN architecture: serves images directly from the worker.
 * - Cache hit: Returns image from R2 with long cache headers
 * - Cache miss: Fetches from origin, stores in R2, returns image
 *
 * Error handling philosophy:
 * - CDN serves image OR redirects to origin. Never errors for origin issues.
 * - If we can't serve via CDN for any reason, redirect to origin.
 * - User sees the real origin response (404, 500, etc.) - honest and simple.
 * - Only hard errors for truly invalid requests (IPs, SSRF attempts).
 *
 * Hard errors (400/403):
 * - Invalid domains (IPs, internal hostnames) - security
 * - SSRF redirect attempts - security
 *
 * No separate R2 public bucket domain needed - the worker IS the CDN.
 *
 * @version 1.3.0
 */

import type { Env, LogEntry } from './types';
import { parseUrl, validateOrigin, isImageContentType, isMediaContentType, validateUrlForFetch } from './validation';
import { fetchMediaFromOrigin, validateResponseSize, createSizeLimitedStream } from './origin';
import {
  getFromCache,
  getFromCacheWithRange,
  getCacheHead,
  handleConditionalRequest,
  storeInCacheStream,
} from './cache';
import { parseRangeHeader, buildContentRangeHeader } from './range';
import { createHtmlViewer } from './viewer';
import { createStatsResponse, createLogger } from './analytics';
import { errorResponse, getCORSHeaders, formatBytes, parseFileSize, VERSION } from './utils';
import { trackUsage } from './usage';


// Export Durable Object for usage tracking
export { SiteUsageTracker } from './usage-tracker';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: getCORSHeaders(),
      });
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/ping') {
      return new Response(JSON.stringify({
        status: 'healthy',
        version: VERSION,
        timestamp: new Date().toISOString(),
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ...getCORSHeaders(),
        },
      });
    }

    // Stats endpoint
    if (url.pathname === '/stats') {
      return createStatsResponse(env);
    }

    try {
      // Parse URL: /example.com/wp-content/uploads/photo.jpg
      const parsed = parseUrl(url);

      // Workflow logs for HTML viewer
      const logs: LogEntry[] = [];
      const startTime = Date.now();
      const addLog = createLogger(logs, startTime, env.DEBUG === 'true');

      addLog('Request received', `${request.method} ${parsed.domain}${parsed.path}`);

      // DELETE functionality disabled - will be implemented with proper authentication later
      // See issue W-03/W-11 in security audit
      if (request.method === 'DELETE') {
        return errorResponse('DELETE method not currently supported', 405);
      }

      // Only GET and HEAD requests beyond this point
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return errorResponse('Method not allowed', 405);
      }

      const isHeadRequest = request.method === 'HEAD';

      // Check for Range header early - determines our cache strategy
      const rangeHeader = request.headers.get('Range');

      // Parse standard ranges early (bytes=X-Y where both X and Y are specified)
      // This allows us to fetch metadata and range data in parallel
      let standardRangeStart: number | null = null;
      let standardRangeEnd: number | null = null;
      if (rangeHeader && rangeHeader.startsWith('bytes=')) {
        const match = rangeHeader.match(/^bytes=(\d+)-(\d+)$/);
        if (match) {
          standardRangeStart = parseInt(match[1], 10);
          standardRangeEnd = parseInt(match[2], 10);
        }
      }
      // Only consider it a valid standard range if start <= end
      // Invalid ranges like bytes=100-50 should fall through to parseRangeHeader
      // which will return null and trigger a proper 416 response
      const isStandardRange = standardRangeStart !== null &&
                              standardRangeEnd !== null &&
                              standardRangeStart <= standardRangeEnd;

      // Detect "full file" range requests like bytes=0- (Safari video probe)
      // These should fetch the full object upfront, not HEAD then GET
      const isFullFileRange = rangeHeader === 'bytes=0-';

      // Run validation and cache operations in parallel
      // For HEAD requests: only fetch metadata (never full body)
      // For standard range requests: fetch HEAD (metadata) AND range data in parallel
      // For full-file ranges (bytes=0-): fetch full object (Safari video probe)
      // For other range requests: just HEAD (then fetch range after)
      // For full requests: get the full object
      const [validation, cacheResult, rangeData] = await Promise.all([
        validateOrigin(parsed.domain, env),
        parsed.forceReprocess
          ? Promise.resolve(null)
          : (isHeadRequest || (rangeHeader && !isFullFileRange))
            ? getCacheHead(env, parsed.cacheKey)  // HEAD or partial range: metadata only
            : getFromCache(env, parsed.cacheKey), // Full GET request or bytes=0-: get full object
        // For standard ranges (GET only), also fetch the range data in parallel
        // Skip for HEAD requests - they don't need the actual range data
        (parsed.forceReprocess || isHeadRequest || !isStandardRange)
          ? Promise.resolve(null)
          : getFromCacheWithRange(env, parsed.cacheKey, {
              start: standardRangeStart!,
              end: standardRangeEnd!,
              length: standardRangeEnd! - standardRangeStart! + 1,
              isPartial: true,
            }),
      ]);

      addLog('Origin validation', `${validation.reason} (source: ${validation.source})`);

      if (!validation.allowed) {
        // Non-allowed or blocked: redirect to original URL
        // This ensures no service disruption while preventing CDN abuse
        addLog('Redirecting to origin', `Reason: ${validation.reason}`);

        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            // Note: X-ImgPro-Reason removed to prevent information disclosure
            ...getCORSHeaders(),
          },
        });
      }

      // Handle HEAD requests - only serve from cache, don't fetch from origin
      // HEAD requests are used to check metadata without downloading the body
      if (isHeadRequest) {
        addLog('HEAD request', 'Checking cache metadata');

        // If forceReprocess is set, redirect to origin (consistent with GET behavior)
        // We don't fetch the full file just for a HEAD request
        if (parsed.forceReprocess) {
          addLog('HEAD + forceReprocess', 'Redirecting to origin');
          return new Response(null, {
            status: 302,
            headers: {
              'Location': parsed.sourceUrl,
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'X-ImgPro-Status': 'redirect',
              ...getCORSHeaders(),
            },
          });
        }

        // Get cache metadata (if not already fetched above)
        const headResult = cacheResult || await getCacheHead(env, parsed.cacheKey);

        if (headResult) {
          const cachedContentType = (headResult.httpMetadata?.contentType || '').toLowerCase();

          // Validate cached content is supported media type
          if (!isMediaContentType(cachedContentType)) {
            // Invalid cached content - delete and redirect
            ctx.waitUntil(env.R2.delete(parsed.cacheKey).catch(() => {}));
            return new Response(null, {
              status: 302,
              headers: {
                'Location': parsed.sourceUrl,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                'X-ImgPro-Status': 'redirect',
                ...getCORSHeaders(),
              },
            });
          }

          // Return HEAD response with metadata
          addLog('HEAD cache hit', `${headResult.size} bytes`);
          return new Response(null, {
            status: 200,
            headers: {
              'Content-Type': headResult.httpMetadata?.contentType || 'application/octet-stream',
              'Content-Length': headResult.size.toString(),
              'Accept-Ranges': 'bytes',
              'ETag': headResult.etag,
              'Last-Modified': headResult.uploaded.toUTCString(),
              'Cache-Control': 'public, max-age=31536000, immutable',
              'X-ImgPro-Status': 'hit',
              'X-ImgPro-Cached-At': headResult.customMetadata?.cachedAt || '',
              ...getCORSHeaders(),
            },
          });
        }

        // Not in cache - redirect to origin for HEAD
        // We don't fetch from origin just to answer a HEAD request
        addLog('HEAD cache miss', 'Redirecting to origin');
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            ...getCORSHeaders(),
          },
        });
      }

      // Check cache result (GET requests only from here)
      if (cacheResult) {
        addLog('Cache HIT', parsed.cacheKey);

        // cacheResult is R2ObjectBody for full requests, R2Object for range requests (HEAD)
        const cachedContentType = (cacheResult.httpMetadata?.contentType || '').toLowerCase();

        // Validate cached content is supported media type
        // (protects against previously cached HTML/garbage)
        if (!isMediaContentType(cachedContentType)) {
          addLog('Invalid cached content', `${cachedContentType} - deleting and redirecting`);
          // Delete invalid cached content in background (don't block response)
          ctx.waitUntil(env.R2.delete(parsed.cacheKey).catch(e => {
            console.error('Failed to delete invalid cache entry:', e);
          }));
          // Redirect to origin
          return new Response(null, {
            status: 302,
            headers: {
              'Location': parsed.sourceUrl,
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              'X-ImgPro-Status': 'redirect',
              'X-ImgPro-Reason': 'invalid_cached_content',
              ...getCORSHeaders(),
            },
          });
        }

        // Check ETag for conditional request (304 Not Modified)
        const conditionalResponse = handleConditionalRequest(request, cacheResult.etag);
        if (conditionalResponse) {
          addLog('Conditional request', '304 Not Modified');
          // Track usage (cache hit with 0 bytes - no body transferred)
          trackUsage(env, ctx, parsed.domain, 0, true, validation.domain_records);
          return conditionalResponse;
        }

        const contentType = cacheResult.httpMetadata?.contentType || 'application/octet-stream';
        const metadata = cacheResult.customMetadata || {};
        const totalSize = cacheResult.size;

        // Parse Range header for partial content support (video/audio seeking)
        const rangeInfo = rangeHeader ? parseRangeHeader(rangeHeader, totalSize) : null;

        // Invalid range = 416 Range Not Satisfiable
        if (rangeHeader && !rangeInfo) {
          addLog('Invalid range', `${rangeHeader} for size ${totalSize}`);
          return new Response('Range Not Satisfiable', {
            status: 416,
            headers: {
              'Content-Range': `bytes */${totalSize}`,
              'Accept-Ranges': 'bytes',
              ...getCORSHeaders(),
            },
          });
        }

        // If view parameter is set, return HTML viewer (images only)
        // SECURITY: Only allow in debug mode to prevent information disclosure
        if (parsed.viewImage && env.DEBUG === 'true' && isImageContentType(contentType)) {
          // For view mode, we need the full object
          const fullObject = rangeHeader
            ? await getFromCache(env, parsed.cacheKey)
            : cacheResult as R2ObjectBody;

          if (fullObject && 'body' in fullObject) {
            const imageData = await fullObject.arrayBuffer();
            const totalTime = Date.now() - startTime;
            addLog('Generating HTML viewer', `${imageData.byteLength} bytes in ${totalTime}ms`);

            return createHtmlViewer({
              imageData,
              contentType,
              status: 'cached',
              imageSize: imageData.byteLength,
              sourceUrl: parsed.sourceUrl,
              cdnUrl: request.url.split('?')[0],
              cacheKey: parsed.cacheKey,
              cachedAt: metadata.cachedAt,
              processingTime: totalTime,
              logs,
              env
            });
          }
        }

        // Handle range request for cached content (partial content for video/audio seeking)
        if (rangeInfo?.isPartial) {
          addLog('Range request', `bytes ${rangeInfo.start}-${rangeInfo.end}/${totalSize}`);

          // For standard ranges, we already fetched in parallel. Otherwise fetch now.
          const partialObject = (isStandardRange && rangeData)
            ? rangeData
            : await getFromCacheWithRange(env, parsed.cacheKey, rangeInfo);

          if (!partialObject) {
            // Shouldn't happen, but handle gracefully
            return new Response(null, {
              status: 302,
              headers: {
                'Location': parsed.sourceUrl,
                'Cache-Control': 'no-store, no-cache, must-revalidate',
                ...getCORSHeaders(),
              },
            });
          }

          addLog('Serving partial', `${rangeInfo.length} bytes${isStandardRange ? ' (parallel fetch)' : ''}`);

          // Track requested range size (not actual bytes - for performance)
          // Trade-off: may over-count if client disconnects early
          trackUsage(env, ctx, parsed.domain, rangeInfo.length, true, validation.domain_records);

          return new Response(partialObject.body, {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Length': rangeInfo.length.toString(),
              'Content-Range': buildContentRangeHeader(rangeInfo.start, rangeInfo.end, totalSize),
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'public, max-age=31536000, immutable',
              'ETag': cacheResult.etag,
              'Last-Modified': cacheResult.uploaded.toUTCString(),
              'X-ImgPro-Status': 'hit',
              'X-ImgPro-Cached-At': metadata.cachedAt || '',
              ...getCORSHeaders(),
            },
          });
        }

        // Full content response (no range or range covers entire file)
        // For non-range requests, cacheResult already has the body (from getFromCache)
        // For full-range requests (e.g., bytes=0-99 on 100-byte file), cacheResult is
        // from getCacheHead (no body), so we need to use rangeData or fetch the full object
        let fullObject: R2ObjectBody | null = null;

        if ('body' in cacheResult) {
          // Non-range request: cacheResult has the body
          fullObject = cacheResult as R2ObjectBody;
        } else if (isStandardRange && rangeData) {
          // Full-range standard request: rangeData was fetched in parallel
          fullObject = rangeData;
        } else if (rangeHeader) {
          // Full-range non-standard request (e.g., bytes=0-): fetch the full object
          fullObject = await getFromCache(env, parsed.cacheKey);
        }

        if (!fullObject) {
          // Shouldn't happen, but handle gracefully
          return new Response(null, {
            status: 302,
            headers: {
              'Location': parsed.sourceUrl,
              'Cache-Control': 'no-store, no-cache, must-revalidate',
              ...getCORSHeaders(),
            },
          });
        }

        // Track requested size (not actual bytes - for performance)
        // Trade-off: may over-count if client disconnects early
        const bytesToTrack = rangeInfo ? rangeInfo.length : fullObject.size;
        trackUsage(env, ctx, parsed.domain, bytesToTrack, true, validation.domain_records);

        addLog('Serving media', `${fullObject.size} bytes, ${contentType}`);

        // If Range header was sent (even for full file like bytes=0-), return 206 with Content-Range
        // This is critical for video: browsers expect 206 to confirm range support for seeking
        const responseHeaders: Record<string, string> = {
          'Content-Type': contentType,
          'Content-Length': fullObject.size.toString(),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'ETag': cacheResult.etag,
          'Last-Modified': cacheResult.uploaded.toUTCString(),
          'X-ImgPro-Status': 'hit',
          'X-ImgPro-Cached-At': metadata.cachedAt || '',
          ...getCORSHeaders(),
        };

        // Add Content-Range for range requests (even full-file ranges)
        if (rangeInfo) {
          responseHeaders['Content-Range'] = buildContentRangeHeader(rangeInfo.start, rangeInfo.end, totalSize);
        }

        return new Response(fullObject.body, {
          status: rangeInfo ? 206 : 200,
          headers: responseHeaders,
        });
      }

      if (parsed.forceReprocess) {
        addLog('Cache bypass', 'Force reprocess requested');
      }

      // Cache miss (or forced reprocess) - fetch from origin
      addLog('Cache MISS', `Fetching from origin: ${parsed.sourceUrl}`);

      // IMPORTANT: For partial range requests on cache miss, redirect to origin
      // We can only fetch the full file from origin, so we can't serve specific byte ranges.
      // Lying about Content-Range (saying bytes 0-X when they asked for bytes Y-Z) breaks video players.
      // Redirect lets the browser get the exact bytes from origin while we cache the full file in background.
      if (rangeHeader && !isFullFileRange) {
        addLog('Partial range on cache miss', `${rangeHeader} - redirecting to origin`);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            'X-ImgPro-Redirect-Reason': 'partial-range-cache-miss',
            ...getCORSHeaders(),
          },
        });
      }

      // Create redirect validator that checks against our allowlist
      const validateRedirect = async (finalUrl: string): Promise<boolean> => {
        const urlValidation = validateUrlForFetch(finalUrl);
        if (!urlValidation.valid || !urlValidation.domain) {
          return false;
        }

        // Check if the redirected domain is also allowed
        const redirectValidation = await validateOrigin(urlValidation.domain, env);
        return redirectValidation.allowed;
      };

      // Fetch with block detection
      const fetchResult = await fetchMediaFromOrigin(parsed.sourceUrl, env, request, undefined, validateRedirect);
      const response = fetchResult.response;

      // Check if origin blocked us (WAF, rate limit, challenge page)
      if (fetchResult.blocked) {
        addLog('Origin blocked', `${fetchResult.blockReason} - redirecting to origin`);
        // TODO: Implement negative caching here to avoid hammering blocked origins
        // For now, just redirect
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            'X-ImgPro-Block-Reason': fetchResult.blockReason || 'unknown',
            ...getCORSHeaders(),
          },
        });
      }

      if (!response.ok) {
        // Redirect to origin - let user see the real error (404, 500, etc.)
        addLog('Origin fetch failed', `HTTP ${response.status} - redirecting to origin`);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            ...getCORSHeaders(),
          },
        });
      }

      addLog('Origin fetch success', `HTTP ${response.status}`);

      // Validate content type - must be supported media type
      const contentType = response.headers.get('Content-Type') || '';
      if (!isMediaContentType(contentType)) {
        addLog('Not supported media', `${contentType} - redirecting to origin`);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            ...getCORSHeaders(),
          },
        });
      }

      addLog('Content type validated', contentType);

      // Parse max file size (default 500MB for video support)
      const maxSize = parseFileSize(env.MAX_FILE_SIZE || '500MB');

      // Validate size via Content-Length header (no buffering)
      const sizeValidation = validateResponseSize(response, maxSize);

      if (!sizeValidation.valid) {
        addLog('File too large', `${sizeValidation.reason} - redirecting to origin`);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            ...getCORSHeaders(),
          },
        });
      }

      const contentLength = sizeValidation.size;
      addLog('Size validated', contentLength ? `${formatBytes(contentLength)}` : 'unknown (chunked)');

      // Check if response body exists
      if (!response.body) {
        addLog('No response body', 'redirecting to origin');
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            ...getCORSHeaders(),
          },
        });
      }

      // STREAMING: Split the response body into two streams
      // One for caching to R2, one for responding to the client
      //
      // Always use size-limited stream for defense-in-depth:
      // - Content-Length can be spoofed (send small header, stream large body)
      // - HTTP/2+ framing may not enforce Content-Length boundaries
      // - Provides accurate byte counting for usage tracking
      const { stream: limitedStream, byteCount } = createSizeLimitedStream(response.body, maxSize);
      const [cacheStream, responseStream] = limitedStream.tee();

      // Track usage after stream completes (actual bytes, not Content-Length)
      ctx.waitUntil(
        byteCount.then(bytes => {
          trackUsage(env, ctx, parsed.domain, bytes, false, validation.domain_records);
        }).catch(() => {
          // Size limit exceeded - usage not tracked (request failed anyway)
        })
      );

      // Store in R2 using stream (background, non-blocking)
      ctx.waitUntil(
        storeInCacheStream(
          env,
          parsed.cacheKey,
          cacheStream,
          contentType,
          contentLength,
          parsed.sourceUrl,
          parsed.domain
        ).catch(e => {
          console.error('Failed to store in cache:', e);
        })
      );

      addLog('Storing in R2', 'streaming (background)');

      // Return streaming response to client
      // For Range requests with known size, return 206 to indicate range support
      // This is critical for video players that probe with "Range: bytes=0-"
      addLog('Serving media', `streaming, ${contentType}`);

      // Determine if we should return 206 Partial Content
      // Video players expect 206 with Content-Range to confirm range support
      // For empty files (contentLength === 0), return 200 - no bytes to serve in a range
      const shouldReturn206 = rangeHeader && contentLength !== null && contentLength > 0;
      const status = shouldReturn206 ? 206 : 200;

      // Build response headers
      const responseHeaders: Record<string, string> = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-ImgPro-Status': 'miss',
        ...getCORSHeaders(),
      };

      if (contentLength !== null) {
        responseHeaders['Content-Length'] = contentLength.toString();
      }

      // Add Content-Range header for 206 responses
      // For "bytes=0-" probe, we serve the full file but indicate the range
      if (shouldReturn206 && contentLength !== null) {
        responseHeaders['Content-Range'] = `bytes 0-${contentLength - 1}/${contentLength}`;
      }

      // CRITICAL: Wrap response stream in FixedLengthStream when Content-Length is known
      // tee()'d streams don't have a known length, causing Cloudflare Workers to strip
      // the Content-Length header and use chunked encoding. This breaks video players
      // that need Content-Length to calculate seek positions.
      let finalResponseStream: ReadableStream<Uint8Array> = responseStream;
      if (contentLength !== null) {
        const { readable, writable } = new FixedLengthStream(contentLength);
        responseStream.pipeTo(writable).catch(() => {
          // Stream error - will be handled by Response
        });
        finalResponseStream = readable;
      }

      return new Response(finalResponseStream, {
        status,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error('Worker error:', error);

      // For ALL errors, try to redirect to origin
      // This ensures the CDN NEVER breaks user experience
      // Even security errors (SSRF) - let the user's browser handle the redirect directly
      try {
        const parsed = parseUrl(url);
        return new Response(null, {
          status: 302,
          headers: {
            'Location': parsed.sourceUrl,
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'X-ImgPro-Status': 'redirect',
            ...getCORSHeaders(),
          },
        });
      } catch {
        // URL parsing failed - can't redirect, return generic error
        // This only happens for completely malformed URLs
        return errorResponse('Invalid request', 400);
      }
    }
  },
};
