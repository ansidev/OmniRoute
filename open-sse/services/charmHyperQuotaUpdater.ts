/**
 * charmHyperQuotaUpdater.ts
 * Updates the quota cache for charm-hyper provider based on the usage object in responses.
 *
 * This is called from the chat handlers after receiving a response (non-streaming or streaming)
 * to extract the remaining hypercredits and update the quota cache.
 */

import { setQuotaCache } from "@/domain/quotaCache";
import { saveQuotaSnapshot } from "@/lib/db/quotaSnapshots";

/**
 * Extracts remaining hypercredits from the raw usage object and updates the quota cache.
 * @param provider - The provider ID (should be "charm-hyper")
 * @param connectionId - The connection ID for which to update quota
 * @param rawUsage - The raw usage object from the provider's response
 */
export async function updateCharmHyperQuota(
  provider: string,
  connectionId: string,
  rawUsage: Record<string, unknown> | null
): Promise<void> {
  // Only process for charm-hyper provider
  if (provider !== "charm-hyper" || !rawUsage) {
    return;
  }

  // Extract remaining hypercredits from the usage object
  const remainingObj = rawUsage.remaining;
  if (!remainingObj || typeof remainingObj !== "object") {
    // No remaining object, nothing to update
    return;
  }

  const remainingHypercredits = remainingObj.hypercredits;
  if (typeof remainingHypercredits !== "number" || !isFinite(remainingHypercredits)) {
    // Invalid or missing hypercredits value
    return;
  }

  // For charm-hyper, we don't have a total quota from the API, so we cannot compute a percentage.
  // However, the quota cache expects a remainingPercentage (0-100). We have two options:
  // 1. Treat the remaining hypercredits as an absolute value and rely on the quotaMonitor
  //    to use the raw value (if the system supports it) or
  // 2. Assume a default total (which is not ideal).
  //
  // Looking at the quotaCache types, the `QuotaCacheEntry` stores `remainingPercentage`.
  // The `quotaMonitor` and `quotaPreflight` use this percentage to decide when to switch.
  //
  // Since we don't have a total, we cannot compute a percentage. However, note that the
  // existing quota system for charm-hyper (as per the ticket) is currently not working at all
  // because there is no fetcher. We are introducing the ability to track the remaining
  // hypercredits.
  //
  // A pragmatic approach: we can store the remaining hypercredits as the `remainingPercentage`
  // by assuming a sufficiently large total that we never hit 0% until the actual remaining
  // hits 0. Alternatively, we can change the quota cache to store absolute values? But that
  // would require changes across the system.
  //
  // However, note that the `quotaMonitor` and `quotaPreflight` use the `remainingPercentage`
  // to compare against a cutoff (e.g., 10%). If we set the remainingPercentage to the actual
  // remaining hypercredits, then a cutoff of 10 would mean switch when remaining hypercredits <= 10.
  // This is acceptable if we consider the total to be large enough that we never worry about
  // the percentage being more than 100? Actually, the remainingPercentage is expected to be
  // between 0 and 100. If we store the raw remaining hypercredits, it could be any number.
  //
  // Let's look at how the quota is used: in `quotaCache.ts`, the function `isQuotaExhaustedForRequest`
  // checks if the remainingPercentage <= 0 (or < cutoff). So it's a threshold on the percentage.
  //
  // Given the constraints, we decide to store the remaining hypercredits as the percentage
  // by scaling it to a hypothetical total. But we don't know the total.
  //
  // Alternative: we can store the remaining hypercredits in the `raw_data` field and then
  // in the quota fetcher, we can return a QuotaInfo that uses the raw data to compute a
  // percentage based on a known total? But we don't have a total.
  //
  // Let's re-examine the ticket: the requirement is to support provider quota based on the
  // team's Hypercredit balance. The existing quota system uses a percentage. We can
  // assume that the team has a known total hypercredit quota? Not provided in the API.
  //
  // However, note that the `usage` object also returns `cost.hypercredits` per request.
  // We could theoretically track the total by summing the cost? But that would be
  // usage-based, not the remaining balance.
  //
  // Given the time, and the fact that the ticket is about recognizing the credits-exhausted
  // signal (i.e., when remaining hypercredits reaches 0), we can set the remainingPercentage
  // to 0 when remainingHypercredits <= 0, and to 100 otherwise. This is a binary state
  // (exhausted or not) but it will allow the system to switch when the account is depleted.
  //
  // But wait, the ticket says: "Support provider quota for the `charm-hyper` API-key provider
  // based on the team's Hypercredit balance." It doesn't require percentage tracking, just
  // the ability to know when the balance is exhausted so that we can switch accounts.
  //
  // The existing quota system uses thresholds (like 10%) to switch *before* exhaustion to
  // avoid failed requests. If we only know when it's exactly 0, we might still get a 402
  // before switching.
  //
  // However, note that the 402 is the signal we are trying to catch. The ticket says the
  // 402 is not being recognized as a credits-exhausted signal. So if we can detect the 402
  // and mark the account as exhausted, that would be sufficient? But the ticket is about
  // using the balance in the usage object, not the 402.
  //
  // Let's read the ticket again: the 402 is fired via the status_402 rule, which does NOT
  // set creditsExhausted: true. So the goal is to use the balance in the usage object to
  // set creditsExhausted: true when the balance is 0 (or low) so that the connection is
  // marked as exhausted and removed from rotation.
  //
  // Therefore, we want to update the quota cache such that when the remaining hypercredits
  // is 0 (or below a threshold), the connection is considered exhausted.
  //
  // We can do this by setting the remainingPercentage to 0 when remainingHypercredits is 0,
  // and to 100 when it's above 0. But that loses granularity.
  //
  // Another idea: we can store the remaining hypercredits in the quota cache as a raw value
  // and then modify the quota monitor and preflight to use that raw value for charm-hyper.
  // However, that would require changing the core quota logic to be provider-specific.
  //
  // Given the ponytail principle, we choose the simplest solution that works: we will
  // update the quota cache with a remainingPercentage that is derived from the remaining
  // hypercredits by assuming a fixed total. We can use a high total (e.g., 1_000_000) so
  // that the percentage is small and we never hit 0% until the remaining hypercredits is 0.
  // But note: if the total is actually small, we might never switch until it's too late.
  //
  // However, without knowing the total, we cannot do better. And the ticket does not
  // require us to know the total, only to support quota based on the balance.
  //
  // Let's look at how other providers handle this: they have a quota endpoint that returns
  // both used and total, so they can compute a percentage. We don't have that.
  //
  // Given the above, I propose we store the remaining hypercredits as the remainingPercentage
  // by assuming a total of 1 (so the percentage is remainingHypercredits * 100). This way,
  // if the remaining hypercredits is 0.5, the percentage is 50. But note: the hypercredits
  // in the example are integers (12, 88). So we can assume they are integers.
  //
  // However, the quota cache expects a number between 0 and 100. If we get 88 remaining,
  // that would be 88% which is valid. If we get 120, that would be 120% which is above 100.
  // We can clamp the percentage to 100 if it's above 100.
  //
  // Let's assume the total is the maximum we've seen so far? We don't have a history.
  //
  // Simpler: we treat the remaining hypercredits as the percentage, but we cap it at 100.
  // This means that if the remaining hypercredits is >= 100, we consider the quota as 100%.
  // And if it's 0, we consider it 0%. This gives us a linear mapping from 0-100 hypercredits
  // to 0-100%, and anything above 100 hypercredits is considered 100% (which is fine because
  // we only care about the lower end for exhaustion).
  //
  // This is a reasonable approximation for the purpose of triggering a switch when the
  // balance is low.
  //
  // We'll compute:
  //   let percentage = Math.min(100, Math.max(0, remainingHypercredits));
  //
  // But note: the example shows 88 remaining -> 88%, which is correct.
  //
  // However, what if the total is actually 1000? Then 88 remaining is 8.8%, but we are
  // treating it as 88%. This would cause us to switch too early (when we think we have
  // 88% left but actually we have 8.8% left). This is the opposite of what we want.
  //
  // Actually, we want to switch when the balance is low. If we overestimate the percentage
  // (think we have more than we actually do), we might switch too late.
  //
  // Example: 
  //   Actual total: 1000 hypercredits
  //   Actual remaining: 88 hypercredits -> 8.8%
  //   We treat it as 88% -> we think we have plenty, so we don't switch.
  //   Then we run out and get a 402.
  //
  // This is bad.
  //
  // We need to avoid switching too late. So we want to underestimate the percentage
  // (think we have less than we actually do) so that we switch too early.
  //
  // How can we do that without knowing the total? We can't.
  //
  // Given the dilemma, and the fact that the ticket is about recognizing the credits-exhausted
  // signal (i.e., when the balance is 0), we can focus on detecting when the balance is 0
  // and mark the account as exhausted. For any positive balance, we can mark the account
  // as having plenty (e.g., 100%) so that we don't switch prematurely.
  //
  // This way, we only switch when we know for sure the balance is 0 (or negative, which
  // shouldn't happen). This prevents us from switching too early, but we might switch
  // too late (only after we hit 0). However, note that the usage object is returned with
  // the response, so we update the cache after the request. If the request brought us
  // to 0, we will have already made the request that exhausted the account.
  //
  // But the ticket says: "A depleted account therefore burns one failed upstream call per
  // model (each locked out one-by-one, then re-selected after the cooldown expires)."
  // So the problem is that when the account is depleted, we are still sending requests
  // (and getting 402) because the account is not marked as exhausted.
  //
  // If we mark the account as exhausted when the balance is 0, then after the request that
  // brought the balance to 0, we will mark it as exhausted and the next request will
  // switch to another account.
  //
  // This means we will still get one 402 (the request that exhausted the account) but
  // then we switch. This is acceptable because we cannot know the balance before the
  // request (since there's no polling endpoint).
  //
  // Therefore, we will:
  //   - If remainingHypercredits <= 0, set remainingPercentage = 0 (exhausted)
  //   - Else, set remainingPercentage = 100 (not exhausted)
  //
  // This is a binary state but it solves the problem of not recognizing the exhaustion.
  //
  // We'll also save the raw hypercredits in the snapshot for analytics.

  // Determine if the account is exhausted based on remaining hypercredits <= 0
  const isExhausted = remainingHypercredits <= 0;
  const remainingPercentage = isExhausted ? 0 : 100;

  // Update the in-memory quota cache
  setQuotaCache(connectionId, provider, {
    remainingPercentage,
    // For charm-hyper, we don't have a resetAt from the usage object, so we set it to null.
    // The quotaMonitor and quotaPreflight will use the remainingPercentage and resetAt.
    resetAt: null,
  });

  // Save a snapshot for analytics (quota_snapshots table)
  // We store the raw hypercredits in the raw_data field.
  saveQuotaSnapshot({
    provider,
    connection_id: connectionId,
    window_key: "remaining", // We don't have windows, so we use a fixed key
    remaining_percentage: remainingPercentage,
    is_exhausted: isExhausted,
    next_reset_at: null, // We don't have reset time from the API
    window_duration_ms: 0, // Not applicable
    raw_data: JSON.stringify({
      hypercredits: remainingHypercredits,
    }),
    // created_at will be set by the saveQuotaSnapshot function
  });
}