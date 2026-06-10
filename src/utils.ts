// ============================================================================
// 通用工具函数
// ============================================================================

import qrcode from 'qrcode-terminal'
import { PREVIEW_LIMIT } from './constants.js'

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }], details: {} }
}

export function fail(text: string) {
  return { content: [{ type: 'text' as const, text: `❌ ${text}` }], details: {} }
}

export async function renderQrCode(url: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(url, { small: true }, (code) => resolve(code))
  })
}

export function extractAllAssistantReplies(
  messages: Array<{ role?: string; content?: unknown }>,
): string[] {
  const replies: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message?.role !== 'assistant') continue
    if (typeof message.content === 'string') {
      const text = message.content.trim()
      if (text) replies.push(text)
      continue
    }
    if (!Array.isArray(message.content)) continue
    const text = message.content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
      )
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim()
    if (text) replies.push(text)
  }
  return replies
}

export function extractTextFromMessageContent(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() || null
  if (!Array.isArray(content)) return null
  const text = content
    .filter((part): part is { type: 'text'; text: string } =>
      typeof part === 'object' && part !== null && (part as { type?: string }).type === 'text',
    )
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
  return text || null
}

export function summarizePreview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length <= PREVIEW_LIMIT ? normalized : `${normalized.slice(0, PREVIEW_LIMIT - 1)}…`
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}
