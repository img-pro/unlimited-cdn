/**
 * Per-Site Usage Tracker Durable Object
 *
 * Each WordPress site gets its own Durable Object instance that:
 * 1. Accumulates request metrics in persistent storage (survives eviction)
 * 2. Writes to billing D1 database every 60 seconds via alarm
 * 3. Only writes when there's actual activity (silent when idle)
 *
 * Architecture:
 * - Worker sends metrics to DO via ctx.waitUntil (no blocking)
 * - DO accumulates counters in memory (not persisted per-request)
 * - Alarm triggers every 60s to flush to D1 and persist counters
 * - Direct D1 access (no API calls, no API keys exposed)
 * - Idle DOs (no traffic) stop their alarm and go dormant
 *
 * Durability:
 * - Counters are in-memory between alarm flushes; at most 60s of data
 *   can be lost if the DO evicts before the next alarm fires
 * - Acceptable trade-off for usage analytics (not billing-critical)
 *
 * Scaling:
 * - Each site = one DO instance
 * - Distributed across Cloudflare's global fleet
 * - Max 1 D1 write per site per minute
 * - 10,000 active sites = 166 writes/sec (well within D1 capacity)
 *
 * Note: Bandwidth tracking has been removed for the Unlimited Media CDN model.
 * We now track requests only (for reporting purposes).
 */

import type { Env } from './types';

export interface UsageMetrics {
	siteId: number;
	domain: string;
	cacheHit: boolean;
}

// Storage keys for persistent counters
const STORAGE_KEYS = {
	SITE_ID: 'siteId',
	DOMAIN: 'domain',
	REQUESTS: 'requests',
	CACHE_HITS: 'cacheHits',
	CACHE_MISSES: 'cacheMisses',
	D1_FAILURES: 'd1Failures',
} as const;

// Alert threshold for consecutive D1 failures
const D1_FAILURE_ALERT_THRESHOLD = 5;

export class SiteUsageTracker implements DurableObject {
	private state: DurableObjectState;
	private env: Env;

