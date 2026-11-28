// ============================================================================
// TUI 命令处理（/wechat login/start/stop/status/...）
// ============================================================================

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { BridgeRuntime, Ctx } from './runtime.js'
import { debugLog, debugError, redactUrl } from '../shared/logger.js'
import {
  clearCredentials,
  getCredentialsPath,
  getBridgeLockState,
  getQrCode,
  pollQrStatus,
  saveCredentials,
} from '../bridge/auth.js'
import { WeixinClient, type ApiCallResult } from '../wechat/client.js'
import { renderQrCode, formatError } from '../shared/utils.js'
import { QR_POLL_INTERVAL_MS, QR_MAX_REFRESH } from '../shared/constants.js'
import { describeBridgeLock } from '../bridge/bridge-lock.js'
import { cmdConfig, cmdAutostart, cmdRemoteTools, cmdPrompt } from './config-commands.js'
import { completionSummarySetting } from './completion-summary.js'
import { getWechatArgumentCompletions } from './command-completion.js'
import { resolveConfig } from '../bridge/config-values.js'
import { loadConfig } from '../bridge/config.js'
import { clearContextTokens, clearTransportState } from '../bridge/transport-state.js'

async function cmdLogin(args: string, ctx: Ctx, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  const force = args.split(/\s+/).includes('--force')
  if (!force) {
    const cached = await rt.loadClient()
    if (cached) {
      rt.notify(`已加载本地微信凭证: ${getCredentialsPath()}`, 'info')
      if (!rt.running) await rt.startBridge(ctx)
      return
    }
  }
  if (rt.running) await rt.stopBridge({ releaseLock: true })

  // 强制重新登录时清除旧身份的会话和长轮询状态。
  if (force) {
    await rt.disposeClient()
    await Promise.all([clearContextTokens(), clearTransportState()])
  }

  let currentBaseUrl: string | undefined

  try {
    const qr = await getQrCode(currentBaseUrl)
    const qrText = await renderQrCode(qr.url)
    rt.notify(`请用微信扫码登录：\n\n${qrText}\n\n二维码链接：${qr.url}`, 'info')

    let lastStatus: string | null = null
    let refreshCount = 0

    while (true) {
      await new Promise(r => setTimeout(r, QR_POLL_INTERVAL_MS))
      const result = await pollQrStatus(qr.token, currentBaseUrl)

      if (result.redirectHost) {
        currentBaseUrl = `https://${result.redirectHost}`
        debugLog(`重定向到: ${redactUrl(currentBaseUrl)}`)
      }

      if (result.status === lastStatus) continue
      lastStatus = result.status

      if (result.status === 'scaned') { rt.notify('已扫码，请在手机上确认登录', 'info'); continue }

      if (result.status === 'confirmed' && result.credentials) {
        await saveCredentials(result.credentials)
        const newClient = await WeixinClient.create(result.credentials)
        rt.setClient(newClient)
        rt.notify('微信登录成功 ✅', 'info')
        rt.updateStatusBar()
        if (!rt.running) await rt.startBridge(ctx)
        return
      }

      if (result.status === 'expired') {
        refreshCount++
        if (refreshCount >= QR_MAX_REFRESH) {
          rt.notify(`二维码多次过期，请重新执行 /wechat login`, 'error')
          return
        }
        rt.notify(`二维码已过期，正在刷新 (${refreshCount}/${QR_MAX_REFRESH})...`, 'info')
        const newQr = await getQrCode(currentBaseUrl)
        qr.token = newQr.token
        const newQrText = await renderQrCode(newQr.url)
        rt.notify(`请重新扫码：\n\n${newQrText}\n\n二维码链接：${newQr.url}`, 'info')
        lastStatus = null
      }

      if (result.status === 'scaned_but_redirect') continue
    }
  } catch (error) {
    rt.notify(`微信登录失败: ${formatError(error)}`, 'error')
  }
}

async function cmdStop(_args: string, ctx: Ctx, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  await rt.stopBridge({ releaseLock: true })
  rt.notify('微信桥接已停止', 'info')
  rt.updateStatusBar()
}

function describeApiResult(result: ApiCallResult | null | undefined, successLabel: string): string {
  if (!result) return '尚未尝试'
  const detail = result.success ? successLabel
    : `失败: ${result.error}${result.code !== undefined ? ` (code=${result.code})` : ''}`
  return `${detail} @ ${result.at}`
}

