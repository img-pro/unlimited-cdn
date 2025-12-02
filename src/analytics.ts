/**
 * Analytics and metrics tracking
 */

import type { Env, LogEntry } from './types';
import { getCORSHeaders } from './utils';

/**
 * Create stats endpoint response
 *
 * SECURITY: Only exposes non-sensitive operational information.
 * Configuration details like ALLOWED_ORIGINS, DEBUG mode, and
 * other settings are intentionally omitted to prevent reconnaissance.
 */
export function createStatsResponse(_env: Env): Response {
  const stats = {
    status: 'healthy',
    version: '1.2.1',
    mode: 'single-domain',
    features: {
      caching: 'R2 CDN caching enabled',
      streaming: 'Large file streaming support',
      formats: 'All image formats supported',
    },
    endpoints: {
      health: '/health or /ping',
      stats: '/stats',
      image: '/{domain}/{path}',
    },
    notes: {
      metrics: 'Per-worker metrics require Durable Objects or Analytics Engine',
      cacheHits: 'Use Cloudflare Analytics for detailed cache performance',
      bandwidth: 'R2 bandwidth statistics available in Cloudflare dashboard',
    },
    timestamp: new Date().toISOString(),
  };

  return new Response(JSON.stringify(stats, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...getCORSHeaders(),
    },
  });
}

/**
 * Create logger function for workflow tracking
 */
export function createLogger(
  logs: LogEntry[],
  startTime: number,
  debugMode: boolean
): (action: string, details?: string) => void {
  return (action: string, details?: string) => {
    const entry: LogEntry = {
      time: `${Date.now() - startTime}ms`,
      action,
      details,
    };

    logs.push(entry);

    if (debugMode) {
      console.log(`[${entry.time}] ${action}${details ? ': ' + details : ''}`);
    }
  };
}
