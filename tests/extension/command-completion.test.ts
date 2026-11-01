// ============================================================================
// 测试: command-completion.ts — /wechat 参数补全
// ============================================================================

import { describe, expect, it } from 'vitest'
import { getWechatArgumentCompletions, type WechatCompletionItem } from '../../src/extension/command-completion.js'

const values = (prefix: string) => getWechatArgumentCompletions(prefix)?.map(item => item.value) ?? null

/**
 * 复刻宿主 applyCompletion 的参数分支：把整段参数文本换成 item.value，
 * 光标落在末尾，不追加空格（pi-tui `dist/autocomplete.js` 的 `beforePrefix + item.value`）。
 * 返回下一次请求补全时应传入的参数文本。
 */
const applyCompletion = (item: WechatCompletionItem): string => item.value

describe('/wechat 参数补全', () => {
  it('列出全部子命令并带描述', () => {
    const items = getWechatArgumentCompletions('')
    expect(items?.map(item => item.value)).toEqual([
      'login', 'start', 'stop', 'status', 'prompt', 'config', 'logout', 'autostart', 'remotetools',
    ])
    expect(items?.every(item => item.label === item.value && item.description)).toBe(true)
  })

  it('按前缀过滤子命令', () => {
    expect(values('st')).toEqual(['start', 'stop', 'status'])
    expect(values('c')).toEqual(['config'])
    expect(values('zzz')).toBeNull()
  })

  it('补全 login 的 --force 且只在未出现时提供', () => {
    expect(values('login ')).toEqual(['login --force'])
    expect(values('login -')).toEqual(['login --force'])
    expect(values('login --force ')).toBeNull()
  })

  it('补全 prompt 的固定动作，完成后不再建议', () => {
    expect(values('prompt ')).toEqual(['prompt show', 'prompt init', 'prompt reload'])
    expect(values('prompt re')).toEqual(['prompt reload'])
    expect(values('prompt reload ')).toBeNull()
  })

  it('补全 config 的配置项，并保留已输入的配置项', () => {
    expect(values('config ')).toContain('config ack')
    expect(values('config hand')).toEqual(['config handoff'])
    expect(values('config handoff ')).toEqual(['config handoff ask', 'config handoff auto'])
    expect(values('config handoff as')).toEqual(['config handoff ask'])
    expect(values('config handoff auto ')).toBeNull()
  })

  it('只为枚举型配置补全取值，自由文本与数字不补全', () => {
    expect(values('config bidirectional ')).toEqual(['config bidirectional on', 'config bidirectional off'])
    expect(values('config ack-text ')).toBeNull()
    expect(values('config image-wait ')).toBeNull()
    expect(values('config image-max ')).toBeNull()
  })

  it('补全 remotetools 的 on/off', () => {
    expect(values('remotetools ')).toEqual(['remotetools on', 'remotetools off'])
    expect(values('remotetools o')).toEqual(['remotetools on', 'remotetools off'])
  })

  it('无参数补全的子命令返回 null，且不因多余空白出错', () => {
    expect(values('start ')).toBeNull()
    expect(values('status ')).toBeNull()
    expect(values('  config   handoff  ')).toEqual(['config handoff ask', 'config handoff auto'])
  })

  // 宿主不会在补全结果后补空格，因此“应用补全后再请求下一轮候选”只能停在当前层；
  // 两个 README 据此要求用户手动输入空格。
  it('应用子命令补全后再请求候选，仍停在子命令层', () => {
    const config = getWechatArgumentCompletions('')!.find(item => item.value === 'config')!
    const argumentText = applyCompletion(config)

    expect(argumentText).toBe('config')
    expect(values(argumentText)).toEqual(['config'])
    expect(values(`${argumentText} `)).toContain('config ack')
  })

  it('应用中间层参数补全后再请求候选，需先输入空格才出现取值', () => {
    const handoff = getWechatArgumentCompletions('config ')!.find(item => item.value === 'config handoff')!
    const argumentText = applyCompletion(handoff)

    expect(argumentText).toBe('config handoff')
    expect(values(argumentText)).toEqual(['config handoff'])
    expect(values(`${argumentText} `)).toEqual(['config handoff ask', 'config handoff auto'])
  })
})
