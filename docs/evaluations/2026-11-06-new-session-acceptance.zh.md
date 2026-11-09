# 微信 /new：验证记录与真实账号验收

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/evaluations/2026-11-06-new-session-acceptance.md) | 简体中文

初始记录日期：2026-11-06；发布决定日期：2026-11-09。功能：[PR #49](https://github.com/shenjiecode/pi-wechat-assistant/pull/49)，已评审实现 `e54f170`，包含 #50 引入的开发用 Pi 1.5.0。交付测试的候选为 `codex/release-v0.6.6` 分支上的 `d9cadfb`。

## 维护者验收与发布决定

2026-11-09，维护者在收到供另一台电脑测试的候选版本后，确认已完成真机测试，并明确要求发布新版本。此确认满足维护者对 v0.6.6 的发布门槛。维护者未提供测试设备/环境、实际检出的提交及逐项观察，因此下表标记为未逐项报告，不推断每一项均通过。下方自动化证据和此前本机扫码尝试仍分别记录。最终准备仅更新发布信息和文档，没有改变已交付候选的运行代码。

## 已完成的检查

| 证据 | 结果与范围 |
| --- | --- |
| [GitHub CI 42185776048](https://github.com/shenjiecode/pi-wechat-assistant/actions/runs/42185776048) | `e54f170` 的全部 10 项任务通过，包括 Linux/Windows 矩阵、最低运行版本、生产依赖审计和汇总。 |
| Windows、WSL Ubuntu / Node 24.19.0 | 365 项测试全部通过，源码类型、架构、文档与包清单检查通过。 |
| Node 20.19.0 | 363 项扩展测试通过。开发用 Pi 1.5.0 要求 Node >=22.19.0，因此明确排除两项真实 Pi SDK 测试；支持的 Node 版本仍执行它们。这不代表 Pi 1.5.0 能在 Node 20 运行。 |
| 真实 Pi SDK 会话替换 | 自动启动开/关均通过，覆盖取消、旧历史保留、新上下文为空、继续收发、重复替换和进程监听器数量稳定。微信传输与模型回复均为模拟。 |
| 已发布 Pi API 检查 | 0.73.1、0.78.0、0.84.0、0.84.4、0.99.2、1.1.0、1.2.0、1.4.0 共八个版本通过。它们是声明兼容检查，不是八次真实账号运行。 |
| 完整依赖审计 | 已评审依赖树为零告警。 |

代理于 2026-11-06 进行的本机真实账号尝试**没有完成**：隔离桥接二维码过期，未获取微信凭据，未发送测试消息。桌面微信已经登录，不能证明桥接登录或消息投递成功。维护者停止该尝试后，另行确认真机测试完成，见上方发布决定。SDK 测试或固定模型回复不等于真实微信、真实模型验收。以下操作和清单保留用于复现与后续测试。

## 准备另一台电脑

使用 Node >=22.19.0、候选锁定的 Pi 1.5.0，以及真实模型/供应商账号。使用专用测试系统账户，或没有既有桥接凭据的干净环境。不要复制、覆盖、删除或强制刷新生产凭据；不要同时运行同一微信机器人/账号的另一个接收端。

扩展状态保存在系统用户的 `.pi/agent/wechat-assistant` 下。`-ne`、`-e` 和 `--session-dir` **不会隔离这些凭据**。如果当前账户已有生产桥接状态，请先换专用测试账户。新测试账户可能需要独立配置模型登录/API key；不要把秘密写进命令、截图或结果报告。

在该测试账户的 PowerShell 中运行：

```powershell
git clone --branch codex/release-v0.6.6 --single-branch https://github.com/shenjiecode/pi-wechat-assistant.git C:\codes\projects\pi-wechat-assistant-acceptance
Set-Location C:\codes\projects\pi-wechat-assistant-acceptance
git rev-parse HEAD
node --version
npm ci
.\node_modules\.bin\pi.cmd --version
New-Item -ItemType Directory -Force C:\codes\projects\pi-wechat-acceptance-sessions | Out-Null
.\node_modules\.bin\pi.cmd -ne -e .\index.ts --session-dir C:\codes\projects\pi-wechat-acceptance-sessions
```

这些选项已核对本地 Pi 1.5.0 CLI 文档：`-ne` 禁用自动发现、配置及内置扩展，但显式 `-e` 路径仍加载；`--session-dir` 指定会话存储目录。这样可临时加载候选源码，避免同时加载已安装的另一份扩展。不要添加 `--no-session`，因为本次需要验证历史持久化。通过 Pi 的模型/登录界面选择可用的真实模型，再运行 `/wechat login` 并扫描新二维码。不要对生产登录使用 `--force`。

记录候选 SHA、扩展版本、Pi 版本、Node 版本、系统、模型/供应商（不含秘密）、日期，以及观察来自桌面微信还是手机。仅桌面端成功不等于手机端验收通过。

## 操作与逐项记录

只使用可丢弃的示例文字和文件，保持终端运行。除刻意测试忙碌状态外，每步等待任务结束，并在 `/new` 成功确认后再发送新任务。

| 步骤 | 操作与预期证据 | 结果 |
| --- | --- | --- |
| 基线 | Pi 中设置 `/wechat config auto-start off`，再执行 `/wechat start`。微信发送“验收 OLD-1106：请原样回复这个标记”，收到真实模型回复。发送 `/session`，记录旧 ID，并在专用会话目录定位对应 JSONL 文件。 | 未逐项报告 |
| 关闭自动启动后新建 | 空闲后按下文记录旧会话文件哈希，从微信发送 `/new`。无需再次扫码，收到包含不同 ID 的成功确认。在发送任何新模型提示前，发送 `/session`：用户/助手历史计数应为零。旧文件存在且哈希相同。 | 未逐项报告 |
| 继续收发 | 发送“验收 NEW-1106：请原样回复这个标记”，收到一次最终回复，新会话包含这次交互。新上下文不能包含旧对话；保留系统/项目指令属于预期。仅询问模型“还记不记得”不能证明上下文为空。 | 未逐项报告 |
| 重复替换 | 空闲后再发 `/new`，确认成功后发另一个标记。ID 再次变化，继续收到回复，没有重放历史。 | 未逐项报告 |
| 开启自动启动 | Pi 中设置 `/wechat config auto-start on`；出现交接方式提示时保留所需选择。重复 `/new` 和测试消息，应只有一个有效桥接，回复正常到达。 | 未逐项报告 |
| 忙碌拒绝 | 请真实模型执行一个无副作用、约 15 秒的等待命令。终端明确显示任务运行时，微信发送 `/new`，应明确提示忙碌/有待处理消息，ID 不变。任务结束后 `/new` 成功。若发出时任务已完成，不能算测过忙碌拒绝。 | 未逐项报告 |
| 待处理文件拒绝 | 微信发送一个可丢弃的小文本文件，不附处理指令。收到保存确认后发 `/new`，应拒绝且 ID 不变。补充读取/概述文件的指令，完成后 `/new` 应成功。 | 未逐项报告 |
| 取消与重试 | 在单独测试运行中使用下文的一次性取消辅助扩展。第一次 `/new` 返回已取消，ID 不变且桥接可用；第二次 `/new` 成功。 | 未逐项报告 |
| 停止/重启恢复 | Pi 中执行 `/wechat stop`、`/wechat start`，微信发送新标记并收到回复，不能重放旧消息。若实际遇到创建/重连错误，应记录失败，检查 `/wechat status` 并用 `/wechat start` 恢复；恢复成功不能把原失败项目改写成通过。 | 未逐项报告 |

历史证据：按旧会话 ID 找到准确的 JSONL 文件。基线任务结束、发送 `/new` 之前，在另一个 PowerShell 窗口执行：

```powershell
$oldSessionPath = 'C:\codes\projects\pi-wechat-acceptance-sessions\<实际旧会话文件名>.jsonl'
$oldSessionHash = (Get-FileHash -LiteralPath $oldSessionPath -Algorithm SHA256).Hash
```

`/new` 成功后执行：

```powershell
Test-Path -LiteralPath $oldSessionPath
(Get-FileHash -LiteralPath $oldSessionPath -Algorithm SHA256).Hash -eq $oldSessionHash
```

两个结果都应为 `True`。新会话发送第一条普通提示前记录 `/session` 计数。只检查这些专用测试历史，不要上传私人会话文件。

## 不模拟微信或模型的确定性取消测试

普通 `/new` 不一定弹出取消对话框。为验证宿主取消分支，将以下辅助扩展保存为 `C:\codes\projects\pi-wechat-cancel-once.ts`。它使用已公开的 `session_before_switch` 事件，取消该扩展实例的第一次新建请求：

```typescript
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function cancelOnce(pi: ExtensionAPI) {
  let pending = true
  pi.on('session_before_switch', event => {
    if (event.reason === 'new' && pending) {
      pending = false
      return { cancel: true }
    }
  })
}
```

先干净停止并退出之前的候选 Pi，再在同一候选目录运行：

```powershell
.\node_modules\.bin\pi.cmd -ne -e .\index.ts -e C:\codes\projects\pi-wechat-cancel-once.ts --session-dir C:\codes\projects\pi-wechat-acceptance-sessions
```

执行 `/wechat start`，记录 ID，通过真实微信完成表中的取消/重试项目。会话替换后辅助扩展状态会重置，因此下一次正常启动应去掉它的 `-e` 参数；不要把它放入发布扩展。记录“宿主取消为刻意注入”，微信传输与模型仍必须真实。

## 结束与交接

用 `/wechat stop` 停止测试桥接，再退出 Pi；保持生产状态不变。每行填写**通过 / 失败 / 未执行**、实际观察和脱敏证据，明确跳过的设备及场景，不只记录成功项。附上实测候选 SHA；测试后代码若变化，应判断受影响场景是否需重测。后续发布仍需分别记录维护者验收与自动检查结果。本次 v0.6.6 发布决定见上文。
