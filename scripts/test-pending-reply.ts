/**
 * Local-only #53 acceptance helper; scripts/ is excluded from the npm package.
 * Run instead of index.ts (never load both):
 *   pi --no-extensions -e ./scripts/test-pending-reply.ts
 * In Pi: /wechat start, then /wechat-test-reject
 * In WeChat: ask the model to reply with exactly 补发测试53, then send /status.
 * No credentials are edited. Only this exact test text is intercepted; inbound
 * polling, typing, receipts, media, and all other requests use the real fetch.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import wechatAssistant from '../index.js'

export const TEST_REPLY = '补发测试53'

/** Fail one matching send, including the client's optional context-free fallback. */
export function createRejectionTest(original: typeof fetch, onReject: () => void = () => {}) {
  let armed = false
  let fallbackKey: string | null = null

  const intercepted: typeof fetch = async (input, init) => {
    let match: { key: string; hasContext: boolean } | undefined
    try {
      const url = new URL(input instanceof Request ? input.url : String(input))
      if (url.pathname === '/ilink/bot/sendmessage' && init?.method?.toUpperCase() === 'POST' && typeof init.body === 'string') {
        const { msg } = JSON.parse(init.body)
        if (msg?.message_type === 2 && typeof msg.to_user_id === 'string' && msg.to_user_id
          && msg.item_list?.length === 1 && msg.item_list[0].type === 1
          && msg.item_list[0].text_item?.text?.trim() === TEST_REPLY) {
          match = {
            key: JSON.stringify([url.origin, url.pathname, msg.to_user_id]),
            hasContext: typeof msg.context_token === 'string' && msg.context_token.length > 0,
          }
        }
      }
    } catch { /* Nonmatching requests must keep their original behavior. */ }

    if (match) {
      let reject = false
      if (armed) {
        armed = false
        fallbackKey = match.hasContext ? match.key : null
        reject = true
        onReject()
      } else if (fallbackKey === match.key) {
        reject = !match.hasContext
        fallbackKey = null
      }
      if (reject) {
        // Exercise the real ApiError parser and fallback, without sending this
        // attempt to WeChat. The subsequent replay goes through real transport.
        return new Response(JSON.stringify({ ret: -2, errmsg: 'LOCAL TEST: simulated prepare failed' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }
    }
    return original(input, init)
  }

  return {
    fetch: intercepted,
    arm() { armed = true; fallbackKey = null },
    cancel() { armed = false; fallbackKey = null },
  }
}

export default function pendingReplyTest(pi: ExtensionAPI): void {
  wechatAssistant(pi)
  let test: ReturnType<typeof createRejectionTest> | undefined
  let original: typeof fetch | undefined

  pi.on('session_start', (_event, ctx) => {
    original = globalThis.fetch
    // The bridge reports one final outcome after storage succeeds or fails.
    // A separate simulation warning would duplicate that message.
    test = createRejectionTest(original)
    globalThis.fetch = test.fetch
    ctx.ui.notify('【本地测试】使用 /wechat-test-reject 准备一次模拟拒收；默认不拦截任何消息。', 'info')
  })

  pi.registerCommand('wechat-test-reject', {
    description: '仅本地测试：模拟下一条“补发测试53”被拒；off 取消',
    handler: async (args, ctx) => {
      if (!test) { ctx.ui.notify('测试入口尚未初始化', 'warning'); return }
      if (args.trim() === 'off') {
        test.cancel()
        ctx.ui.notify('已取消模拟拒收；已经暂存的回复仍可正常补发。', 'info')
        return
      }
      if (args.trim()) { ctx.ui.notify('用法：/wechat-test-reject 或 /wechat-test-reject off', 'warning'); return }
      if (!ctx.isIdle()) { ctx.ui.notify('请等当前任务结束，再准备模拟拒收。', 'warning'); return }
      test.arm()
      ctx.ui.notify('已准备：请从微信发送「只回复：补发测试53」。只拦截这条测试回复一次，不用等待三分钟。', 'info')
    },
  })

  // Registered after the real bridge's cleanup, which drains in-flight sends.
  pi.on('session_shutdown', () => {
    test?.cancel()
    if (test && original && globalThis.fetch === test.fetch) globalThis.fetch = original
    test = undefined
    original = undefined
  })
}
