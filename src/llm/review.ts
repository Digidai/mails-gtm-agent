import { KnowledgeBase } from '../types'
import { extractJson } from './openrouter'
import { LLMProvider } from './provider'
import { truncateKnowledgeBase } from '../knowledge/generate'

export interface ReviewResult {
  approved: boolean
  issues: string[]
  corrected_body?: string
}

/**
 * Review an email before sending to ensure content accuracy.
 * Checks that product descriptions match the knowledge base
 * and that no fabricated features/claims are present.
 *
 * On LLM failure, defaults to NOT approved (fail-safe: use safe template).
 */
export async function reviewEmail(
  provider: LLMProvider,
  knowledgeBase: KnowledgeBase,
  subject: string,
  body: string,
  contactName: string,
  productName: string,
): Promise<ReviewResult> {
  const kbJson = truncateKnowledgeBase(knowledgeBase)

  const systemPrompt = `你是邮件质量审查员。审查以下冷邮件是否准确和合适。

## 产品知识库（唯一的事实来源）
${kbJson}

## 审查标准
1. 产品描述是否与知识库一致？（不能编造功能、用途、价格）
2. 是否包含知识库中不存在的产品功能声明？
3. 安装命令/URL 是否正确？
4. 是否包含转化链接？
5. 语气是否专业友好（不过度推销）？
6. 是否有明显的事实错误？

返回 JSON:
{
  "approved": true/false,
  "issues": ["问题1", "问题2"],
  "corrected_body": "修正后的邮件正文（仅当 approved=false 且可修正时提供）"
}

如果邮件完全准确，返回 { "approved": true, "issues": [] }`

  const userPrompt = `## 待审查的邮件
Product: ${productName}
Recipient: ${contactName}
Subject: ${subject}
Body:
${body}`

  try {
    const raw = await provider.call(systemPrompt, userPrompt)
    const jsonStr = extractJson(raw)

    if (jsonStr) {
      const parsed = JSON.parse(jsonStr)
      return {
        approved: parsed.approved === true,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        corrected_body: typeof parsed.corrected_body === 'string' ? parsed.corrected_body : undefined,
      }
    }
  } catch (err) {
    console.error('[review] LLM review failed, defaulting to NOT approved (fail-safe):', err)
  }

  // On failure, default to NOT approved — use safe template (fail-safe)
  return { approved: false, issues: ['LLM review unavailable — using safe template'] }
}

/**
 * Build a safe fallback email from the knowledge base when the reviewer
 * rejects a generated email and cannot provide a corrected version.
 */
export function buildSafeEmail(
  knowledgeBase: KnowledgeBase,
  contactName: string,
): { subject: string; body: string } {
  const name = contactName || 'there'
  const productName = knowledgeBase.product_name || 'our product'
  const tagline = knowledgeBase.tagline || knowledgeBase.description || ''
  const description = knowledgeBase.description || ''
  const conversionUrl = knowledgeBase.conversion_url || ''

  const subject = `Introducing ${productName}`

  const lines: string[] = [
    `Hi ${name},`,
    '',
    `I'd like to introduce ${productName}${tagline ? ' — ' + tagline : ''}.`,
  ]

  if (description && description !== tagline) {
    lines.push('')
    lines.push(description)
  }

  if (conversionUrl) {
    lines.push('')
    lines.push(`You can try it here: ${conversionUrl}`)
  }

  lines.push('')
  lines.push(`Best,`)
  lines.push(`${productName} team`)

  return { subject, body: lines.join('\n') }
}
