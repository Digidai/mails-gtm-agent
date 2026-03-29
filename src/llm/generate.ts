import { Env, GenerateResult, CampaignContact, Campaign, CampaignStep } from '../types'
import { callLLM } from './openrouter'

function buildSystemPrompt(campaign: Campaign, contact: CampaignContact): string {
  return `You are writing a cold outreach email for ${campaign.product_name}.
Product: ${campaign.product_description}
Recipient: ${contact.name || 'there'}, ${contact.role || 'professional'} at ${contact.company || 'their company'}
Tone: professional, concise, max 5 sentences.
Include a specific reason why ${contact.company || 'their company'} would benefit.
Return ONLY valid JSON: { "subject": "...", "body": "..." }`
}

function buildUserPrompt(step: CampaignStep, stepNumber: number): string {
  if (stepNumber === 0) {
    return 'Write the initial cold outreach email.'
  }
  return `Write follow-up email #${stepNumber + 1}. Be brief, reference the previous email, and provide additional value.`
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function applyTemplate(template: string, contact: CampaignContact): string {
  const custom = JSON.parse(contact.custom_fields || '{}')
  let result = template
  result = result.replace(/\{\{name\}\}/g, contact.name || '')
  result = result.replace(/\{\{company\}\}/g, contact.company || '')
  result = result.replace(/\{\{role\}\}/g, contact.role || '')
  result = result.replace(/\{\{email\}\}/g, contact.email)
  for (const [key, value] of Object.entries(custom)) {
    // Escape key to prevent ReDoS from user-controlled CSV column names
    result = result.replace(new RegExp(`\\{\\{${escapeRegex(key)}\\}\\}`, 'g'), String(value))
  }
  return result
}

export async function generateEmail(
  env: Env,
  campaign: Campaign,
  contact: CampaignContact,
  stepNumber: number
): Promise<GenerateResult> {
  const steps: CampaignStep[] = JSON.parse(campaign.steps || '[]')
  const step = steps[stepNumber]

  // If AI generation is enabled
  if (campaign.ai_generate) {
    try {
      const systemPrompt = buildSystemPrompt(campaign, contact)
      const userPrompt = buildUserPrompt(step, stepNumber)
      const raw = await callLLM(env, systemPrompt, userPrompt)

      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as GenerateResult
        if (parsed.subject && parsed.body) {
          return parsed
        }
      }
    } catch (err) {
      console.error('LLM generation failed, falling back to template:', err)
    }
  }

  // Fallback: use template with variable replacement
  if (step) {
    return {
      subject: applyTemplate(step.subject_template || `Following up - ${campaign.product_name}`, contact),
      body: applyTemplate(step.body_template || `Hi {{name}},\n\nI wanted to reach out about ${campaign.product_name}.\n\nBest regards`, contact),
    }
  }

  // Last resort default
  return {
    subject: `Introduction - ${campaign.product_name}`,
    body: `Hi ${contact.name || 'there'},\n\nI wanted to introduce ${campaign.product_name}. ${campaign.product_description}\n\nWould you be open to a quick chat?\n\nBest regards`,
  }
}
