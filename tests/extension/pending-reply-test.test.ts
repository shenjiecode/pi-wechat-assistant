import { afterEach, describe, expect, it, vi } from 'vitest'
import pendingReplyTest, { createRejectionTest, TEST_REPLY } from '../../scripts/test-pending-reply.js'
import extension from '../../index.js'

vi.mock('../../index.js', () => ({ default: vi.fn() }))

function request(text = TEST_REPLY, context: string | null = 'old-context', user = 'bound-user'): Parameters<typeof fetch> {
  return [new URL('https://example.test/ilink/bot/sendmessage'), {
    method: 'POST', body: JSON.stringify({ msg: {
      message_type: 2, to_user_id: user, context_token: context ?? undefined,
      item_list: [{ type: 1, text_item: { text } }],
    } }),
  }]
}
const http = () => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ret: 0 })))
let cleanup: (() => void) | undefined
afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('local-only one-shot rejection helper', () => {
  it('passes all sends through until explicitly armed', async () => {
    const original = http()
    const test = createRejectionTest(original)
    expect(await (await test.fetch(...request())).json()).toEqual({ ret: 0 })
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('rejects one test reply and its context-free fallback, then permits real replay', async () => {
    const original = http()
    const notify = vi.fn()
    const test = createRejectionTest(original, notify)
    test.arm()
    expect(await (await test.fetch(...request())).json()).toMatchObject({ ret: -2 })
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toMatchObject({ ret: -2 })
    expect(original).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(await (await test.fetch(...request(TEST_REPLY, 'fresh-context'))).json()).toEqual({ ret: 0 })
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toEqual({ ret: 0 })
    expect(original).toHaveBeenCalledTimes(2)
  })

  it('rejects only once when there was no context and hence no fallback', async () => {
    const original = http()
    const test = createRejectionTest(original)
    test.arm()
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toMatchObject({ ret: -2 })
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toEqual({ ret: 0 })
    expect(original).toHaveBeenCalledTimes(1)
  })

  it('does not mistake a fresh-context send for a fallback', async () => {
    const original = http()
    const test = createRejectionTest(original)
    test.arm()
    await test.fetch(...request())
    expect(await (await test.fetch(...request(TEST_REPLY, 'fresh-context'))).json()).toEqual({ ret: 0 })
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toEqual({ ret: 0 })
  })

  it('never intercepts polling, typing, receipts, media, unrelated text or another endpoint', async () => {
    const original = http()
    const test = createRejectionTest(original)
    test.arm()
    const payloads: Parameters<typeof fetch>[] = [
      request('normal result'), request(`mention ${TEST_REPLY} in prose`), request('✅ 已收到'),
      ['https://example.test/ilink/bot/getupdates', { method: 'POST', body: '{}' }],
      ['https://example.test/ilink/bot/sendtyping', { method: 'POST', body: '{}' }],
      ['https://example.test/other', request()[1]],
      [request()[0], { ...request()[1], method: 'GET' }],
      [request()[0], { method: 'POST', body: 'invalid JSON' }],
      [request()[0], { method: 'POST', body: JSON.stringify({ msg: {
        message_type: 2, to_user_id: 'bound-user', item_list: [{ type: 4, file_item: { file_name: TEST_REPLY } }],
      } }) }],
    ]
    for (const args of payloads) expect(await (await test.fetch(...args)).json()).toEqual({ ret: 0 })
    expect(original).toHaveBeenCalledTimes(payloads.length)
    expect(await (await test.fetch(...request())).json()).toMatchObject({ ret: -2 })
  })

  it('scopes the one fallback to the original recipient and endpoint', async () => {
    const original = http()
    const test = createRejectionTest(original)
    test.arm()
    await test.fetch(...request())
    expect(await (await test.fetch(...request(TEST_REPLY, null, 'other-user'))).json()).toEqual({ ret: 0 })
    expect(await (await test.fetch('https://other.test/ilink/bot/sendmessage', request(TEST_REPLY, null)[1])).json()).toEqual({ ret: 0 })
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toMatchObject({ ret: -2 })
    expect(original).toHaveBeenCalledTimes(2)
  })

  it('can cancel both unused arming and the remaining fallback rejection', async () => {
    const original = http()
    const test = createRejectionTest(original)
    test.arm(); test.cancel()
    expect(await (await test.fetch(...request())).json()).toEqual({ ret: 0 })
    test.arm()
    await test.fetch(...request())
    test.cancel()
    expect(await (await test.fetch(...request(TEST_REPLY, null))).json()).toEqual({ ret: 0 })
  })

  it('installs only at session start and restores fetch on shutdown, including armed state', async () => {
    const original = http()
    vi.stubGlobal('fetch', original)
    const handlers: Record<string, any> = {}
    const commands: Record<string, any> = {}
    const pi = {
      on: (name: string, handler: any) => { handlers[name] = handler },
      registerCommand: (name: string, command: any) => { commands[name] = command },
    } as any
    const ctx = { isIdle: () => true, ui: { notify: vi.fn() } } as any
    pendingReplyTest(pi)
    expect(extension).toHaveBeenCalledExactlyOnceWith(pi)
    expect(globalThis.fetch).toBe(original)
    handlers.session_start({}, ctx)
    cleanup = handlers.session_shutdown
    expect(globalThis.fetch).not.toBe(original)
    await commands['wechat-test-reject'].handler('', ctx)
    expect(await (await fetch(...request())).json()).toMatchObject({ ret: -2 })
    // The real bridge owns the one storage-confirmed warning; the helper is silent.
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), 'warning')
    handlers.session_shutdown()
    expect(globalThis.fetch).toBe(original)
    expect(await (await fetch(...request(TEST_REPLY, null))).json()).toEqual({ ret: 0 })
  })

  it('refuses arming while busy and supports explicit off', async () => {
    const original = http()
    vi.stubGlobal('fetch', original)
    const handlers: Record<string, any> = {}
    const commands: Record<string, any> = {}
    pendingReplyTest({
      on: (name: string, handler: any) => { handlers[name] = handler },
      registerCommand: (name: string, command: any) => { commands[name] = command },
    } as any)
    const ctx = { isIdle: vi.fn(() => false), ui: { notify: vi.fn() } }
    handlers.session_start({}, ctx)
    cleanup = handlers.session_shutdown
    await commands['wechat-test-reject'].handler('', ctx)
    expect(await (await fetch(...request())).json()).toEqual({ ret: 0 })
    ctx.isIdle.mockReturnValue(true)
    await commands['wechat-test-reject'].handler('', ctx)
    await commands['wechat-test-reject'].handler('off', ctx)
    expect(await (await fetch(...request())).json()).toEqual({ ret: 0 })
  })
})
