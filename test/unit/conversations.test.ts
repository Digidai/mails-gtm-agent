import { describe, test, expect } from 'bun:test'
import { formatConversation } from '../../src/conversations/context'
import { ConversationMessage } from '../../src/types'

describe('Conversation Context', () => {
  describe('formatConversation', () => {
    test('returns placeholder for empty history', () => {
      const result = formatConversation([])
      expect(result).toBe('(No previous conversation)')
    })

    test('formats single agent message', () => {
      const messages: ConversationMessage[] = [
        { role: 'agent', content: 'Hi Alice, check out our product!', created_at: '2026-03-28T10:00:00Z' },
      ]
      const result = formatConversation(messages, 'Alice')
      expect(result).toBe('[Agent] Hi Alice, check out our product!')
    })

    test('formats multi-turn conversation with contact name', () => {
      const messages: ConversationMessage[] = [
        { role: 'agent', content: 'Hi Alice, mails-agent gives your AI agents email capabilities.', created_at: '2026-03-28T10:00:00Z' },
        { role: 'contact', content: 'Interesting, but how does it compare to AgentMail?', created_at: '2026-03-28T11:00:00Z' },
        { role: 'agent', content: 'Great question. Key differences: free vs $97/mo, self-hosted, MCP built-in.', created_at: '2026-03-28T11:05:00Z' },
      ]
      const result = formatConversation(messages, 'Alice')
      expect(result).toContain('[Agent] Hi Alice')
      expect(result).toContain('[Alice] Interesting')
      expect(result).toContain('[Agent] Great question')
    })

    test('uses "Contact" label when no name provided', () => {
      const messages: ConversationMessage[] = [
        { role: 'contact', content: 'Tell me more.', created_at: '2026-03-28T10:00:00Z' },
      ]
      const result = formatConversation(messages)
      expect(result).toBe('[Contact] Tell me more.')
    })

    test('uses "Contact" label when name is null', () => {
      const messages: ConversationMessage[] = [
        { role: 'contact', content: 'Tell me more.', created_at: '2026-03-28T10:00:00Z' },
      ]
      const result = formatConversation(messages, null)
      expect(result).toBe('[Contact] Tell me more.')
    })

    test('truncates very long messages', () => {
      const longContent = 'A'.repeat(600)
      const messages: ConversationMessage[] = [
        { role: 'agent', content: longContent, created_at: '2026-03-28T10:00:00Z' },
      ]
      const result = formatConversation(messages)
      expect(result.length).toBeLessThan(600)
      expect(result).toContain('...')
    })

    test('separates messages with double newlines', () => {
      const messages: ConversationMessage[] = [
        { role: 'agent', content: 'First message', created_at: '2026-03-28T10:00:00Z' },
        { role: 'contact', content: 'Second message', created_at: '2026-03-28T11:00:00Z' },
      ]
      const result = formatConversation(messages, 'Bob')
      expect(result).toBe('[Agent] First message\n\n[Bob] Second message')
    })
  })
})
