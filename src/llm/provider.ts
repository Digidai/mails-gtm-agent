import { Env } from '../types'
import { callLLM } from './openrouter'

export interface LLMProvider {
  call(systemPrompt: string, userPrompt: string): Promise<string>
}

export function createProvider(env: Env): LLMProvider {
  return {
    call: (systemPrompt: string, userPrompt: string) => callLLM(env, systemPrompt, userPrompt),
  }
}
