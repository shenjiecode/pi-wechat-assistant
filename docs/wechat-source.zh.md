# 微信来源与回复约定

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.md) | 简体中文

## 发送工具与桥接归属

`send_file_to_wechat` 和 `send_image_to_wechat` 仅在桥接启动时注册，包括配置的自动启动。其他进程持锁导致启动失败时，不注册工具。停止时移出活动工具集、清除工具提示词说明，并在支持的宿主中设为 `hidden`，使其无法被重新激活或经 codemode 调用。旧版通过活动工具移除、下一任务开始前清理及调用/执行守卫兜底；重新启动恢复两个工具。

这里控制的是当前工具可用性，不能清除模型记忆：历史对话和工具记录仍保留，已经发出的模型请求或已完成的发送也不能撤回。旧版 TUI 工具选择器可能仍列出已注册但未激活的定义；模型停止后尝试调用记住的工具名会被拒绝，不发送消息。

桥接启动过再停止后，`context` 事件会为每次模型请求临时添加一条“发送工具不可用”的说明，不写入会话历史或系统提示词，也不触发新任务。再次启动会从后续模型上下文中移除这条说明；从未启动过的扩展不添加说明。重复处理上下文时替换旧说明，不累积多条。

`/wechat start` 和 `/wechat status` 会说明共享桥接锁的归属。其他存活进程持锁且支持交接（0.4.4+）时，交互式 `/wechat start` 会请求确认，最多等待 30 秒让旧桥接停止并释放锁。旧版需在原会话执行 `/wechat stop`；超时或归属不明时不强行接管。PID 存活只说明持锁进程存在，不证明它正在正常轮询。未发现锁或确认原进程退出时允许启动；锁内容损坏、不可读、权限不足或无法探测时保持“无法确认”，不自动覆盖。这项诊断不提供跨进程消息转发。

已针对 Pi 0.73.1、0.78.0、0.84.0、0.84.4、0.99.2、1.1.0、1.2.0、1.4.0 的发布 API 检查兼容性。参见[旧版动态工具示例](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/examples/extensions/dynamic-tools.ts)和[新版工具可见性契约](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts)。

来源标识、微信回复模板和提问工具守卫共用一个开关，**默认开启**：

```text
/wechat config source on
/wechat config source off
```

开启后，每个新投递的微信消息批次以 `[微信]` 开头，随后仅附带用户原文。文字、语音转写、引用回复、图片描述及已保存文件的信息统一处理，合并后的批次只加一次。单独收到文件时仍只保存并回执，不触发 AI。

桥接根据自己的投递记录，在 pi 真正消费消息时判断来源。TUI 手工输入来源标识，或仅有 `input.source === "extension"`，都不会自动被认作微信消息。开关关闭及任务运行中追加消息时，来源路由仍然有效。使用 `/wechat config bidirectional off` 时，电脑端回复不转发，微信任务回复继续正常返回。

双向同步开启时，电脑端输入的微信副本会附带图片数量；纯图片输入也会发送提示。提示在 Pi 实际消费消息时发送，不自动向微信转发图片内容。

## 修改回复模板

内置模板位于 [`prompts/wechat.md`](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/prompts/wechat.md)。用户覆盖文件为 `~/.pi/agent/wechat-assistant/wechat-prompt.md`，Windows 通常是 `C:\Users\<用户名>\.pi\agent\wechat-assistant\wechat-prompt.md`。

```text
/wechat prompt show
/wechat prompt init
/wechat prompt reload
```

`show` 查看当前加载的模板及路径；`init` 导出默认模板，不覆盖已有文件。编辑后执行 `reload`，下一次任务启动时使用新规则（命令会等待当前任务结束）。已经投递的消息、pi 内部排队的追加消息及历史消息保持原样。加载失败时保留之前的有效模板；删除覆盖文件并重新加载即可恢复内置模板。

模板要求短段落、简单编号，并通过微信正文提问。规则只适用于当前微信请求及其回复，之后的电脑端或其他来源输入按正常 pi 方式处理。

## 系统提示词和缓存