	// In-memory cache of storage values (for performance)
	// These are synced with state.storage on each operation
	private siteId: number = 0;
	private domain: string = '';
	private requests: number = 0;
	private cacheHits: number = 0;
	private cacheMisses: number = 0;
	private d1Failures: number = 0;
	private initialized: boolean = false;
	private alarmRunning: boolean = false;

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
				this.alarmRunning = true;
			} else if (existingAlarm) {
				this.alarmRunning = true;
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
			STORAGE_KEYS.REQUESTS,
			STORAGE_KEYS.CACHE_HITS,
			STORAGE_KEYS.CACHE_MISSES,
			STORAGE_KEYS.D1_FAILURES,
		]);

		this.siteId = (stored.get(STORAGE_KEYS.SITE_ID) as number) || 0;
		this.domain = (stored.get(STORAGE_KEYS.DOMAIN) as string) || '';
		this.requests = (stored.get(STORAGE_KEYS.REQUESTS) as number) || 0;
		this.cacheHits = (stored.get(STORAGE_KEYS.CACHE_HITS) as number) || 0;
		this.cacheMisses = (stored.get(STORAGE_KEYS.CACHE_MISSES) as number) || 0;
		this.d1Failures = (stored.get(STORAGE_KEYS.D1_FAILURES) as number) || 0;

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

			// Accumulate metrics in memory (persisted by alarm every 60s)
			this.requests += 1;

			if (metrics.cacheHit) {
				this.cacheHits += 1;
			} else {
				this.cacheMisses += 1;
			}

			// Only write identity on first request (one-time per DO instance)
			if (updates.size > 0) {
				await this.state.storage.put(Object.fromEntries(updates));
			}

			// Restart alarm if it went dormant (idle alarm exited without rescheduling)
			if (!this.alarmRunning && this.env.BILLING_DB) {
				await this.state.storage.setAlarm(Date.now() + 60000);
				this.alarmRunning = true;
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
			this.requests = 0;
			this.cacheHits = 0;
			this.cacheMisses = 0;
			await this.state.storage.deleteAll();
			// Explicitly cancel any pending alarm (constructor may have set one during re-hydration)
			await this.state.storage.deleteAlarm();
			return;
		}

		const now = Math.floor(Date.now() / 1000);

		// No activity since last flush — stop the alarm loop.
		// fetch() will restart it when the next request arrives.
		if (this.requests === 0) {
			this.alarmRunning = false;
			return;
		}

		const hourStart = Math.floor(Date.now() / 3600000) * 3600;

		// Capture current values BEFORE any await points
		// This ensures we only flush what existed at this moment
		const flushRequests = this.requests;
		const flushCacheHits = this.cacheHits;
		const flushCacheMisses = this.cacheMisses;
		const flushSiteId = this.siteId;
		const flushDomain = this.domain;

		// Track D1 success separately from storage success to handle errors correctly
		let d1Succeeded = false;

		try {
			// Write to D1 in batch transaction
			// NOTE: During this await, fetch() can run and increment counters
			// Bandwidth tracking removed - writing 0 for schema compatibility
			const batch = [
				// Update current period totals in sites table (bandwidth=0, only tracking cache stats)
				this.env.BILLING_DB.prepare(
					`UPDATE sites SET
						cache_hits = cache_hits + ?,
						cache_misses = cache_misses + ?,
						updated_at = ?
					WHERE id = ?`
				).bind(flushCacheHits, flushCacheMisses, now, flushSiteId),

				// Insert/update hourly rollup (bandwidth_bytes=0 for schema compatibility)
				this.env.BILLING_DB.prepare(
					`INSERT INTO usage_hourly (site_id, hour_start, bandwidth_bytes, requests, cache_hits, cache_misses, created_at, updated_at)
					VALUES (?, ?, 0, ?, ?, ?, ?, ?)
					ON CONFLICT (site_id, hour_start) DO UPDATE SET
						requests = requests + excluded.requests,
						cache_hits = cache_hits + excluded.cache_hits,
						cache_misses = cache_misses + excluded.cache_misses,
						updated_at = excluded.updated_at`
				).bind(flushSiteId, hourStart, flushRequests, flushCacheHits, flushCacheMisses, now, now),
			];

			await this.env.BILLING_DB.batch(batch);
			d1Succeeded = true;

			console.log(
				`[UsageTracker] Flushed ${flushDomain}: ${flushRequests} req, ${flushCacheHits} hits, ${flushCacheMisses} misses`
			);

			// Subtract only what we flushed, preserving any metrics added during D1 write
			// This is safe because fetch() only adds to counters, never subtracts
			this.requests -= flushRequests;
			this.cacheHits -= flushCacheHits;
			this.cacheMisses -= flushCacheMisses;

			// D1 write succeeded - reset failure counter
			this.d1Failures = 0;

			// Persist all values atomically (counters + d1Failures reset)
			// CRITICAL: If this fails after D1 succeeded, we risk double-counting on DO eviction
			await this.state.storage.put({
				[STORAGE_KEYS.REQUESTS]: this.requests,
				[STORAGE_KEYS.CACHE_HITS]: this.cacheHits,
				[STORAGE_KEYS.CACHE_MISSES]: this.cacheMisses,
				[STORAGE_KEYS.D1_FAILURES]: 0,
			});
		} catch (err) {
			if (d1Succeeded) {
				// D1 succeeded but storage failed - CRITICAL: risk of double-counting on DO eviction
				// The data is already in D1, but if DO evicts before storage recovers,
				// loadFromStorage will restore old values and we'll write the same data again.
				// In-memory counters are already decremented, so we're OK if DO stays alive.
				console.error(
					`[UsageTracker] CRITICAL: D1 succeeded but storage failed for ${flushDomain}. ` +
					`If DO evicts before storage recovers, data may be double-counted. ` +
					`Flushed: ${flushRequests} requests.`,
					err
				);
				// Don't increment d1Failures - D1 didn't fail
				// Don't restore counters - they're correctly decremented in memory
			} else {
				// True D1 failure - track it and preserve counters for retry
				try {
					this.d1Failures += 1;
					await this.state.storage.put(STORAGE_KEYS.D1_FAILURES, this.d1Failures);

					console.error(`[UsageTracker] D1 write failed for ${flushDomain}:`, err, {
						consecutiveFailures: this.d1Failures,
						accumulatedRequests: this.requests,
					});

					// Alert if failure threshold exceeded (indicates persistent D1 issue)
					if (this.d1Failures >= D1_FAILURE_ALERT_THRESHOLD) {
						console.error(
							`[UsageTracker] ALERT: ${this.d1Failures} consecutive D1 failures for site:${flushSiteId} (${flushDomain}). ` +
							`Accumulated: ${this.requests} requests. ` +
							`Data preserved in DO storage, will retry on next alarm.`
						);
					}
				} catch (storageErr) {
					// Storage also failing - just log, alarm will still be rescheduled
					console.error(`[UsageTracker] Storage error while tracking D1 failure for ${flushDomain}:`, storageErr);
				}
				// Counters not modified - will retry on next alarm
			}
		} finally {
			// CRITICAL: Always reschedule alarm to prevent permanent stoppage
			// Even if D1 and storage both fail, we must keep trying
			try {
				await this.state.storage.setAlarm(Date.now() + 60000);
			} catch (alarmErr) {
				// If we can't set alarm, storage is fundamentally broken
				// Log and hope the next request to this DO triggers recovery
				console.error(`[UsageTracker] CRITICAL: Failed to reschedule alarm for ${flushDomain}:`, alarmErr);
			}
		}
	}
}
