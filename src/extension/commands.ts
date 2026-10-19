// ============================================================================
// TUI 命令处理（/wechat login/start/stop/status/...）
// ============================================================================

import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from '@mariozechner/pi-coding-agent'
import { debugLog } from '../shared/logger.js'
import {
  clearCredentials,
  clearContextTokens,
  clearTransportState,
  getCredentialsPath,
  getBridgeLockState,
  getQrCode,
  loadConfig,
  pollQrStatus,
  saveConfig,
  saveCredentials,
  requestHandoff,
} from '../bridge/auth.js'
import { WeixinClient, type ApiCallResult } from '../wechat/client.js'
import { MessageQueue, getImageBatchWaitMs, getImageMaxBytes } from '../bridge/queue.js'
import { renderQrCode, formatError } from '../shared/utils.js'
import { QR_POLL_INTERVAL_MS, QR_MAX_REFRESH, ACK_TEXT, IMAGE_BATCH_ACK_TEXT } from '../shared/constants.js'
import type { WechatPrompt } from '../messaging/wechat-prompt.js'
import { WECHAT_SOURCE_TAG } from '../messaging/wechat-source.js'
import { describeBridgeLock } from '../bridge/bridge-lock.js'
import { showConfigMenu } from './config-menu.js'

type Ctx = ExtensionContext | ExtensionCommandContext

export interface CommandDeps {
  pi: ExtensionAPI
  prepareBridge: () => Promise<void>
  preflightBridge: () => Promise<void>
  wechatPrompt: WechatPrompt
  getClient: () => WeixinClient | null
  setClient: (c: WeixinClient | null) => void
  loadClient: () => Promise<WeixinClient | null>
  isRunning: () => boolean
  setRunning: (v: boolean) => void
  requestHandoff: typeof requestHandoff
  setPollAbort: (c: AbortController | null) => void
  queue: MessageQueue
  lock: () => Promise<{ success: boolean; message: string }>
  stopBridge: (options?: { releaseLock?: boolean }) => Promise<void>
  pollMessages: (client: WeixinClient) => Promise<void>
  latestCtx: () => Ctx | null
  setLatestCtx: (ctx: Ctx) => void
  updateStatusBar: () => void
  notify: (message: string, level: 'info' | 'warning' | 'error') => void
  disposeClient: () => Promise<void>
}

async function cmdLogin(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const force = args.split(/\s+/).includes('--force')
  if (!force) {
    const cached = await deps.loadClient()
    if (cached) {
      deps.notify(`已加载本地微信凭证: ${getCredentialsPath()}`, 'info')
      if (!deps.isRunning()) await startBridge('', ctx, deps)
      return
    }
  }
  if (deps.isRunning()) await deps.stopBridge({ releaseLock: true })

  // 强制重新登录时清除旧身份的会话和长轮询状态。
  if (force) {
    await deps.disposeClient()
    await Promise.all([clearContextTokens(), clearTransportState()])
  }

  let currentBaseUrl: string | undefined

  try {
    const qr = await getQrCode(currentBaseUrl)
    const qrText = await renderQrCode(qr.url)
    deps.notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info')

    let lastStatus: string | null = null
    let refreshCount = 0

    while (true) {
      await new Promise(r => setTimeout(r, QR_POLL_INTERVAL_MS))
      const result = await pollQrStatus(qr.token, currentBaseUrl)

      if (result.redirectHost) {
        currentBaseUrl = `https://${result.redirectHost}`
        debugLog(`重定向到: ${currentBaseUrl}`)
      }

      if (result.status === lastStatus) continue
      lastStatus = result.status

      if (result.status === 'scaned') { deps.notify('已扫码，请在手机上确认登录', 'info'); continue }

      if (result.status === 'confirmed' && result.credentials) {
        await saveCredentials(result.credentials)
        const newClient = await WeixinClient.create(result.credentials)
        deps.setClient(newClient)
        deps.notify('微信登录成功 ✅', 'info')
        deps.updateStatusBar()
        if (!deps.isRunning()) await startBridge('', ctx, deps)
        return
      }

      if (result.status === 'expired') {
        refreshCount++
        if (refreshCount >= QR_MAX_REFRESH) {
          deps.notify(`二维码多次过期，请重新执行 /wechat login`, 'error')
          return
        }
        deps.notify(`二维码已过期，正在刷新 (${refreshCount}/${QR_MAX_REFRESH})...`, 'info')
        const newQr = await getQrCode(currentBaseUrl)
        qr.token = newQr.token
        const newQrText = await renderQrCode(newQr.url)
        deps.notify(`请重新扫码：\n\n${newQrText}\n\n二维码链接：${newQr.url}`, 'info')
        lastStatus = null
      }

      if (result.status === 'scaned_but_redirect') continue
    }
  } catch (error) {
    deps.notify(`微信登录失败: ${formatError(error)}`, 'error')
  }
}

