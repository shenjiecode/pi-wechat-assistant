# 微信来源与回复约定

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.md) | 简体中文

## 发送工具与桥接归属

`send_file_to_wechat` 和 `send_image_to_wechat` 仅在桥接运行时注册，包括配置的自动启动。其他进程持锁导致启动失败时，不注册工具。停止时移出活动工具集、清除工具提示词说明，并保留为无法激活、也无法经 codemode 调用的 `hidden` 定义；重新启动桥接即恢复两个工具。

这里控制的是当前工具可用性，不能清除模型记忆：已经发出的模型请求或已完成的发送无法撤回，模型停止后尝试调用记住的工具名会被拒绝，不发送消息。

`/wechat start` 和 `/wechat status` 会说明共享桥接锁的归属。其他存活进程持锁且支持协作交接时，交互式 `/wechat start` 会请求确认，最多等待 30 秒让旧桥接停止并释放锁；超时或归属不明时不强行接管。

## 来源标记与路由

来源标识、微信回复模板和提问工具守卫共用一个开关，**默认开启**：

```text
/wechat config source on
/wechat config source off
```

开启后，每个投递的微信消息批次以 `[微信]` 开头，随后仅附带用户原文。文字、语音转写、引用回复、图片描述及已保存文件的信息统一处理，合并后的批次只加一次标记。单独收到文件时仍只保存并回执，不触发 AI 任务。

桥接根据自己的投递记录，在 Pi 真正消费消息时判断来源。在电脑端手工输入来源标记，或仅有 `input.source === "extension"`，都不会被认作微信消息。开关关闭及任务运行中追加消息时，来源路由仍然有效。使用 `/wechat config bidirectional off` 时，电脑端回复不转发，微信任务回复继续正常返回。

双向同步开启时，电脑端输入的微信副本会附带图片数量，纯图片输入也会发送提示。提示在 Pi 实际消费消息时发送，不自动向微信转发图片内容。

## 修改回复模板

内置模板位于 [`prompts/wechat.md`](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/prompts/wechat.md)。用户覆盖文件为 `~/.pi/agent/wechat-assistant/wechat-prompt.md`，Windows 通常是 `C:\Users\<用户名>\.pi\agent\wechat-assistant\wechat-prompt.md`。

```text
/wechat prompt show
/wechat prompt init
/wechat prompt reload
```

`show` 查看当前加载的模板及路径；`init` 导出默认模板，不覆盖已有文件。编辑后执行 `reload`，下一次任务启动时使用新规则（命令会等待当前任务结束）。已经投递的消息和历史消息保持原样。加载失败时保留之前的有效模板；删除覆盖文件并重新加载即可恢复内置模板。

模板要求短段落、简单编号，并通过微信正文提问。规则只适用于当前微信请求及其回复，之后其他来源的输入按正常 Pi 方式处理。

## 系统提示词和缓存

桥接运行且来源功能开启（默认）时，每次任务都会在系统提示词末尾追加同一段固定的 `<wechat-system-rules>`，不区分本次输入来自微信还是电脑端。该段明确规则是条件性的：仅当最新用户请求由桥接投递并以来源标记开头时才套用。用户消息只携带来源标记和原文，历史不会被改写。

由于微信/电脑端交替输入时该段完全一致，切换输入源不会重写系统提示词。启动和停止桥接会改变工具集（见上），切换来源开关或重载模板会改变系统规则——两者都可能影响后续任务的提示词缓存。切换来源开关或重载模板会等待当前任务结束，进行中的回复保持原规则。

## 本机提问工具

功能开启且当前请求经桥接确认来自微信时，`tool_call` 会阻止官方示例中的 `question` 和 `questionnaire` 工具，要求模型改在回复正文里提问。电脑端请求不受影响。

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

`wechatTag` 可省略，默认 `[微信]`；`blockedTools` 可省略，默认包含两个官方示例名称，设为 `[]` 可以关闭守卫。其他会打开本机界面的工具需要明确添加名称。直接修改 `config.json` 后重启 pi；TUI 来源开关在下一次任务启动时更新系统规则。

## 微信排版

只转换发往微信的副本，Pi 会话保留原始 Markdown。链接保留名称与完整 URL；标题和强调转成普通文字；表格转成逐行说明。代码单独发送，标注语言和块序号，保留缩进、空行和特殊字符，优先按行切分。去掉每块首行标签后，直接拼接代码正文即可还原；超长单行按 Unicode 字素边界切分。

普通消息以 800 个 UTF-16 代码单元为分段目标，完整 URL 或单个字素超过目标时保留整体。特别长的代码或报告也可以用 `send_file_to_wechat` 发送文件。

## Pi 兼容性

扩展以 Pi >= 1.2.0（`@earendil-works/pi-coding-agent`）为基线；`npm run typecheck:pi` 针对 Pi 1.2.0 与 1.4.0 的发布 API 检查类型，开发宿主（1.6.x）由 `npm run typecheck` 覆盖。每次投递显式指定 `deliverAs: "followUp"`。对于启动任务的图片，桥接会把此前观察到的完整输入（包括原始图片字节）一次性匹配到本轮第一条用户消息，因此 Pi 1.4+ 对图片的缩放、重新编码、添加提示或丢弃无效图片都不影响来源路由——历史不会被改写，匹配也不依赖标记或纯文字。

参考：[pi 1.2.0 扩展约定](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)、[工具可见性契约](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts)。
