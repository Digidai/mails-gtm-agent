import { Env } from '../types'

/**
 * Atomically claim an LLM quota slot for a campaign.
 * Returns true if a slot was successfully claimed, false if the limit is reached.
 * Resets the daily counter if daily_llm_reset_at is stale (before today).
 *
 * Extracted from reply-cron.ts to be shared by both reply-cron and evaluate-consumer,
 * fixing the non-atomic read-then-increment race in evaluate-consumer.
 */
export async function claimLlmQuota(env: Env, campaignId: string): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10)

  // First, try to reset if the reset date is stale (before today)
  await env.DB.prepare(
    "UPDATE campaigns SET daily_llm_calls = 0, daily_llm_reset_at = ? WHERE id = ? AND (daily_llm_reset_at IS NULL OR daily_llm_reset_at < ?)",
  ).bind(today, campaignId, today).run()

  // Atomically claim a slot
  const result = await env.DB.prepare(
    "UPDATE campaigns SET daily_llm_calls = daily_llm_calls + 1 WHERE id = ? AND daily_llm_calls < daily_llm_limit",
  ).bind(campaignId).run()

  return !!(result.meta?.changes)
}
