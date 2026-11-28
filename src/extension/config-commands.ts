import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent'
import { loadConfig, saveConfig } from '../bridge/config.js'
import { resolveConfig, parseImageSetting } from '../bridge/config-values.js'
import { formatError } from '../shared/utils.js'
import { showConfigMenu } from './config-menu.js'
import { completionSummarySetting } from './completion-summary.js'
import type { BridgeRuntime, Ctx } from './runtime.js'

export async function cmdConfig(args: string, ctx: ExtensionCommandContext, rt: BridgeRuntime): Promise<void> {
  try { await applyConfigCommand(args, ctx, rt) }
  catch (error) { rt.notify('配置未保存: ' + formatError(error), 'error') }
}

async function applyConfigCommand(args: string, ctx: ExtensionCommandContext, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  const [key, value] = args.trim().split(/\s+/)
  const config = { ...await loadConfig() }
  const resolved = resolveConfig(config)
  if (!key && ctx.hasUI) {
    await showConfigMenu(ctx, {
      apply: value => cmdConfig(value, ctx, rt),
      prompt: action => cmdPrompt(action, ctx, rt),
    })
    return
  }
  if (!key || key === 'show') {
    rt.notify([
      `收件回执通知: ${resolved.sendAck ? '已开启（默认）' : '已关闭'}`,
      `文字回执: ${resolved.ackText}`,
      `图片回执: ${resolved.imageBatchAckText}`,
      `自动启动: ${resolved.autoStart ? '已开启' : '已关闭'}`,
      `持锁接管: ${resolved.handoff === 'auto' ? '自动（直接请求交接）' : '询问（默认）'}`,
      `双向同步: ${resolved.bidirectionalSync ? '已开启' : '已关闭（默认）'}`,
      '完成摘要: ' + completionSummarySetting(resolved.completionSummary),
      `微信 /tools: ${resolved.allowRemoteTools ? '已开启' : '已关闭（/wechat remotetools on 开启）'}`,
      `微信来源与回复约定: ${resolved.sourceEnabled ? '已开启（默认）' : '已关闭'}`,
      `来源标识: ${resolved.wechatTag}`,
      `图片合并等待: ${resolved.imageBatchWaitMs}ms`,
      `图片上限: ${Math.round(resolved.imageMaxBytes / 1024 / 1024)}MB`,
      '', '用法:', '/wechat config ack on|off', '/wechat config ack-text [内容，留空恢复默认]', '/wechat config image-ack-text [内容，留空恢复默认]', '/wechat config source on|off', '/wechat config bidirectional on|off', '/wechat config summary on|off', '/wechat config handoff ask|auto', '/wechat config image-wait 8000', '/wechat config image-max 50',
    ].join('\n'), 'info')
    return
  }
  if (key === 'ack') {
    if (value !== 'on' && value !== 'off') { rt.notify('用法: /wechat config ack on|off', 'error'); return }
    config.sendAck = value === 'on'
    await saveConfig(config)
    rt.notify(`收件回执通知已${config.sendAck ? '开启' : '关闭'}`, 'info')
    return
  }
  if (key === 'ack-text' || key === 'image-ack-text') {
    const text = args.trim().slice(key.length).trim()
    const field = key === 'ack-text' ? 'ackText' : 'imageBatchAckText'
    if (text) config[field] = text
    else delete config[field]
    await saveConfig(config)
    rt.notify(text ? '回执内容已保存' : '回执内容已恢复默认', 'info')
    return
  }
  if (key === 'summary') {
    if (value !== 'on' && value !== 'off') { rt.notify('用法: /wechat config summary on|off', 'error'); return }
    config.completionSummary = value === 'on'
    await saveConfig(config)
    rt.notify('完成摘要' + completionSummarySetting(config.completionSummary) + '。下一轮请求生效。', 'info')
    return
  }
  if (key === 'source') {
    if (value !== 'on' && value !== 'off') { rt.notify('用法: /wechat config source on|off', 'error'); return }
    if (!ctx.isIdle()) {
      rt.notify('等待当前任务结束后更新微信来源与系统回复规则…', 'info')
      await ctx.waitForIdle()
    }
    if (value === 'on') {
      try { await rt.wechatPrompt.load() } catch (error) {
        rt.notify('无法加载微信模板: ' + formatError(error), 'error')
        return
      }
    }
    config.messageSourceTag = { ...config.messageSourceTag, enabled: value === 'on' }
    await saveConfig(config)
    rt.notify('微信来源与回复约定已' + (value === 'on' ? '开启（默认）' : '关闭') + '，系统规则从下一次任务启动起更新；新微信消息仅附来源标识。', 'info')
    return
  }
  if (key === 'bidirectional') {
    if (value !== 'on' && value !== 'off') { rt.notify('用法: /wechat config bidirectional on|off', 'error'); return }
    config.bidirectionalSync = value === 'on'
    await saveConfig(config)
    rt.updateStatusBar()
    rt.notify(`双向同步已${config.bidirectionalSync ? '开启' : '关闭'}`, 'info')
    return
  }
  if (key === 'auto-start' || key === 'remote-tools') {
    if (value !== 'on' && value !== 'off') { rt.notify(`用法: /wechat config ${key} on|off`, 'error'); return }
    if (key === 'auto-start') config.autoStart = value === 'on'
    else config.allowRemoteTools = value === 'on'
    await saveConfig(config)
    if (key === 'remote-tools') {
      rt.notify(`微信端修改工具权限已${value === 'on' ? '开启' : '关闭'}。`, 'info')
      return
    }
    const summary = `新会话自动启动已${value === 'on' ? '开启' : '关闭'}，不改变当前桥接状态。`
    if (value === 'off' || config.handoff === 'auto') { rt.notify(summary, 'info'); return }
    if (!ctx.hasUI) {
      rt.notify(`${summary}\n提示: 可将持锁接管方式设为自动，避免每次打开会话都要确认：/wechat config handoff auto`, 'info')
      return
    }
    const auto = '改为自动接管（推荐）'
    rt.notify(summary, 'info')
    const pick = await ctx.ui.select('遇到其他会话持有微信桥接时如何处理？', [auto, '保持每次询问（当前）'])
    if (pick === auto) {
      config.handoff = 'auto'
      await saveConfig(config)
      rt.notify('持锁接管方式已设为自动：支持协作交接的会话持锁时会直接请求交接，不再弹窗。', 'info')
    }
    return
  }
  if (key === 'handoff') {
    if (value !== 'ask' && value !== 'auto') { rt.notify('用法: /wechat config handoff ask|auto', 'error'); return }
    config.handoff = value
    await saveConfig(config)
    rt.notify(value === 'auto'
      ? '持锁接管方式已设为自动：自动启动或 /wechat start 遇到支持协作交接的会话持锁时直接请求交接，不再弹窗。'
      : '持锁接管方式已设为询问：遇到其他会话持锁时弹窗确认。', 'info')
    return
  }
  if (key !== 'image-wait' && key !== 'image-max') {
    rt.notify('未知配置项。支持: ack, ack-text, image-ack-text, source, bidirectional, summary, auto-start, handoff, remote-tools, image-wait, image-max', 'error')
    return
  }
  const parsed = parseImageSetting(key, value)
  if (parsed === undefined) {
    rt.notify(key === 'image-wait' ? '图片合并等待须为 0–60000 毫秒。' : '图片下载上限须至少为 1 MB，且不能超过安全数值范围。', 'error')
    return
  }
  if (key === 'image-wait') config.imageBatchWaitMs = parsed
  else config.imageMaxBytes = parsed
  await saveConfig(config)
  rt.notify('微信桥接配置已更新 ✅', 'info')
}

