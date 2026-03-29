import { Campaign } from '../types'

/**
 * Calculate the daily send limit based on warmup schedule.
 *
 * warmup_start_volume: emails/day on day 1
 * warmup_increment:    additional emails/day each subsequent day
 *
 * Day 1: start_volume
 * Day 2: start_volume + increment
 * Day N: start_volume + (N-1) * increment
 *
 * Capped by the global daily limit.
 */
export function calculateDailyLimit(
  campaign: Campaign,
  globalDailyLimit: number
): number {
  if (!campaign.warmup_enabled) {
    return globalDailyLimit
  }

  if (!campaign.warmup_started_at) {
    return campaign.warmup_start_volume
  }

  const startDate = new Date(campaign.warmup_started_at)
  const now = new Date()
  const daysDiff = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  const dayNumber = Math.max(1, daysDiff + 1)

  const warmupLimit = campaign.warmup_start_volume + (dayNumber - 1) * campaign.warmup_increment

  return Math.min(warmupLimit, globalDailyLimit)
}

/**
 * Get the day number since warmup started
 */
export function getWarmupDay(campaign: Campaign): number {
  if (!campaign.warmup_started_at) return 1
  const startDate = new Date(campaign.warmup_started_at)
  const now = new Date()
  const daysDiff = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
  return Math.max(1, daysDiff + 1)
}
