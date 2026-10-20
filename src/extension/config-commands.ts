import type { ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { loadConfig, saveConfig, getConfigCache } from '../bridge/config.js'
import { resolveImageBatchWaitMs, resolveImageMaxBytes, receiptText, parseImageSetting } from '../bridge/config-values.js'
import { formatError } from '../shared/utils.js'
import { WECHAT_SOURCE_TAG } from '../messaging/wechat-source.js'
import type { WechatPrompt } from '../messaging/wechat-prompt.js'
import { showConfigMenu } from './config-menu.js'

type Ctx = ExtensionContext | ExtensionCommandContext
interface ConfigCommandDeps {
  setLatestCtx: (ctx: Ctx) => void
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
  updateStatusBar: () => void
  isRunning: () => boolean
  wechatPrompt: WechatPrompt
}
const getImageBatchWaitMs = () => resolveImageBatchWaitMs(getConfigCache())
const getImageMaxBytes = () => resolveImageMaxBytes(getConfigCache())

export async function cmdConfig(args: string, ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  try { await applyConfigCommand(args, ctx, deps) }
  catch (error) { deps.notify('配置未保存: ' + formatError(error), 'error') }
}

async function applyConfigCommand(args: string, ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const [key, value] = args.trim().split(/\s+/)
  const config = { ...await loadConfig() }
  if (!key && ctx.hasUI) {
    await showConfigMenu(ctx, {
      load: loadConfig,
      apply: value => cmdConfig(value, ctx, deps),
      prompt: action => cmdPrompt(action, ctx, deps),
      imageWait: getImageBatchWaitMs,
      imageMax: getImageMaxBytes,
    })
    return
  }
  if (!key || key === 'show') {
    deps.notify([
      `收件回执通知: ${config.sendAck === false ? '已关闭' : '已开启（默认）'}`,
      `文字回执: ${receiptText(config)}`,
      `图片回执: ${receiptText(config, true)}`,
      `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
      `持锁接管: ${config.handoff === 'auto' ? '自动（直接请求交接）' : '询问（默认）'}`,
      `双向同步: ${config.bidirectionalSync === true ? '已开启' : '已关闭（默认）'}`,
      `微信 /tools: ${config.allowRemoteTools ? '已开启' : '已关闭（/wechat remotetools on 开启）'}`,
      `微信来源与回复约定: ${config.messageSourceTag?.enabled === false ? '已关闭' : '已开启（默认）'}`,
      `来源标识: ${config.messageSourceTag?.wechatTag?.trim() || WECHAT_SOURCE_TAG}`,
      `图片合并等待: ${getImageBatchWaitMs()}ms`,
      `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
      '', '用法:', '/wechat config ack on|off', '/wechat config ack-text [内容，留空恢复默认]', '/wechat config image-ack-text [内容，留空恢复默认]', '/wechat config source on|off', '/wechat config bidirectional on|off', '/wechat config handoff ask|auto', '/wechat config image-wait 8000', '/wechat config image-max 50',
    ].join('\n'), 'info')
    return
  }
  if (key === 'ack') {
    if (value !== 'on' && value !== 'off') { deps.notify('用法: /wechat config ack on|off', 'error'); return }
    config.sendAck = value === 'on'
    await saveConfig(config)
    deps.notify(`收件回执通知已${config.sendAck ? '开启' : '关闭'}`, 'info')
    return
  }
  if (key === 'ack-text' || key === 'image-ack-text') {
    const text = args.trim().slice(key.length).trim()
    const field = key === 'ack-text' ? 'ackText' : 'imageBatchAckText'
    if (text) config[field] = text
    else delete config[field]
    await saveConfig(config)
    deps.notify(text ? '回执内容已保存' : '回执内容已恢复默认', 'info')
    return
  }
  if (key === 'source') {
    if (value !== 'on' && value !== 'off') { deps.notify('用法: /wechat config source on|off', 'error'); return }
    if (!ctx.isIdle()) {
      deps.notify('等待当前任务结束后更新微信来源与系统回复规则…', 'info')
      await ctx.waitForIdle()
    }
    if (value === 'on') {
      try { await deps.wechatPrompt.load() } catch (error) {
        deps.notify('无法加载微信模板: ' + formatError(error), 'error')
        return
      }
    }
    config.messageSourceTag = { ...config.messageSourceTag, enabled: value === 'on' }
    await saveConfig(config)
    deps.notify('微信来源与回复约定已' + (value === 'on' ? '开启（默认）' : '关闭') + '，系统规则从下一次任务启动起更新；新微信消息仅附来源标识。', 'info')
    return
  }
  if (key === 'bidirectional') {
    if (value !== 'on' && value !== 'off') { deps.notify('用法: /wechat config bidirectional on|off', 'error'); return }
    config.bidirectionalSync = value === 'on'
    await saveConfig(config)
    deps.updateStatusBar()
    deps.notify(`双向同步已${config.bidirectionalSync ? '开启' : '关闭'}`, 'info')
    return
  }
  if (key === 'auto-start' || key === 'remote-tools') {
    if (value !== 'on' && value !== 'off') { deps.notify(`用法: /wechat config ${key} on|off`, 'error'); return }
    if (key === 'auto-start') config.autoStart = value === 'on'
    else config.allowRemoteTools = value === 'on'
    await saveConfig(config)
    if (key === 'remote-tools') {
      deps.notify(`微信端修改工具权限已${value === 'on' ? '开启' : '关闭'}。`, 'info')
      return
    }
    const summary = `新会话自动启动已${value === 'on' ? '开启' : '关闭'}，不改变当前桥接状态。`
    // 自动启动 + 每次弹窗确认是典型抱怨组合（issue #17）：开启一次就引导配好接管方式。
    if (value === 'off' || config.handoff === 'auto') { deps.notify(summary, 'info'); return }
    if (!ctx.hasUI) {
      deps.notify(`${summary}\n提示: 可将持锁接管方式设为自动，避免每次打开会话都要确认：/wechat config handoff auto`, 'info')
      return
    }
    const auto = '改为自动接管（推荐）'
    deps.notify(summary, 'info')
    const pick = await ctx.ui.select('遇到其他会话持有微信桥接时如何处理？', [auto, '保持每次询问（当前）'])
    if (pick === auto) {
      config.handoff = 'auto'
      await saveConfig(config)
      deps.notify('持锁接管方式已设为自动：支持协作交接的会话持锁时会直接请求交接，不再弹窗。', 'info')
    }
    return
  }
  if (key === 'handoff') {
    if (value !== 'ask' && value !== 'auto') { deps.notify('用法: /wechat config handoff ask|auto', 'error'); return }
    config.handoff = value
    await saveConfig(config)
    deps.notify(value === 'auto'
      ? '持锁接管方式已设为自动：自动启动或 /wechat start 遇到支持协作交接的会话持锁时直接请求交接，不再弹窗。'
      : '持锁接管方式已设为询问：遇到其他会话持锁时弹窗确认。', 'info')
    return
  }
  if (key !== 'image-wait' && key !== 'image-max') {
    deps.notify('未知配置项。支持: ack, ack-text, image-ack-text, source, bidirectional, auto-start, handoff, remote-tools, image-wait, image-max', 'error')
    return
  }
  const parsed = parseImageSetting(key, value)
  if (parsed === undefined) {
    deps.notify(key === 'image-wait' ? '图片合并等待须为 0–60000 毫秒。' : '图片下载上限须至少为 1 MB，且不能超过安全数值范围。', 'error')
    return
  }
  if (key === 'image-wait') config.imageBatchWaitMs = parsed
  else config.imageMaxBytes = parsed
  await saveConfig(config)
  deps.notify('微信桥接配置已更新 ✅', 'info')
}

export async function cmdAutostart(_args: string, ctx: Ctx, deps: ConfigCommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = { ...await loadConfig() }
  config.autoStart = !config.autoStart
  await saveConfig(config)
  deps.notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
}

export async function cmdRemoteTools(args: string, ctx: Ctx, deps: ConfigCommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = { ...await loadConfig() }
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    config.allowRemoteTools = arg === 'on'
  } else if (arg === '') {
    config.allowRemoteTools = !config.allowRemoteTools
  } else {
    deps.notify('用法: /wechat remotetools on|off（无参数则切换）', 'error')
    return
  }
  await saveConfig(config)
  deps.notify(`微信端 /tools 已${config.allowRemoteTools ? '开启 ✅（注意：微信消息将可修改本机工具权限）' : '关闭 ❌'}`, 'info')
}

export async function cmdPrompt(args: string, ctx: ExtensionCommandContext, deps: ConfigCommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  try {
    if (args === 'init') {
      await deps.wechatPrompt.init()
      deps.notify('已创建微信回复模板: ' + deps.wechatPrompt.userPath + '\n编辑后执行 /wechat prompt reload。', 'info')
    } else if (args === 'reload') {
      if (!ctx.isIdle()) {
        deps.notify('等待当前任务结束后重新加载微信系统回复规则…', 'info')
        await ctx.waitForIdle()
      }
      await deps.wechatPrompt.load()
      deps.notify('微信模板已重新加载，下一次任务启动时更新系统规则；历史用户消息不变。', 'info')
    } else if (!args || args === 'show') {
      if (!deps.isRunning() || deps.wechatPrompt.rules === null) await deps.wechatPrompt.load()
      deps.notify('模板来源: ' + deps.wechatPrompt.source + '\n用户模板路径: ' + deps.wechatPrompt.userPath
        + '\n\n' + (deps.wechatPrompt.rules ?? ''), 'info')
    } else {
      deps.notify('用法: /wechat prompt show|init|reload', 'warning')
    }
  } catch (error) {
    deps.notify('微信模板操作失败: ' + formatError(error), 'error')
  }
}
