// ============================================================================
// 测试: queue.ts — MessageQueue 入队/批处理/并发控制
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MessageQueue, getImageBatchWaitMs, getImageMaxBytes } from '../../src/bridge/queue.js'
import type { IncomingMessage } from '../../src/wechat/types.js'
import { getConfigCache } from '../../src/bridge/auth.js'
import { fetchFile, fetchImageAsBase64, saveFileToDisk } from '../../src/wechat/media.js'
import { extractTextFromMessageContent } from '../../src/shared/utils.js'
import { WECHAT_SOURCE_TAG } from '../../src/messaging/wechat-source.js'
import { ACK_TEXT, IMAGE_BATCH_ACK_TEXT } from '../../src/shared/constants.js'

// --- Mock getConfigCache 使配置读取可控 ---
vi.mock('../../src/bridge/auth.js', () => ({
  getConfigCache: vi.fn(() => ({})),
}))
vi.mock('../../src/wechat/media.js', () => ({
  fetchImageAsBase64: vi.fn(async () => null),
  fetchFile: vi.fn(async () => null),
  saveFileToDisk: vi.fn(async () => null),
}))

const queues = new Set<MessageQueue>()
beforeEach(() => {
  vi.clearAllMocks()
  // Marker and reply profile are on by default; opt these unit tests out to keep
  // asserting raw passthrough behaviour.
  vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: false } })
  vi.mocked(fetchImageAsBase64).mockResolvedValue(null)
  vi.mocked(fetchFile).mockResolvedValue(null)
  vi.mocked(saveFileToDisk).mockResolvedValue(null)
})
afterEach(() => {
  for (const queue of queues) queue.reset()
  queues.clear()
  vi.useRealTimers()
})

// --- 工厂: 创建可测试的 MessageQueue ---
function makeQueue(opts?: {
  client?: ReturnType<typeof vi.fn>
  running?: boolean
  agentIdle?: boolean
  canSubmit?: () => boolean
}) {
  const client = opts?.client ?? vi.fn().mockReturnValue(null)
  const running = opts?.running ?? true
  const agentIdle = opts?.agentIdle ?? true
  const pollSignal = vi.fn(() => undefined)
  const wechatFilesDir = vi.fn(() => process.cwd())
  const sendUserMessage = vi.fn()
  const updateStatusBar = vi.fn()

  const queue = new MessageQueue(
    () => client() as any,
    () => running,
    () => agentIdle,
    () => pollSignal() as any,
    () => wechatFilesDir() as any,
    sendUserMessage,
    updateStatusBar,
    opts?.canSubmit,
  )
  queues.add(queue)

  return { queue, client, sendUserMessage, updateStatusBar }
}

// --- 辅助: 构造 IncomingMessage ---
function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    messageId: 'msg_1',
    userId: 'user_1',
    text: '',
    type: 'text',
    imageUrls: [],
    raw: {} as any,
    contextToken: 'token_1',
    timestamp: new Date(),
    ...overrides,
  }
}

