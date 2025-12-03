/**
 * Per-Site Usage Tracker Durable Object
 *
 * Each WordPress site gets its own Durable Object instance that:
 * 1. Accumulates usage metrics in memory (bandwidth, requests, cache hits/misses)
 * 2. Writes to billing D1 database every 60 seconds via alarm
 * 3. Only writes when there's actual activity (silent when idle)
 *
 * Architecture:
 * - Worker sends metrics to DO via ctx.waitUntil (no blocking)
 * - DO accumulates counters in memory
 * - Alarm triggers every 60s to flush to D1
 * - Direct D1 access (no API calls, no API keys exposed)
 *
 * Scaling:
 * - Each site = one DO instance
 * - Distributed across Cloudflare's global fleet
 * - Max 1 D1 write per site per minute
 * - 10,000 active sites = 166 writes/sec (well within D1 capacity)
 */

import type { Env } from './types';

export interface UsageMetrics {
	siteId: number;
	domain: string;
	bytes: number;
	cacheHit: boolean;
}

export class SiteUsageTracker implements DurableObject {
	private state: DurableObjectState;
	private env: Env;

	// In-memory counters (reset after each flush)
	private siteId: number = 0;
	private domain: string = '';
	private bandwidth: number = 0;
	private requests: number = 0;
	private cacheHits: number = 0;
	private cacheMisses: number = 0;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;

		// Set initial alarm for 60 seconds from now
		this.state.storage.setAlarm(Date.now() + 60000);
	}

	/**
	 * Receive usage metrics from CDN worker
	 *
	 * Called via ctx.waitUntil - no response needed, async fire-and-forget
	 */
	async fetch(request: Request): Promise<Response> {
		try {
			const metrics: UsageMetrics = await request.json();

			// Store siteId/domain from first request (should always be same for this DO)
			if (!this.siteId) {
				this.siteId = metrics.siteId;
				this.domain = metrics.domain;
			}

			// Accumulate metrics
			this.bandwidth += metrics.bytes;
			this.requests += 1;

			if (metrics.cacheHit) {
				this.cacheHits += 1;
			} else {
				this.cacheMisses += 1;
			}

			return new Response('OK', { status: 200 });
		} catch (err) {
			console.error('Usage tracker fetch error:', err);
			return new Response('Error', { status: 500 });
		}
	}

	/**
	 * Alarm handler - flushes accumulated metrics to D1 every 60 seconds
	 *
	 * Cloudflare guarantees alarm will fire even if DO instance moves/restarts
	 */
	async alarm(): Promise<void> {
		const now = Math.floor(Date.now() / 1000);

		// Skip if no activity since last flush
		if (this.requests === 0) {
			// Reset alarm for next period
			await this.state.storage.setAlarm(Date.now() + 60000);
			return;
		}

		const hourStart = Math.floor(Date.now() / 3600000) * 3600;

		try {
			// Write to D1 in batch transaction
			const batch = [
				// Update current period totals in sites table
				// images_cached = total requests (all deliveries, hits + misses)
				this.env.BILLING_DB.prepare(
					`UPDATE sites SET
						bandwidth_used_bytes = bandwidth_used_bytes + ?,
						images_cached = images_cached + ?,
						cache_hits = cache_hits + ?,
						cache_misses = cache_misses + ?,
						updated_at = ?
					WHERE id = ?`
				).bind(this.bandwidth, this.requests, this.cacheHits, this.cacheMisses, now, this.siteId),

				// Insert/update hourly rollup
				this.env.BILLING_DB.prepare(
					`INSERT INTO usage_hourly (site_id, hour_start, bandwidth_bytes, requests, cache_hits, cache_misses, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (site_id, hour_start) DO UPDATE SET
						bandwidth_bytes = bandwidth_bytes + excluded.bandwidth_bytes,
						requests = requests + excluded.requests,
						cache_hits = cache_hits + excluded.cache_hits,
						cache_misses = cache_misses + excluded.cache_misses,
						updated_at = excluded.updated_at`
				).bind(this.siteId, hourStart, this.bandwidth, this.requests, this.cacheHits, this.cacheMisses, now, now),
			];

			await this.env.BILLING_DB.batch(batch);

			console.log(
				`[UsageTracker] Flushed ${this.domain}: ${this.requests} req, ${this.bandwidth} bytes, ${this.cacheHits} hits, ${this.cacheMisses} misses`
			);

			// Reset counters after successful flush
			this.bandwidth = 0;
			this.requests = 0;
			this.cacheHits = 0;
			this.cacheMisses = 0;
		} catch (err) {
			console.error(`[UsageTracker] D1 write failed for ${this.domain}:`, err);
			// Don't reset counters - will retry on next alarm
			// This prevents data loss if D1 is temporarily unavailable
		}

		// Schedule next alarm
		await this.state.storage.setAlarm(Date.now() + 60000);
	}
}
