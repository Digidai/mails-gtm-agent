import { Env, Campaign, CampaignContact, Event, KnowledgeBase, AgentDecision } from '../types'
import { callLLM } from '../llm/openrouter'
import { checkHardRules } from './rules'
import { truncateKnowledgeBase } from '../knowledge/generate'

/**
 * Make a decision for a contact: send, wait, or stop.
 *
 * 1. Check hard rules (code-enforced limits)
 * 2. If evaluate -> call LLM for decision
 * 3. Parse and return decision
 */
export async function makeDecision(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  events: Event[],
  knowledgeBase: KnowledgeBase,
): Promise<AgentDecision> {
  // 1. Hard rules
  const hardResult = checkHardRules(contact, events, campaign)

  if (hardResult === 'stop') {
    return {
      action: 'stop',
      reasoning: getStopReason(contact, events, campaign),
    }
  }

  if (hardResult === 'wait') {
    return {
      action: 'wait',
      reasoning: 'Minimum interval between emails not yet reached.',
      wait_days: campaign.min_interval_days,
    }
  }

  // 2. Build LLM context and call
  const systemPrompt = buildSystemPrompt(campaign, contact, events, knowledgeBase)
  const userPrompt = 'Based on the above context, make your decision. Return ONLY valid JSON.'

  try {
    const raw = await callLLM(env, systemPrompt, userPrompt)

    // Extract JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as AgentDecision

      // Validate action
      if (!['send', 'wait', 'stop'].includes(parsed.action)) {
        throw new Error(`Invalid action: ${parsed.action}`)
      }

      // Ensure reasoning exists
      if (!parsed.reasoning) {
        parsed.reasoning = 'No reasoning provided.'
      }

      // Validate email object for send action
      if (parsed.action === 'send') {
        if (!parsed.email || !parsed.email.subject || !parsed.email.body) {
          throw new Error('Send action requires email with subject and body')
        }
        if (!parsed.email.angle) {
          parsed.email.angle = 'general'
        }
      }

      // Default wait_days
      if (parsed.action === 'wait' && !parsed.wait_days) {
        parsed.wait_days = 3
      }

      return parsed
    }

    throw new Error('LLM response did not contain valid JSON')
  } catch (err) {
    console.error('LLM decision failed, defaulting to wait:', err)
    return {
      action: 'wait',
      reasoning: `LLM decision failed: ${(err as Error).message}. Will retry later.`,
      wait_days: 1,
    }
  }
}

function getStopReason(contact: CampaignContact, events: Event[], campaign: Campaign): string {
  const terminal = ['converted', 'stopped', 'unsubscribed', 'bounced', 'do_not_contact']
  if (terminal.includes(contact.status)) {
    return `Contact is in terminal status: ${contact.status}`
  }
  if (contact.emails_sent >= campaign.max_emails) {
    return `Maximum email limit reached (${contact.emails_sent}/${campaign.max_emails})`
  }
  return 'No-response streak exceeded 3 consecutive sends without engagement.'
}

function buildSystemPrompt(
  campaign: Campaign,
  contact: CampaignContact,
  events: Event[],
  kb: KnowledgeBase,
): string {
  const kbJson = truncateKnowledgeBase(kb)

  // Build event timeline
  let timeline: string
  if (events.length === 0) {
    timeline = '(no prior interactions)'
  } else {
    timeline = events
      .map(e => {
        let data = ''
        try {
          data = e.event_data && e.event_data !== '{}' ? ` | ${e.event_data}` : ''
        } catch { /* ignore */ }
        return `- ${e.created_at} | ${e.event_type}${data}`
      })
      .join('\n')
  }

  // Calculate days since last send
  let daysSinceLastSend = 'N/A (no emails sent)'
  if (contact.last_sent_at) {
    const days = Math.floor(
      (Date.now() - new Date(contact.last_sent_at).getTime()) / (1000 * 60 * 60 * 24),
    )
    daysSinceLastSend = `${days} days`
  }

  // Conversion status
  let conversionStatus = 'not converted'
  if (contact.converted_at) {
    conversionStatus = `${contact.conversion_type || 'converted'} at ${contact.converted_at}`
  }

  return `You are a PLG conversion Agent. Your goal is to get the contact to click the conversion link and complete conversion (signup/payment).

## Product Knowledge
${kbJson}

## Contact Information
- Name: ${contact.name || 'Unknown'}
- Company: ${contact.company || 'Unknown'}
- Role: ${contact.role || 'Unknown'}
- Email: ${contact.email}

## Interaction Timeline (chronological, last 20 events)
${timeline}

## Current State
- Emails sent: ${contact.emails_sent}
- Last email sent: ${contact.last_sent_at || 'never'}
- Days since last send: ${daysSinceLastSend}
- Contact status: ${contact.status}
- Conversion status: ${conversionStatus}

## Rules
1. Maximum ${campaign.max_emails} emails total (currently sent: ${contact.emails_sent})
2. Minimum ${campaign.min_interval_days} days between emails
3. If already converted (signup/payment), send a thank-you email then stop
4. If they replied "not interested" or "unsubscribe", stop immediately
5. Do NOT repeat the same angle/approach as a previous email
6. Every email MUST include the conversion link: ${campaign.conversion_url || '(not set)'}
7. Keep emails concise (max 5 sentences), professional, and value-driven
8. Use plain text format (no HTML)

## Decision
Return ONLY valid JSON:
{
  "action": "send" | "wait" | "stop",
  "reasoning": "one sentence explaining why",
  "email": {
    "angle": "first_touch / product_intro / case_study / tutorial / pricing / competitor_comparison / limited_offer / thank_you",
    "subject": "email subject line",
    "body": "full email body text"
  },
  "wait_days": 3
}

Notes:
- "email" is required only when action="send"
- "wait_days" is required only when action="wait" (how many days until next evaluation)`
}
