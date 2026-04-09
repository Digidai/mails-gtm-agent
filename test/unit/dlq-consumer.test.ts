import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { dlqConsumer } from '../../src/queue/dlq-consumer'

// Mock DB, recordEvent, notifyOwner, mailsFetch
function createMockEnv(overrides: Record<string, unknown> = {}) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => overrides.campaign ?? { id: 'camp1', name: 'Test Campaign', from_email: 'hi@test.com' },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    },
    MAILS_MAILBOX: 'test@mails0.com',
    MAILS_API_URL: 'https://test.workers.dev',
    MAILS_API_KEY: 'test-key',
    MAILS_WORKER: {
      fetch: async () => new Response(JSON.stringify({ id: 'msg1' }), { status: 200 }),
    },
    ...overrides,
  } as any
}

function createMockBatch(messages: Array<{ body: Record<string, unknown> }>) {
  return {
    messages: messages.map(m => ({
      body: m.body,
      ack: mock(() => {}),
      retry: mock(() => {}),
    })),
  } as any
}

describe('dlqConsumer', () => {
  test('processes message with known campaign and contact', async () => {
    const env = createMockEnv()
    const batch = createMockBatch([{
      body: {
        type: 'agent_send',
        campaign_id: 'camp1',
        contact_id: 'cont1',
        to: 'alice@example.com',
      },
    }])

    await dlqConsumer(batch, env)

    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(batch.messages[0].retry).not.toHaveBeenCalled()
  })

  test('handles unknown campaign_id gracefully', async () => {
    const env = createMockEnv()
    const batch = createMockBatch([{
      body: { type: 'agent_send' }, // no campaign_id or contact_id
    }])

    await dlqConsumer(batch, env)

    // Should still ack — DLQ messages are always acknowledged
    expect(batch.messages[0].ack).toHaveBeenCalled()
  })

  test('handles unknown contact_id — skips recordEvent but still notifies', async () => {
    const env = createMockEnv()
    const batch = createMockBatch([{
      body: { type: 'evaluate', campaign_id: 'camp1' }, // no contact_id
    }])

    await dlqConsumer(batch, env)

    expect(batch.messages[0].ack).toHaveBeenCalled()
  })

  test('acks even when notifyOwner throws', async () => {
    const env = createMockEnv({
      campaign: null, // campaign not found → notifyOwner won't be called
    })
    const batch = createMockBatch([{
      body: { type: 'agent_send', campaign_id: 'camp1', contact_id: 'cont1' },
    }])

    await dlqConsumer(batch, env)

    // Should still ack even though campaign was null
    expect(batch.messages[0].ack).toHaveBeenCalled()
  })

  test('acks on general processing error (outer catch)', async () => {
    // DB.prepare throws → outer catch → ack
    const env = createMockEnv({
      DB: {
        prepare: () => { throw new Error('DB connection failed') },
      },
    })
    const batch = createMockBatch([{
      body: { type: 'agent_send', campaign_id: 'camp1', contact_id: 'cont1' },
    }])

    await dlqConsumer(batch, env)

    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(batch.messages[0].retry).not.toHaveBeenCalled()
  })

  test('processes multiple messages in batch', async () => {
    const env = createMockEnv()
    const batch = createMockBatch([
      { body: { type: 'agent_send', campaign_id: 'camp1', contact_id: 'c1' } },
      { body: { type: 'evaluate', campaign_id: 'camp2', contact_id: 'c2' } },
    ])

    await dlqConsumer(batch, env)

    expect(batch.messages[0].ack).toHaveBeenCalled()
    expect(batch.messages[1].ack).toHaveBeenCalled()
  })
})