const pendingStarts = new WeakMap<CommandDeps, AbortController>()

export function cancelBridgeStart(deps: CommandDeps): void {
  pendingStarts.get(deps)?.abort()
}

export async function startBridge(_args: string, ctx: Ctx, deps: CommandDeps, interactive = true): Promise<void> {
  deps.setLatestCtx(ctx)
  if (deps.isRunning()) { deps.notify('微信桥接已经在运行', 'info'); return }
  if (pendingStarts.has(deps)) { deps.notify('微信桥接正在启动或等待交接', 'info'); return }
  const attempt = new AbortController()
  pendingStarts.set(deps, attempt)
  const check = () => attempt.signal.throwIfAborted()
  let acquired = false
  try {
    const activeClient = await deps.loadClient()
    if (!activeClient) { deps.notify('未找到微信凭证，请先执行 /wechat login', 'error'); return }
    if (!ctx.isIdle()) {
      if (!('waitForIdle' in ctx)) return
      deps.notify('等待当前任务结束后启动微信桥接…', 'info')
      await ctx.waitForIdle()
    }
    check()
    await deps.preflightBridge()
    check()
    const owner = await getBridgeLockState()
    check()
    if (owner.kind === 'other' || owner.kind === 'current' || owner.kind === 'unknown') {
      if (owner.kind === 'unknown' || owner.protocol !== 1 || !ctx.hasUI || !interactive) {
        deps.notify(describeBridgeLock(owner), 'error')
        return
      }
      const takeover = '请求旧会话停止，等待释放后在本会话启动'
      if ((await loadConfig()).handoff === 'auto') {
        deps.notify(`正在自动请求旧会话（PID ${owner.pid}）停止并释放桥接（最多 30 秒）…`, 'info')
      } else {
        const choice = await ctx.ui.select(`微信桥接由其他 pi 会话持有（PID ${owner.pid}）`, [takeover, '取消'])
        check()
        if (choice !== takeover) { deps.notify('已取消，未改动其他会话的微信桥接。', 'info'); return }
        deps.notify('正在等待旧会话停止并释放桥接（最多 30 秒）…', 'info')
      }
      await deps.requestHandoff(owner, attempt.signal)
      check()
    }
    const result = await deps.lock()
    acquired = result.success
    check()
    if (!result.success) { deps.notify(result.message, 'error'); return }
    // The previous owner may have advanced its cursor while we were waiting.
    await activeClient.reloadReceiveState()
    check()
    await deps.prepareBridge()
    check()
    deps.setRunning(true)
    deps.setPollAbort(new AbortController())
    deps.notify('微信桥接已启动 📱', 'info')
    deps.updateStatusBar()
    void deps.pollMessages(activeClient).catch(error => deps.notify(`微信轮询异常退出: ${formatError(error)}`, 'error'))
  } catch (error) {
    const cancelled = attempt.signal.aborted
    if (acquired) await deps.stopBridge({ releaseLock: true })
    deps.notify(cancelled ? '微信桥接启动已取消。' : '微信桥接启动失败: ' + formatError(error), cancelled ? 'info' : 'error')
  } finally {
    pendingStarts.delete(deps)
  }
}

async function cmdStop(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  deps.notify('微信桥接已停止', 'info')
  deps.updateStatusBar()
}

function describeApiResult(result: ApiCallResult | null | undefined, successLabel: string): string {
  if (!result) return '尚未尝试'
  const detail = result.success ? successLabel
    : `失败: ${result.error}${result.code !== undefined ? ` (code=${result.code})` : ''}`
  return `${detail} @ ${result.at}`
}

