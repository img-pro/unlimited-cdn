/**
 * HTTP Range Request handling for media streaming
 *
 * Parses Range headers and builds 206 Partial Content responses.
 * Supports single-range requests only (multipart ranges are rare and complex).
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests
 */

export interface RangeInfo {
  start: number;
  end: number;
  length: number;
  isPartial: boolean;
}

/**
 * Parse HTTP Range header
 *
 * Supports formats:
 * - bytes=0-499      (first 500 bytes)
 * - bytes=500-999    (second 500 bytes)
 * - bytes=-500       (last 500 bytes)
 * - bytes=500-       (from byte 500 to end)
 * - bytes=0-         (full file, but indicates range support)
 *
 * @param rangeHeader - The Range header value
 * @param totalSize - Total size of the resource in bytes
 * @returns RangeInfo or null if invalid/unsupported
 */
export function parseRangeHeader(
  rangeHeader: string | null,
  totalSize: number
): RangeInfo | null {
  if (!rangeHeader || !rangeHeader.startsWith('bytes=')) {
    return null;
  }

  // Extract the range spec (e.g., "0-499" from "bytes=0-499")
  const rangeSpec = rangeHeader.substring(6).trim();

  // Only support single ranges (not multipart like "bytes=0-50, 100-150")
  if (rangeSpec.includes(',')) {
    return null;
  }

  const dashIndex = rangeSpec.indexOf('-');
  if (dashIndex === -1) {
    return null;
  }

  const startStr = rangeSpec.substring(0, dashIndex);
  const endStr = rangeSpec.substring(dashIndex + 1);

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffix = parseInt(endStr, 10);
    if (isNaN(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else if (endStr === '') {
    // Open-ended range: bytes=500- (from 500 to end)
    start = parseInt(startStr, 10);
    if (isNaN(start) || start < 0) return null;
    end = totalSize - 1;
  } else {
    // Standard range: bytes=0-499
    start = parseInt(startStr, 10);
    end = parseInt(endStr, 10);
    if (isNaN(start) || isNaN(end) || start < 0) return null;
  }

  // Clamp end to file size
  end = Math.min(end, totalSize - 1);

  // Validate range
  if (start > end || start >= totalSize) {
    return null; // Will trigger 416 Range Not Satisfiable
  }

  return {
    start,
    end,
    length: end - start + 1,
    isPartial: !(start === 0 && end === totalSize - 1),
  };
}

/**
 * Build Content-Range header value
 *
 * @example "bytes 0-499/1000"
 */
export function buildContentRangeHeader(
  start: number,
  end: number,
  totalSize: number
): string {
  return `bytes ${start}-${end}/${totalSize}`;
}

