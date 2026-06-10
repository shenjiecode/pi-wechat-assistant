// ============================================================================
// 轻量调试日志（默认关闭）
// ============================================================================

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const DEBUG = process.env.PI_WECHAT_DEBUG === '1'
const DEBUG_LOG_FILE = process.env.PI_WECHAT_DEBUG_FILE
  ?? path.join(os.homedir(), '.pi', 'agent', 'wechat-assistant', 'debug.log')

export function isDebugEnabled(): boolean {
  return DEBUG
}

export function debugLog(message: string): void {
  if (!DEBUG) return

  const timestamp = new Date().toISOString()
  const line = `[${timestamp}] ${message}\n`

  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true })
    fs.appendFileSync(DEBUG_LOG_FILE, line, { mode: 0o600 })
  } catch {
    // logging must never affect bridge behavior
  }
}

export function redactUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`.slice(0, 120)
  } catch {
    return url.slice(0, 80)
  }
}