async function cmdStatus(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const activeClient = deps.getClient()
  const config = await loadConfig()
  const lines = [
    '微信来源与回复约定: ' + (config.messageSourceTag?.enabled === false ? '已关闭' : '已开启（默认）'),
    '提示词位置: 系统提示词中的固定微信规则（仅作用于当前微信请求）',
    '微信模板: ' + deps.wechatPrompt.source,
    '用户模板路径: ' + deps.wechatPrompt.userPath,
    `运行状态: ${deps.isRunning() ? '✅ 运行中' : '⏸ 已停止'}`,
    `桥接锁: ${describeBridgeLock(await getBridgeLockState())}`,
    `登录凭据: ${activeClient ? '已加载（有效性由接口验证）' : '未加载'}`,
    `消息发送凭据: ${activeClient?.hasContextToken ? '已保存（不代表仍有效）' : '未获取（发送时尝试不携带此凭据）'}`,
    `最近发送: ${describeApiResult(activeClient?.lastSend, 'API 返回成功（不代表已读）')}`,
    ...(activeClient?.lastSend && !activeClient.lastSend.success && activeClient.lastSend.code === -2
      ? ['发送被拒提示: 微信要求新的用户活动，请先从微信发送一条消息，然后重试。']
      : []),
    `上线状态通知: ${describeApiResult(activeClient?.lastLifecycle?.start, 'API 返回成功（不代表客户端已更新）')}`,
    `下线状态通知: ${describeApiResult(activeClient?.lastLifecycle?.stop, 'API 返回成功（不代表客户端已更新）')}`,
    `双向同步: ${config.bidirectionalSync === true ? '开启' : '关闭（仅微信任务回复）'}`,
    `账号 ID: ${activeClient?.accountId ?? '-'}`,
    `用户 ID: ${activeClient?.userId ?? '-'}`,
    `排队消息: ${deps.queue.pending}`,
    `凭证路径: ${getCredentialsPath()}`,
    `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
    `图片合并等待: ${getImageBatchWaitMs()}ms`,
    `图片上限: ${Math.round(getImageMaxBytes() / 1024 / 1024)}MB`,
  ]
  deps.notify(lines.join('\n'), 'info')
}

async function cmdLogout(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  await deps.stopBridge({ releaseLock: true })
  await deps.disposeClient()
  await Promise.all([
    clearCredentials(),
    clearContextTokens(),
    clearTransportState(),
  ])
  deps.setClient(null)
  deps.queue.lastWechatUser = null
  deps.notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info')
  deps.updateStatusBar()
}

async function cmdConfig(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
  try { await applyConfigCommand(args, ctx, deps) }
  catch (error) { deps.notify('配置未保存: ' + formatError(error), 'error') }
}

async function applyConfigCommand(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
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
      `文字回执: ${config.ackText?.trim() || ACK_TEXT}`,
      `图片回执: ${config.imageBatchAckText?.trim() || IMAGE_BATCH_ACK_TEXT}`,
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
  const numeric = Number(value)
  if (!value || !Number.isFinite(numeric)
    || (key === 'image-wait' ? numeric < 0 || numeric > 60_000 : numeric < 1 || !Number.isSafeInteger(Math.round(numeric * 1024 * 1024)))) {
    deps.notify(key === 'image-wait' ? '图片合并等待须为 0–60000 毫秒。' : '图片下载上限须至少为 1 MB，且不能超过安全数值范围。', 'error')
    return
  }
  if (key === 'image-wait') {
    config.imageBatchWaitMs = Math.min(Math.max(Math.round(numeric), 0), 60_000)
  } else if (key === 'image-max') {
    config.imageMaxBytes = Math.round(numeric * 1024 * 1024)
  } else {
    deps.notify('未知配置项。支持: source, bidirectional, image-wait, image-max', 'error')
    return
  }
  await saveConfig(config)
  deps.notify('微信桥接配置已更新 ✅', 'info')
}

async function cmdAutostart(_args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig()
  config.autoStart = !config.autoStart
  await saveConfig(config)
  deps.notify(`自动启动已${config.autoStart ? '开启 ✅' : '关闭 ❌'}`, 'info')
}

async function cmdRemoteTools(args: string, ctx: Ctx, deps: CommandDeps): Promise<void> {
  deps.setLatestCtx(ctx)
  const config = await loadConfig()
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

async function cmdPrompt(args: string, ctx: ExtensionCommandContext, deps: CommandDeps): Promise<void> {
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

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand('wechat', {
    description: '微信桥接管理：login | start | stop | status | prompt | config | logout | autostart | remotetools',
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/)
      const restArgs = rest.join(' ')
      const help = [
        '/wechat login             扫码登录',
        '/wechat login --force     强制重新扫码',
        '/wechat start             启动桥接',
        '/wechat stop              停止桥接',
        '/wechat status            查看状态',
        '/wechat prompt show       查看微信回复模板',
        '/wechat prompt init       创建用户模板（不覆盖已有文件）',
        '/wechat prompt reload     重新加载模板',
        '/wechat config            打开设置窗口',
        '/wechat config show       查看配置文本',
        '/wechat logout            清除凭证并停止',
        '/wechat autostart         开关自动启动',
        '/wechat remotetools       开关微信端 /tools 命令（默认禁用）',
      ].join('\n')
      switch (sub) {
        case 'login': return cmdLogin(restArgs, ctx, deps)
        case 'start': return startBridge(restArgs, ctx, deps)
        case 'stop': return cmdStop(restArgs, ctx, deps)
        case 'status': return cmdStatus(restArgs, ctx, deps)
        case 'prompt': return cmdPrompt(restArgs, ctx, deps)
        case 'config': return cmdConfig(args.trim().slice(sub.length).trim(), ctx, deps)
        case 'logout': return cmdLogout(restArgs, ctx, deps)
        case 'autostart': return cmdAutostart(restArgs, ctx, deps)
        case 'remotetools': return cmdRemoteTools(restArgs, ctx, deps)
        default: deps.notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })
}
