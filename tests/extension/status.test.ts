import { describe, expect, it } from 'vitest'
import { formatWechatStatus, type WechatStatusState } from '../../src/extension/status.js'

const active: WechatStatusState = { running: true, bidirectional: true, pending: 0, sendFailed: false }
const plain = { NO_COLOR: '1' }

describe('compact WeChat footer', () => {
  it('uses standard Unicode glyphs that render on any terminal', () => {
    expect(formatWechatStatus(active, plain)).toBe('[微信 ⇄ ▶]')
    expect(formatWechatStatus({ ...active, bidirectional: false }, plain)).toBe('[微信 ▶]')
    expect(formatWechatStatus({ ...active, running: false }, plain)).toBe('[微信 ⏸]')
  })

  it('only adds pending messages and failed sending to the running state', () => {
    const pending = { ...active, pending: 2, sendFailed: true }
    expect(formatWechatStatus(pending, plain)).toBe('[微信 ⇄ ▶ | 待处理:2 | 发送失败]')
    expect(formatWechatStatus({ ...pending, running: false }, plain)).toBe('[微信 ⏸]')
  })

  it('distinguishes inbound work, pending replies and uncertain deliveries', () => {
    const state = { ...active, pending: 2, pendingReplies: 3, uncertainReplies: 1 }
    expect(formatWechatStatus(state, plain)).toBe('[微信 ⇄ ▶ | 待处理:2 | 待补发:3 | 送达待确认:1]')
    expect(formatWechatStatus({ ...state, running: false }, plain)).toBe('[微信 ⏸]')
  })

  it.each(['truecolor', '24bit', 'TRUECOLOR'])('colors the label and running indicator WeChat green on %s terminals', COLORTERM => {
    expect(formatWechatStatus(active, { COLORTERM })).toBe('[\x1b[38;2;7;193;96m微信\x1b[39m ⇄ \x1b[38;2;7;193;96m▶\x1b[39m]')
  })

  it('colors the stopped indicator red while preserving the green label', () => {
    expect(formatWechatStatus({ ...active, running: false }, { COLORTERM: 'truecolor' })).toBe('[\x1b[38;2;7;193;96m微信\x1b[39m \x1b[38;2;239;68;68m⏸\x1b[39m]')
  })

  it('falls back to standard ANSI colors without truecolor support', () => {
    expect(formatWechatStatus(active, { TERM: 'xterm-256color' })).toBe('[\x1b[37m微信\x1b[39m ⇄ \x1b[32m▶\x1b[39m]')
    expect(formatWechatStatus({ ...active, running: false }, { TERM: 'xterm-256color' })).toBe('[\x1b[37m微信\x1b[39m \x1b[31m⏸\x1b[39m]')
  })

  it.each([{ NO_COLOR: '1', COLORTERM: 'truecolor' }, { TERM: 'dumb', COLORTERM: 'truecolor' }])('omits all ANSI color when disabled: %j', env => {
    expect(formatWechatStatus(active, env)).toBe('[微信 ⇄ ▶]')
    expect(formatWechatStatus({ ...active, running: false }, env)).toBe('[微信 ⏸]')
  })
})
