# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [0.6.4] - 2026-10-29

### English

- Explain why bridge startup or cooperative handoff is refused, distinguish ownership changes and timeouts, show waiting progress every five seconds, and retain the previous session's release and elapsed time in the final startup notification so Pi TUI does not immediately overwrite them. Keep cancellation and drain-before-release safeguards; a timeout does not leave a background retry running.
- Fix WeChat image replies and subsequent queue progress when Pi 1.4.0 resizes, re-encodes, or omits images (issue #37). Associate the starting message with its fully matched, observed input before normalization; keep source validation and exact matching for busy follow-ups, without rewriting history.
- Add sanitized startup, handoff, and shutdown diagnostics. Remove message previews, account identifiers, raw attachment fields, private paths, and full error text from debug call sites; preserve safe nested network error codes. Rotate debug logs at approximately 1 MiB with one backup. Existing logs are not retroactively sanitized.
- Add architecture-boundary and runtime-cycle checks, a complete CI aggregate, weekly dependency-update configuration, and Pi 1.4.0 API compatibility coverage alongside seven older versions.
- Refresh development tooling and override the development Pi host's vulnerable `undici` dependency to `8.12.3`. Production dependencies are unchanged; this override does not patch a user's separately installed Pi host.
- Add bilingual quick-start, upgrade, hands-on, and maintenance guides, plus discoverable contribution, security, and support entry points.
- This release improves diagnostics for issue #33; its original startup failure is not yet conclusively diagnosed. The separate command-completion PR #34 is not included.

### 中文

- 明确桥接启动与协作交接被拒绝的原因，区分持锁方变化和超时，每 5 秒显示等待进度；在最终启动提示中保留旧会话已释放及等待耗时，避免被 Pi TUI 立即覆盖。保留取消及收发排空后释放锁的保护，超时不会留下后台重试。
- 修复 Pi 1.4.0 缩放、重新编码或丢弃图片后，微信回复无法回传、后续消息停滞的问题（issue #37）；在规范化前通过完整输入匹配关联本轮启动消息，保留来源校验和忙碌追加消息的精确匹配，不改写历史。
- 增加脱敏的启动、交接和停止诊断；调试调用点不再记录消息预览、账号标识、原始附件字段、私人路径或完整错误文本，保留安全的嵌套网络错误码。日志约 1 MiB 时轮转并保留一个备份，旧日志不会自动清洗。
- 增加架构边界与运行时循环检查、完整 CI 汇总、每周依赖更新配置；在原有七个版本之外增加 Pi 1.4.0 API 兼容检查。
- 更新开发工具，将开发用 Pi 宿主中存在已知漏洞的 `undici` 覆盖到 `8.12.3`；生产依赖不变，这项覆盖不会修补用户单独安装的 Pi 宿主。
- 补充中英文快速上手、升级、实操和维护指南，以及便于发现的贡献、安全与求助入口。
- 本版改善 issue #33 的诊断，尚未最终查明其原始启动失败原因；独立的命令补全 PR #34 不包含在本版中。

## [0.6.3] - 2026-10-20

### English

- Separate configuration persistence and value resolution, transport state, configuration commands, and sending tools into focused modules. Preserve existing configuration paths, fields, defaults, environment fallbacks, and legacy exports; no configuration migration is required.
- Fix legacy `/wechat autostart` and `/wechat remotetools` commands changing cached settings when saving fails.
- Add regression coverage for configuration round trips, unknown fields, failed saves, transport-state isolation, and sending-tool lifecycle guards; update the architecture guides.
- Expand Linux/Windows CI to Node.js 20.19.0, 22, and 24, with a separate Node.js 20.3.0 runtime smoke check. Clarify that the selected Pi host may require a newer Node.js version.
- Welcome issues and PRs in any language without requiring translations, and document the private vulnerability-reporting channel.

### 中文

- 将配置持久化与取值、传输状态、配置命令和发送工具拆为独立模块；保留原配置路径、字段、默认值、环境变量回退及旧导出，无需迁移配置。
- 修复旧 `/wechat autostart`、`/wechat remotetools` 命令保存失败时修改缓存配置的问题。
- 补充配置往返、未知字段、保存失败、传输状态隔离及发送工具生命周期守卫的回归测试，同步架构文档。
- Linux/Windows CI 扩展到 Node.js 20.19.0、22、24，并单独检查 Node.js 20.3.0 运行时冒烟场景；说明所选 Pi 宿主可能要求更高的 Node.js 版本。
- 允许使用任何语言提交 issue 和 PR，无需翻译，并明确私密漏洞报告入口。

## [0.6.2] - 2026-10-20

### English

- Fix receipt notifications ignoring `sendAck: false` (issue #21). Text and image-batch receipts can now be enabled or disabled from the settings menu or `/wechat config ack on|off`.
- Support separate custom text and image receipt messages through the settings menu, commands, or JSON configuration, with a reset to built-in defaults. AI replies, file-save results, and errors remain unaffected.

### 中文

- 修复收件回执忽略 `sendAck: false` 的问题（issue #21）；可在设置窗口或通过 `/wechat config ack on|off` 开关文字和图片批处理回执。
- 支持通过设置窗口、命令或 JSON 分别自定义文字和图片回执，并恢复内置默认文案；不影响 AI 回复、文件保存结果和错误提示。

## [0.6.1] - 2026-10-15

### English

- Organize source and tests by responsibility while preserving the public extension entry and runtime behavior.
- Split English and Chinese documentation into separate files, add contribution and architecture guides, and fix navigation links when guides are displayed outside their source directory.
- Add documentation-link and package-content checks, Linux/Windows CI, and issue/PR templates.
- Document the develop/main workflow and version tags; require release commits to belong to main before publishing.

### 中文

- 按职责整理源码与测试，保持扩展公开入口和运行行为不变。
- 拆分中英文说明文档，补充贡献指南与架构说明，修复文档在其他入口展示时的导航链接。
- 增加文档链接和发布包内容检查、Linux/Windows CI，以及 issue/PR 模板。
- 明确 develop/main 开发流程和版本标签约定，发布前验证提交已合入 main。

## [0.6.0] - 2026-10-14

### Changed
- Bidirectional sync now defaults to off: WeChat still receives replies to WeChat-initiated tasks, but desktop input and AI replies are no longer mirrored unless enabled with `/wechat config bidirectional on` or in the settings menu. Existing configs that saved an explicit value keep it.
  双向同步默认改为关闭：微信任务回复仍回传微信，电脑端输入和 AI 回复不再自动镜像；可通过 `/wechat config bidirectional on` 或设置菜单开启。已保存过显式取值的配置不受影响。

## [0.5.2] - 2026-10-14

### Added
- `handoff: ask | auto` (default ask, issue #17): with Auto, TUI starts hand off directly to a cooperative-handoff owner (0.4.4+) instead of showing the takeover dialog. Selectable in the settings menu next to auto-start, and enabling auto-start offers to switch it to Auto.
  `handoff: ask | auto`（默认 ask，issue #17）：设为自动时，TUI 启动对支持协作交接（0.4.4+）的持锁方直接请求交接，不再弹窗；设置菜单中与自动启动相邻，开启自动启动时会引导改设为自动。
## [0.5.1] - 2026-10-14

### Fixed
- TUI auto-start now offers the same takeover dialog as `/wechat start` when another session holds the bridge; headless modes keep the plain lock diagnostic.
  TUI 自动启动遇到其他会话持锁时，改为弹出与 `/wechat start` 相同的接管确认；无界面模式保持原有锁占用提示。

## [0.5.0] - 2026-10-14

### Added
- Open interactive common/advanced settings with `/wechat config`, using host dialogs compatible with both Pi package generations. Keep `/wechat config show` and parameterized commands for text-only use. Include reply-template actions without starting the bridge.
  `/wechat config` 使用兼容新旧 Pi 包的宿主窗口打开常用及高级设置；保留 `/wechat config show` 和带参数命令，提供回复模板操作，打开窗口不会启动桥接。
- Document defaults, scope, and which settings belong in the UI versus files. Add explicit `config auto-start on|off` and `config remote-tools on|off` commands.
  梳理默认值、生效范围及适合窗口或文件的配置项，增加显式的 `config auto-start on|off` 和 `config remote-tools on|off` 命令。

- Show short explanations beside settings and offer image presets plus guided custom input; cancelling either step leaves settings unchanged.
  配置列表直接显示简短用途；图片配置提供常用预设及带填写提示的自定义入口，取消任一步骤均不修改配置。

### Fixed
- Allow zero image batching delay and reject out-of-range numeric settings. Preserve previous configuration when a menu save fails.
  允许图片合并等待设为零，拒绝超出范围的数值；窗口保存失败时保留原配置。

### Changed
- Simplify the README into Chinese and English pages with language links; add the project logo, cover image, and Pi gallery image metadata. Update the package description.
  README 精简为可切换的中英文页面，加入项目 logo、主图和 Pi 扩展展示图配置，更新包描述。
- Explain settings by their effects, with current values, presets, and guided custom input. The maintainer has verified the settings changes.
  设置说明改为直接解释操作效果，显示当前值、常用预设及自定义填写提示；维护者已验证设置改动。

## [0.4.4] - 2026-10-14

### Added
- Cooperative bridge handoff: after local startup checks, `/wechat start` can ask a protocol-capable owner to stop, wait for its poller, in-flight sends, and state writes to finish, and acquire the released lock exclusively. Legacy owners require manual `/wechat stop`; timeout, cancellation, or changed ownership never forces takeover.
  协作交接桥接：`/wechat start` 先完成本地启动检查，再请求支持交接协议的旧会话停止，等待其轮询、进行中的发送和状态写入结束后排他获取锁；旧版需手动 `/wechat stop`，超时、取消或归属变化时不会强行接管。
- `/wechat login` automatically attempts to start the bridge after successful login; startup failures are reported separately from login success.
  `/wechat login` 登录成功后自动尝试启动桥接，启动失败与登录成功分别报告。

### Fixed
- Serialize lock creation, stale-lock cleanup, and release. Give each bridge start a unique instance ID and reload receive state after acquiring ownership. Stop accepting messages before draining the previous poller; do not cancel the local AI task.
  串行处理锁创建、失效锁清理和释放；每次启动分配唯一实例 ID，获取锁后重新读取接收状态；停止接收后等待旧轮询退出，不取消本机 AI 任务。

### Validation
- Passed 206 automated tests and API compatibility checks against seven Pi versions (0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0, and 1.2.0). Two-session handoff was also verified by the maintainer on Linux.
  通过 206 项自动化测试及七个 Pi 版本（0.73.1、0.78.0、0.84.0、0.84.4、0.99.2、1.1.0、1.2.0）的 API 兼容检查；维护者已在 Linux 验证双会话交接。

## [0.4.3] - 2026-10-14

### Fixed
- Share bridge-lock diagnostics across start, status, and sending guards (PR #13). Report other-process ownership without claiming polling health; keep unreadable locks and permission failures distinct from exited processes. Correct the stop command to `/wechat stop`.
  启动、状态查询及发送守卫共用桥接锁诊断（PR #13）；指出其他进程持锁而不误称轮询正常，区分不可读锁、权限错误与已退出进程，并修正停止命令为 `/wechat stop`。
- Register sending tools only on start; hide them and clear their prompt hints on stop, with active-tool cleanup and execution guards for older Pi. Restart restores availability without duplicate definitions.
  仅启动时注册发送工具；停止时隐藏工具并清除其提示词说明，旧版 Pi 通过活动工具清理及执行守卫兜底；重启恢复可用性且不重复注册条目。
- Add a transient stopped-tool notice to model context after stopping; remove it on restart without persisting it in session history or changing the system prompt.
  停止后在模型上下文中临时说明发送工具不可用，重启时移除；不写入会话历史、不改变系统提示词。

### Thanks
- Thanks to [@Nike163](https://github.com/Nike163) for the cross-process diagnostic proposal in [PR #13](https://github.com/shenjiecode/pi-wechat-assistant/pull/13). This release covers the request through the main-branch implementation and extends it to start/status diagnostics.
  感谢 [@Nike163](https://github.com/Nike163) 在 [PR #13](https://github.com/shenjiecode/pi-wechat-assistant/pull/13) 中提出跨进程诊断方案；本版通过主分支实现覆盖该需求，并扩展到启动与状态查询。

## [0.4.2] - 2026-10-13

### Fixed
- Forward structured model errors and missing model/auth startup configuration to WeChat (#11). Preserve routing through retries and avoid historical-error and duplicate notifications.
  将结构化模型错误及缺少模型/认证配置的启动错误通知微信（#11），重试期间保留来源，避免历史错误和重复通知。
- Use three compatibility modes: boundary-capable Pi confirms failure after settlement; 0.84.x conservatively reports a previous failed request; older Pi reports one failed attempt that may retry. Fix first-request cancellation false positives on boundary-capable hosts. Validated with 162 tests, seven published Pi API versions, and user-confirmed Linux testing.
  按三档兼容处理：支持结束前边界的 Pi 在结束后确认失败，0.84.x 保守提示此前一次请求失败，更旧版本提示本次失败且可能重试；修复支持边界的宿主首次任务取消误报。通过 162 项测试、七个已发布 Pi 版本的 API 检查及用户 Linux 验证。
- Explain persistent WeChat `ret=-2` rejections with a one-time warning and a `/wechat status` hint suggesting fresh activity from WeChat.
  微信持续以 `ret=-2` 拒绝发送时，通过一次性警告及 `/wechat status` 提示先从微信发送一条消息。

### Changed
- Use a bracketed Unicode footer with a text WeChat label, removing the Nerd Font requirement.
  状态栏改为带方括号的 Unicode 与微信文字标签，不再依赖 Nerd Font。

### Thanks
- Thanks to [@Duducoco](https://github.com/Duducoco) for proposing error notifications in [PR #9](https://github.com/shenjiecode/pi-wechat-assistant/pull/9). This release covers the request through the main-branch implementation with version-aware cancellation and retry handling.
  感谢 [@Duducoco](https://github.com/Duducoco) 在 [PR #9](https://github.com/shenjiecode/pi-wechat-assistant/pull/9) 中提出错误通知方案；本版通过主分支实现覆盖该需求，并补齐不同版本的取消与重试处理。

## [0.4.1] - 2026-10-13

### Fixed
- Include image counts in mirrored TUI input, including image-only messages, when bidirectional sync is enabled.
  双向同步开启时，电脑端输入的微信副本显示图片数量，并覆盖纯图片消息。

### Thanks
- Thanks to [@koudle](https://github.com/koudle) for the bidirectional-sync contribution in [PR #10](https://github.com/shenjiecode/pi-wechat-assistant/pull/10), including the image-count notice. This release completes coverage of that request with the main-branch implementation.
  感谢 [@koudle](https://github.com/koudle) 在 [PR #10](https://github.com/shenjiecode/pi-wechat-assistant/pull/10) 中贡献双向同步方案及图片数量提示；本版通过主分支的实现补齐了该需求。

## [0.4.0] - 2026-10-13

### Added
- Bidirectional TUI/WeChat sync by default, with a configurable switch and online/offline notifications.
  默认启用 TUI/微信双向同步，提供配置开关及上下线通知。
- Optional `[微信]` source marker and user-editable reply template, sharing one switch (on by default), with guards for known local question tools (#16).
  可选微信来源标识与可编辑回复模板共用一个开关（默认开启），并守卫已知本机提问工具（#16）。
- `/wechat config source on|off` and `/wechat prompt show|init|reload`; published Pi API checks for 0.73.1 through 1.2.0.
  新增来源开关、模板查看/导出/重载命令，以及 pi 0.73.1 至 1.2.0 的已发布 API 检查。

### Changed
- Unframed compact footer with a green WeChat logo (white fallback), a two-way sync arrow, and green/red running/stopped icons; keep routine diagnostics in `/wechat status` and refresh sync indicators immediately.
  底部去掉方括号，精简为微信绿图标（白色降级）、双向同步箭头和绿/红启停图标；常规诊断留在 `/wechat status`，切换同步立即刷新。
- Reply rules live in one fixed conditional system-prompt section appended to every run while the bridge runs; the section applies them only to requests that start with the WeChat marker, and WeChat user messages carry only the source marker.
  回复规则放在固定的条件化系统提示词段中，桥接运行期间每次任务都追加；规则仅作用于以微信标识开头的请求，微信用户消息仅携带来源标识。
- `/wechat status` now reports the latest online/offline state-notification results, and failed lifecycle notifications surface a warning without blocking start/stop.
  `/wechat status` 新增上/下线状态通知结果，启停状态通知失败时给出警告且不阻断启停。
- WeChat formatting retains link URLs, converts tables to labelled rows, and sends lossless code chunks with Unicode-safe boundaries.
  微信排版保留完整 URL、将表格转为逐行说明，并支持保留原文的代码分块与 Unicode 安全切分。

### Fixed
- Declare host-provided TypeBox as an optional peer dependency to remove Pi startup warnings (#12, #15; thanks Omega-L).
  将宿主提供的 TypeBox 声明为可选 peer dependency，消除 Pi 启动警告（#12、#15；感谢 Omega-L）。
- Restore the bound recipient without waiting for an inbound message, and retry rejected-context sends once without the context token.
  无需等待微信先发消息即可恢复绑定接收方，上下文凭据被拒绝时尝试一次不携带该凭据的发送。
- Notifications no longer print to stdout while the TUI is attached (debug output painted notify text over the editor); debug logging stays in the debug file.
  修复 TUI 模式下通知同时打印到 stdout、把文字绘制进输入框区域的问题；调试日志仅写入调试文件。
- Send WeChat text verbatim instead of trimming it, preserving code-chunk indentation and trailing newlines.
  发送微信文本不再整体 trim，保留代码块的缩进和末尾换行。
- Track consumed WeChat follow-ups within an active run and preserve file notes while downloads or earlier submissions are pending.
  修复同一次运行中微信追加消息的来源路由，以及下载或先前投递未完成时文件说明丢失的问题。

## [0.3.1] - 2026-09-04

### Security
- 仅接受扫码凭证绑定用户的微信消息，其他用户不会缓存上下文、进入队列或触发 Agent（感谢 JOM）
- 微信端 `/tools` 默认禁用，只能从本机 TUI 显式开启
- 状态目录和状态文件权限分别收紧为 `700` 和 `600`

### Fixed
- 持久化长轮询游标和近期消息 ID，防止重启后重复处理历史消息（感谢 midmirror）
- 移除 `agent_end` 历史回复补发，防止恢复会话后重复发送全部旧回复（感谢 midmirror）
- 强制重新登录或退出时清理旧凭证对应的游标、去重和上下文状态

### Changed
- CI 和发布工作流升级 GitHub Actions 运行时，并改用 `npm ci`

## [0.3.0] - 2026-06-11

### Added
- 单元测试（vitest，47 用例）：`utils`、`message`、`queue` 模块
- 进程退出清理：`SIGINT`/`SIGTERM`/`beforeExit` 自动释放锁 + 落盘 context tokens
- 图片预下载并发控制（`Semaphore`，上限 3 并发）
- CI 增加测试检查（`npm test`）

### Changed
- **Breaking**: `MessageQueue` drain 防重入保护（`_draining` 标志位）
- **Breaking**: `CommandDeps.loadClient` / `lock` / `unlock` 接口改为 async
- **Breaking**: `WeixinClient` 构造函数不再执行 I/O，改用 `WeixinClient.create()` 静态工厂
- 全部文件 I/O 从同步改为 `fs.promises` 异步
- sendFile/sendImage 重复代码提取为 `sendMedia()` 通用方法
- AI 工具守卫逻辑提取为 `guardSendToWechat()` / `guardFileSize()`
- Context token 持久化从立即写入改为 5 秒节流写入（退出时立即落盘）
- 散落的 turn 状态变量封装为 `TurnContext` 类
- 语音无转写消息改为友好提示文案

### Fixed
- `queue.drain()` 中 `setTimeout(0)` 堆叠问题（改用 `setImmediate` + 防重入）
- `tsconfig.json` `rootDir` 修正，`include` 包含根 `index.ts`

## [0.2.1] - 2026-06-10

### Changed
- 重构项目结构：所有源码移至 `src/` 目录
- 模块化拆分：`index.ts`（1378 行）拆分为 8 个职责清晰的模块
- 优化 CI：新增 typecheck 持续集成，发布流程支持 OIDC Trusted Publishing
- 新增 `preversion` hook：发版前自动 typecheck

## [0.2.0] - 2026-06-03

### Added
- 文件消息支持（下载、解密、保存到项目目录）
- 远程命令 `/name`、`/session`
- `send_file_to_wechat` / `send_image_to_wechat` AI 工具
- TUI 输入 → 微信双向同步（预览 + 图片注释）
- 增量回复发送（`message_end` 即发，不等 `agent_end`）
- 图片/文件批处理：连续发送多张图片或多文件时合并处理
- 调试日志（`PI_WECHAT_DEBUG=1`）

### Changed
- 微信时间戳从 system prompt 移至 user message 前缀

## [0.1.3] - 2026-05-30

### Added
- 远程命令：`/model`、`/thinking`、`/tools`、`/compact`、`/stop`、`/status`、`/help`
- 图片支持（下载、AES 解密、发送给模型分析）
- 消息队列 + 合并排队
- 排他锁（同一时间只有一个 TUI session 连接微信）
- 状态栏显示微信连接状态
- 扫码登录（QR code + 轮询）

## [0.1.0] - 2026-05-30

### Added
- 初始版本：微信 iLink Bot 桥接
- 文字消息双向同步
- 语音消息支持（使用微信语音转文字）