async function cmdStatus(_args: string, ctx: Ctx, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  const client = rt.client
  const config = resolveConfig(await loadConfig())
  const outbox = rt.outboxStatus()
  const lines = [
    '微信来源与回复约定: ' + (config.sourceEnabled ? '已开启（默认）' : '已关闭'),
    '提示词位置: 系统提示词中的固定微信规则（仅作用于当前微信请求）',
    '微信模板: ' + rt.wechatPrompt.source,
    '用户模板路径: ' + rt.wechatPrompt.userPath,
    `运行状态: ${rt.running ? '✅ 运行中' : '⏸ 已停止'}`,
    `桥接锁: ${describeBridgeLock(await getBridgeLockState())}`,
    `登录凭据: ${client ? '已加载（有效性由接口验证）' : '未加载'}`,
    `消息发送凭据: ${client?.hasContextToken ? '已保存（不代表仍有效）' : '未获取（发送时尝试不携带此凭据）'}`,
    `最近发送: ${describeApiResult(client?.lastSend, 'API 返回成功（不代表已读）')}`,
    ...(client?.lastSend && !client.lastSend.success && client.lastSend.code === -2
      ? ['发送被拒提示: 请从微信发送一条新消息，已暂存的文本回复将自动补发；媒体需重新发送。']
      : []),
    `上线状态通知: ${describeApiResult(client?.lastLifecycle?.start, 'API 返回成功（不代表客户端已更新）')}`,
    `下线状态通知: ${describeApiResult(client?.lastLifecycle?.stop, 'API 返回成功（不代表客户端已更新）')}`,
    `双向同步: ${config.bidirectionalSync ? '开启' : '关闭（仅微信任务回复）'}`,
    '完成摘要: ' + completionSummarySetting(config.completionSummary),
    `账号 ID: ${client?.accountId ?? '-'}`,
    `用户 ID: ${client?.userId ?? '-'}`,
    `排队消息: ${rt.queue.pending}`,
    `待补发回复: ${outbox.pending}`,
    `送达待确认: ${outbox.uncertain}（不自动重发，请在 Pi 会话中核对）`,
    `凭证路径: ${getCredentialsPath()}`,
    `自动启动: ${config.autoStart ? '已开启' : '已关闭'}`,
    `持锁接管: ${config.handoff === 'auto' ? '自动（仅交互界面和支持协作交接的旧会话）' : '询问（默认）'}`,
    `图片合并等待: ${config.imageBatchWaitMs}ms`,
    `图片上限: ${Math.round(config.imageMaxBytes / 1024 / 1024)}MB`,
  ]
  rt.notify(lines.join('\n'), 'info')
}

async function cmdLogout(_args: string, ctx: Ctx, rt: BridgeRuntime): Promise<void> {
  rt.latestCtx = ctx
  await rt.stopBridge({ releaseLock: true })
  await rt.disposeClient()
  await Promise.all([
    clearCredentials(),
    clearContextTokens(),
    clearTransportState(),
  ])
  rt.notify(`已清除微信凭证: ${getCredentialsPath()}`, 'info')
  rt.updateStatusBar()
}

export function registerCommands(pi: ExtensionAPI, rt: BridgeRuntime): void {
  pi.registerCommand('wechat', {
    description: '微信桥接管理：login | start | stop | status | prompt | config | logout | autostart | remotetools',
    getArgumentCompletions: getWechatArgumentCompletions,
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
        case 'login': return cmdLogin(restArgs, ctx, rt)
        case 'start': return rt.startBridge(ctx)
        case 'stop': return cmdStop(restArgs, ctx, rt)
        case 'status': return cmdStatus(restArgs, ctx, rt)
        case 'prompt': return cmdPrompt(restArgs, ctx, rt)
        case 'config': return cmdConfig(args.trim().slice(sub.length).trim(), ctx, rt)
        case 'logout': return cmdLogout(restArgs, ctx, rt)
        case 'autostart': return cmdAutostart(restArgs, ctx, rt)
        case 'remotetools': return cmdRemoteTools(restArgs, ctx, rt)
        default: rt.notify(`未知子命令: ${sub || '(无)'}\n\n${help}`, 'warning')
      }
    },
  })
}
