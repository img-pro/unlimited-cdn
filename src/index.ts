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
import { fetchMediaFromOrigin, validateResponseSize, createSizeLimitedStream, createByteCountingStream } from './origin';
import {
  getFromCache,
  getFromCacheWithRange,
  getCacheHead,
  handleHeadRequest,
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

      // Handle HEAD request
      if (request.method === 'HEAD') {
        addLog('HEAD request', 'Checking cache without download');
        return await handleHeadRequest(env, parsed.cacheKey);
      }

      // Only GET requests beyond this point
      if (request.method !== 'GET') {
        return errorResponse('Method not allowed', 405);
      }

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
      // For standard range requests: fetch HEAD (metadata) AND range data in parallel
      // For full-file ranges (bytes=0-): fetch full object (Safari video probe)
      // For other range requests: just HEAD (then fetch range after)
      // For full requests: get the full object
      const [validation, cacheResult, rangeData] = await Promise.all([
        validateOrigin(parsed.domain, env),
        parsed.forceReprocess
          ? Promise.resolve(null)
          : (rangeHeader && !isFullFileRange)
            ? getCacheHead(env, parsed.cacheKey)  // Partial range: get metadata only
            : getFromCache(env, parsed.cacheKey), // Full request or bytes=0-: get full object
        // For standard ranges, also fetch the range data in parallel
        (parsed.forceReprocess || !isStandardRange)
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

      // Check cache result
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

          // Wrap body with byte counting for accurate usage tracking
          const { stream: countedStream, byteCount } = createByteCountingStream(partialObject.body);

          // Track actual bytes delivered (not requested) via waitUntil
          ctx.waitUntil(
            byteCount.then(bytes => {
              trackUsage(env, ctx, parsed.domain, bytes, true, validation.domain_records);
            })
          );

          return new Response(countedStream, {
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

        // Wrap body with byte counting for accurate usage tracking
        const { stream: countedStream, byteCount } = createByteCountingStream(fullObject.body);

        // Track actual bytes delivered (not file size) via waitUntil
        ctx.waitUntil(
          byteCount.then(bytes => {
            trackUsage(env, ctx, parsed.domain, bytes, true, validation.domain_records);
          })
        );

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

        return new Response(countedStream, {
          status: rangeInfo ? 206 : 200,
          headers: responseHeaders,
        });
      }

      if (parsed.forceReprocess) {
        addLog('Cache bypass', 'Force reprocess requested');
      }

      // Cache miss (or forced reprocess) - fetch from origin
      addLog('Cache MISS', `Fetching from origin: ${parsed.sourceUrl}`);

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
      // Note: For cache miss, we serve full file - next request will hit cache and support ranges
      addLog('Serving media', `streaming, ${contentType}`);

      return new Response(responseStream, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          ...(contentLength !== null ? { 'Content-Length': contentLength.toString() } : {}),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-ImgPro-Status': 'miss',
          ...getCORSHeaders(),
        },
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
