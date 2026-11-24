import { extractTextFromMessageContent } from '../shared/utils.js'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const detailHint = '完整回复见 Pi 终端。'

export const SUMMARY_REPLY_RULE = '把最终结果写在开头的短段落里。按实际情况用“任务完成：”“任务失败：”或“需要你回复：”开头，写清结果、原因或可选项。结果尚不确定时用“摘要：”。空行后可保留完整说明。'

export function completionSummarySetting(enabled: boolean, supported: boolean): string {
  if (!enabled) return '已关闭（默认）'
  return supported ? '已开启' : '已开启（当前 Pi 缺少完整结束事件，使用实时回复）'
}

function shortTitle(task: string): string {
  const text = task.replace(/\s+/g, ' ').trim()
  if (text.length <= 60) return text
  return text.slice(0, graphemes.segment(text).containing(59)!.index) + '…'
}

function excerpt(body: string): string {
  if (body.length <= 560) return body
  // Keep both the conclusion and closing questions/options within one WeChat message.
  const segments = graphemes.segment(body)
  const headEnd = segments.containing(304)!.index
  const tail = segments.containing(body.length - 208)!
  return body.slice(0, headEnd).trimEnd() + '\n…\n' + body.slice(tail.index + tail.segment.length).trimStart() + '\n' + detailHint
}

type Reply = { label?: string; body: string }
type Draft = { title: string; fromWechat: boolean; muted: boolean; reply: Reply | null }

function briefReply(text: string, lengthLimited: boolean): Reply {
  const marker = /^(摘要|任务完成|任务失败|需要你回复)[：:][ \t]*/.exec(text)
  let body = marker ? text.slice(marker[0].length).trim() || text : text
  // Preserve questions and options even when they span multiple paragraphs.
  if (marker && marker[1] !== '需要你回复') body = body.split(/\r?\n[ \t]*\r?\n/, 1)[0]
  const label = lengthLimited ? '回复达到长度上限' : marker?.[1]
  return { label: label === '摘要' ? undefined : label, body: excerpt(body) }
}

function format(draft: Draft, label: string, body: string): string {
  return `【${label}】\n任务：${draft.title}\n${body}`
}

function formatReply(draft: Draft, label: string): string {
  return format(draft, draft.reply?.label ?? label, draft.reply?.body ?? '本轮没有最终文字回复，详情见 Pi 终端。')
}

/** Retain only the latest eligible reply seen live in this Pi activity. */
export class CompletionSummary {
  private current: Draft | null = null
  private previousWechatReply: string | null = null
  private outcome = ''
  private observed = false
  private cancelled = false
  private signal?: AbortSignal

  get active(): boolean { return this.current !== null }

  reset(): void {
    this.current = null
    this.previousWechatReply = null
    this.startAttempt()
  }

  beginRequest(task: string | null, fromWechat: boolean): void {
    // A private desktop follow-up may share the same final settlement.
    if (this.current?.fromWechat && this.current.reply) this.previousWechatReply = formatReply(this.current, '回复摘要')
    this.current = task === null ? null : { title: shortTitle(task) || '本轮请求', fromWechat, muted: false, reply: null }
    this.startAttempt()
  }

  startAttempt(): void {
    this.outcome = ''
    this.observed = false
    this.cancelled = false
    this.signal = undefined
  }

  observe(message: { stopReason?: string; content: unknown }, visible: boolean, signal?: AbortSignal): void {
    if (!this.current) return
    if (!visible) this.current.muted = true
    if (this.current.muted) return
    this.outcome = ''
    this.observed = true
    this.cancelled = message.stopReason === 'aborted'
    this.signal = signal
    this.current.reply = null
    if (message.stopReason && message.stopReason !== 'stop' && message.stopReason !== 'length') return
    if (Array.isArray(message.content) && message.content.some(part => part?.type === 'toolCall')) return
    const text = extractTextFromMessageContent(message.content)
    if (text) this.current.reply = briefReply(text, message.stopReason === 'length')
  }

  beforeSettle(outcome: string): void { this.outcome = outcome }

  take(failure: string | null, aborted: boolean, syncDesktop: boolean): string | null {
    let notice = this.previousWechatReply
    const draft = this.current
    if (draft && !draft.muted && (draft.fromWechat || syncDesktop)) {
      if (aborted || this.cancelled || this.signal?.aborted || this.outcome === 'aborted') {
        notice = format(draft, '本轮已取消', 'Pi 已停止本轮处理。')
      } else if (this.outcome === 'error') {
        notice = format(draft, '本轮失败', failure ?? 'Pi 处理遇到错误，详情见 Pi 终端。')
      } else if (this.outcome === 'completed') {
        if (!this.observed) draft.reply = null
        notice = formatReply(draft, '完成摘要')
      }
    }
    this.reset()
    return notice
  }
}
