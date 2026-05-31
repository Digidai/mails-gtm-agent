import { describe, test, expect } from 'bun:test'
import { sanitizeEmail } from '../../src/agent/decide'
import type { CampaignContact, Campaign } from '../../src/types'

const baseContact: CampaignContact = {
  id: 'c1',
  campaign_id: 'cmp1',
  email: 'alice@example.com',
  name: 'Alice Chen',
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
  created_at: '2026-05-31',
  updated_at: '2026-05-31',
}

const baseCampaign = {
  product_name: 'mails-gtm-agent',
  product_url: 'https://github.com/Digidai/mails-gtm-agent',
  conversion_url: 'https://github.com/Digidai/mails-gtm-agent/stargazers',
  from_email: 'gene@mails0.com',
  sender_name: 'Gene',
} as unknown as Campaign

describe('sanitizeEmail — URL repair', () => {
  test('repairs LLM-mangled URL with host-only fragment', () => {
    // The exact mangling seen in the 2026-05-31 dress rehearsal:
    // "want to com/Digidai/mails-gtm-agent/stargazers" with protocol+host dropped.
    const mangled = {
      subject: 'open source AI SDR',
      body: 'Hi Alice,\n\nMight be useful for Acme — want to com/Digidai/mails-gtm-agent/stargazers\n\nBest,\nGene',
    }
    const out = sanitizeEmail(mangled, baseContact, baseCampaign)
    expect(out.body).toContain('https://github.com/Digidai/mails-gtm-agent/stargazers')
    // The bare "want to com/..." fragment must be gone (now replaced by https://...)
    expect(out.body).not.toMatch(/want to com\/Digidai/)
  })

  test('repairs URL fragment with full hostname but no protocol', () => {
    const mangled = {
      subject: 'AI SDR',
      body: 'Hi Alice,\n\nCheck github.com/Digidai/mails-gtm-agent/stargazers\n\nBest,\nGene',
    }
    const out = sanitizeEmail(mangled, baseContact, baseCampaign)
    expect(out.body).toContain('https://github.com/Digidai/mails-gtm-agent/stargazers')
  })

  test('leaves a correctly-formatted URL untouched', () => {
    const ok = {
      subject: 'AI SDR',
      body: 'Hi Alice,\n\nTake a look: https://github.com/Digidai/mails-gtm-agent/stargazers\n\nBest,\nGene',
    }
    const out = sanitizeEmail(ok, baseContact, baseCampaign)
    expect(out.body.match(/https:\/\/github\.com\/Digidai\/mails-gtm-agent\/stargazers/g)?.length).toBe(1)
  })

  test('does not insert a URL when no fragment is present in the body', () => {
    const noUrl = {
      subject: 'AI SDR',
      body: 'Hi Alice,\n\nCheck the repo for details.\n\nBest,\nGene',
    }
    const out = sanitizeEmail(noUrl, baseContact, baseCampaign)
    expect(out.body).not.toContain('https://github.com')
  })
})
