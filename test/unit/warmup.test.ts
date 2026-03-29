import { describe, test, expect } from 'bun:test'
import { calculateDailyLimit, getWarmupDay } from '../../src/utils/warmup'
import { Campaign } from '../../src/types'

function makeCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'test-campaign',
    name: 'Test',
    product_name: 'Test Product',
    product_description: 'A test product',
    from_email: 'test@example.com',
    physical_address: '',
    status: 'active',
    ai_generate: 1,
    warmup_enabled: 1,
    warmup_start_volume: 10,
    warmup_increment: 5,
    warmup_started_at: null,
    steps: '[]',
    last_inbox_check_at: null,
    engine: 'sequence',
    product_url: null,
    conversion_url: null,
    knowledge_base: '{}',
    knowledge_base_status: 'pending',
    max_emails: 6,
    min_interval_days: 2,
    webhook_secret: null,
    dry_run: 0,
    daily_llm_calls: 0,
    daily_llm_limit: 100,
    daily_llm_reset_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('Warmup Calculator', () => {
  test('returns start volume on day 1 (no warmup_started_at)', () => {
    const campaign = makeCampaign()
    expect(calculateDailyLimit(campaign, 100)).toBe(10)
  })

  test('returns start volume on day 1 (warmup just started)', () => {
    const campaign = makeCampaign({
      warmup_started_at: new Date().toISOString(),
    })
    expect(calculateDailyLimit(campaign, 100)).toBe(10)
  })

  test('increments correctly on day 5', () => {
    const fiveDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000)
    const campaign = makeCampaign({
      warmup_started_at: fiveDaysAgo.toISOString(),
    })
    // Day 5: 10 + (5-1)*5 = 30
    expect(calculateDailyLimit(campaign, 100)).toBe(30)
  })

  test('caps at global daily limit', () => {
    const thirtyDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)
    const campaign = makeCampaign({
      warmup_started_at: thirtyDaysAgo.toISOString(),
    })
    // Day 30: 10 + 29*5 = 155, but global limit is 100
    expect(calculateDailyLimit(campaign, 100)).toBe(100)
  })

  test('returns global limit when warmup disabled', () => {
    const campaign = makeCampaign({ warmup_enabled: 0 })
    expect(calculateDailyLimit(campaign, 100)).toBe(100)
  })

  test('getWarmupDay returns 1 when not started', () => {
    const campaign = makeCampaign()
    expect(getWarmupDay(campaign)).toBe(1)
  })

  test('getWarmupDay returns correct day', () => {
    const threeDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const campaign = makeCampaign({
      warmup_started_at: threeDaysAgo.toISOString(),
    })
    expect(getWarmupDay(campaign)).toBe(3)
  })
})
