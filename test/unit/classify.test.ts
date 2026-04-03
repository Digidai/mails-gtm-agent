import { describe, test, expect } from 'bun:test'
import { classifyReply } from '../../src/llm/classify'
import { IntentType } from '../../src/types'
import { LLMProvider } from '../../src/llm/provider'

/** Create a mock LLM provider that returns a fixed classify response */
function mockProvider(intent: IntentType, confidence = 0.9, resume_date: string | null = null): LLMProvider {
  return {
    call: async () => JSON.stringify({ intent, confidence, resume_date }),
  }
}

describe('Reply Classifier', () => {
  test('classifies interested reply', async () => {
    const result = await classifyReply(mockProvider('interested', 0.95), "Yes, I'd love to learn more! Can we schedule a call?")
    expect(result.intent).toBe('interested')
    expect(result.confidence).toBe(0.95)
  })

  test('classifies not_now reply with resume date', async () => {
    const result = await classifyReply(mockProvider('not_now', 0.85, '2026-04-15'), "Interesting but we're in the middle of Q1 planning. Can you reach out in April?")
    expect(result.intent).toBe('not_now')
    expect(result.resume_date).toBe('2026-04-15')
  })

  test('classifies not_interested reply', async () => {
    const result = await classifyReply(mockProvider('not_interested', 0.9), "Thanks but we're not looking for this kind of solution.")
    expect(result.intent).toBe('not_interested')
  })

  test('classifies wrong_person reply', async () => {
    const result = await classifyReply(mockProvider('wrong_person', 0.8), "I'm not the right person. You should contact John in procurement.")
    expect(result.intent).toBe('wrong_person')
  })

  test('classifies out_of_office reply', async () => {
    const result = await classifyReply(mockProvider('out_of_office', 0.95), "I'm out of office until March 30. I'll respond when I return.")
    expect(result.intent).toBe('out_of_office')
  })

  test('classifies unsubscribe reply', async () => {
    const result = await classifyReply(mockProvider('unsubscribe', 0.95), "Please remove me from your mailing list.")
    expect(result.intent).toBe('unsubscribe')
  })

  test('classifies auto_reply', async () => {
    const result = await classifyReply(mockProvider('auto_reply', 0.9), "This is an automated response. Your email has been received.")
    expect(result.intent).toBe('auto_reply')
  })

  test('classifies do_not_contact reply', async () => {
    const result = await classifyReply(mockProvider('do_not_contact', 0.95), "Stop emailing me or I will report this as spam.")
    expect(result.intent).toBe('do_not_contact')
  })

  test('falls back to unclear on LLM failure', async () => {
    const provider: LLMProvider = {
      call: async () => { throw new Error('LLM unavailable') },
    }
    const result = await classifyReply(provider, "Some reply text")
    expect(result.intent).toBe('unclear')
    expect(result.confidence).toBe(0)
  })

  test('falls back to unclear on invalid JSON', async () => {
    const provider: LLMProvider = {
      call: async () => 'not valid json at all',
    }
    const result = await classifyReply(provider, "Some reply text")
    expect(result.intent).toBe('unclear')
  })

  test('handles LLM response wrapped in markdown code block', async () => {
    const provider: LLMProvider = {
      call: async () => '```json\n{"intent": "interested", "confidence": 0.9, "resume_date": null}\n```',
    }
    const result = await classifyReply(provider, "Yes, I'd love to hear more")
    expect(result.intent).toBe('interested')
  })
})