describe('receipt notifications', () => {
  it.each([undefined, true, false])('honors sendAck=%s for text without blocking submission', async sendAck => {
    vi.mocked(getConfigCache).mockReturnValue({ sendAck, messageSourceTag: { enabled: false } })
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({ client: vi.fn(() => ({ sendText, startTyping: vi.fn().mockResolvedValue(undefined) })) })
    queue.enqueue(makeMsg({ text: 'hello' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    if (sendAck === false) expect(sendText).not.toHaveBeenCalled()
    else expect(sendText).toHaveBeenCalledWith('user_1', ACK_TEXT)
  })

  it.each([undefined, true, false])('honors sendAck=%s for image batches without blocking submission', async sendAck => {
    vi.useFakeTimers()
    vi.mocked(getConfigCache).mockReturnValue({ sendAck, imageBatchWaitMs: 20 })
    vi.mocked(fetchImageAsBase64).mockResolvedValue({ data: 'image', mediaType: 'image/png' })
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({ client: vi.fn(() => ({ sendText, startTyping: vi.fn().mockResolvedValue(undefined) })) })
    for (let i = 0; i < 2; i++) queue.enqueue(makeMsg({ imageUrls: [{ url: 'https://example.com/image.png' }] }))
    await vi.advanceTimersByTimeAsync(25)
    expect(sendUserMessage).toHaveBeenCalledOnce()
    if (sendAck === false) expect(sendText).not.toHaveBeenCalled()
    else {
      expect(sendText).toHaveBeenCalledOnce()
      expect(sendText).toHaveBeenCalledWith('user_1', IMAGE_BATCH_ACK_TEXT)
    }
  })

  it.each([['Custom receipt text', 'Custom image receipt'], ['  ', '  ']])('uses custom contents or default for blank values: %s', async (ackText, imageBatchAckText) => {
    vi.mocked(getConfigCache).mockReturnValue({ ackText, imageBatchAckText })
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue, sendUserMessage } = makeQueue({ client: vi.fn(() => ({ sendText, startTyping: vi.fn().mockResolvedValue(undefined) })) })
    queue.enqueue(makeMsg({ text: 'hello' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendText).toHaveBeenCalledWith('user_1', ackText.trim() || ACK_TEXT)
    queue.enqueue(makeMsg({ imageUrls: [{ url: 'https://example.com/image.png' }] }))
    expect(sendText).toHaveBeenCalledWith('user_1', imageBatchAckText.trim() || IMAGE_BATCH_ACK_TEXT)
  })

  it('keeps file-save confirmations and download errors when receipts are disabled', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ sendAck: false })
    vi.mocked(fetchFile).mockResolvedValueOnce(Buffer.from('file')).mockResolvedValueOnce(null)
    vi.mocked(saveFileToDisk).mockResolvedValue('C:/project/report.txt')
    const sendText = vi.fn().mockResolvedValue(undefined)
    const { queue } = makeQueue({ client: vi.fn(() => ({ sendText })) })
    queue.enqueue(makeMsg({ fileEncryptParam: 'file', fileName: 'report.txt' }))
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('user_1', expect.stringContaining('✅ 已保存:')))
    queue.enqueue(makeMsg({ fileEncryptParam: 'file', fileName: 'failed.txt' }))
    await vi.waitFor(() => expect(sendText).toHaveBeenCalledWith('user_1', '⚠️ 文件下载失败: failed.txt'))
  })
})

describe('MessageQueue — enqueue', () => {
  it('enqueues text messages', () => {
    const { queue, sendUserMessage } = makeQueue({ agentIdle: false })
    const msg = makeMsg({ text: 'hello world' })
    queue.enqueue(msg)
    expect(queue.pending).toBe(1)
    // agent idle but running=true: should enqueue
    expect(queue.queue.length).toBe(1) // still in queue waiting for drain
  })

  it('enqueues image messages and sets batch timer', () => {
    vi.useFakeTimers()
    const mockSendText = vi.fn().mockResolvedValue(undefined)
    const { queue } = makeQueue({
      client: vi.fn(() => ({ sendText: mockSendText })),
    })
    const msg = makeMsg({
      text: '',
      type: 'image',
      imageUrls: [{ url: 'https://example.com/img.jpg' }],
    })
    queue.enqueue(msg)
    expect(queue.queue.length).toBeGreaterThanOrEqual(1)
    vi.useRealTimers()
  })

  it('sets lastWechatUser after enqueue', () => {
    const { queue } = makeQueue()
    const msg = makeMsg({ text: 'hello' })
    queue.enqueue(msg)
    expect(queue.lastWechatUser).toEqual({ userId: 'user_1', contextToken: 'token_1' })
  })
})

describe('MessageQueue — drain protection', () => {
  it('does not drain when not running', async () => {
    const { queue } = makeQueue({ running: false })
    const msg = makeMsg({ text: 'test' })
    queue.enqueue(msg)
    // drain is called but should skip
    await queue.drain()
    // Since we're not running, nothing should happen
    expect(queue.pendingInjection).toBeNull()
  })
})

describe('MessageQueue — reset', () => {
  it('clears queue and accumulated state', () => {
    const { queue } = makeQueue()
    queue.enqueue(makeMsg({ text: 'test 1' }))
    queue.enqueue(makeMsg({ text: 'test 2' }))
    queue.lastWechatUser = { userId: 'u1', contextToken: 'ct1' }
    queue.pendingInjection = {} as any
    queue.activeRequest = {} as any

    queue.reset()

    expect(queue.pending).toBe(0)
    expect(queue.pendingInjection).toBeNull()
    expect(queue.activeRequest).toBeNull()
  })
})

