import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ApiError } from '../wechat/api.js'
import { getStateDir } from './state-storage.js'

export const MAX_PENDING_REPLIES = 100
export const MAX_OUTBOX_BYTES = 4 * 1024 * 1024
export const MAX_REPLAY_CHUNKS = 20
const REPLAY_BUDGET_MS = 5_000

export interface OutboxIdentity {
  accountId: string
  userId: string
}

export interface ReplyOrigin {
  cwd: string
  sessionId?: string
}

export interface OutboxStatus {
  pending: number
  uncertain: number
}

export interface ReplyTransport {
  /** Rechecked after asynchronous writes and before every send. */
  active: () => boolean
  send: (text: string) => Promise<void>
}

interface PendingReply {
  id: string
  createdAt: string
  origin: ReplyOrigin
  chunks: string[]
  nextChunk: number
  // Written BEFORE a replay request. A crash/timeout must not cause blind retries.
  state: 'pending' | 'uncertain'
}

interface StoredOutbox {
  version: 1
  identity: OutboxIdentity
  replies: PendingReply[]
}

export class OutboxStorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'OutboxStorageError'
  }
}

function rejectedForContext(error: unknown): boolean {
  return error instanceof ApiError && error.code === -2
}

function validReply(value: unknown): value is PendingReply {
  if (!value || typeof value !== 'object') return false
  const r = value as PendingReply
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt))
    && !!r.origin && typeof r.origin.cwd === 'string'
    && (r.origin.sessionId === undefined || typeof r.origin.sessionId === 'string')
    && Array.isArray(r.chunks) && r.chunks.length > 0
    && r.chunks.every(chunk => typeof chunk === 'string' && chunk.trim().length > 0)
    && Number.isInteger(r.nextChunk) && r.nextChunk >= 0 && r.nextChunk < r.chunks.length
    && (r.state === 'pending' || r.state === 'uncertain')
}

/**
 * Durable recovery for assistant TEXT only. The bridge owner opens this after
 * acquiring its lock and pauses/drains it before releasing ownership. It is not
 * the inbound MessageQueue, and never reads/replays Pi's conversation history.
 */
export class ReplyOutbox {
  private replies: PendingReply[] = []
  private tail: Promise<void> = Promise.resolve()
  private paused = false
  readonly filePath: string

  private constructor(private readonly identity: OutboxIdentity, private readonly onChange?: () => void) {
    const key = createHash('sha256').update(JSON.stringify([identity.accountId, identity.userId])).digest('hex')
    this.filePath = path.join(getStateDir(), 'outbox', `${key}.json`)
  }

  static async open(identity: OutboxIdentity, onChange?: () => void): Promise<ReplyOutbox> {
    if (!identity.accountId.trim() || !identity.userId.trim()) {
      throw new OutboxStorageError('无法确认待补发回复所属的微信账号')
    }
    // Callers may pass a Credentials-shaped object: never persist its token.
    const outbox = new ReplyOutbox({ accountId: identity.accountId, userId: identity.userId }, onChange)
    await outbox.load()
    return outbox
  }

  get status(): OutboxStatus {
    return {
      pending: this.replies.filter(reply => reply.state === 'pending').length,
      uncertain: this.replies.filter(reply => reply.state === 'uncertain').length,
    }
  }

  /** Includes persistence after an in-flight rejection, not just the HTTP send. */
  pause(): Promise<void> {
    this.paused = true
    return this.tail
  }

  deliver(chunks: string[], origin: ReplyOrigin, transport: ReplyTransport): Promise<'sent' | 'queued' | 'stopped'> {
    return this.serial(async () => {
      if (!this.active(transport)) return 'stopped'
      if (!chunks.length) return 'sent'
      // Keep later output behind known-undelivered replies, without repeatedly
      // hitting an inactive conversation. Only fresh inbound activity drains it.
      if (this.status.pending > 0) {
        await this.enqueue(chunks, origin)
        return 'queued'
      }
      for (let index = 0; index < chunks.length; index++) {
        if (!this.active(transport)) return 'stopped'
        try {
          await transport.send(chunks[index])
        } catch (error) {
          if (!rejectedForContext(error)) throw error
          // Save even if stop/handoff started while this request was in flight.
          await this.enqueue(chunks.slice(index), origin)
          return 'queued'
        }
      }
      return 'sent'
    })
  }

