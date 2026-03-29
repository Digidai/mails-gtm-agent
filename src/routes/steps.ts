import { Env, Campaign } from '../types'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export interface StepInput {
  step_number: number
  delay_days: number
  subject_template: string | null
  body_template: string | null
  ai_generate: boolean
}

export async function handleStepsRoutes(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method

  // POST /api/campaign/:id/steps
  const postMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/steps$/)
  if (postMatch && method === 'POST') {
    return setSteps(postMatch[1], request, env)
  }

  // GET /api/campaign/:id/steps
  const getMatch = path.match(/^\/api\/campaign\/([a-f0-9]+)\/steps$/)
  if (getMatch && method === 'GET') {
    return getSteps(getMatch[1], env)
  }

  return json({ error: 'Not Found' }, 404)
}

async function setSteps(campaignId: string, request: Request, env: Env): Promise<Response> {
  // Verify campaign exists
  const campaign = await env.DB.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  const body = await request.json() as any
  const steps: StepInput[] = body.steps

  if (!Array.isArray(steps) || steps.length === 0) {
    return json({ error: 'steps must be a non-empty array' }, 400)
  }

  // Validate step_number is strictly increasing
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]

    if (typeof step.step_number !== 'number' || step.step_number < 1) {
      return json({ error: `steps[${i}].step_number must be a positive integer` }, 400)
    }

    if (i > 0 && step.step_number <= steps[i - 1].step_number) {
      return json({ error: `steps[${i}].step_number must be greater than steps[${i - 1}].step_number (${steps[i - 1].step_number})` }, 400)
    }

    if (typeof step.delay_days !== 'number' || step.delay_days < 0) {
      return json({ error: `steps[${i}].delay_days must be a non-negative number` }, 400)
    }

    // If not ai_generate, must have subject and body templates
    if (!step.ai_generate) {
      if (!step.subject_template || !step.body_template) {
        return json({ error: `steps[${i}]: non-AI steps require subject_template and body_template` }, 400)
      }
    }
  }

  // Convert to the internal format stored in campaigns.steps JSON column
  const stepsJson = steps.map(s => ({
    step_number: s.step_number,
    delay_days: s.delay_days,
    subject_template: s.subject_template || '',
    body_template: s.body_template || '',
    ai_generate: s.ai_generate ? true : false,
  }))

  // Update the campaign's steps column (replace all old steps)
  await env.DB.prepare(`
    UPDATE campaigns SET steps = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(JSON.stringify(stepsJson), campaignId).run()

  return json({ campaign_id: campaignId, steps: stepsJson }, 200)
}

async function getSteps(campaignId: string, env: Env): Promise<Response> {
  const campaign = await env.DB.prepare('SELECT id, steps FROM campaigns WHERE id = ?').bind(campaignId).first<Campaign>()
  if (!campaign) {
    return json({ error: 'Campaign not found' }, 404)
  }

  const steps = JSON.parse(campaign.steps || '[]')
  return json({ campaign_id: campaignId, steps })
}
