import { Campaign, CampaignContact, Event } from '../types'
import { TERMINAL_STATUSES } from '../queue/send-consumer'

export type HardRuleResult = 'send' | 'wait' | 'stop' | 'evaluate'

/**
 * Hard-coded rules that override LLM decision.
 * These protect against runaway sends.
 */
export function checkHardRules(
  contact: CampaignContact,
  events: Event[],
  campaign: Campaign,
): HardRuleResult {
  // Terminal statuses — never evaluate
  if (TERMINAL_STATUSES.includes(contact.status as typeof TERMINAL_STATUSES[number])) {
    return 'stop'
  }

  // Max emails reached
  if (contact.emails_sent >= campaign.max_emails) {
    return 'stop'
  }

  // Min interval check
  if (contact.last_sent_at) {
    const lastSent = new Date(contact.last_sent_at)
    const now = new Date()
    const daysSince = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60 * 24)
    if (daysSince < campaign.min_interval_days) {
      return 'wait'
    }
  }

  // Consecutive no-response streak (3 sends with no click or reply)
  const noResponseStreak = countNoResponseStreak(events)
  if (noResponseStreak >= 3) {
    return 'stop'
  }

  // Otherwise, let the LLM decide
  return 'evaluate'
}

/**
 * Count consecutive email_sent events with no intervening engagement events.
 * Looks at the most recent events.
 * Any engagement (link_click, reply, signup, payment) resets the streak.
 */
function countNoResponseStreak(events: Event[]): number {
  let streak = 0
  // Events are ordered oldest first, so iterate from newest
  const engagementTypes = ['link_click', 'reply', 'signup', 'payment']
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.event_type === 'email_sent') {
      streak++
    } else if (engagementTypes.includes(e.event_type)) {
      break
    }
    // Other event types (e.g. bounce, custom) are ignored — they neither
    // increase the streak nor break it.
  }
  return streak
}
