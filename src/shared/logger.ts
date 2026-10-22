// ============================================================================
// 轻量调试日志（默认关闭）
// ============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const DEBUG = process.env.PI_WECHAT_DEBUG === '1'
const DEBUG_LOG_FILE = process.env.PI_WECHAT_DEBUG_FILE
  ?? path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant', 'debug.log')

export const MAX_LOG_BYTES = 1024 * 1024
const MAX_MESSAGE_CHARS = 1000

export function isDebugEnabled(): boolean {
  return DEBUG
}

export function debugLog(message: string): void {
  if (!DEBUG) return

  const timestamp = new Date().toISOString()
  // Call sites must pass metadata only. This is not a general-purpose secret scrubber.
  const safeMessage = message.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_MESSAGE_CHARS)
  const line = `[${timestamp}] ${safeMessage}\n`

  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true })
    if (fs.existsSync(DEBUG_LOG_FILE) && fs.statSync(DEBUG_LOG_FILE).size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      // Best effort for concurrent Pi processes; failures must not interrupt a bridge.
      fs.rmSync(`${DEBUG_LOG_FILE}.1`, { force: true })
      fs.renameSync(DEBUG_LOG_FILE, `${DEBUG_LOG_FILE}.1`)
    }
    fs.appendFileSync(DEBUG_LOG_FILE, line, { mode: 0o600 })
  } catch {
    // logging must never affect bridge behavior
  }
}

export function redactUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.origin.slice(0, 120) : '[redacted URL]'
  } catch {
    return '[invalid URL]'
  }
}

/** Errors can contain private paths, response bodies and URLs. Log codes only. */
export function debugError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'Error'
  const value = error as { name?: unknown; code?: unknown; status?: unknown }
  const name = ['Error', 'TypeError', 'RangeError', 'AbortError', 'TimeoutError', 'ApiError'].includes(String(value.name))
    ? String(value.name) : 'Error'
  const code = typeof value.code === 'number' && Number.isFinite(value.code) ? String(value.code)
    : typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(value.code) ? value.code : undefined
  const status = typeof value.status === 'number' && Number.isFinite(value.status) ? value.status : undefined
  return [name, code === undefined ? '' : `code=${code}`, status === undefined ? '' : `status=${status}`].filter(Boolean).join(' ')
}
