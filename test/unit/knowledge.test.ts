import { describe, test, expect, beforeEach } from 'bun:test'
import { truncateKnowledgeBase } from '../../src/knowledge/generate'
import { KnowledgeBase } from '../../src/types'

const originalFetch = globalThis.fetch

describe('Knowledge Base - truncateKnowledgeBase', () => {
  test('returns full JSON when under limit', () => {
    const kb: KnowledgeBase = {
      product_name: 'TestProduct',
      tagline: 'A test product',
      features: ['Feature 1'],
    }
    const result = truncateKnowledgeBase(kb)
    const parsed = JSON.parse(result)
    expect(parsed.product_name).toBe('TestProduct')
    expect(parsed.features).toHaveLength(1)
  })

  test('trims FAQ first when over limit', () => {
    const kb: KnowledgeBase = {
      product_name: 'TestProduct',
      faq: Array.from({ length: 20 }, (_, i) => ({
        q: `Question ${i}?`.repeat(50),
        a: `Answer ${i}.`.repeat(50),
      })),
    }
    const result = truncateKnowledgeBase(kb, 5000)
    const parsed = JSON.parse(result)
    // Should have trimmed FAQ
    expect(parsed.faq.length).toBeLessThanOrEqual(3)
  })

  test('trims features when FAQ trim is not enough', () => {
    const kb: KnowledgeBase = {
      product_name: 'TestProduct',
      features: Array.from({ length: 50 }, (_, i) => `Feature ${i} `.repeat(30)),
      faq: [{ q: 'Q1', a: 'A1' }],
    }
    const result = truncateKnowledgeBase(kb, 5000)
    const parsed = JSON.parse(result)
    expect(parsed.features.length).toBeLessThanOrEqual(5)
  })
})

describe('Knowledge Base - generateKnowledgeBase', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
  })

  test('generates knowledge base from URL (mocked)', async () => {
    let fetchCalls = 0
    globalThis.fetch = (async (url: string, opts?: any) => {
      fetchCalls++
      if (fetchCalls === 1) {
        // md.genedai.me call
        return new Response('# TestProduct\nA great product for testing things.\nFeatures: fast, reliable, secure.')
      }
      // OpenRouter LLM call
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              product_name: 'TestProduct',
              tagline: 'A great product',
              description: 'For testing things',
              features: ['fast', 'reliable', 'secure'],
              pricing: 'Free',
            }),
          },
        }],
      }))
    }) as any

    const { generateKnowledgeBase } = await import('../../src/knowledge/generate')
    const env = {
      OPENROUTER_API_KEY: 'test-key',
    } as any

    const kb = await generateKnowledgeBase('https://testproduct.com', env)
    expect(kb.product_name).toBe('TestProduct')
    expect(kb.features).toContain('fast')
    expect(fetchCalls).toBe(2) // md.genedai.me + LLM
  })

  test('throws on empty page content', async () => {
    globalThis.fetch = (async () => new Response('')) as any

    const { generateKnowledgeBase } = await import('../../src/knowledge/generate')
    const env = { OPENROUTER_API_KEY: 'test-key' } as any

    await expect(generateKnowledgeBase('https://empty.com', env)).rejects.toThrow('insufficient content')
  })

  test('throws on fetch failure', async () => {
    globalThis.fetch = (async () => new Response('Not Found', { status: 404 })) as any

    const { generateKnowledgeBase } = await import('../../src/knowledge/generate')
    const env = { OPENROUTER_API_KEY: 'test-key' } as any

    await expect(generateKnowledgeBase('https://404.com', env)).rejects.toThrow('Failed to fetch')
  })
})