  /** Called after an authorized, deduplicated inbound message refreshed context. */
  replay(transport: ReplyTransport): Promise<void> {
    return this.serial(async () => {
      const deadline = Date.now() + REPLAY_BUDGET_MS
      let sent = 0
      for (let reply of [...this.replies]) {
        // An ambiguous send cannot safely be retried, even after a restart.
        if (reply.state === 'uncertain') continue
        while (reply.nextChunk < reply.chunks.length) {
          if (!this.active(transport) || sent >= MAX_REPLAY_CHUNKS || Date.now() >= deadline) return
          const pending = reply
          reply = { ...reply, state: 'uncertain' }
          await this.replace(reply)
          if (!this.active(transport)) {
            await this.replace(pending)
            return
          }
          try {
            await transport.send(reply.chunks[reply.nextChunk])
          } catch (error) {
            // Explicit rejection means definitely not delivered. Any other
            // failure leaves the durable uncertain marker for manual review.
            if (rejectedForContext(error)) await this.replace(pending)
            throw error
          }
          sent++
          reply = { ...reply, nextChunk: reply.nextChunk + 1, state: 'pending' }
          await this.replace(reply)
        }
      }
    })
  }

  private active(transport: ReplyTransport): boolean {
    return !this.paused && transport.active()
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.tail.then(action)
    this.tail = task.then(() => {}, () => {})
    return task
  }

  private async enqueue(chunks: string[], origin: ReplyOrigin): Promise<void> {
    if (this.replies.length >= MAX_PENDING_REPLIES) {
      throw new OutboxStorageError('微信待补发队列已满（100 条）；本次回复未暂存，请在 Pi 会话中查看')
    }
    const createdAt = new Date().toISOString()
    const reply: PendingReply = {
      id: randomUUID(), createdAt, origin: { cwd: origin.cwd, sessionId: origin.sessionId }, nextChunk: 0, state: 'pending',
      chunks: [`【补发】此前未送达的回复（${createdAt}），以下仅包含尚未发送的部分：`, ...chunks],
    }
    await this.commit([...this.replies, reply], 128)
  }

  private replace(reply: PendingReply): Promise<void> {
    const replies = reply.nextChunk === reply.chunks.length
      ? this.replies.filter(item => item.id !== reply.id)
      : this.replies.map(item => item.id === reply.id ? reply : item)
    return this.commit(replies)
  }

  private async load(): Promise<void> {
    try {
      const info = await fs.stat(this.filePath)
      if (info.size > MAX_OUTBOX_BYTES) throw new Error('oversized outbox')
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as StoredOutbox
      if (data?.version !== 1
        || data.identity?.accountId !== this.identity.accountId || data.identity?.userId !== this.identity.userId
        || !Array.isArray(data.replies) || data.replies.length > MAX_PENDING_REPLIES
        || !data.replies.every(validReply) || new Set(data.replies.map(reply => reply.id)).size !== data.replies.length) {
        throw new Error('invalid outbox')
      }
      this.replies = data.replies
      await fs.chmod(this.filePath, 0o600).catch(() => {})
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // Do not treat corruption or permission errors as an empty queue, which
      // would silently overwrite undelivered replies on the next write.
      throw new OutboxStorageError('无法读取微信待补发记录；原文件未修改，请检查本地 outbox 目录', error)
    }
  }

  private async commit(replies: PendingReply[], reserveBytes = 0): Promise<void> {
    const data: StoredOutbox = { version: 1, identity: this.identity, replies }
    const json = JSON.stringify(data)
    // Admission leaves room for state/cursor growth during replay checkpoints.
    if (Buffer.byteLength(json, 'utf8') > MAX_OUTBOX_BYTES - reserveBytes) {
      throw new OutboxStorageError('微信待补发记录超过 4 MiB；本次更新未保存，请在 Pi 会话中查看原回复')
    }
    const temporary = `${this.filePath}.${randomUUID()}.tmp`
    try {
      const directory = path.dirname(this.filePath)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await fs.chmod(directory, 0o700).catch(() => {})
      const handle = await fs.open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(json, 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await fs.rename(temporary, this.filePath)
    } catch (error) {
      throw new OutboxStorageError('微信待补发记录保存失败；请在 Pi 会话中查看原回复，勿假定已暂存', error)
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
    // Publish state only after the atomic replacement succeeded. In particular,
    // a failed post-send checkpoint keeps the uncertain marker, not a retryable copy.
    this.replies = replies
    this.onChange?.()
  }
}
