# 模型错误通知

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/model-errors.md) | 简体中文

`/wechat start` 运行期间，失败的模型请求会通知当前回复对象，无需额外开关。`/wechat config bidirectional off` 时只有桥接发起的请求会产生通知；开启同步后包括电脑端请求。来源标记开关不影响错误路由。

扩展要求 Pi >= 1.2.0（`@earendil-works/pi-coding-agent`），并使用两个公共事件：

- `agent_before_settle` 报告本轮是否以模型错误结束；自动重试成功会清除该状态。
- `agent_settled` 确认本轮真正结束——包含自动重试、压缩与继续执行。通知只在结算之后发送，因此「重试后成功」不会产生通知，仅凭 `agent_end` 也不会判定任务停止。

只有 assistant `message_end` 事件中的 `stopReason: "error"` 与 `errorMessage` 才算失败。出现「error」「failed」等普通字样、工具失败、空回复以及历史消息都不是失败信号。每条实际消费的用户请求最多发送一次通知。

取消消息与已取消信号（`agent_settled.aborted`）不会产生失败通知：用户取消不是模型失败。

桥接空闲时，缺少模型/认证配置可能在任何生命周期事件之前就失败。扩展检查公共模型/注册表 API（懒加载认证先行解析）并上报该启动失败，同时把被拒提交移出桥接队列；忙碌中的排队输入不会被抢先判失败。

通知在重试循环中保持来源路由：发送前先认领，传输结果不明确时不重试。部分失败的 assistant 文本不会转发，因为重试可能重复发送。诊断信息会缩短，并移除常见凭证模式与 URL 查询/片段数据。

`npm run typecheck:pi` 针对 Pi 1.2.0 与 1.4.0 的发布声明校验这些事件签名；开发宿主（1.6.x）由 `npm run typecheck` 覆盖。参考：[Pi 扩展 API](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md)、[会话实现](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts)。
