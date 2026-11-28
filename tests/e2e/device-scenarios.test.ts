// ============================================================================
// Near-real-device E2E suite: REAL extension (index.ts) + REAL WeixinClient +
// REAL api.ts/media.ts/outbox.ts/config.ts/transport-state.ts inside a REAL
// Pi SDK runtime, over real HTTP against the fake iLink/CDN and fake OpenAI
// SSE servers. Zero vi.mock — every failure mode is scripted on the wire.
// ============================================================================

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeIlinkServer, type SentMessageRecord } from './fake-ilink-server.js'
import { FakeLlmServer } from './fake-llm-server.js'
import {
  createDeviceEnvironment,
  disposeDeviceEnvironment,
  startFakeLlm,
  startPiRuntime,
  startBridge,
  stopBridge,
  type ManagedDeviceEnvironment,
  type RuntimeHandle,
} from './helpers.js'

// Classic valid 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const WAIT = { timeout: 20_000, interval: 50 } as const

let env: ManagedDeviceEnvironment
let fakeLlm: FakeLlmServer
let handle: RuntimeHandle | undefined

/**
 * Seed the real config module (file under the isolated HOME + its in-process
 * cache, which persists across tests in this worker).
 */
async function seedConfig(overrides: Record<string, unknown> = {}): Promise<void> {
  const { saveConfig } = await import('../../src/bridge/config.js')
  await saveConfig({ sendAck: false, ...overrides })
}

beforeEach(async () => {
  env = await createDeviceEnvironment()
  fakeLlm = await startFakeLlm(env, new FakeLlmServer())
  await seedConfig()
})

afterEach(async () => {
  await handle?.runtime.dispose().catch(() => {})
  handle = undefined
  await disposeDeviceEnvironment(env)
})

// --- 断言辅助 ---

function since(fakeIlink: FakeIlinkServer, count: number): SentMessageRecord[] {
  return fakeIlink.sentMessages.slice(count)
}

function textsSince(fakeIlink: FakeIlinkServer, count: number): string[] {
  return since(fakeIlink, count).map(message => message.text)
}

async function waitReply(fakeIlink: FakeIlinkServer, baseline: number, matcher: (text: string) => boolean, timeoutMs = 20_000): Promise<SentMessageRecord> {
  return vi.waitFor(() => {
    const found = since(fakeIlink, baseline).find(message => matcher(message.text))
    expect(found, `no matching WeChat message after #${baseline}; all=${JSON.stringify(fakeIlink.sentMessages.map(message => message.text))}`).toBeTruthy()
    return found!
  }, { timeout: timeoutMs, interval: 50 })
}

async function readOutboxFile(): Promise<{ replies: Array<{ chunks: string[]; state: string }> } | null> {
  const dir = env.statePath('outbox')
  const files = await fs.readdir(dir).catch(() => [])
  if (files.length === 0) return null
  return JSON.parse(await fs.readFile(path.join(dir, files[0]), 'utf8'))
}

async function lastUserMessageImageUrls(): Promise<Array<string>> {
  const body = fakeLlm.requests[fakeLlm.requests.length - 1].body
  const userMessages = (body.messages ?? []).filter(message => message.role === 'user')
  const last = userMessages[userMessages.length - 1]
  if (!last || !Array.isArray(last.content)) return []
  return (last.content as Array<Record<string, any>>)
    .filter(part => part?.type === 'image_url')
    .map(part => String(part.image_url?.url ?? ''))
}

function dataUrlSha256(dataUrl: string): string {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex')
}

/** User-message text parts from a recorded request body (string or array content). */
function userTextsOf(body: Record<string, any>): string[] {
  return (body.messages ?? [])
    .filter((message: any) => message.role === 'user')
    .flatMap((message: any) => typeof message.content === 'string'
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.filter((part: any) => part?.type === 'text').map((part: any) => String(part.text))
        : [])
}

