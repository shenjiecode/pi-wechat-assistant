# 维护指南

本指南面向维护者与准备发版的贡献者。环境准备见[贡献指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md)。

## 自动检查

| 命令 | 内容 |
| --- | --- |
| `npm run check` | 类型检查、架构边界（`check:architecture`）、单元/集成测试、文档链接（`check:docs`）与 npm 发布文件列表（`check:package`） |
| `npm run test:e2e` | 近真机端到端测试：14 个端到端用例（12 个全链路真机场景 + 2 个双进程 OS 交接）。除 Fake iLink/CDN 与 Fake LLM 服务器外零 mock，运行真实 Pi SDK |
| `npm run typecheck:pi` | 针对 Pi 1.2.0、1.4.0 的发布声明检查 API 兼容性；开发基线 Pi 1.6.0 由 `npm run typecheck` 覆盖 |
| `npm run audit:production` | 生产依赖已知漏洞审计，high/critical 直接失败 |
| `npm audit` | 完整开发依赖树审计 |

本地完整流程：

```bash
npm ci
npm run check
npm run test:e2e
npm run typecheck:pi
npm run audit:production
```

CI 在 Linux/Windows、Node 20.19.0/22/24 上运行主检查，另有 Node 20.3.0 最小运行时冒烟任务（Node >= 22.19 才能运行 Pi SDK 集成与 E2E 测试）。`CI success` 聚合任务要求整个矩阵、最小运行时与生产审计全部成功。

`npm run test:e2e` 覆盖以下功能场景：扫码登录与凭据复用、文本往返与模型错误通知、真实 `ret=-2` 暂存补发（含重启后恰好一次重放）、AES 加密图片解密与批量、文件收发、回执开关与自定义回执、桌面同步开关、停止/重连与游标恢复、旧配置升级、远程 `/new`、完成摘要，以及双进程协作交接（Auto/Ask 模式）与 outbox 接管。所有场景通过真实 HTTP/SSE 与 Pi SDK 运行。

## 发版前最小真机冒烟

功能场景已由 `npm run test:e2e` 自动覆盖，常规发版只需记录提交、扩展版本、Pi 版本、Node 版本与日期，并执行：

1. **文本往返**：微信发一条任务，收到 AI 回复。
2. **图片往返**：仅在发大版本或排查 iLink 上游变化时执行——微信发一张图片，确认模型正常处理。

## 本地模拟拒收

等待真实 `ret=-2` 不可控时，用仓库自带的辅助脚本触发同一条代码路径（不会改动真实凭证，已排除出 npm 包）。先停掉旧桥接并退出 Pi，再从仓库根目录运行（不要同时加载 `index.ts`）：

```bash
pi --no-extensions -e ./scripts/test-pending-reply.ts
```

1. 在 Pi 中执行 `/wechat start`，然后 `/wechat-test-reject`。
2. 从微信发送「只回复：补发测试53」。只有完全匹配的出站测试回复会被模拟一次 `ret=-2`，其他请求不受影响。
3. 等待「回复已暂存」与「待补发:1」，手机端此时不应收到测试结果；从微信发送 `/status`。
4. 预期依次收到「【补发】」、「补发测试53」以及待补发为零的状态；再次 `/status` 不应重复。
5. 验证重启恢复：第 3 步保存后退出，重新打开辅助脚本并启动桥接，再从微信发 `/status`。重启后不要再武装新的拒收。

拦截默认关闭，须在任务开始前武装；`/wechat-test-reject off` 取消未使用的武装，关闭桥接或更换会话也会清除。模拟在选中的那次发送后自动解除。

## 调试日志

启动 Pi 前设置 `PI_WECHAT_DEBUG=1` 开启调试日志。日志只记录事件类型、长度、计数、来源与错误码，不含消息预览、账号 ID、附件对象、文件名或完整错误文本；新增日志调用点只能传诊断元数据。日志约 1 MiB 轮换出一份 `.1` 备份，单条消息截断到 1000 字符。

交接排障时在两端分别开启并使用独立输出文件。原因码含义：

- `HANDOFF_UNSUPPORTED`：持有方未声明协作交接支持——升级并重启持有方，或先在那里 `/wechat stop`。
- `HANDOFF_NON_INTERACTIVE`：当前模式无法自动接管。
- `LOCK_CONFLICT`：获取锁时归属已被占用。
- `HANDOFF_OWNER_CHANGED` / `HANDOFF_LOCK_UNKNOWN` / `HANDOFF_TIMEOUT`：归属变更、锁状态不确定与超时。

PowerShell（输出到项目本地文件）：

```powershell
$env:PI_WECHAT_DEBUG = '1'
$env:PI_WECHAT_DEBUG_FILE = Join-Path (Get-Location) 'debug.log'
pi
Remove-Item Env:PI_WECHAT_DEBUG
Remove-Item Env:PI_WECHAT_DEBUG_FILE
```

bash：

```bash
PI_WECHAT_DEBUG=1 PI_WECHAT_DEBUG_FILE="$PWD/debug.log" pi
```

分享日志前先检查内容，只分享脱敏后的相关片段。

## 依赖与 CI

Dependabot 每周把 npm 与 GitHub Actions 的版本更新合并为一个指向 `develop` 的 PR（最多同时存在一个）；忽略主版本升级（需维护者显式决定），minor/patch 正常参与。无自动合并，合并前人工确认行为与 CI。安全告警与更新是独立的仓库设置，与此分组互不影响。

审计失败时，检查受影响的依赖路径、公告与修复版本，更新锁文件并重跑检查。锁文件的开发基线为 Pi `1.6.0`；宿主升级后用 `npm ls undici` 确认版本，运行两项审计并检查 Pi API 兼容性。用户自行更新自己的 Pi 安装。兼容样本在 `scripts/check-pi-compat.mjs` 中维护，宿主 API 变化时补充对应版本。

## 发布与回滚

分支流程见[贡献指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md)：评审分支 → `develop` → `main` → 显式版本 tag。tag 触发发布 workflow：校验提交属于 `main` 且 tag 与包版本一致，运行检查，发布 npm 并从 changelog 创建 GitHub Release；普通推送不发布。已发布 tag 不可变，后续修复使用新版本。

出现回归时，用[升级指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md)选择已知版本回退，保留用户偏好与自定义模板。
