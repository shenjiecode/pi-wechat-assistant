import * as path from 'node:path'
import { getStateDir, readJsonFile, writeJsonFile, deleteFile } from './state-storage.js'

const CONTEXT_TOKENS_FILE = path.join(getStateDir(), 'context-tokens.json')
const CURSOR_FILE = path.join(getStateDir(), 'cursor.json')
const SEEN_IDS_FILE = path.join(getStateDir(), 'seen-ids.json')

export async function clearContextTokens(): Promise<void> {
  await deleteFile(CONTEXT_TOKENS_FILE)
}

// --- 消息游标（跨重启持久化，防止重放历史消息导致重复回复） ---

export async function loadCursor(): Promise<string> {
  const data = await readJsonFile<{ cursor: string }>(CURSOR_FILE)
  return data?.cursor ?? ''
}

export async function saveCursor(cursor: string): Promise<void> {
  if (!cursor) return
  await writeJsonFile(CURSOR_FILE, { cursor, updatedAt: new Date().toISOString() })
}

// --- 已见消息 id（持久化去重，游标丢失/过期时兜底防重发） ---

const MAX_SEEN_IDS = 5_000

export async function loadSeenIds(): Promise<Set<string>> {
  const data = await readJsonFile<{ ids: string[] }>(SEEN_IDS_FILE)
  return new Set(data?.ids ?? [])
}

export async function saveSeenIds(ids: Set<string>): Promise<void> {
  const arr = Array.from(ids)
  if (arr.length === 0) return
  // 只保留最近 N 个，防止文件无限增长
  const trimmed = arr.length > MAX_SEEN_IDS ? arr.slice(arr.length - MAX_SEEN_IDS) : arr
  await writeJsonFile(SEEN_IDS_FILE, { ids: trimmed, updatedAt: new Date().toISOString() })
}

/** 登录身份变化后清除旧长轮询位置，避免跨凭证复用游标和去重记录。 */
export async function clearTransportState(): Promise<void> {
  await Promise.all([deleteFile(CURSOR_FILE), deleteFile(SEEN_IDS_FILE)])
}

// --- Context Tokens 持久化 ---

export interface PersistedContextTokens {
  /** 上次活跃的微信用户 ID */
  lastUserId: string | null
  /** userId → context_token 映射 */
  tokens: Record<string, string>
}

/** 用于节流持久化的定时器 */
let _contextTokensFlushTimer: ReturnType<typeof setTimeout> | null = null
let _contextTokensWrite: Promise<void> = Promise.resolve()
const CONTEXT_TOKENS_FLUSH_MS = 5_000

function queueContextTokensWrite(data: PersistedContextTokens): Promise<void> {
  // A timer may already be writing when handoff begins. Flush must wait behind it.
  _contextTokensWrite = _contextTokensWrite.catch(() => {}).then(() => writeJsonFile(CONTEXT_TOKENS_FILE, data))
  return _contextTokensWrite
}

export async function loadContextTokens(): Promise<PersistedContextTokens> {
  const data = await readJsonFile<PersistedContextTokens>(CONTEXT_TOKENS_FILE)
  return data ?? { lastUserId: null, tokens: {} }
}

/**
 * 节流写入 — 5 秒内多次调用只写最后一次。
 * 如果需要在退出前确保写入，请直接 await flushContextTokens()。
 */
export function saveContextTokensThrottled(data: PersistedContextTokens): void {
  if (_contextTokensFlushTimer) clearTimeout(_contextTokensFlushTimer)
  _contextTokensFlushTimer = setTimeout(() => {
    _contextTokensFlushTimer = null
    void queueContextTokensWrite(data).catch(() => {})
  }, CONTEXT_TOKENS_FLUSH_MS)
}

/** 立即持久化 context tokens（退出时使用） */
export async function flushContextTokens(data: PersistedContextTokens): Promise<void> {
  if (_contextTokensFlushTimer) {
    clearTimeout(_contextTokensFlushTimer)
    _contextTokensFlushTimer = null
  }
  await queueContextTokensWrite(data)
}