function systemTextOf(body: Record<string, any>): string {
  return (body.messages ?? [])
    .filter((message: any) => message.role === 'system')
    .map((message: any) => String(message.content))
    .join('\n')
}

// ============================================================================

describe('near-real-device WeChat bridge scenarios', () => {
  it('1. fresh QR login with redirect, restart reuses credentials without QR login', async () => {
    // Replace the default (credentials-seeded) environment with a fresh device.
    const seededEnv = env
    await disposeDeviceEnvironment(seededEnv)
    env = await createDeviceEnvironment({
      // The fake server must accept the token this fresh login will obtain.
      credentials: { token: 'fresh-bot-token' },
      withoutCredentials: true,
    })
    fakeLlm = await startFakeLlm(env, new FakeLlmServer())
    await seedConfig()
    env.fakeIlink.scriptQrLogin(['wait', 'scaned_but_redirect', 'scaned', 'confirmed'], {
      botToken: 'fresh-bot-token',
      ilinkBotId: 'bot-account',
      ilinkUserId: 'bound-user',
      baseUrl: 'https://redirect.ilink.test',
    })
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    fakeLlm.queueText('登录后的第一条回复')

    await handle.runtime.session.prompt('/wechat login')
    await vi.waitFor(() => expect(env.fakeIlink.notifyStarts.length).toBeGreaterThan(0), WAIT)

    const credentials = JSON.parse(await fs.readFile(env.statePath('credentials.json'), 'utf8'))
    expect(credentials).toMatchObject({ token: 'fresh-bot-token', userId: 'bound-user', accountId: 'bot-account' })
    expect(env.fakeIlink.qrCodeRequests).toHaveLength(1)
    // The redirect host was followed: status polls moved to redirect.ilink.test.
    expect(env.fakeIlink.qrStatusRequests.length).toBeGreaterThanOrEqual(4)
    expect(env.redirect.rewrittenUrls.some(url => url.startsWith('https://redirect.ilink.test/'))).toBe(true)

    env.fakeIlink.pushText('你好')
    await waitReply(env.fakeIlink, 0, text => text === '登录后的第一条回复')

    // --- restart with the same isolated HOME: credentials are reused ---
    await handle.runtime.dispose()
    const notifyStartsBefore = env.fakeIlink.notifyStarts.length
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await handle.runtime.session.prompt('/wechat start')
    await vi.waitFor(() => expect(env.fakeIlink.notifyStarts.length).toBeGreaterThan(notifyStartsBefore), WAIT)

    expect(env.fakeIlink.qrCodeRequests).toHaveLength(1) // no second QR flow
    fakeLlm.queueText('重启后的回复')
    env.fakeIlink.pushText('在吗')
    await waitReply(env.fakeIlink, 1, text => text === '重启后的回复')
    expect(handle.errors).toEqual([])
  }, 90_000)

  it('2. text round-trip over real SSE, then a real HTTP 500 sends the model-failure notice', async () => {
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    fakeLlm.queueText('你好！我是 pi。')
    env.fakeIlink.pushText('你好')
    const firstReply = await waitReply(env.fakeIlink, 0, text => text === '你好！我是 pi。')
    expect(firstReply.toUserId).toBe('bound-user')

    // Exact LLM input: WeChat source tag + system rules from the packaged prompt.
    const firstRequest = fakeLlm.requests[0].body
    expect(userTextsOf(firstRequest).some(text => text.startsWith('[微信]') && text.includes('你好'))).toBe(true)
    const systemText = systemTextOf(firstRequest)
    expect(systemText).toContain('Device E2E base system prompt.')
    expect(systemText).toContain('<wechat-system-rules>')

    // A long streamed reply is split into ordered WeChat chunks without loss.
    const longReply = '这是一段很长的回复，用于验证分块发送与顺序。'.repeat(50)
    const longBaseline = env.fakeIlink.sentMessages.length
    fakeLlm.queueText(longReply, { chunks: 4 })
    env.fakeIlink.pushText('发一段长文')
    await vi.waitFor(() => {
      expect(fakeLlm.requests).toHaveLength(2)
      const chunks = textsSince(env.fakeIlink, longBaseline)
      expect(chunks.length).toBeGreaterThanOrEqual(2)
      expect(chunks.join('')).toBe(longReply)
    }, WAIT)

    // Real HTTP 500 from the provider → real Pi settle → WeChat failure notice.
    fakeLlm.queueError(500, 'upstream model overloaded')
    env.fakeIlink.pushText('再来一次')
    const failureNotice = await waitReply(env.fakeIlink, 2, text => text.includes('模型请求失败'))
    expect(failureNotice.text).toContain('upstream model overloaded')
    expect(fakeLlm.requests).toHaveLength(3)
    // The failed turn produced exactly one WeChat message (the notice), no partial reply.
    expect(textsSince(env.fakeIlink, 2).slice(-1)).toHaveLength(1)
    expect(handle.errors).toEqual([])
  }, 60_000)

  it('3. real ret=-2 defers the reply to the on-disk outbox; a restart replays it exactly once', async () => {
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    fakeLlm.queueText('第一轮回复')
    env.fakeIlink.pushText('第一条')
    await waitReply(env.fakeIlink, 0, text => text === '第一轮回复')

    // Both the context-token attempt and the context-free fallback are rejected.
    env.fakeIlink.failNextSend({ ret: -2, errmsg: 'prepare failed', failFallbackToo: true })
    fakeLlm.queueText('未送达的回复')
    env.fakeIlink.pushText('第二条')
    await vi.waitFor(() => expect(env.fakeIlink.rejectedSends.length).toBeGreaterThanOrEqual(2), WAIT)
    const outbox = await vi.waitFor(async () => {
      const file = await readOutboxFile()
      expect(file?.replies.length ?? 0).toBe(1)
      return file!
    }, WAIT)
    expect(outbox.replies[0].chunks.join('\n')).toContain('未送达的回复')
    expect(outbox.replies[0].state).toBe('pending')

    // Restart (simulated reboot) with the same isolated HOME.
    await handle.runtime.dispose()
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    env.fakeIlink.pushText('/status')
    await waitReply(env.fakeIlink, 1, text => text.startsWith('【补发】'))
    await waitReply(env.fakeIlink, 1, text => text === '未送达的回复')
    await waitReply(env.fakeIlink, 1, text => text.includes('待补发回复: 0'))
    expect(textsSince(env.fakeIlink, 1).filter(text => text === '未送达的回复')).toHaveLength(1)

    // A second /status must not repeat the replay.
    env.fakeIlink.pushText('/status')
    await waitReply(env.fakeIlink, 4, text => text.includes('待补发回复: 0'))
    expect(textsSince(env.fakeIlink, 4).filter(text => text.includes('【补发】'))).toHaveLength(0)
    expect(textsSince(env.fakeIlink, 4).filter(text => text === '未送达的回复')).toHaveLength(0)
    expect(handle.errors).toEqual([])
  }, 90_000)

  it('4. AES-encrypted inbound images are decrypted, batched and reach the LLM as image parts with exactly one reply', async () => {
    await seedConfig({ imageBatchWaitMs: 0 })
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl, { modelInput: ['text', 'image'] })
    await startBridge(handle, env.fakeIlink)

    // Single image turn.
    const staged = env.fakeIlink.stageEncryptedMedia(PNG_1X1, 'image/png')
    const singleBaseline = env.fakeIlink.sentMessages.length
    fakeLlm.queueText('图片收到了')
    env.fakeIlink.pushUserMessage({
      items: [{
        type: 2,
        image_item: {
          media: { full_url: staged.imageUrl, encrypt_type: 1 },
          aeskey: staged.aesKeyHex,
          mid_size: PNG_1X1.length,
        },
      }],
    })
    await vi.waitFor(() => expect(fakeLlm.requests).toHaveLength(1), WAIT)
    const urls = await lastUserMessageImageUrls()
    expect(urls).toHaveLength(1)
    expect(dataUrlSha256(urls[0])).toBe(createHash('sha256').update(PNG_1X1).digest('hex'))
    expect(urls[0].startsWith('data:image/png;base64,')).toBe(true)
    await waitReply(env.fakeIlink, singleBaseline, text => text === '图片收到了')
    // #37 regression: exactly one reply, no duplicate chunks for the image turn.
    expect(textsSince(env.fakeIlink, singleBaseline)).toHaveLength(1)

    // Batch turn: two images in one message merge into one request / one reply.
    const stagedA = env.fakeIlink.stageEncryptedMedia(PNG_1X1, 'image/png')
    const stagedB = env.fakeIlink.stageEncryptedMedia(PNG_1X1, 'image/png')
    const batchBaseline = env.fakeIlink.sentMessages.length
    fakeLlm.queueText('两张图都收到了')
    env.fakeIlink.pushUserMessage({
      items: [
        { type: 2, image_item: { media: { full_url: stagedA.imageUrl, encrypt_type: 1 }, aeskey: stagedA.aesKeyHex } },
        { type: 2, image_item: { media: { full_url: stagedB.imageUrl, encrypt_type: 1 }, aeskey: stagedB.aesKeyHex } },
      ],
    })
    await vi.waitFor(() => expect(fakeLlm.requests).toHaveLength(2), WAIT)
    const batchUrls = await lastUserMessageImageUrls()
    expect(batchUrls).toHaveLength(2)
    expect(dataUrlSha256(batchUrls[0])).toBe(createHash('sha256').update(PNG_1X1).digest('hex'))
    expect(dataUrlSha256(batchUrls[1])).toBe(createHash('sha256').update(PNG_1X1).digest('hex'))
    await waitReply(env.fakeIlink, batchBaseline, text => text === '两张图都收到了')
    expect(textsSince(env.fakeIlink, batchBaseline)).toHaveLength(1)
    expect(handle.errors).toEqual([])
  }, 60_000)

  it('5. inbound file saved without LLM, follow-up triggers send_file_to_wechat and byte-for-byte upload', async () => {
    const report = 'E2E 报告内容 12345\n第二行'
    const projectReport = path.join(env.projectDir, 'report.md')
    await fs.writeFile(projectReport, report)
    const notes = Buffer.from('会议纪要：周五发布', 'utf8')
    const staged = env.fakeIlink.stageEncryptedMedia(notes, 'application/octet-stream')

    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    // Inbound file: saved to the project without any model involvement.
    env.fakeIlink.pushUserMessage({
      items: [{
        type: 4,
        file_item: {
          media: { encrypt_query_param: staged.encryptParam, aes_key: staged.aesKeyBase64, encrypt_type: 1 },
          file_name: 'notes.txt',
          len: String(notes.length),
        },
      }],
    })
    const saveReceipt = await waitReply(env.fakeIlink, 0, text => text.includes('已保存: notes.txt'))
    expect(saveReceipt.text).toMatch(/notes\.txt \(\d+\.\d KB\)/)
    expect(fakeLlm.requests).toHaveLength(0)
    const savedFiles = await fs.readdir(env.wechatFilesDir)
    expect(savedFiles.some(name => name.endsWith('notes.txt'))).toBe(true)
    expect(await fs.readFile(path.join(env.wechatFilesDir, savedFiles.find(name => name.endsWith('notes.txt'))!), 'utf8')).toBe(notes.toString('utf8'))

    // Follow-up text reaches the LLM, which calls the real send tool.
    fakeLlm.queueToolCall(
      { name: 'send_file_to_wechat', arguments: { filePath: 'report.md' } },
      '已发送 report.md 到微信 ✅',
    )
    env.fakeIlink.pushText('请把项目里的 report.md 发给我')
    const summary = await waitReply(env.fakeIlink, 1, text => text.includes('已发送 report.md'))
    expect(summary.text).toBe('已发送 report.md 到微信 ✅')

    // The tool upload went through the fake CDN; decrypt with the server-side key.
    expect(fakeLlm.requests.length).toBeGreaterThanOrEqual(2)
    expect(env.fakeIlink.uploadUrlRequests).toHaveLength(1)
    const upload = env.fakeIlink.uploadUrlRequests[0]
    expect(upload.mediaType).toBe(3) // FILE
    expect(upload.rawSize).toBe(Buffer.byteLength(report))
    expect(upload.rawMd5).toBe(createHash('md5').update(report).digest('hex'))
    const downloadParam = env.fakeIlink.cdnUploads[0].uploadParam
    expect(env.fakeIlink.decryptUploadedMedia(downloadParam).equals(Buffer.from(report, 'utf8'))).toBe(true)
    expect(env.fakeIlink.sha256OfUploadedMedia(downloadParam)).toBe(createHash('sha256').update(report, 'utf8').digest('hex'))

    // The media message itself referenced the uploaded artifact.
    const mediaMessage = since(env.fakeIlink, 1).find(message => message.itemList.some((item: any) => item.type === 4))
    expect(mediaMessage).toBeTruthy()
    const fileItem = mediaMessage!.itemList[0] as any
    expect(fileItem.file_item.file_name).toBe('report.md')
    expect(fileItem.file_item.media.encrypt_query_param).toBe(downloadParam)
    expect(Buffer.from(fileItem.file_item.media.aes_key, 'base64').toString('utf8')).toMatch(/^[0-9a-f]{32}$/)

    // The follow-up turn reached the LLM with the tool result.
    const secondRequest = fakeLlm.requests[1].body
    expect(JSON.stringify(secondRequest.messages)).toContain('report.md')
    expect(handle.errors).toEqual([])
  }, 90_000)

  it('6a. sendAck: false sends no receipt at all', async () => {
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)
    fakeLlm.queueText('回复一')
    env.fakeIlink.pushText('消息一')
    await waitReply(env.fakeIlink, 0, text => text === '回复一')
    expect(textsSince(env.fakeIlink, 0)).toEqual(['回复一'])
  }, 60_000)

  it('6b. a custom ackText is sent before the model reply', async () => {
    await handle?.runtime.dispose()
    await disposeDeviceEnvironment(env)
    env = await createDeviceEnvironment()
    fakeLlm = await startFakeLlm(env, new FakeLlmServer())
    await seedConfig({ ackText: '自定义回执内容', sendAck: undefined })
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)
    fakeLlm.queueText('回复二')
    env.fakeIlink.pushText('消息二')
    await waitReply(env.fakeIlink, 0, text => text === '自定义回执内容')
    await waitReply(env.fakeIlink, 0, text => text === '回复二')
    expect(textsSince(env.fakeIlink, 0)).toEqual(['自定义回执内容', '回复二'])
  }, 60_000)

  it('7. bidirectionalSync off mirrors nothing; on mirrors local turns with [电脑端] and no history replay', async () => {
    await handle?.runtime.dispose()
    await disposeDeviceEnvironment(env)
    env = await createDeviceEnvironment()
    fakeLlm = await startFakeLlm(env, new FakeLlmServer())
    await seedConfig({ bidirectionalSync: false })
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl, {
      preseedHistory: [
        { role: 'user', text: 'old-context-marker' },
        { role: 'assistant', text: '旧回复' },
      ],
    })
    await startBridge(handle, env.fakeIlink)

    // Sync off: local prompts produce no WeChat traffic.
    fakeLlm.queueText('本地回答一')
    await handle.runtime.session.prompt('本地问题一')
    await vi.waitFor(() => expect(fakeLlm.requests).toHaveLength(1), WAIT)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(env.fakeIlink.sentMessages).toHaveLength(0)

    // Enable sync at runtime through the real config file + cache.
    const { loadConfig, saveConfig, getConfigCache } = await import('../../src/bridge/config.js')
    await saveConfig({ ...(await loadConfig()), bidirectionalSync: true })
    expect(getConfigCache().bidirectionalSync).toBe(true)

    fakeLlm.queueText('本地回答二')
    await handle.runtime.session.prompt('本地问题二')
    await waitReply(env.fakeIlink, 0, text => text === '[电脑端] 本地问题二')
    await waitReply(env.fakeIlink, 0, text => text === '本地回答二')
    expect(textsSince(env.fakeIlink, 0)).toEqual(['[电脑端] 本地问题二', '本地回答二'])
    // Pre-existing history is never replayed.
    expect(JSON.stringify(textsSince(env.fakeIlink, 0))).not.toContain('old-context-marker')
    expect(JSON.stringify(textsSince(env.fakeIlink, 0))).not.toContain('旧回复')
    expect(handle.errors).toEqual([])
  }, 60_000)

  it('8. stop blocks sending + notifies; reconnect resumes from the persisted cursor without replays', async () => {
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    fakeLlm.queueText('第一条回复')
    env.fakeIlink.pushText('消息A')
    await waitReply(env.fakeIlink, 0, text => text === '第一条回复')

    const persistedCursor = JSON.parse(await fs.readFile(env.statePath('cursor.json'), 'utf8')).cursor
    expect(persistedCursor).toBe(env.fakeIlink.latestCursor)

    await stopBridge(handle, env.fakeIlink)
    expect(env.fakeIlink.notifyStops.length).toBeGreaterThanOrEqual(1)
    expect(env.fakeIlink.notifyStarts).toHaveLength(1)

    // Reconnect: the poll resumes from the persisted cursor.
    await handle.runtime.session.prompt('/wechat start')
    await vi.waitFor(() => expect(env.fakeIlink.notifyStarts).toHaveLength(2), WAIT)
    const lastPoll = env.fakeIlink.getUpdatesRequests[env.fakeIlink.getUpdatesRequests.length - 1]
    expect(lastPoll.cursor).toBe(persistedCursor)

    fakeLlm.queueText('第二条回复')
    env.fakeIlink.pushText('消息B')
    await waitReply(env.fakeIlink, 1, text => text === '第二条回复')
    // The already-delivered message was not replayed by the server or client.
    expect(textsSince(env.fakeIlink, 0).filter(text => text === '第一条回复')).toHaveLength(1)
    expect(handle.errors).toEqual([])
  }, 60_000)

  it('9. legacy config upgrade preserves unknown fields, false, 0 and a custom prompt template', async () => {
    await handle?.runtime.dispose()
    await disposeDeviceEnvironment(env)
    env = await createDeviceEnvironment()
    fakeLlm = await startFakeLlm(env, new FakeLlmServer())
    await seedConfig({
      sendAck: false,
      autoStart: false,
      bidirectionalSync: false,
      imageBatchWaitMs: 0,
      ackText: '原有回执',
      handoff: 'auto',
      futureUnknown: { keep: true, nested: [1, 2] },
      messageSourceTag: { enabled: true, wechatTag: '[自定义标识]', blockedTools: [] },
    })
    const templatePath = env.statePath('wechat-prompt.md')
    const template = '# 自定义微信规则\n简短回复并附上编号。'
    await fs.writeFile(templatePath, template)
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    // A config command rewrites the file through the real save path.
    await handle.runtime.session.prompt('/wechat config auto-start on')
    await vi.waitFor(async () => {
      const raw = JSON.parse(await fs.readFile(env.statePath('config.json'), 'utf8'))
      expect(raw.autoStart).toBe(true)
    }, WAIT)
    const raw = JSON.parse(await fs.readFile(env.statePath('config.json'), 'utf8'))
    expect(raw).toMatchObject({
      sendAck: false,
      bidirectionalSync: false,
      imageBatchWaitMs: 0,
      ackText: '原有回执',
      handoff: 'auto',
      futureUnknown: { keep: true, nested: [1, 2] },
      messageSourceTag: { enabled: true, wechatTag: '[自定义标识]', blockedTools: [] },
    })

    // The custom template reached the model and the custom source tag marked input.
    fakeLlm.queueText('收到，自定义规则已生效')
    env.fakeIlink.pushText('你好')
    await waitReply(env.fakeIlink, 0, text => text.includes('自定义规则已生效'))
    const request = fakeLlm.requests[0].body
    expect(systemTextOf(request)).toContain('自定义微信规则')
    expect(userTextsOf(request).some(text => text.startsWith('[自定义标识]'))).toBe(true)
    expect(await fs.readFile(templatePath, 'utf8')).toBe(template)
    expect(handle.errors).toEqual([])
  }, 60_000)

  it('10. remote /new switches sessions over real HTTP while preserving the old JSONL on disk', async () => {
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    fakeLlm.queueText('第一轮回答')
    env.fakeIlink.pushText('第一个问题')
    await waitReply(env.fakeIlink, 0, text => text === '第一轮回答')
    const oldSessionFile = handle.sessionFile!
    expect(oldSessionFile).toBeTruthy()
    const oldHistory = await fs.readFile(oldSessionFile, 'utf8')
    expect(oldHistory).toContain('第一个问题')
    const oldSessionId = handle.runtime.session.sessionId

    env.fakeIlink.pushText('/new')
    const resumed = await waitReply(env.fakeIlink, 1, text => text.includes('桥接已恢复'))
    expect(resumed.text).toContain('✅ 已新建空白会话，微信桥接已恢复')
    expect(handle.runtime.session.sessionId).not.toBe(oldSessionId)
    expect(handle.runtime.session.messages).toEqual([])
    // Old JSONL history is untouched.
    expect(await fs.readFile(oldSessionFile, 'utf8')).toBe(oldHistory)

    // The new session has clean context.
    fakeLlm.queueText('新会话回答')
    env.fakeIlink.pushText('新会话的问题')
    await waitReply(env.fakeIlink, 2, text => text === '新会话回答')
    const lastRequest = fakeLlm.requests[fakeLlm.requests.length - 1].body
    expect(JSON.stringify(lastRequest.messages)).not.toContain('第一个问题')
    expect(JSON.stringify(lastRequest.messages)).toContain('新会话的问题')
    expect(env.fakeIlink.notifyStarts.length).toBeGreaterThanOrEqual(2) // bridge reconnected
    expect(handle.errors).toEqual([])
  }, 90_000)

  it('11. completionSummary: true sends one 【完成摘要】 at settlement instead of incremental replies', async () => {
    await handle?.runtime.dispose()
    await disposeDeviceEnvironment(env)
    env = await createDeviceEnvironment()
    fakeLlm = await startFakeLlm(env, new FakeLlmServer())
    await seedConfig({ completionSummary: true })
    handle = await startPiRuntime(env, fakeLlm.openaiBaseUrl)
    await startBridge(handle, env.fakeIlink)

    fakeLlm.queueText('这是最终结论。', { chunks: 4 })
    env.fakeIlink.pushText('帮我总结')
    const summary = await waitReply(env.fakeIlink, 0, text => text.startsWith('【完成摘要】'))
    expect(summary.text).toBe('【完成摘要】\n任务：帮我总结\n这是最终结论。')
    // Exactly one WeChat message for the whole streamed turn.
    expect(textsSince(env.fakeIlink, 0)).toHaveLength(1)
    expect(fakeLlm.requests).toHaveLength(1)
    expect(handle.errors).toEqual([])
  }, 60_000)
})
