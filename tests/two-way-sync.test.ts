import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const sendText = vi.fn(async () => {})
  const startTyping = vi.fn(async () => {})
  const stopTyping = vi.fn(async () => {})
  const dispose = vi.fn(async () => {})
  let firstPoll = true

  const incoming = {
    messageId: 'wechat-message-1',
    userId: 'bound-user',
    text: '微信发来的消息',
    type: 'text' as const,
    imageUrls: [],
    raw: {
      message_type: 1,
      from_user_id: 'bound-user',
      context_token: 'context-token',
    },
    contextToken: 'context-token',
    timestamp: new Date(),
  }

  const client = {
    accountId: 'account-1',
    userId: 'bound-user',
    lastActiveUserId: null,
    sendText,
    startTyping,
    stopTyping,
    dispose,
    async getUpdates(signal?: AbortSignal) {
      if (firstPoll) {
        firstPoll = false
        return [incoming]
      }
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    },
  }

  return { client, sendText, startTyping, stopTyping, dispose }
})

vi.mock('../src/client.js', () => {
  class SessionExpiredError extends Error {}
  return {
    SessionExpiredError,
    WeixinClient: {
      create: vi.fn(async () => state.client),
    },
  }
})

vi.mock('../src/auth.js', () => ({
  acquireLock: vi.fn(async () => ({ success: true, message: 'ok' })),
  releaseLock: vi.fn(async () => {}),
  loadCredentials: vi.fn(async () => ({
    accountId: 'account-1',
    userId: 'bound-user',
    token: 'token',
    baseUrl: 'https://example.invalid',
  })),
  loadConfig: vi.fn(async () => ({ autoStart: false, allowRemoteTools: false })),
  getConfigCache: vi.fn(() => ({})),
  clearCredentials: vi.fn(async () => {}),
  clearContextTokens: vi.fn(async () => {}),
  clearTransportState: vi.fn(async () => {}),
  getCredentialsPath: vi.fn(() => '/tmp/credentials.json'),
  getQrCode: vi.fn(),
  pollQrStatus: vi.fn(),
  saveConfig: vi.fn(async () => {}),
  saveCredentials: vi.fn(async () => {}),
}))

import wechatAssistant from '../src/index.js'

type Handler = (event: any, ctx: any) => unknown

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('Timed out waiting for condition'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('true two-way sync', () => {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>()
  const sendUserMessage = vi.fn()

  const pi = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? []
      current.push(handler)
      handlers.set(name, current)
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, command)
    },
    registerTool: vi.fn(),
    sendUserMessage,
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  }

  const ctx = {
    cwd: '/tmp/project',
    hasUI: false,
    mode: 'tui',
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getSessionFile: vi.fn(() => '/tmp/session.jsonl'),
      getSessionId: vi.fn(() => 'session-1'),
      getBranch: vi.fn(() => []),
    },
  }

  const emit = async (name: string, event: any) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx)
  }

  beforeAll(async () => {
    wechatAssistant(pi as any)
    await emit('session_start', { reason: 'startup' })
    await commands.get('wechat')!.handler('start', ctx)
    await waitFor(() => sendUserMessage.mock.calls.length > 0)
  })

  afterAll(async () => {
    await emit('session_shutdown', { reason: 'quit' })
  })

  it('shows an incoming WeChat message in the active Pi session', () => {
    expect(sendUserMessage).toHaveBeenCalledWith('微信发来的消息', undefined)
  })

  it('does not echo an extension-injected WeChat message back to WeChat', async () => {
    state.sendText.mockClear()
    await emit('input', {
      source: 'extension',
      text: '微信发来的消息',
      images: [],
    })
    expect(state.sendText).not.toHaveBeenCalled()
  })

  it('mirrors Pi user input and the assistant conclusion to WeChat', async () => {
    state.sendText.mockClear()

    await emit('agent_start', {})
    await emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: '微信问题的回答' }] },
    })
    await emit('agent_end', {
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '微信问题的回答' }] }],
    })

    state.sendText.mockClear()
    await emit('input', {
      source: 'interactive',
      text: 'Pi 上输入的问题',
      images: [],
    })
    await emit('agent_start', {})
    await emit('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'Pi 得出的结论' }] },
    })

    expect(state.sendText.mock.calls.map(([_, text]) => text)).toEqual([
      '💻 Pi 发送：Pi 上输入的问题',
      'Pi 得出的结论',
    ])
  })

  it('splits long Pi input without losing content and includes an image note', async () => {
    state.sendText.mockClear()
    const longText = '长'.repeat(1200)

    await emit('input', {
      source: 'interactive',
      text: longText,
      images: [{ type: 'image' }],
    })

    const mirrored = state.sendText.mock.calls.map(([_, text]) => text).join('')
    expect(state.sendText).toHaveBeenCalledTimes(2)
    expect(mirrored).toBe(`💻 Pi 发送：${longText}\n[附带 1 张图片]`)
  })
})
