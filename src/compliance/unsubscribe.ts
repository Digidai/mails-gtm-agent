import { Env } from '../types'

// Simple HMAC-based token (no external JWT library needed)
// Token format: base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(payload, secret))

async function hmacSign(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(data))
  return base64UrlEncode(new Uint8Array(signature))
}

function base64UrlEncode(data: Uint8Array | string): string {
  let bytes: Uint8Array
  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data)
  } else {
    bytes = data
  }
  const base64 = btoa(String.fromCharCode(...bytes))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64UrlDecode(str: string): string {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (base64.length % 4) base64 += '='
  return atob(base64)
}

export interface UnsubscribePayload {
  email: string
  campaign_id: string
  exp: number // expiry timestamp (Unix seconds)
}

export async function generateUnsubscribeToken(
  email: string,
  campaignId: string,
  secret: string
): Promise<string> {
  // 用短字段名压缩 payload 长度
  const payload = { e: email, c: campaignId, x: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 }
  const payloadStr = base64UrlEncode(JSON.stringify(payload))
  // 签名取前 16 字符，足够防篡改
  const sig = await hmacSign(payloadStr, secret)
  const shortSig = sig.slice(0, 16)
  return `${payloadStr}.${shortSig}`
}

export async function verifyUnsubscribeToken(
  token: string,
  secret: string
): Promise<UnsubscribePayload | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payloadStr, sig] = parts
  // 签名只比较前 16 字符（与生成时一致）
  const expectedFull = await hmacSign(payloadStr, secret)
  const expectedShort = expectedFull.slice(0, 16)
  if (sig.length !== expectedShort.length) return null
  let diff = 0
  for (let i = 0; i < sig.length; i++) {
    diff |= sig.charCodeAt(i) ^ expectedShort.charCodeAt(i)
  }
  if (diff !== 0) return null

  try {
    const raw = JSON.parse(base64UrlDecode(payloadStr))
    // 支持短字段名 (e/c/x) 和旧格式 (email/campaign_id/exp)
    const payload: UnsubscribePayload = {
      email: raw.e || raw.email,
      campaign_id: raw.c || raw.campaign_id,
      exp: raw.x || raw.exp,
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    if (!payload.email || !payload.campaign_id) return null
    return payload
  } catch {
    return null
  }
}

export function generateUnsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/unsubscribe?token=${encodeURIComponent(token)}`
}
