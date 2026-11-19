// Compact footer only; credentials and send diagnostics remain in /wechat status.
// Standard Unicode glyphs only: they render on every terminal at a consistent
// size, with no dependency on Nerd Fonts or per-font fallback behaviour.
export interface WechatStatusState {
  running: boolean
  bidirectional: boolean
  pending: number
  sendFailed: boolean
  pendingReplies?: number
  uncertainReplies?: number
}

export function formatWechatStatus(state: WechatStatusState, env: NodeJS.ProcessEnv = process.env): string {
  const canColor = !env.NO_COLOR && env.TERM !== 'dumb'
  const trueColor = /^(truecolor|24bit)$/i.test(env.COLORTERM ?? '')
  const paint = (text: string, rgb: string, ansi: number): string => canColor
    ? `\x1b[${trueColor ? '38;2;' + rgb : ansi}m${text}\x1b[39m`
    : text
  const logo = paint('微信', '7;193;96', 37)
  const indicator = state.running ? paint('▶', '7;193;96', 32) : paint('⏸', '239;68;68', 31)

  const parts = [state.running
    ? `${logo}${state.bidirectional ? ' ⇄' : ''} ${indicator}`
    : `${logo} ${indicator}`]
  if (state.running && state.pending > 0) parts.push(`待处理:${state.pending}`)
  if (state.running && state.sendFailed) parts.push('发送失败')
  if (state.running && state.pendingReplies) parts.push(`待补发:${state.pendingReplies}`)
  if (state.running && state.uncertainReplies) parts.push(`送达待确认:${state.uncertainReplies}`)
  return `[${parts.join(' | ')}]`
}
