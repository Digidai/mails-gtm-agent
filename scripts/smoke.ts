#!/usr/bin/env bun
/**
 * scripts/smoke.ts — minimal production smoke test
 *
 * Verifies the deployed worker is doing real work end-to-end:
 *   1. POST /api/campaign/create with product_url → expects 201 in <5s
 *   2. Poll campaigns table until knowledge_base_status='ready' (max 120s)
 *   3. Verify KB has expected shape (product_name field non-empty)
 *   4. DELETE the test campaign + its child rows
 *
 * Exits 0 on success, 1 on failure. Suitable for CI smoke step + manual
 * post-deploy verification. Run via:
 *
 *   bun run smoke
 *
 * Required env (passed via wrangler dev or process.env when run locally):
 *   GTM_API           e.g. https://mails-gtm-agent.genedai.workers.dev
 *   ADMIN_TOKEN       worker /api/* auth token
 *   CF_ACCOUNT_ID     for D1 cleanup query
 *   CF_API_TOKEN      for D1 cleanup query
 *   D1_DATABASE_ID    mails-gtm D1 UUID
 */

const env = (k: string): string => {
  const v = process.env[k]
  if (!v) {
    console.error(`✗ env ${k} not set`)
    process.exit(1)
  }
  return v
}

const GTM_API        = env('GTM_API')
const ADMIN_TOKEN    = env('ADMIN_TOKEN')
const CF_ACCOUNT_ID  = env('CF_ACCOUNT_ID')
const CF_API_TOKEN   = env('CF_API_TOKEN')
const D1_DATABASE_ID = env('D1_DATABASE_ID')

const D1_QUERY_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`

async function d1<T = unknown>(sql: string): Promise<T[]> {
  const res = await fetch(D1_QUERY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mails-gtm-smoke/1.0',
    },
    body: JSON.stringify({ sql }),
  })
  const data: any = await res.json()
  if (!data.success) throw new Error(`d1 error: ${JSON.stringify(data.errors)}`)
  return data.result[0].results as T[]
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${GTM_API}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'mails-gtm-smoke/1.0',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed: any
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  return { status: res.status, body: parsed }
}

let campaignId: string | null = null

async function cleanup() {
  if (!campaignId) return
  try {
    for (const tbl of [
      'tracked_links', 'unsubscribes', 'scheduled_replies',
      'events', 'send_log', 'decision_log', 'conversations', 'campaign_contacts',
    ]) {
      await d1(`DELETE FROM ${tbl} WHERE campaign_id='${campaignId}';`)
    }
    await d1(`DELETE FROM campaigns WHERE id='${campaignId}';`)
    console.log(`  ↳ cleaned up campaign ${campaignId}`)
  } catch (err) {
    console.warn(`  ↳ cleanup failed (rows may linger): ${err}`)
  }
}

async function main() {
  console.log(`smoke test → ${GTM_API}`)
  const t0 = Date.now()

  // Step 1: create campaign
  console.log('[1/3] POST /api/campaign/create...')
  const stamp = Date.now()
  const created = await api('POST', '/api/campaign/create', {
    name: `smoke-${stamp}`,
    product_url: 'https://github.com/Digidai/mails-gtm-agent',
    from_email: 'smoke@example.com',
    physical_address: 'Smoke Test, Demo, CA 94000',
    engine: 'agent',
    ai_generate: true,
  })
  if (created.status !== 201) {
    console.error(`✗ create returned HTTP ${created.status}: ${JSON.stringify(created.body)}`)
    process.exit(1)
  }
  campaignId = created.body.id
  const createMs = Date.now() - t0
  console.log(`  ↳ created ${campaignId} in ${createMs}ms`)
  if (createMs > 8000) {
    console.warn(`  ↳ WARN: create took ${createMs}ms (>8s suggests synchronous LLM in request path — should be async via EVALUATE_QUEUE)`)
  }

  // Step 2: poll knowledge_base_status
  console.log('[2/3] polling for KB ready (max 120s)...')
  const pollStart = Date.now()
  let kbStatus = 'pending'
  let kbLen = 0
  while (Date.now() - pollStart < 120_000) {
    const rows = await d1<{ knowledge_base_status: string; kb_len: number }>(
      `SELECT knowledge_base_status, LENGTH(knowledge_base) AS kb_len FROM campaigns WHERE id='${campaignId}';`,
    )
    if (rows.length) {
      kbStatus = rows[0].knowledge_base_status
      kbLen = rows[0].kb_len ?? 0
      if (kbStatus === 'ready' || kbStatus === 'failed') break
    }
    await new Promise(r => setTimeout(r, 5_000))
  }
  const kbMs = Date.now() - pollStart
  console.log(`  ↳ status=${kbStatus} kb_len=${kbLen} elapsed=${(kbMs / 1000).toFixed(1)}s`)
  if (kbStatus !== 'ready') {
    console.error(`✗ KB did not become ready (status=${kbStatus})`)
    await cleanup()
    process.exit(1)
  }
  if (kbLen < 200) {
    console.error(`✗ KB suspiciously short (${kbLen} bytes); expected ≥200`)
    await cleanup()
    process.exit(1)
  }

  // Step 3: verify shape
  console.log('[3/3] verifying KB shape...')
  const rows = await d1<{ knowledge_base: string }>(
    `SELECT knowledge_base FROM campaigns WHERE id='${campaignId}';`,
  )
  const kb = JSON.parse(rows[0].knowledge_base)
  if (!kb.product_name || typeof kb.product_name !== 'string') {
    console.error(`✗ KB missing product_name`)
    await cleanup()
    process.exit(1)
  }
  console.log(`  ↳ product_name="${kb.product_name}" features=${(kb.features ?? []).length}`)

  await cleanup()

  console.log('')
  console.log(`✓ smoke OK · total ${(Date.now() - t0) / 1000}s`)
  process.exit(0)
}

main().catch(async (err) => {
  console.error(`✗ smoke failed: ${err}`)
  await cleanup()
  process.exit(1)
})
