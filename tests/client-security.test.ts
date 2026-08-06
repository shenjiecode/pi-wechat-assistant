// ============================================================================
// 测试: 客户端入口必须在缓存 context token 前完成授权和去重
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGetUpdates: vi.fn(),
  saveContextTokensThrottled: vi.fn(),
  saveTransportState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../src/api.js', () => ({
  getUpdates: mocks.apiGetUpdates,
  getConfig: vi.fn(),
  sendMessage: vi.fn(),
  sendTyping: vi.fn(),
  getUploadUrl: vi.fn(),
  uploadToCdn: vi.fn(),
  sendMediaMessage: vi.fn(),
  isSessionExpired: vi.fn(() => false),
}))

vi.mock('../src/auth.js', () => ({
  loadContextTokens: vi.fn().mockResolvedValue({ lastUserId: null, tokens: {} }),
  saveContextTokensThrottled: mocks.saveContextTokensThrottled,
  flushContextTokens: vi.fn().mockResolvedValue(undefined),
  loadTransportState: vi.fn().mockResolvedValue({ cursor: '', processedMessageIds: [] }),
  saveTransportState: mocks.saveTransportState,
}))

import { WeixinClient } from '../src/client.js'

const credentials = {
  token: 'token',
  baseUrl: 'https://example.test',
  accountId: 'bot',
  userId: 'bound-user',
}

function rawMessage(messageId: string, fromUserId: string) {
  return {
    message_type: 1,
    message_id: messageId,
    from_user_id: fromUserId,
    context_token: `context-${messageId}`,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text: 'hello' } }],
  }
}

describe('WeixinClient security gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.saveTransportState.mockResolvedValue(undefined)
  })

  it('drops an unbound sender before it stores a context token or produces an incoming message', async () => {
    mocks.apiGetUpdates.mockResolvedValueOnce({
      get_updates_buf: 'cursor-1',
      msgs: [rawMessage('attacker-message', 'attacker')],
    })
    const client = await WeixinClient.create(credentials)

    await expect(client.getUpdates()).resolves.toEqual([])
    expect(mocks.saveContextTokensThrottled).not.toHaveBeenCalled()
    expect(client.lastActiveUserId).toBeNull()
    expect(mocks.saveTransportState).toHaveBeenCalledWith({ cursor: 'cursor-1', processedMessageIds: [] })
  })

  it('skips a processed message ID after restart-safe transport state is recorded', async () => {
    const message = rawMessage('same-message', 'bound-user')
    mocks.apiGetUpdates
      .mockResolvedValueOnce({ get_updates_buf: 'cursor-1', msgs: [message] })
      .mockResolvedValueOnce({ get_updates_buf: 'cursor-2', msgs: [message] })
    const client = await WeixinClient.create(credentials)

    await expect(client.getUpdates()).resolves.toHaveLength(1)
    await expect(client.getUpdates()).resolves.toEqual([])
    expect(mocks.saveTransportState).toHaveBeenLastCalledWith({ cursor: 'cursor-2', processedMessageIds: ['same-message'] })
  })
})
