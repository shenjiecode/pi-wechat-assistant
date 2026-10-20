import type { ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import type { BridgeConfig } from '../bridge/config.js'
import { receiptText } from '../bridge/config-values.js'

interface ConfigMenuDeps {
  load: () => Promise<BridgeConfig>
  apply: (args: string) => Promise<void>
  prompt: (action: string) => Promise<void>
  imageWait: () => number
  imageMax: () => number
}

/** Use host dialogs: no runtime dependency on either generation of pi-tui. */
export async function showConfigMenu(ctx: ExtensionCommandContext, deps: ConfigMenuDeps): Promise<void> {
  let advanced = false
  const enabled = (value: boolean) => value ? '开启' : '关闭'
  while (true) {
    const config = await deps.load()
    const entries: Array<{ id: string; label: string }> = advanced ? [
      { id: 'remote-tools', label: `微信端 /tools 修改本机权限：${enabled(config.allowRemoteTools === true)} · 默认关闭，谨慎开启` },
      { id: 'image-wait', label: `连发图片合并等待：${deps.imageWait()} 毫秒 · 微信连发多张图时凑成一批` },
      { id: 'image-max', label: `单张图片下载上限：${deps.imageMax() / 1024 / 1024} MB · 超过则拒绝下载` },
      { id: 'back', label: '返回常用设置' },
    ] : [
      { id: 'ack', label: `收件回执通知：${enabled(config.sendAck !== false)} · 收到文字或图片时发送确认` },
      { id: 'ack-text', label: '文字回执内容：自定义 / 恢复默认' },
      { id: 'image-ack-text', label: '图片回执内容：自定义 / 恢复默认' },
      { id: 'bidirectional', label: `双向同步：${enabled(config.bidirectionalSync === true)} · 电脑输入和 AI 回复也转发到微信` },
      { id: 'auto-start', label: `自动启动微信桥接：${enabled(config.autoStart === true)} · 打开 pi 时尝试连接微信` },
      { id: 'handoff', label: `持锁接管方式：${config.handoff === 'auto' ? '自动' : '询问'} · ${config.handoff === 'auto' ? '其他会话持锁时直接请求交接' : '其他会话持锁时先弹窗确认'}` },
      { id: 'source', label: `微信消息标识与排版：${enabled(config.messageSourceTag?.enabled !== false)} · 消息加来源标记，回复按微信风格` },
      { id: 'prompt', label: '回复模板：查看 / 导出 / 重载 · 约束 AI 回复微信的格式' },
      { id: 'advanced', label: '高级设置…' },
      { id: 'close', label: '关闭' },
    ]
    const selection = await ctx.ui.select(`微信${advanced ? '高级' : ''}设置（选择后保存；Esc 返回）`, entries.map(entry => entry.label))
    const id = entries.find(entry => entry.label === selection)?.id
    if (!id || id === 'close') {
      if (advanced) { advanced = false; continue }
      return
    }
    if (id === 'advanced' || id === 'back') { advanced = id === 'advanced'; continue }
    if (id === 'ack-text' || id === 'image-ack-text') {
      const current = receiptText(config, id === 'image-ack-text')
      const value = await ctx.ui.input('收件回执内容（留空恢复默认；Esc 取消）', current)
      if (value !== undefined) await deps.apply(`${id} ${value}`)
      continue
    }
    if (id === 'prompt') {
      const actions = ['查看当前模板及路径', '导出默认模板（不覆盖已有文件）', '重载已编辑的模板']
      const action = await ctx.ui.select('微信回复模板', actions)
      const index = actions.indexOf(action ?? '')
      if (index >= 0) await deps.prompt(['show', 'init', 'reload'][index])
      continue
    }
    if (id === 'image-wait' || id === 'image-max') {
      const wait = id === 'image-wait'
      const presets = wait ? [
        { label: '不等待（0 毫秒）', value: 0 },
        { label: '2 秒（较快）', value: 2000 },
        { label: '8 秒（默认，便于连续发图）', value: 8000 },
        { label: '15 秒（预留更多发图时间）', value: 15000 },
      ] : [
        { label: '10 MB（较小图片）', value: 10 },
        { label: '20 MB', value: 20 },
        { label: '50 MB（默认）', value: 50 },
      ]
      const current = wait ? deps.imageWait() : deps.imageMax() / 1024 / 1024
      const choice = await ctx.ui.select(
        `${wait ? '连发图片合并等待' : '单张图片下载上限'}：当前 ${current} ${wait ? '毫秒' : 'MB'}`,
        [...presets.map(preset => preset.label), '自定义…'],
      )
      const preset = presets.find(item => item.label === choice)
      if (preset) await deps.apply(`${id} ${preset.value}`)
      else if (choice === '自定义…') {
        const value = await ctx.ui.input(wait
          ? '连发图片合并等待（毫秒，0–60000；0 表示不等待，默认 8000）'
          : '单张图片下载上限（MB，至少 1；默认 50）', String(current))
        if (value !== undefined) await deps.apply(`${id} ${value.trim()}`)
      }
      continue
    }
    const descriptions: Record<string, string> = {
      ack: '收件回执通知：收到文字或图片时发送确认；关闭不影响 AI 回复、文件保存结果和错误提示',
      bidirectional: '双向同步：把电脑端的输入和 AI 回复转发给微信；关闭后只有微信发起的任务回复才发回微信',
      'auto-start': '自动启动微信桥接：打开 pi 会话时尝试连接微信；其他会话持锁且支持交接时，按「持锁接管方式」询问或直接交接',
      handoff: '持锁接管方式：询问 = 遇到其他会话持锁时弹窗确认；自动 = 直接请求旧会话交接，不再询问（仅对支持协作交接的 0.4.4+ 会话生效；无界面模式始终不自动接管）',
      source: '微信消息标识与排版：微信消息加来源标记（默认 [微信]），引导 AI 用短段落和文字提问，并拦截已配置的本机提问工具',
      'remote-tools': '允许微信端 /tools 命令修改本机工具权限，默认关闭',
    }
    if (id === 'handoff') {
      const choices = ['询问（默认，先确认再接管）', '自动接管（不再询问）']
      const choice = await ctx.ui.select(descriptions.handoff, choices)
      if (choice === choices[0]) await deps.apply('handoff ask')
      else if (choice === choices[1]) await deps.apply('handoff auto')
      continue
    }
    const choice = await ctx.ui.select(descriptions[id], ['开启', '关闭'])
    if (choice === '开启' || choice === '关闭') await deps.apply(`${id} ${choice === '开启' ? 'on' : 'off'}`)
  }
}
