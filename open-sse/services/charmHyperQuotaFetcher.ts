/**
 * charmHyperQuotaFetcher.ts
 * QuotaFetcher for charm-hyper provider.
 *
 * Since charm-hyper has no polling endpoint, it relies on the response-side
 * updater (charmHyperQuotaUpdater.ts) to push balance data into the quota cache.
 * This fetcher simply returns the last-known value from that cache.
 */

import { registerQuotaFetcher, type QuotaInfo } from "./quotaPreflight.ts";
import { getQuotaCache } from "@/domain/quotaCache";

/**
 * Fetches the last-known quota for a charm-hyper connection from the in-memory cache.
 */
export async function fetchCharmHyperQuota(
  connectionId: string,
  connection?: Record<string, unknown>
): Promise<QuotaInfo | null> {
  const cache = getQuotaCache(connectionId);
  if (!cache) {
    // No cached data yet; assume healthy until a response proves otherwise.
    return {
      used: 0,
      total: 100,
      percentUsed: 0,
      resetAt: null,
    };
  }

  // The updater pushes the remaining percentage into the cache.
  const remainingPercent = cache.remainingPercentage ?? 100;
  
  return {
    used: 100 - remainingPercent,
    total: 100,
    percentUsed: 100 - remainingPercent,
    resetAt: null,
  };
}

export function registerCharmHyperQuotaFetcher(): void {
  registerQuotaFetcher("charm-hyper", fetchCharmHyperQuota);
}
