// ============================================================================
// Fake WeChat iLink Bot + CDN server — real HTTP implementation of the protocol
// used by src/wechat/api.ts, src/wechat/client.ts and src/wechat/media.ts.
// Pure node:http, ephemeral port, no mocks of production code.
// ============================================================================

import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

// --- 公共地址常量（与 src/shared/constants.ts / api.ts 对应） ---

export const REDIRECT_BASE = 'https://redirect.ilink.test'
export const DEFAULT_ILINK_BASE = 'https://ilinkai.weixin.qq.com'
export const FAKE_CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com'

const REDIRECTED_ORIGINS = [DEFAULT_ILINK_BASE, FAKE_CDN_ORIGIN, REDIRECT_BASE]

/**
 * Rewrites ONLY the fake WeChat origins (iLink API, CDN, redirect host) to the
 * fake server base URL and forwards everything else to the real fetch.
 */
export function installNetworkRedirect(fakeBaseUrl: string): { restore(): void; rewrittenUrls: string[] } {
  const original = globalThis.fetch
  const rewrittenUrls: string[] = []
  const rewrite = (raw: string): string | null => {
    let url: URL
    try { url = new URL(raw) } catch { return null }
    for (const origin of REDIRECTED_ORIGINS) {
      const parsed = new URL(origin)
      if (url.protocol === parsed.protocol && url.host === parsed.host) {
        return fakeBaseUrl + url.pathname + url.search + url.hash
      }
    }
    return null
  }
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input
      : input instanceof URL ? input.href
        : input instanceof Request ? input.url
          : String(input)
    const target = rewrite(raw)
    if (!target) return original(input, init)
    rewrittenUrls.push(raw)
    if (input instanceof Request && init === undefined) return original(new Request(target, input))
    return original(target, init)
  }
  globalThis.fetch = wrapped as typeof fetch
  return {
    restore() { globalThis.fetch = original },
    rewrittenUrls,
  }
}

// --- 类型 ---

export type QrStep = 'wait' | 'scaned' | 'scaned_but_redirect' | 'confirmed' | 'expired'

export interface QrScriptPayload {
  botToken?: string
  ilinkBotId?: string
  ilinkUserId?: string
  baseUrl?: string
  redirectHost?: string
}

export interface SentMessageRecord {
  toUserId: string
  contextToken: string | undefined
  itemList: Array<Record<string, unknown>>
  text: string
  clientId: string
  authorization: string
  rejected: false
  raw: Record<string, unknown>
}

export interface RejectedSendRecord {
  text: string
  contextToken: string | undefined
  ret: number
  errmsg: string
  rejected: true
}

export interface UploadUrlRecord {
  filekey: string
  mediaType: number
  toUserId: string
  rawSize: number
  rawMd5: string
  encryptedSize: number
  /** hex-encoded AES key, exactly as the client sends it */
  aesKey: string
  uploadParam: string
}

interface MediaEntry {
  encrypted: Buffer
  contentType: string
  filekey: string
  /** Registered getuploadurl record when this entry came from an outbound upload. */
  upload: UploadUrlRecord | null
}

interface SendFault {
  kind: 'reject' | 'drop'
  ret: number
  errmsg: string
  match?: (text: string) => boolean
  remaining: number
}

interface PendingPoll {
  startAfter: number
  requestCursor: string
  timer: ReturnType<typeof setTimeout>
}

export interface StagedMedia {
  encryptParam: string
  aesKeyHex: string
  aesKeyBase64: string
  imageUrl: string
}

export interface PushedMessage {
  messageId: string
  cursor: string
}

export interface FakeIlinkOptions {
  expectedToken?: string
  boundUserId?: string
  accountId?: string
  /** Long-poll hold time before answering with an empty batch. */
  pollTimeoutMs?: number
}

// --- AES-128-ECB helpers (matching client.ts encryptFile / media.ts aesDecryptECB) ---

function aesEncrypt(plain: Buffer, keyHex: string): Buffer {
  const cipher = createCipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null)
  return Buffer.concat([cipher.update(plain), cipher.final()])
}

function aesDecrypt(encrypted: Buffer, keyHex: string): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from(keyHex, 'hex'), null)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

