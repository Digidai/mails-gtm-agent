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

async function hmacVerify(data: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(data, secret)
  // Constant-time comparison to prevent timing attacks
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
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
  const payload: UnsubscribePayload = {
    email,
    campaign_id: campaignId,
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60, // 1 year
  }
  const payloadStr = base64UrlEncode(JSON.stringify(payload))
  const sig = await hmacSign(payloadStr, secret)
  return `${payloadStr}.${sig}`
}

export async function verifyUnsubscribeToken(
  token: string,
  secret: string
): Promise<UnsubscribePayload | null> {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payloadStr, sig] = parts
  const valid = await hmacVerify(payloadStr, sig, secret)
  if (!valid) return null

  try {
    const payload = JSON.parse(base64UrlDecode(payloadStr)) as UnsubscribePayload
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