describe('getImageBatchWaitMs', () => {
  it('returns default when no config', () => {
    expect(getImageBatchWaitMs()).toBe(8000)
  })

  it('respects env override', () => {
    process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS = '3000'
    expect(getImageBatchWaitMs()).toBe(3000)
    delete process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS
  })

  it('clamps to valid range (rejects invalid values, falls back to default)', () => {
    process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS = '-500'
    // -500 fails Number.isFinite && >0 check, falls back to DEFAULT=8000
    expect(getImageBatchWaitMs()).toBe(8000)
    process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS = '999999'
    // clamps to max 60000
    expect(getImageBatchWaitMs()).toBe(60000)
    delete process.env.PI_WECHAT_IMAGE_BATCH_WAIT_MS
  })
})

describe('getImageMaxBytes', () => {
  it('returns default 50MB', () => {
    expect(getImageMaxBytes()).toBe(50 * 1024 * 1024)
  })

  it('enforces minimum 1MB', () => {
    process.env.PI_WECHAT_IMAGE_MAX_BYTES = '100'
    expect(getImageMaxBytes()).toBe(1024 * 1024)
    delete process.env.PI_WECHAT_IMAGE_MAX_BYTES
  })
})

function testClient() {
  return vi.fn(() => ({
    sendText: vi.fn().mockResolvedValue(undefined),
    startTyping: vi.fn().mockResolvedValue(undefined),
    stopTyping: vi.fn().mockResolvedValue(undefined),
  }))
}