// ============================================================================

export class FakeIlinkServer {
  readonly sentMessages: SentMessageRecord[] = []
  readonly rejectedSends: RejectedSendRecord[] = []
  readonly droppedSends: Array<{ text: string }> = []
  readonly getUpdatesRequests: Array<{ cursor: string; authorization: string }> = []
  readonly qrCodeRequests: string[] = []
  readonly qrStatusRequests: Array<{ qrcode: string; authorization?: string }> = []
  readonly notifyStarts: Record<string, unknown>[] = []
  readonly notifyStops: Record<string, unknown>[] = []
  readonly typingCalls: Array<{ status: number; userId: string }> = []
  readonly getConfigCalls: Record<string, unknown>[] = []
  readonly uploadUrlRequests: UploadUrlRecord[] = []
  readonly cdnUploads: Array<{ filekey: string; uploadParam: string; bytes: number }> = []

  private server: http.Server | null = null
  private port = 0
  private messageSeq = 0
  private qrSeq = 0
  private readonly messages: Array<{ cursor: string; msg: Record<string, unknown> }> = []
  private readonly qrScripts = new Map<string, { steps: QrStep[]; payload: QrScriptPayload }>()
  private readonly qrPositions = new Map<string, number>()
  private readonly pendingPolls = new Set<{ res: http.ServerResponse; timer: ReturnType<typeof setTimeout>; poll: PendingPoll; req: http.IncomingMessage }>()
  private readonly faults: SendFault[] = []
  private readonly mediaStore = new Map<string, MediaEntry>()
  private readonly uploadParams = new Map<string, UploadUrlRecord>()
  private expireNextPoll = false
  private replayDuplicates = false

  readonly expectedToken: string
  readonly boundUserId: string
  readonly accountId: string
  private readonly pollTimeoutMs: number

  constructor(options: FakeIlinkOptions = {}) {
    this.expectedToken = options.expectedToken ?? 'test-token'
    this.boundUserId = options.boundUserId ?? 'bound-user'
    this.accountId = options.accountId ?? 'bot-account'
    this.pollTimeoutMs = options.pollTimeoutMs ?? 1000
  }

