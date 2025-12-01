/**
 * Analytics and metrics tracking
 */

import type { Env, LogEntry } from './types';
import { getCORSHeaders } from './utils';

/**
 * Create stats endpoint response
 * Note: In production, these would be stored in Durable Objects or KV
 * For now, this returns a template that can be extended
 */
export function createStatsResponse(env: Env): Response {
  const stats = {
    status: 'healthy',
    version: '1.2.1',
    mode: 'single-domain',
    features: {
      caching: 'R2 CDN caching enabled',
      streaming: 'Large file streaming support',
      formats: 'All image formats supported',
      limits: `Max file size: ${env.MAX_FILE_SIZE || '50MB'}`,
      timeout: `Fetch timeout: ${env.FETCH_TIMEOUT || '30000'}ms`,
      methods: 'GET, HEAD, DELETE, OPTIONS',
    },
    config: {
      allowedOrigins: env.ALLOWED_ORIGINS || '*',
      userAgent: env.ORIGIN_USER_AGENT || 'ImageCDN/1.0 WordPress Cache',
      debug: env.DEBUG === 'true',
    },
    endpoints: {
      health: '/health or /ping',
      stats: '/stats',
      image: '/{domain}/{path}',
      viewer: '/{domain}/{path}?view=true',
      force: '/{domain}/{path}?force=true',
      delete: 'DELETE /{domain}/{path}',
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
