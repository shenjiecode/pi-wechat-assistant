# 常见问题与排查

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md) | 简体中文

先在 pi 终端界面运行 `/wechat status`，检查桥接归属、运行状态和最近发送结果，再按下方现象排查。

## 安装后没有 `/wechat` 命令

在系统终端执行 `pi list` 确认配置来源，再在目标项目重新打开 pi。检查启动报错、Node.js 是否满足 Pi 宿主要求，以及 Pi 包配置中是否禁用了扩展。避免同时加载 npm 和 Git 两份。参见[快速上手](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.zh.md)和[升级指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.zh.md)。

## 登录成功，但微信没有回复

1. 确认电脑、pi 会话仍在运行且联网。
2. 在 pi 执行 `/wechat status`；有凭据但桥接已停止时，执行 `/wechat start`。
3. 从绑定的微信账号发一条新文字消息；其他用户的消息不会被接收。
4. 消息进入 pi 却没有 AI 回复时，直接在 pi 提问并检查模型、认证报错；pi 已产生回复但微信收不到时，检查最近发送结果。

保存登录凭据不保证始终可以主动发送。持续遇到 `ret=-2` 时，从微信发一条新消息再重试；反复重装扩展不会刷新对话活跃状态。登录过期时执行 `/wechat login --force` 重新扫码。

## 只收到回执，或收到模型错误

回执表示接收消息，不代表任务完成。检查 pi 终端是否仍在工作，以及模型或供应商报错。不同 Pi 版本的自动重试与错误通知行为有差异，详见[模型错误通知](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/model-errors.zh.md)。关闭收件回执不会关闭 AI 回复或错误提示。

## 提示其他会话持有桥接

同一份本地账号状态同时只能由一个桥接持有。在旧会话执行 `/wechat stop`，再在新会话执行 `/wechat start`；也可按新会话的接管提示操作。协作交接要求双方扩展均为 0.4.4+，更旧的持有方需手动停止。

`/wechat config handoff auto` 可在交互界面中跳过协作交接确认；无界面会话不会自动接管。交接转移的是桥接，不会搬移旧对话历史，也不会取消旧 AI 任务。不要通过手动删除活跃会话的锁文件绕过归属检查。

这个配置同时适用于手动 `/wechat start` 和自动启动，保存配置本身不会立即切换桥接。执行 `/wechat config auto-start on` 时，如果尚未开启自动接管，会引导选择推荐的自动接管；也可在 `/wechat config` →「持锁接管方式」→「自动接管」中设置。验证步骤和 30 秒超时行为见[双会话实操教程](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.zh.md)。目前不支持 `/wechat start!`。

## 电脑上的对话没有同步到微信

从 0.6.0 起默认如此，微信任务仍能收到自己的回复。在 pi 执行 `/wechat config bidirectional on` 可同步新的电脑输入及回复。已有显式设置会保留，历史消息不会重发。

## 如何修改回执或配置？

使用 `/wechat config`，或通过 `/wechat config ack off` 关闭文字、图片收件回执。文字与图片回执可分别自定义，留空恢复默认；文件保存结果及错误提示仍保留。

配置按进程缓存。直接编辑 JSON 或在另一个 pi 进程修改后，需要重新打开受影响的会话，仅停止再启动桥接不够。回复模板编辑后使用 `/wechat prompt reload`。详见[配置说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.zh.md)和[回复规则](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.zh.md)。

## 图片或文件的行为与预期不同

| 现象 | 说明与处理 |
| --- | --- |
| 图片等待一会儿才处理 | 纯图片会合并成批；可补充文字，或在设置中调整 `image-wait`。 |
| 收到文件后没有启动任务 | 纯文件消息只保存并确认，随后再发文字指令。 |
| AI 无法把文件发回来 | 先启动桥接，文件须位于当前项目内且不超过 50 MB。 |
| 图片下载失败 | 检查报错及设置中的下载上限；入站图片限制与出站文件限制相互独立。 |
| 电脑图片只显示数量 | 电脑端镜像不转发图片本体；需要作为模型输入时，从微信发送图片。 |
| 视频无法使用 | 暂不支持视频。 |

## 停止和退出登录有什么区别？

- 微信 `/stop` 请求取消 AI 任务。
- pi `/wechat stop` 停止本会话桥接、阻止新发送，保留登录凭据。
- pi `/wechat logout` 停止桥接并清除本地登录、上下文及游标状态，不重置偏好配置或自定义回复模板。

## 报告问题需要提供什么？

可以使用任何语言提交 [issue](https://github.com/shenjiecode/pi-wechat-assistant/issues)。提供扩展、Pi、Node 版本，操作系统、安装来源、最小复现步骤、预期与实际结果，以及脱敏的 `/wechat status` 输出。`pi --version` 是宿主版本，扩展版本可在安装目录的 `package.json` 中查看。

需要更多细节时，可在启动 pi 前设置 `PI_WECHAT_DEBUG=1` 开启调试。日志默认为 `~/.pi/agent/wechat-assistant/debug.log`，可用 `PI_WECHAT_DEBUG_FILE` 指定路径。日志可能包含消息内容和本地路径，分享前请移除这些内容中的隐私，以及 token、账号标识等敏感信息；排查后关闭调试。漏洞请走[私密报告](https://github.com/shenjiecode/pi-wechat-assistant/security/advisories/new)，不要公开相关日志。

[文档目录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.zh.md)
