import { Env, ConversationMessage } from '../types'

/**
 * Record an Agent-sent email to the conversations table.
 */
export async function recordAgentMessage(
  env: Env,
  campaignId: string,
  contactId: string,
  content: string,
  subject: string | null,
  messageId: string | null,
): Promise<void> {
  const id = crypto.randomUUID().replace(/-/g, '')
  await env.DB.prepare(
    'INSERT INTO conversations (id, campaign_id, contact_id, role, content, message_id, subject) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, campaignId, contactId, 'agent', content, messageId || null, subject || null).run()
}

/**
 * Record a contact's reply to the conversations table.
 */
export async function recordContactMessage(
  env: Env,
  campaignId: string,
  contactId: string,
  content: string,
  messageId: string | null,
): Promise<void> {
  const id = crypto.randomUUID().replace(/-/g, '')
  await env.DB.prepare(
    'INSERT INTO conversations (id, campaign_id, contact_id, role, content, message_id) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(id, campaignId, contactId, 'contact', content, messageId || null).run()
}

/**
 * Get full conversation history for a contact in a specific campaign
 * (most recent 10 turns = 20 messages).
 */
export async function getConversationHistory(
  env: Env,
  contactId: string,
  campaignId: string,
): Promise<ConversationMessage[]> {
  const result = await env.DB.prepare(`
    SELECT role, content, subject, created_at
    FROM conversations
    WHERE contact_id = ? AND campaign_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).bind(contactId, campaignId).all<ConversationMessage>()

  // Return in chronological order (oldest first)
  return (result.results || []).reverse()
}

/**
 * Sanitize message content: strip control characters and HTML tags.
 * Applied to contact messages to mitigate prompt injection via conversation history.
 */
function sanitizeContent(text: string): string {
  let cleaned = text
  // Strip control characters except newline/tab
  cleaned = cleaned.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  // Strip HTML/script tags
  cleaned = cleaned.replace(/<[^>]*>/g, '')
  return cleaned
}

/**
 * Format conversation history into a readable string for LLM context.
 * Uses [Agent] and [Contact name / email] prefixes.
 * Contact messages are sanitized to mitigate prompt injection.
 */
export function formatConversation(
  messages: ConversationMessage[],
  contactName?: string | null,
): string {
  if (!messages.length) return '(No previous conversation)'

  const label = contactName || 'Contact'

  return messages
    .map((msg) => {
      const prefix = msg.role === 'agent' ? '[Agent]' : `[${label}]`
      // Sanitize contact messages to mitigate prompt injection
      let content = msg.role === 'contact' ? sanitizeContent(msg.content) : msg.content
      // Truncate very long messages to keep context manageable
      content = content.length > 500 ? content.slice(0, 500) + '...' : content
      return `${prefix} ${content}`
    })
    .join('\n\n')
}