export async function cmdAutostart(_args: string, ctx: Ctx, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  const config = { ...await loadConfig() }
  config.autoStart = !resolveConfig(config).autoStart
  await saveConfig(config)
  rt.notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
}

export async function cmdRemoteTools(args: string, ctx: Ctx, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  const config = { ...await loadConfig() }
  const arg = args.trim().toLowerCase()
  if (arg === 'on' || arg === 'off') {
    config.allowRemoteTools = arg === 'on'
  } else if (arg === '') {
    config.allowRemoteTools = !resolveConfig(config).allowRemoteTools
  } else {
    rt.notify('用法: /wechat remotetools on|off（无参数则切换）', 'error')
    return
  }
  await saveConfig(config)
  rt.notify(`微信端 /tools 已${config.allowRemoteTools ? '开启 ✅（注意：微信消息将可修改本机工具权限）' : '关闭 ❌'}`, 'info')
}

export async function cmdPrompt(args: string, ctx: ExtensionCommandContext, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  try {
    if (args === 'init') {
      await rt.wechatPrompt.init()
      rt.notify('已创建微信回复模板: ' + rt.wechatPrompt.userPath + '\n编辑后执行 /wechat prompt reload。', 'info')
    } else if (args === 'reload') {
      if (!ctx.isIdle()) {
        rt.notify('等待当前任务结束后重新加载微信系统回复规则…', 'info')
        await ctx.waitForIdle()
      }
      await rt.wechatPrompt.load()
      rt.notify('微信模板已重新加载，下一次任务启动时更新系统规则；历史用户消息不变。', 'info')
    } else if (!args || args === 'show') {
      if (!rt.running || rt.wechatPrompt.rules === null) await rt.wechatPrompt.load()
      rt.notify('模板来源: ' + rt.wechatPrompt.source + '\n用户模板路径: ' + rt.wechatPrompt.userPath
        + '\n\n' + (rt.wechatPrompt.rules ?? ''), 'info')
    } else {
      rt.notify('用法: /wechat prompt show|init|reload', 'warning')
    }
  } catch (error) {
    rt.notify('微信模板操作失败: ' + formatError(error), 'error')
  }
}
