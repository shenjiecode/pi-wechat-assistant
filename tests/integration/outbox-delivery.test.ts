import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ReplyOutbox } from '../../src/bridge/outbox.js'
import { WeixinClient } from '../../src/wechat/client.js'
import { createRejectionTest, TEST_REPLY } from '../../scripts/test-pending-reply.js'

// Only the helper's interceptor is used here, not its Pi extension factory.
vi.mock('../../index.js', () => ({ default: vi.fn() }))

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('../../src/bridge/state-storage.js', () => ({ getStateDir: () => state.directory }))
vi.mock('../../src/bridge/transport-state.js', () => ({
  loadContextTokens: async () => ({ lastUserId: 'bound-user', tokens: { 'bound-user': 'stale-context' } }),
  loadCursor: async () => '', loadSeenIds: async () => new Set(),
  saveCursor: async () => {}, saveSeenIds: async () => {},
  saveContextTokensThrottled: () => {}, flushContextTokens: async () => {},
}))

beforeEach(async () => {
  const root = path.resolve('node_modules/.cache')
  await fs.mkdir(root, { recursive: true })
  state.directory = await fs.mkdtemp(path.join(root, 'outbox-client-test-'))
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(state.directory, { recursive: true, force: true })
})

describe('outbox with the real client and API parser, mocked HTTP only', () => {
  it('the manual rejection helper exercises real fallback, persistence and recovery without sending the rejected attempt', async () => {
    const sent: string[] = []
    const original: typeof fetch = vi.fn(async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/ilink/bot/sendmessage') {
        sent.push(JSON.parse(init!.body as string).msg.item_list[0].text_item.text)
        return new Response(JSON.stringify({ ret: 0 }))
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        return new Response(JSON.stringify({ ret: 0, msgs: [{
          message_type: 1, message_id: 'activation', from_user_id: 'bound-user',
          context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text: '/status' } }],
        }] }))
      }
      throw new Error('Unexpected mocked endpoint')
    })
    const injection = createRejectionTest(original)
    vi.stubGlobal('fetch', injection.fetch)
    const credentials = { accountId: 'test-bot', userId: 'bound-user', baseUrl: 'https://example.test', token: 'test-token' }
    const client = await WeixinClient.create(credentials)
    const box = await ReplyOutbox.open(credentials)
    client.onNeedsFreshContext = vi.fn()
    const transport = { active: () => true, send: (text: string) => client.sendText(client.userId, text, { hintOnRejection: false }) }
    injection.arm()
    await expect(box.deliver([TEST_REPLY], { cwd: '/test/project' }, transport)).resolves.toBe('queued')
    expect(sent).toEqual([])
    expect(client.onNeedsFreshContext).not.toHaveBeenCalled() // The outbox reports the final saved/failed outcome instead.
    expect(client.lastSend).toMatchObject({ success: false, code: -2 })
    expect(box.status.pending).toBe(1)
    expect(await client.getUpdates()).toHaveLength(1)
    await box.replay(transport)
    expect(sent).toEqual([expect.stringContaining('【补发】'), TEST_REPLY])
    expect(box.status.pending).toBe(0)
    await box.replay(transport)
    expect(sent).toHaveLength(2)
    await box.pause()
    await client.dispose()
  })

  it.each([0, 1])('recovers after context expires at chunk %i, using fresh context without replaying delivered text', async failAt => {
    const requests: Array<{ text: string; context?: string }> = []
    let accepted = 0
    vi.stubGlobal('fetch', vi.fn(async (url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      if (url.pathname === '/ilink/bot/sendmessage') {
        const text = body.msg.item_list[0].text_item.text
        const context = body.msg.context_token
        requests.push({ text, context })
        const allowed = context === 'fresh-context' || (context === 'stale-context' && accepted < failAt)
        if (allowed) accepted++
        return new Response(JSON.stringify({ ret: allowed ? 0 : -2, errmsg: allowed ? '' : 'prepare failed' }))
      }
      if (url.pathname === '/ilink/bot/getupdates') {
        return new Response(JSON.stringify({ ret: 0, get_updates_buf: 'next-cursor', msgs: [{
          message_type: 1, message_id: 'fresh-message', from_user_id: 'bound-user', to_user_id: 'test-bot',
          context_token: 'fresh-context', item_list: [{ type: 1, text_item: { text: 'are you there?' } }],
        }] }))
      }
      throw new Error(`Unexpected mocked endpoint: ${url.pathname}`)
    }))
    const credentials = { accountId: 'test-bot', userId: 'bound-user', baseUrl: 'https://example.test', token: 'test-token' }
    const client = await WeixinClient.create(credentials)
    const box = await ReplyOutbox.open(credentials)
    const transport = { active: () => true, send: (text: string) => client.sendText(client.userId, text) }
    const chunks = ['part one', 'part two', '  part three\n\n']
    await expect(box.deliver(chunks, { cwd: '/test/project' }, transport)).resolves.toBe('queued')
    expect(requests.slice(-2)).toEqual([
      { text: chunks[failAt], context: 'stale-context' },
      { text: chunks[failAt], context: undefined }, // existing one-time fallback
    ])
    expect(client.lastSend).toMatchObject({ success: false, code: -2 })
    const record = await fs.readFile(box.filePath, 'utf8')
    expect(record).not.toContain('stale-context')
    expect(record).not.toContain('test-token')
    requests.length = 0

    const incoming = await client.getUpdates()
    expect(incoming).toHaveLength(1)
    await box.replay(transport)
    expect(requests.every(request => request.context === 'fresh-context')).toBe(true)
    expect(requests.filter(request => !request.text.startsWith('【补发】')).map(request => request.text))
      .toEqual(chunks.slice(failAt))
    expect(box.status).toEqual({ pending: 0, uncertain: 0 })
    expect(await client.getUpdates()).toEqual([]) // duplicate activity is not a new delivery
    await box.pause()
    await client.dispose()
  })
})
