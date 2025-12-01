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
 * @version 1.2.1
 */

import type { Env, LogEntry } from './types';
import { parseUrl, validateOrigin, isImageContentType, validateUrlDomain } from './validation';
import { fetchFromOrigin, fetchImageData } from './origin';
import {
  getFromCache,
  handleHeadRequest,
  handleConditionalRequest,
  storeInCache,
} from './cache';
import { createHtmlViewer } from './viewer';
import { createStatsResponse, createLogger } from './analytics';
import { errorResponse, getCORSHeaders, formatBytes, parseFileSize } from './utils';

const VERSION = '1.2.1';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

      // Validate origin against allow/block lists
      const validation = await validateOrigin(parsed.domain, env);
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

      // Check R2 cache (skip if force parameter is set)
      if (!parsed.forceReprocess) {
        const cached = await getFromCache(env, parsed.cacheKey);
        if (cached) {
          addLog('Cache HIT', parsed.cacheKey);

          // Check ETag for conditional request (304 Not Modified)
          const conditionalResponse = handleConditionalRequest(request, cached.etag);
          if (conditionalResponse) {
            addLog('Conditional request', '304 Not Modified');
            return conditionalResponse;
          }

          const imageContentType = cached.httpMetadata?.contentType || 'image/jpeg';
          const metadata = cached.customMetadata || {};

          // If view parameter is set, return HTML viewer
          // SECURITY: Only allow in debug mode to prevent information disclosure
          if (parsed.viewImage && env.DEBUG === 'true') {
            const imageData = await cached.arrayBuffer();
            const totalTime = Date.now() - startTime;
            addLog('Generating HTML viewer', `${imageData.byteLength} bytes in ${totalTime}ms`);

            return createHtmlViewer({
              imageData,
              contentType: imageContentType,
              status: 'cached',
              imageSize: imageData.byteLength,
              sourceUrl: parsed.sourceUrl,
              cdnUrl: request.url.split('?')[0], // Current URL without query params
              cacheKey: parsed.cacheKey,
              cachedAt: metadata.cachedAt,
              processingTime: totalTime,
              logs,
              env
            });
          }

          // Return the actual image with long cache headers
          addLog('Serving image', `${cached.size} bytes, ${imageContentType}`);
          return new Response(cached.body, {
            status: 200,
            headers: {
              'Content-Type': imageContentType,
              'Content-Length': cached.size.toString(),
              'Cache-Control': 'public, max-age=31536000, immutable',
              'ETag': cached.etag,
              'Last-Modified': cached.uploaded.toUTCString(),
              'X-ImgPro-Status': 'hit',
              'X-ImgPro-Cached-At': metadata.cachedAt || '',
              ...getCORSHeaders(),
            },
          });
        }
      } else {
        addLog('Cache bypass', 'Force reprocess requested');
      }

      // Cache miss (or forced reprocess) - fetch from origin
      addLog('Cache MISS', `Fetching from origin: ${parsed.sourceUrl}`);

      // Create redirect validator that checks against our allowlist
      const validateRedirect = async (finalUrl: string): Promise<boolean> => {
        const urlValidation = validateUrlDomain(finalUrl);
        if (!urlValidation.valid || !urlValidation.domain) {
          return false;
        }

        // Check if the redirected domain is also allowed
        const redirectValidation = await validateOrigin(urlValidation.domain, env);
        return redirectValidation.allowed;
      };

      const response = await fetchFromOrigin(parsed.sourceUrl, env, undefined, validateRedirect);

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

      // Validate content type - if not an image, redirect to origin
      const contentType = response.headers.get('Content-Type') || '';
      if (!isImageContentType(contentType)) {
        addLog('Not an image', `${contentType} - redirecting to origin`);
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

      // Parse max file size
      const maxSize = parseFileSize(env.MAX_FILE_SIZE || '50MB');

      // Fetch image data with size validation
      let imageData: ArrayBuffer;
      try {
        imageData = await fetchImageData(response, maxSize);
        addLog('Image data fetched', `${formatBytes(imageData.byteLength)}`);
      } catch (error) {
        // File too large - redirect to origin so user gets the full file directly
        addLog('File too large', `${error instanceof Error ? error.message : 'Unknown'} - redirecting to origin`);
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

      // Store in R2
      await storeInCache(
        env,
        parsed.cacheKey,
        imageData,
        contentType,
        parsed.sourceUrl,
        parsed.domain
      );

      const cdnUrl = request.url.split('?')[0]; // Current URL without query params
      addLog('Stored in R2', `${formatBytes(imageData.byteLength)}`);

      // If view parameter is set, return HTML viewer
      // SECURITY: Only allow in debug mode to prevent information disclosure
      if (parsed.viewImage && env.DEBUG === 'true') {
        const totalTime = Date.now() - startTime;
        addLog('Generating HTML viewer', `Processing complete in ${totalTime}ms`);

        return createHtmlViewer({
          imageData,
          contentType,
          status: 'fetched',
          imageSize: imageData.byteLength,
          sourceUrl: parsed.sourceUrl,
          cdnUrl,
          cacheKey: parsed.cacheKey,
          cachedAt: new Date().toISOString(),
          processingTime: totalTime,
          logs,
          env
        });
      }

      // Return the actual image (just fetched and cached)
      addLog('Serving image', `${formatBytes(imageData.byteLength)}, ${contentType}`);
      return new Response(imageData, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Length': imageData.byteLength.toString(),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-ImgPro-Status': 'miss',
          ...getCORSHeaders(),
        },
      });

    } catch (error) {
      console.error('Worker error:', error);

      const message = error instanceof Error ? error.message : 'Unknown error';

      // Hard errors for security issues only
      if (message.includes('Invalid domain') || message.includes('Invalid URL')) {
        return errorResponse('Invalid request', 400);
      }
      if (message.includes('Redirect to')) {
        return errorResponse('Redirect blocked for security', 403);
      }

      // For all other errors, try to extract origin URL and redirect
      // This handles timeouts, fetch failures, R2 errors, etc.
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
        return errorResponse('Invalid request', 400);
      }
    }
  },
};