桥接运行且来源功能开启（默认）时，每次任务都会在系统提示词末尾追加同一段固定的 `<wechat-system-rules>`，不区分本次输入来自微信还是电脑端。该段明确规则是条件性的：仅当最新用户请求由桥接投递并以来源标识开头时才套用。用户消息只携带来源标识和原文，历史不会被改写。

由于微信/电脑端交替输入时该段完全一致，切换输入源不会重写系统提示词。切换来源开关或重载模板只影响之后的任务（两条命令都会等待当前任务结束），进行中的回复保持原规则。启动和停止桥接仍会改变工具集（见下）并可能影响提示词缓存。切换来源功能开关或重载模板也可能因系统规则变化而影响缓存；单纯切换输入来源不会。

仅安装但不启动桥接，不注册微信发送工具。启动时注册并激活文件/图片工具，停止时移出活动工具集。因此，启动和停止会改变工具集，可能影响提示词缓存；切换来源开关或输入渠道不改变工具集。

## 本机提问工具

功能开启且当前请求经桥接确认来自微信时，`tool_call` 会阻止官方示例中的 `question` 和 `questionnaire` 工具，要求模型改在回复正文里提问。电脑端请求不受影响。支持嵌套工具执行的 pi 版本也会对这类调用应用守卫，包括通过 codemode 发起的调用。

使用其他提问工具时，在 `config.json` 中加入准确的注册名称：

```json
{
  "messageSourceTag": {
    "enabled": true,
    "wechatTag": "[微信]",
    "blockedTools": ["question", "questionnaire", "ask_user"]
  }
}
```

`wechatTag` 可省略，默认 `[微信]`；`blockedTools` 可省略，默认包含两个官方示例名称，设为 `[]` 可以关闭守卫。其他会打开本机界面的工具需要明确添加名称，模板无法自动识别所有第三方阻塞工具。直接修改 `config.json` 后重启 pi；TUI 来源开关在下一次任务启动时更新系统规则，并等待当前任务结束。

## 微信排版

只转换发往微信的副本，pi 会话保留原始 Markdown。链接保留名称与完整 URL；标题和强调转成普通文字；表格转成逐行说明。代码单独发送，标注语言和块序号，保留缩进、空行和特殊字符，优先按行切分。去掉每块首行标签后，直接拼接代码正文即可还原；超长单行按 Unicode 字素边界切分。

普通消息以 800 个 UTF-16 代码单元为分段目标，完整 URL 或单个字素超过目标时保留整体。特别长的代码或报告也可以用 `send_file_to_wechat` 发送文件。

## 兼容验证

`npm run typecheck:pi` 针对 pi **0.73.1、0.78.0、0.84.0、0.84.4、0.99.2、1.1.0、1.2.0、1.4.0** 的已发布 API 检查类型。脚本校验下载包完整性，缓存放在项目的 `node_modules/.cache`，不替换本地依赖。`npm test` 覆盖新旧启动事件形式、工具启停、来源路由、忙碌时追加消息、模板重载、混合媒体和格式转换。自动检查不连接真实微信账号或模型服务。

实现使用稳定的 `sendUserMessage`、`input`、消息生命周期、`tool_call` 和活动工具接口；每次投递显式指定 `deliverAs: "followUp"`。观察到 `before_agent_start` 准备阶段时暂缓投递，在 `agent_start` 和消息消费时继续处理队列。对于启动任务的图片，若 `before_agent_start` 提供 `prompt` 和 `images`，会用完整内容（包括原始图片字节）匹配此前观察到的输入，并将该记录一次性关联到本轮第一条用户消息。因此 Pi 1.4.0 缩放、重新编码、添加提示或丢弃无效图片后，来源仍正确；不改写历史，不凭标识或纯文字匹配认定来源。交互式、RPC 和未匹配桥接投递的扩展输入仍不是微信消息。忙碌时追加的消息及不提供准备阶段元数据的宿主保留完整内容精确匹配；自定义消息启动、任务结束和桥接重置都会清除准备阶段关联。仅使用公开生命周期事件，不使用宿主私有 API 或系统提示词分区。

参考：[pi 1.2.0 扩展约定](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)、[pi 1.2.0 启动并发变化](https://github.com/earendil-works/pi/releases/tag/v1.2.0)、[pi 0.73.1 动态工具示例](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/examples/extensions/dynamic-tools.ts)。
