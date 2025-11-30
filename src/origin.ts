/**
 * Origin fetching with timeout, redirects, and security validation
 *
 * SECURITY: After following redirects, validates that the final URL
 * is still pointing to a valid, non-internal domain to prevent SSRF.
 */

import type { Env } from './types';
import { isValidDomain, validateUrlDomain } from './validation';

/**
 * Fetch image from origin with timeout, redirect support, and security validation
 *
 * @param url - The source URL to fetch
 * @param env - Environment bindings
 * @param timeout - Optional custom timeout in ms
 * @param validateRedirect - Optional function to validate the final URL after redirects
 * @returns Response from the origin
 * @throws Error if timeout, invalid redirect, or fetch fails
 */
export async function fetchFromOrigin(
  url: string,
  env: Env,
  timeout?: number,
  validateRedirect?: (finalUrl: string) => Promise<boolean>
): Promise<Response> {
  const fetchTimeout = timeout || parseInt(env.FETCH_TIMEOUT || '30000', 10);
  const userAgent = env.ORIGIN_USER_AGENT || 'ImgPro/1.1 CDN';

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': userAgent,
      },
      redirect: 'follow',
      // @ts-ignore - follow is not in TypeScript types but works in runtime
      follow: 5, // Max 5 redirects
    });

    // Security: Validate final URL after redirects
    const finalUrl = response.url;
    if (finalUrl && finalUrl !== url) {
      // URL changed due to redirect - validate the final destination
      const validation = validateUrlDomain(finalUrl);

      if (!validation.valid) {
        throw new Error(`Redirect to invalid domain blocked: ${finalUrl}`);
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
 * Fetch image data as ArrayBuffer with size validation
 *
 * @param response - The fetch response
 * @param maxSize - Maximum allowed file size in bytes
 * @returns Image data as ArrayBuffer
 * @throws Error if file exceeds maxSize
 */
export async function fetchImageData(
  response: Response,
  maxSize: number
): Promise<ArrayBuffer> {
  // Check content-length header first if available
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const size = parseInt(contentLength, 10);
    if (!isNaN(size) && size > maxSize) {
      throw new Error(`File too large: ${size} bytes (max ${maxSize} bytes)`);
    }
  }

  // Fetch the data
  const imageData = await response.arrayBuffer();

  // Validate actual size (content-length can be spoofed or missing)
  if (imageData.byteLength > maxSize) {
    throw new Error(`File too large: ${imageData.byteLength} bytes (max ${maxSize} bytes)`);
  }

  return imageData;
}
