/**
 * Usage tracking utilities
 *
 * Sends metrics to per-site Durable Objects for aggregation
 * Supports M:N model: same domain can track to multiple sites
 */

import type { Env, DomainRecord } from './types';

/**
 * Track usage for sites (fire-and-forget via ctx.waitUntil)
 *
 * M:N Model: Tracks to ALL sites that registered this domain
 * Example: If domain "cdn.agency.com" is registered to 3 sites,
 * all 3 sites get charged the bandwidth.
 *
 * @param env Environment bindings
 * @param ctx Execution context for waitUntil
 * @param domain Origin domain
 * @param bytes Image size in bytes
 * @param cacheHit Whether this was a cache hit
 * @param domainRecords Array of domain records from KV (M:N relationship)
 */
export async function trackUsage(
  env: Env,
  ctx: ExecutionContext,
  domain: string,
  bytes: number,
  cacheHit: boolean,
  domainRecords?: DomainRecord[]
): Promise<void> {
  // Skip tracking if billing infrastructure is not fully configured
  // Both USAGE_TRACKER (DO) and BILLING_DB (D1) are required for usage tracking
  // Self-hosted deployments typically have neither bound
  if (!env.USAGE_TRACKER || !env.BILLING_DB) {
    return;
  }

  // Skip tracking if we don't have any site_ids
  // This happens in "open" or "list" mode where KV lookups aren't used
  if (!domainRecords || domainRecords.length === 0) {
    return;
  }

  // Track usage for ALL sites that registered this domain
  for (const record of domainRecords) {
    // Only track for active sites
    if (record.status !== 'active') continue;

    // Create Durable Object ID based on site_id
    // Each site gets its own DO instance for isolated aggregation
    const doId = env.USAGE_TRACKER.idFromName(`site:${record.site_id}`);
    const stub = env.USAGE_TRACKER.get(doId);

    // Send metrics to DO (async, non-blocking)
    const metricsRequest = new Request('https://usage-tracker/track', {
      method: 'POST',
      body: JSON.stringify({
        siteId: record.site_id,
        domain,
        bytes,
        cacheHit,
      }),
    });

    // Fire-and-forget: don't wait for response, don't block user request
    ctx.waitUntil(stub.fetch(metricsRequest));
  }
}