describe('WeChat submissions and origin tracking', () => {
  it.each([true, false])('uses followUp while idle=%s and leaves the original message unchanged by default', async agentIdle => {
    const { queue, sendUserMessage } = makeQueue({ client: testClient(), agentIdle })
    queue.enqueue(makeMsg({ text: '微信原文' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendUserMessage).toHaveBeenCalledWith('微信原文', { deliverAs: 'followUp' })
    expect(queue.consumeSubmittedRequest('微信原文')?.userId).toBe('user_1')
  })

  it('tags each new batch with one marker and keeps reply rules out of user messages', async () => {
    vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: true } })
    const { queue, sendUserMessage } = makeQueue({ client: testClient(), agentIdle: false })
    queue.enqueue(makeMsg({ text: '第一条' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendUserMessage.mock.calls[0][0]).toBe(WECHAT_SOURCE_TAG + '\n\n第一条')
    queue.enqueue(makeMsg({ text: '第二条' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledTimes(2))
    expect(sendUserMessage.mock.calls[1][0]).toBe(WECHAT_SOURCE_TAG + '\n\n第二条')
  })

  it('does not treat a marker in TUI or another extension input as proof of WeChat origin', async () => {
    const { queue, sendUserMessage } = makeQueue({ client: testClient(), agentIdle: false })
    expect(queue.consumeSubmittedRequest(WECHAT_SOURCE_TAG + '\n\n伪造')).toBeNull()
    queue.enqueue(makeMsg({ text: '相同内容' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    queue.observeInput('相同内容', undefined, 'interactive')
    queue.observeInput('相同内容', undefined, 'extension')
    expect(queue.consumeSubmittedRequest('相同内容')).toBeNull()
    expect(queue.consumeSubmittedRequest('相同内容')?.userId).toBe('user_1')
    queue.observeInput('别的扩展', undefined, 'extension')
    expect(queue.consumeSubmittedRequest('别的扩展')).toBeNull()
  })

  it('matches the submitted images as well as their text, regardless of object property order', async () => {
    vi.mocked(fetchImageAsBase64).mockResolvedValue({ data: 'image-a', mediaType: 'image/png' })
    const { queue, sendUserMessage } = makeQueue({ client: testClient() })
    queue.enqueue(makeMsg({ text: '图片', imageUrls: [{ url: 'https://example.com/a.png' }] }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    const content = sendUserMessage.mock.calls[0][0]
    const text = extractTextFromMessageContent(content)!
    expect(queue.consumeSubmittedRequest([{ type: 'text', text }, { type: 'image', data: 'image-b', mimeType: 'image/png' }])).toBeNull()
    const image = { mimeType: 'image/png', type: 'image', data: 'image-a' }
    queue.observeInput(text, [image], 'extension')
    expect(queue.consumeSubmittedRequest([{ type: 'text', text }, image])?.userId).toBe('user_1')
  })

  it('holds a batch while Pi prepares a run and submits it after preparation', async () => {
    let ready = false
    const { queue, sendUserMessage } = makeQueue({ client: testClient(), canSubmit: () => ready })
    queue.enqueue(makeMsg({ text: '准备阶段的新消息' }))
    await queue.drain()
    expect(sendUserMessage).not.toHaveBeenCalled()
    ready = true
    await queue.drain()
    expect(sendUserMessage).toHaveBeenCalledWith('准备阶段的新消息', { deliverAs: 'followUp' })
  })

  it('rechecks the preparation state after downloading images', async () => {
    let ready = true
    let finish!: (image: { data: string; mediaType: string }) => void
    const image = new Promise<{ data: string; mediaType: string }>(resolve => { finish = resolve })
    vi.mocked(fetchImageAsBase64).mockImplementation(() => image)
    const { queue, sendUserMessage } = makeQueue({ client: testClient(), canSubmit: () => ready })
    queue.enqueue(makeMsg({ text: '看图', imageUrls: [{ url: 'https://example.com/a.png' }] }))
    await vi.waitFor(() => expect(fetchImageAsBase64).toHaveBeenCalled())
    ready = false
    finish({ data: 'image-a', mediaType: 'image/png' })
    await vi.waitFor(() => expect(queue.pendingInjection).toBeNull())
    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(queue.pending).toBe(2)
    ready = true
    await queue.drain()
    expect(sendUserMessage).toHaveBeenCalledOnce()
  })

  it('discards origin records on stop rather than confusing a later TUI message', async () => {
    const { queue, sendUserMessage } = makeQueue({ client: testClient() })
    queue.enqueue(makeMsg({ text: '旧消息' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    queue.reset()
    expect(queue.consumeSubmittedRequest('旧消息')).toBeNull()
  })
})

describe('files accompany the correct input batch', () => {
  it('waits for a file download when its message also contains text', async () => {
    let completeDownload!: (buffer: Buffer) => void
    vi.mocked(fetchFile).mockImplementation(() => new Promise(resolve => { completeDownload = resolve }))
    vi.mocked(saveFileToDisk).mockResolvedValue('C:/project/report.txt')
    vi.mocked(getConfigCache).mockReturnValue({ messageSourceTag: { enabled: true } })
    const { queue, sendUserMessage } = makeQueue({ client: testClient() })
    queue.enqueue(makeMsg({ text: '读取这个文件', fileEncryptParam: 'file', fileName: 'report.txt' }))
    expect(sendUserMessage).not.toHaveBeenCalled()
    completeDownload(Buffer.from('report'))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    const text = extractTextFromMessageContent(sendUserMessage.mock.calls[0][0])!
    expect(text).toContain('读取这个文件')
    expect(text).toContain('C:/project/report.txt')
    expect(text.split(WECHAT_SOURCE_TAG)).toHaveLength(2)
  })

  it('retains a saved file while an earlier idle submission is still pending', async () => {
    vi.mocked(fetchFile).mockResolvedValue(Buffer.from('report'))
    vi.mocked(saveFileToDisk).mockResolvedValue('C:/project/report.txt')
    const { queue, sendUserMessage } = makeQueue({ client: testClient() })
    queue.enqueue(makeMsg({ text: '第一条' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    queue.enqueue(makeMsg({ fileEncryptParam: 'file', fileName: 'report.txt' }))
    await vi.waitFor(() => expect(saveFileToDisk).toHaveBeenCalledOnce())
    queue.enqueue(makeMsg({ text: '读取文件' }))
    await queue.drain()
    queue.consumeSubmittedRequest('第一条')
    await queue.drain()
    expect(extractTextFromMessageContent(sendUserMessage.mock.calls[1][0])).toContain('C:/project/report.txt')
  })

  it('does not inject a file by itself or carry a stopped download into a new session', async () => {
    let completeDownload!: (buffer: Buffer) => void
    vi.mocked(fetchFile).mockImplementation(() => new Promise(resolve => { completeDownload = resolve }))
    const { queue, sendUserMessage } = makeQueue({ client: testClient() })
    queue.enqueue(makeMsg({ fileEncryptParam: 'file', fileName: 'report.txt' }))
    queue.reset()
    completeDownload(Buffer.from('report'))
    queue.enqueue(makeMsg({ text: '新会话' }))
    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledOnce())
    expect(sendUserMessage).toHaveBeenCalledWith('新会话', { deliverAs: 'followUp' })
    expect(saveFileToDisk).not.toHaveBeenCalled()
  })
})
