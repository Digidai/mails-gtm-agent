import { describe, test, expect } from 'bun:test'
import { canAutoReply } from '../../src/scheduler/reply-cron'
import { Campaign, CampaignContact, IntentType } from '../../src/types'

function mockContact(overrides: Partial<CampaignContact> = {}): CampaignContact {
  return {
    id: 'contact-1',
    campaign_id: 'campaign-1',
    email: 'alice@example.com',
    name: 'Alice',
    company: 'Acme',
    role: 'CTO',
    custom_fields: '{}',
    status: 'active',
    current_step: 0,
    next_send_at: null,
    last_sent_at: new Date().toISOString(),
    sent_message_id: null,
    resume_at: null,
    reply_intent: null,
    reply_confidence: null,
    emails_sent: 1,
    last_click_at: null,
    converted_at: null,
    conversion_type: null,
    next_check_at: null,
    last_enqueued_at: null,
    auto_reply_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

function mockCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    product_name: 'TestProduct',
    product_description: 'A test product',
    from_email: 'hi@test.com',
    physical_address: '123 Main St',
    status: 'active',
    ai_generate: 1,
    warmup_enabled: 0,
    warmup_start_volume: 10,
    warmup_increment: 5,
    warmup_started_at: null,
    steps: '[]',
    last_inbox_check_at: null,
    engine: 'agent',
    product_url: null,
    conversion_url: 'https://example.com',
    knowledge_base: '{}',
    knowledge_base_status: 'manual',
    max_emails: 6,
    min_interval_days: 2,
    webhook_secret: null,
    dry_run: 0,
    daily_llm_calls: 0,
    daily_llm_limit: 100,
    daily_llm_reset_at: null,
    max_auto_replies: 5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('canAutoReply', () => {
  test('allows reply for interested intent with active contact', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'interested')).toBe(true)
  })

  test('allows reply for not_now intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'not_now')).toBe(true)
  })

  test('allows reply for wrong_person intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'wrong_person')).toBe(true)
  })

  test('allows reply for not_interested intent (sends final message)', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'not_interested')).toBe(true)
  })

  test('blocks reply for unsubscribe intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'unsubscribe')).toBe(false)
  })

  test('blocks reply for do_not_contact intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'do_not_contact')).toBe(false)
  })

  test('blocks reply for auto_reply intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'auto_reply')).toBe(false)
  })

  test('blocks reply for out_of_office intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'out_of_office')).toBe(false)
  })

  test('blocks reply for unclear intent', () => {
    expect(canAutoReply(mockContact(), mockCampaign(), 'unclear')).toBe(false)
  })

  test('blocks reply when auto_reply_count exceeds limit', () => {
    const contact = mockContact({ auto_reply_count: 5 })
    expect(canAutoReply(contact, mockCampaign(), 'interested')).toBe(false)
  })

  test('blocks reply when auto_reply_count equals limit', () => {
    const contact = mockContact({ auto_reply_count: 5 })
    const campaign = mockCampaign({ max_auto_replies: 5 })
    expect(canAutoReply(contact, campaign, 'interested')).toBe(false)
  })

  test('allows reply when auto_reply_count is below limit', () => {
    const contact = mockContact({ auto_reply_count: 4 })
    const campaign = mockCampaign({ max_auto_replies: 5 })
    expect(canAutoReply(contact, campaign, 'interested')).toBe(true)
  })

  test('respects custom max_auto_replies', () => {
    const contact = mockContact({ auto_reply_count: 2 })
    const campaign = mockCampaign({ max_auto_replies: 3 })
    expect(canAutoReply(contact, campaign, 'interested')).toBe(true)

    const contact2 = mockContact({ auto_reply_count: 3 })
    expect(canAutoReply(contact2, campaign, 'interested')).toBe(false)
  })

  test('blocks reply for terminal statuses', () => {
    const terminalStatuses = ['unsubscribed', 'bounced', 'do_not_contact', 'converted', 'stopped', 'not_interested', 'interested', 'error']
    for (const status of terminalStatuses) {
      const contact = mockContact({ status })
      expect(canAutoReply(contact, mockCampaign(), 'interested')).toBe(false)
    }
  })

  test('allows reply for non-terminal statuses', () => {
    const activeStatuses = ['active', 'sent', 'replied', 'not_now', 'wrong_person']
    for (const status of activeStatuses) {
      const contact = mockContact({ status })
      expect(canAutoReply(contact, mockCampaign(), 'interested')).toBe(true)
    }
  })

  test('defaults max_auto_replies to 5 when undefined', () => {
    const contact = mockContact({ auto_reply_count: 4 })
    const campaign = mockCampaign()
    // @ts-ignore — test undefined
    campaign.max_auto_replies = undefined as any
    expect(canAutoReply(contact, campaign, 'interested')).toBe(true)

    const contact2 = mockContact({ auto_reply_count: 5 })
    expect(canAutoReply(contact2, campaign, 'interested')).toBe(false)
  })
})
