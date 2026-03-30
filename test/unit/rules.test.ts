import { describe, test, expect } from 'bun:test'
import { checkHardRules } from '../../src/agent/rules'
import { Campaign, CampaignContact, Event } from '../../src/types'

function mockCampaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'campaign-1',
    name: 'Test Campaign',
    product_name: 'TestProduct',
    product_description: 'A test product',
    from_email: 'test@example.com',
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

function mockContact(overrides: Partial<CampaignContact> = {}): CampaignContact {
  return {
    id: 'contact-1',
    campaign_id: 'campaign-1',
    email: 'alice@acme.com',
    name: 'Alice',
    company: 'Acme',
    role: 'CTO',
    custom_fields: '{}',
    status: 'active',
    current_step: 0,
    next_send_at: null,
    last_sent_at: null,
    sent_message_id: null,
    resume_at: null,
    reply_intent: null,
    reply_confidence: null,
    emails_sent: 0,
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

function mockEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: crypto.randomUUID(),
    campaign_id: 'campaign-1',
    contact_id: 'contact-1',
    event_type: 'email_sent',
    event_data: '{}',
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('Hard Rules', () => {
  test('returns evaluate for normal contact', () => {
    const result = checkHardRules(mockContact(), [], mockCampaign())
    expect(result).toBe('evaluate')
  })

  test('returns stop for terminal status: converted', () => {
    const result = checkHardRules(mockContact({ status: 'converted' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop for terminal status: unsubscribed', () => {
    const result = checkHardRules(mockContact({ status: 'unsubscribed' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop for terminal status: bounced', () => {
    const result = checkHardRules(mockContact({ status: 'bounced' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop for terminal status: stopped', () => {
    const result = checkHardRules(mockContact({ status: 'stopped' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop for terminal status: interested', () => {
    const result = checkHardRules(mockContact({ status: 'interested' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop for terminal status: error', () => {
    const result = checkHardRules(mockContact({ status: 'error' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop for terminal status: do_not_contact', () => {
    const result = checkHardRules(mockContact({ status: 'do_not_contact' }), [], mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns stop when max_emails reached', () => {
    const result = checkHardRules(
      mockContact({ emails_sent: 6 }),
      [],
      mockCampaign({ max_emails: 6 }),
    )
    expect(result).toBe('stop')
  })

  test('returns stop when max_emails exceeded', () => {
    const result = checkHardRules(
      mockContact({ emails_sent: 8 }),
      [],
      mockCampaign({ max_emails: 6 }),
    )
    expect(result).toBe('stop')
  })

  test('returns wait when min interval not met', () => {
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString()
    const result = checkHardRules(
      mockContact({ last_sent_at: oneHourAgo }),
      [],
      mockCampaign({ min_interval_days: 2 }),
    )
    expect(result).toBe('wait')
  })

  test('returns evaluate when min interval is met', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    const result = checkHardRules(
      mockContact({ last_sent_at: threeDaysAgo }),
      [],
      mockCampaign({ min_interval_days: 2 }),
    )
    expect(result).toBe('evaluate')
  })

  test('returns stop on 3 consecutive no-response sends', () => {
    const events = [
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-25T10:00:00Z' }),
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-27T10:00:00Z' }),
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-29T10:00:00Z' }),
    ]
    const result = checkHardRules(mockContact(), events, mockCampaign())
    expect(result).toBe('stop')
  })

  test('returns evaluate when click breaks no-response streak', () => {
    const events = [
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-25T10:00:00Z' }),
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-27T10:00:00Z' }),
      mockEvent({ event_type: 'link_click', created_at: '2026-03-27T14:00:00Z' }),
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-29T10:00:00Z' }),
    ]
    const result = checkHardRules(mockContact(), events, mockCampaign())
    expect(result).toBe('evaluate')
  })

  test('returns evaluate when reply breaks no-response streak', () => {
    const events = [
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-25T10:00:00Z' }),
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-27T10:00:00Z' }),
      mockEvent({ event_type: 'reply', created_at: '2026-03-28T10:00:00Z' }),
      mockEvent({ event_type: 'email_sent', created_at: '2026-03-29T10:00:00Z' }),
    ]
    const result = checkHardRules(mockContact(), events, mockCampaign())
    expect(result).toBe('evaluate')
  })
})