  get baseUrl(): string { return `http://127.0.0.1:${this.port}` }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => { void this.handle(req, res) })
    this.server.on('clientError', (_err, socket) => socket.destroy())
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => resolve())
    })
    this.server!.removeAllListeners('error')
    this.port = (this.server!.address() as AddressInfo).port
  }

  async close(): Promise<void> {
    for (const pending of this.pendingPolls) {
      clearTimeout(pending.timer)
      pending.res.destroy()
    }
    this.pendingPolls.clear()
    if (!this.server) return
    const server = this.server
    this.server = null
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  // --- 测试脚本辅助 ---

  /** Queue the get_qrcode_status answers served for the next get_bot_qrcode token. */
  scriptQrLogin(steps: QrStep[], payload: QrScriptPayload = {}): void {
    this.pendingQrScript = { steps: [...steps], payload }
  }

  private pendingQrScript: { steps: QrStep[]; payload: QrScriptPayload } | null = null

  /** Next getupdates answers `ret: -14` once (client throws SessionExpiredError). */
  expireSessionOnce(): void { this.expireNextPoll = true }

  /** Respond to getupdates with the full history again (client dedups by id). */
  setReplayDuplicates(value: boolean): void { this.replayDuplicates = value }

  failNextSend(options: { ret?: number; errmsg?: string; match?: (text: string) => boolean; failFallbackToo?: boolean } = {}): void {
    this.faults.push({
      kind: 'reject',
      ret: options.ret ?? -2,
      errmsg: options.errmsg ?? 'rejected by server',
      match: options.match,
      remaining: options.failFallbackToo ? 2 : 1,
    })
  }

  dropNextSend(match?: (text: string) => boolean): void {
    this.faults.push({ kind: 'drop', ret: 0, errmsg: '', match, remaining: 1 })
  }

  /** Push a user message; resolves all eligible long-polls immediately. */
  pushUserMessage(options: { text?: string; items?: Array<Record<string, unknown>>; contextToken?: string; fromUserId?: string }): PushedMessage {
    const id = ++this.messageSeq
    const msg = {
      message_id: `msg-${id}`,
      from_user_id: options.fromUserId ?? this.boundUserId,
      to_user_id: this.accountId,
      client_id: randomUUID(),
      create_time_ms: Date.now(),
      message_type: 1,
      message_state: 2,
      context_token: options.contextToken ?? `ctx-${id}`,
      item_list: options.items ?? [{ type: 1, text_item: { text: options.text ?? '' } }],
    }
    const cursor = String(id)
    this.messages.push({ cursor, msg })
    for (const pending of [...this.pendingPolls]) {
      if (pending.poll.startAfter < this.messages.length) {
        this.finishPoll(pending, this.pendingBatch(pending.poll.startAfter))
      }
    }
    return { messageId: String(msg.message_id), cursor }
  }

  pushText(text: string, contextToken?: string): PushedMessage {
    return this.pushUserMessage({ text, contextToken })
  }

  /** Latest cursor handed to any client — persisted cursor assertions compare this. */
  get latestCursor(): string { return String(this.messageSeq) }

  /** Stage AES-128-ECB encrypted media for inbound download. */
  stageEncryptedMedia(plain: Buffer, contentType = 'application/octet-stream'): StagedMedia {
    const aesKeyHex = randomBytes(16).toString('hex')
    const encrypted = aesEncrypt(plain, aesKeyHex)
    const encryptParam = `media-${randomBytes(12).toString('hex')}`
    this.mediaStore.set(encryptParam, { encrypted, contentType, filekey: '', upload: null })
    return {
      encryptParam,
      aesKeyHex,
      aesKeyBase64: Buffer.from(aesKeyHex, 'utf-8').toString('base64'),
      imageUrl: `${FAKE_CDN_ORIGIN}/c2c/download?encrypted_query_param=${encodeURIComponent(encryptParam)}`,
    }
  }

  /**
   * Decrypt an outbound upload produced by client.ts — AES-128-ECB with the key
   * the client registered via /ilink/bot/getuploadurl.
   */
  decryptUploadedMedia(downloadParam: string): Buffer {
    const entry = this.mediaStore.get(downloadParam)
    if (!entry) throw new Error(`No uploaded media stored for ${downloadParam}`)
    const upload = entry.upload ?? this.uploadParams.get(entry.filekey)
    if (!upload) throw new Error(`No upload key registered for filekey ${entry.filekey}`)
    return aesDecrypt(entry.encrypted, upload.aesKey)
  }

  sha256OfUploadedMedia(downloadParam: string): string {
    return createHash('sha256').update(this.decryptUploadedMedia(downloadParam)).digest('hex')
  }

  // --- HTTP ---

  private readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }

  private respondJson(res: http.ServerResponse, status: number, payload: unknown): void {
    if (res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(payload)) })
    res.end(JSON.stringify(payload))
  }

  private pendingBatch(startAfter: number): Array<Record<string, unknown>> {
    return this.messages.slice(startAfter).map(entry => entry.msg)
  }

  private finishPoll(pending: { res: http.ServerResponse; timer: ReturnType<typeof setTimeout>; poll: PendingPoll; req: http.IncomingMessage }, msgs: Array<Record<string, unknown>>): void {
    if (!this.pendingPolls.delete(pending)) return
    clearTimeout(pending.timer)
    const cursor = msgs.length > 0 ? String(this.messageSeq) : pending.poll.requestCursor || String(pending.poll.startAfter)
    this.respondJson(pending.res, 200, { ret: 0, msgs, get_updates_buf: cursor, longpolling_timeout_ms: this.pollTimeoutMs })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname
      const authorization = req.headers.authorization

      if (pathname === '/ilink/bot/get_bot_qrcode' && req.method === 'GET') {
        this.qrCodeRequests.push(url.search)
        const token = `qr-${++this.qrSeq}`
        const script = this.pendingQrScript ?? { steps: ['wait' as QrStep], payload: {} }
        this.pendingQrScript = null
        this.qrScripts.set(token, script)
        this.qrPositions.set(token, 0)
        this.respondJson(res, 200, { qrcode: token, qrcode_img_content: `https://login.test/qr?token=${token}` })
        return
      }

      if (pathname === '/ilink/bot/get_qrcode_status' && req.method === 'GET') {
        const qrcode = url.searchParams.get('qrcode') ?? ''
        this.qrStatusRequests.push({ qrcode, authorization })
        const script = this.qrScripts.get(qrcode)
        if (!script) { this.respondJson(res, 200, { status: 'expired' }); return }
        const position = Math.min(this.qrPositions.get(qrcode) ?? 0, script.steps.length - 1)
        this.qrPositions.set(qrcode, position + 1)
        const step = script.steps[position]
        switch (step) {
          case 'scaned_but_redirect':
            this.respondJson(res, 200, { status: step, redirect_host: script.payload.redirectHost ?? 'redirect.ilink.test' })
            return
          case 'confirmed':
            this.respondJson(res, 200, {
              status: step,
              bot_token: script.payload.botToken ?? 'confirmed-token',
              ilink_bot_id: script.payload.ilinkBotId ?? this.accountId,
              ilink_user_id: script.payload.ilinkUserId ?? this.boundUserId,
              baseurl: script.payload.baseUrl ?? REDIRECT_BASE,
            })
            return
          default:
            this.respondJson(res, 200, { status: step })
            return
        }
      }

      if (pathname === '/ilink/bot/getupdates' && req.method === 'POST') {
        const body = JSON.parse((await this.readBody(req)).toString('utf8') || '{}')
        this.getUpdatesRequests.push({ cursor: String(body.get_updates_buf ?? ''), authorization: authorization ?? '' })

        if (this.expireNextPoll) {
          this.expireNextPoll = false
          this.respondJson(res, 200, { ret: -14, errmsg: 'session expired' })
          return
        }

        const requestCursor = String(body.get_updates_buf ?? '')
        // Empty cursor = fresh long-poll session: deliver every message not yet
        // acknowledged by any cursor (messages pushed before the first poll are
        // still new to this bridge; real replays are deduplicated by the client).
        const startAfter = requestCursor === '' ? 0 : Number(requestCursor)

        if (this.replayDuplicates && this.messages.length > 0) {
          this.respondJson(res, 200, {
            ret: 0,
            msgs: this.messages.map(entry => entry.msg),
            get_updates_buf: String(this.messageSeq),
          })
          return
        }

        if (startAfter < this.messages.length) {
          this.respondJson(res, 200, {
            ret: 0,
            msgs: this.pendingBatch(startAfter),
            get_updates_buf: String(this.messageSeq),
          })
          return
        }

        const poll: PendingPoll = {
          startAfter,
          requestCursor,
          timer: setTimeout(() => {
            const pending = [...this.pendingPolls].find(candidate => candidate.poll === poll)
            if (pending) this.finishPoll(pending, [])
          }, this.pollTimeoutMs),
        }
        const pending = { res, req, poll, timer: poll.timer }
        this.pendingPolls.add(pending)
        req.on('close', () => {
          if (this.pendingPolls.delete(pending)) clearTimeout(pending.timer)
        })
        return
      }

      if (pathname === '/ilink/bot/sendmessage' && req.method === 'POST') {
        if (authorization !== `Bearer ${this.expectedToken}`) {
          this.respondJson(res, 401, { errmsg: 'invalid token' })
          return
        }
        const body = JSON.parse((await this.readBody(req)).toString('utf8') || '{}')
        const msg = (body.msg ?? {}) as Record<string, unknown>
        const itemList = (msg.item_list ?? []) as Array<Record<string, unknown>>
        const text = itemList
          .map((item: any) => item?.text_item?.text ?? '')
          .filter(Boolean)
          .join('\n')

        const fault = this.faults.find(candidate => candidate.remaining > 0 && (!candidate.match || candidate.match(text)))
        if (fault) {
          fault.remaining--
          if (fault.kind === 'drop') {
            this.droppedSends.push({ text })
            res.socket?.destroy()
            return
          }
          this.rejectedSends.push({ text, contextToken: msg.context_token as string | undefined, ret: fault.ret, errmsg: fault.errmsg, rejected: true })
          this.respondJson(res, 200, { ret: fault.ret, errmsg: fault.errmsg })
          return
        }

        this.sentMessages.push({
          toUserId: String(msg.to_user_id ?? ''),
          contextToken: msg.context_token as string | undefined,
          itemList,
          text,
          clientId: String(msg.client_id ?? ''),
          authorization: authorization ?? '',
          rejected: false,
          raw: body,
        })
        this.respondJson(res, 200, { ret: 0 })
        return
      }

      if (pathname === '/ilink/bot/getconfig' && req.method === 'POST') {
        const body = JSON.parse((await this.readBody(req)).toString('utf8') || '{}')
        this.getConfigCalls.push(body)
        this.respondJson(res, 200, { ret: 0, typing_ticket: 'fake-ticket' })
        return
      }

      if (pathname === '/ilink/bot/sendtyping' && req.method === 'POST') {
        const body = JSON.parse((await this.readBody(req)).toString('utf8') || '{}')
        this.typingCalls.push({ status: Number(body.status ?? 0), userId: String(body.ilink_user_id ?? '') })
        this.respondJson(res, 200, { ret: 0 })
        return
      }

      if (pathname === '/ilink/bot/msg/notifystart' && req.method === 'POST') {
        this.notifyStarts.push(JSON.parse((await this.readBody(req)).toString('utf8') || '{}'))
        this.respondJson(res, 200, { ret: 0 })
        return
      }

      if (pathname === '/ilink/bot/msg/notifystop' && req.method === 'POST') {
        this.notifyStops.push(JSON.parse((await this.readBody(req)).toString('utf8') || '{}'))
        this.respondJson(res, 200, { ret: 0 })
        return
      }

      if (pathname === '/ilink/bot/getuploadurl' && req.method === 'POST') {
        if (authorization !== `Bearer ${this.expectedToken}`) {
          this.respondJson(res, 401, { errmsg: 'invalid token' })
          return
        }
        const body = JSON.parse((await this.readBody(req)).toString('utf8') || '{}')
        const uploadParam = `upload-${randomBytes(12).toString('hex')}`
        const record: UploadUrlRecord = {
          filekey: String(body.filekey ?? ''),
          mediaType: Number(body.media_type ?? 0),
          toUserId: String(body.to_user_id ?? ''),
          rawSize: Number(body.rawsize ?? 0),
          rawMd5: String(body.rawfilemd5 ?? ''),
          encryptedSize: Number(body.filesize ?? 0),
          aesKey: String(body.aeskey ?? ''),
          uploadParam,
        }
        this.uploadParams.set(uploadParam, record)
        this.uploadUrlRequests.push(record)
        this.respondJson(res, 200, { ret: 0, upload_param: uploadParam })
        return
      }

      if (pathname === '/c2c/upload' && req.method === 'POST') {
        const uploadParam = url.searchParams.get('encrypted_query_param') ?? ''
        const filekey = url.searchParams.get('filekey') ?? ''
        const encrypted = await this.readBody(req)
        const upload = this.uploadParams.get(uploadParam)
        if (upload) upload.encryptedSize = encrypted.length
        this.mediaStore.set(uploadParam || filekey, { encrypted, contentType: 'application/octet-stream', filekey, upload: upload ?? null })
        this.cdnUploads.push({ filekey, uploadParam, bytes: encrypted.length })
        res.writeHead(200, { 'x-encrypted-param': uploadParam || filekey, 'Content-Length': '0' })
        res.end()
        return
      }

      if (pathname === '/c2c/download' && req.method === 'GET') {
        const encryptParam = url.searchParams.get('encrypted_query_param') ?? ''
        const entry = this.mediaStore.get(encryptParam)
        if (!entry) { this.respondJson(res, 404, { errmsg: 'unknown media' }); return }
        res.writeHead(200, {
          'Content-Type': entry.contentType,
          'Content-Length': entry.encrypted.length,
        })
        res.end(entry.encrypted)
        return
      }

      this.respondJson(res, 404, { errmsg: `unexpected path ${pathname}` })
    } catch (error) {
      this.respondJson(res, 500, { errmsg: error instanceof Error ? error.message : String(error) })
    }
  }
}
