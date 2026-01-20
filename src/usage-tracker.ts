/**
 * Per-Site Usage Tracker Durable Object
 *
 * Each WordPress site gets its own Durable Object instance that:
 * 1. Accumulates usage metrics in persistent storage (survives eviction)
 * 2. Writes to billing D1 database every 60 seconds via alarm
 * 3. Only writes when there's actual activity (silent when idle)
 *
 * Architecture:
 * - Worker sends metrics to DO via ctx.waitUntil (no blocking)
 * - DO accumulates counters in state.storage (persistent)
 * - Alarm triggers every 60s to flush to D1
 * - Direct D1 access (no API calls, no API keys exposed)
 *
 * Durability:
 * - Counters persist in state.storage, surviving memory eviction
 * - DO can be evicted after ~10s of inactivity, but storage persists
 * - Alarm is guaranteed to fire even after eviction/re-hydration
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

// Storage keys for persistent counters
const STORAGE_KEYS = {
	SITE_ID: 'siteId',
	DOMAIN: 'domain',
	BANDWIDTH: 'bandwidth',
	REQUESTS: 'requests',
	CACHE_HITS: 'cacheHits',
	CACHE_MISSES: 'cacheMisses',
} as const;

export class SiteUsageTracker implements DurableObject {
	private state: DurableObjectState;
	private env: Env;

	// In-memory cache of storage values (for performance)
	// These are synced with state.storage on each operation
	private siteId: number = 0;
	private domain: string = '';
	private bandwidth: number = 0;
	private requests: number = 0;
	private cacheHits: number = 0;
	private cacheMisses: number = 0;
	private initialized: boolean = false;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;

		// Load persisted state before handling any requests
		// This ensures we recover counters after memory eviction
		this.state.blockConcurrencyWhile(async () => {
			await this.loadFromStorage();

			// Only set alarm if:
			// 1. No alarm exists (preserve pending alarms on re-hydration)
			// 2. BILLING_DB is bound (otherwise this DO serves no purpose)
			const existingAlarm = await this.state.storage.getAlarm();
			if (!existingAlarm && this.env.BILLING_DB) {
				await this.state.storage.setAlarm(Date.now() + 60000);
			}
		});
	}

	/**
	 * Load counters from persistent storage
	 */
	private async loadFromStorage(): Promise<void> {
		const stored = await this.state.storage.get<number | string>([
			STORAGE_KEYS.SITE_ID,
			STORAGE_KEYS.DOMAIN,
			STORAGE_KEYS.BANDWIDTH,
			STORAGE_KEYS.REQUESTS,
			STORAGE_KEYS.CACHE_HITS,
			STORAGE_KEYS.CACHE_MISSES,
		]);

		this.siteId = (stored.get(STORAGE_KEYS.SITE_ID) as number) || 0;
		this.domain = (stored.get(STORAGE_KEYS.DOMAIN) as string) || '';
		this.bandwidth = (stored.get(STORAGE_KEYS.BANDWIDTH) as number) || 0;
		this.requests = (stored.get(STORAGE_KEYS.REQUESTS) as number) || 0;
		this.cacheHits = (stored.get(STORAGE_KEYS.CACHE_HITS) as number) || 0;
		this.cacheMisses = (stored.get(STORAGE_KEYS.CACHE_MISSES) as number) || 0;

		// If we have a siteId, we've been initialized before
		this.initialized = this.siteId !== 0 || this.domain !== '';
	}

	/**
	 * Receive usage metrics from CDN worker
	 *
	 * Called via ctx.waitUntil - no response needed, async fire-and-forget
	 */
	async fetch(request: Request): Promise<Response> {
		try {
			const metrics: UsageMetrics = await request.json();

			// Prepare storage updates
			const updates: Map<string, number | string> = new Map();

			// Store siteId/domain from first request (should always be same for this DO)
			if (!this.initialized) {
				this.initialized = true;
				this.siteId = metrics.siteId;
				this.domain = metrics.domain;
				updates.set(STORAGE_KEYS.SITE_ID, metrics.siteId);
				updates.set(STORAGE_KEYS.DOMAIN, metrics.domain);
			}

			// Accumulate metrics
			this.bandwidth += metrics.bytes;
			this.requests += 1;

			if (metrics.cacheHit) {
				this.cacheHits += 1;
			} else {
				this.cacheMisses += 1;
			}

			// Persist all counters atomically
			updates.set(STORAGE_KEYS.BANDWIDTH, this.bandwidth);
			updates.set(STORAGE_KEYS.REQUESTS, this.requests);
			updates.set(STORAGE_KEYS.CACHE_HITS, this.cacheHits);
			updates.set(STORAGE_KEYS.CACHE_MISSES, this.cacheMisses);

			await this.state.storage.put(Object.fromEntries(updates));

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
	 *
	 * CONCURRENCY NOTE: D1 calls are external I/O (not storage), so fetch() handlers
	 * can interleave during the await. We capture values before the D1 call and
	 * subtract only what we flushed, preserving any metrics added during the write.
	 */
	async alarm(): Promise<void> {
		// If BILLING_DB is not bound, this DO serves no purpose
		// Clear all accumulated data and stop the alarm loop
		if (!this.env.BILLING_DB) {
			console.error('[UsageTracker] BILLING_DB not bound - clearing storage and stopping. This is a misconfiguration.');
			// Reset counters to prevent unbounded storage growth
			this.bandwidth = 0;
			this.requests = 0;
			this.cacheHits = 0;
			this.cacheMisses = 0;
			await this.state.storage.deleteAll();
			// Explicitly cancel any pending alarm (constructor may have set one during re-hydration)
			await this.state.storage.deleteAlarm();
			return;
		}

		const now = Math.floor(Date.now() / 1000);

		// Skip if no activity since last flush
		if (this.requests === 0) {
			// Reset alarm for next period
			await this.state.storage.setAlarm(Date.now() + 60000);
			return;
		}

		const hourStart = Math.floor(Date.now() / 3600000) * 3600;

		// Capture current values BEFORE any await points
		// This ensures we only flush what existed at this moment
		const flushBandwidth = this.bandwidth;
		const flushRequests = this.requests;
		const flushCacheHits = this.cacheHits;
		const flushCacheMisses = this.cacheMisses;
		const flushSiteId = this.siteId;
		const flushDomain = this.domain;

		try {
			// Write to D1 in batch transaction
			// NOTE: During this await, fetch() can run and increment counters
			const batch = [
				// Update current period totals in sites table
				this.env.BILLING_DB.prepare(
					`UPDATE sites SET
						bandwidth_used_bytes = bandwidth_used_bytes + ?,
						cache_hits = cache_hits + ?,
						cache_misses = cache_misses + ?,
						updated_at = ?
					WHERE id = ?`
				).bind(flushBandwidth, flushCacheHits, flushCacheMisses, now, flushSiteId),

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
				).bind(flushSiteId, hourStart, flushBandwidth, flushRequests, flushCacheHits, flushCacheMisses, now, now),
			];

			await this.env.BILLING_DB.batch(batch);

			console.log(
				`[UsageTracker] Flushed ${flushDomain}: ${flushRequests} req, ${flushBandwidth} bytes, ${flushCacheHits} hits, ${flushCacheMisses} misses`
			);

			// Subtract only what we flushed, preserving any metrics added during D1 write
			// This is safe because fetch() only adds to counters, never subtracts
			this.bandwidth -= flushBandwidth;
			this.requests -= flushRequests;
			this.cacheHits -= flushCacheHits;
			this.cacheMisses -= flushCacheMisses;

			// Persist the new counter values (may be > 0 if fetch() ran during D1 write)
			await this.state.storage.put({
				[STORAGE_KEYS.BANDWIDTH]: this.bandwidth,
				[STORAGE_KEYS.REQUESTS]: this.requests,
				[STORAGE_KEYS.CACHE_HITS]: this.cacheHits,
				[STORAGE_KEYS.CACHE_MISSES]: this.cacheMisses,
			});
		} catch (err) {
			console.error(`[UsageTracker] D1 write failed for ${flushDomain}:`, err);
			// Don't modify counters - will retry on next alarm
			// This prevents data loss if D1 or storage is temporarily unavailable
		}

		// Schedule next alarm
		await this.state.storage.setAlarm(Date.now() + 60000);
	}
}
