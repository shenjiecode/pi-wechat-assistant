# Model error notifications

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/model-errors.zh.md)

While `/wechat start` is active, failed model requests are reported to the current reply recipient. No extra switch is needed. With `/wechat config bidirectional off`, only bridge-originated requests generate notices; with sync on, TUI requests are included. The source-marker switch does not affect error routing.

The extension requires Pi >= 1.2.0 (`@earendil-works/pi-coding-agent`) and uses two public events:

- `agent_before_settle` reports whether the run ended with a model-error outcome. A successful automatic retry clears it.
- `agent_settled` confirms the run has truly finished — automatic retries, compaction and continuations included. The notice is sent only after settlement, so retry-then-success produces no notice, and `agent_end` alone is never treated as terminal.

Only assistant `message_end` events with `stopReason: "error"` and an `errorMessage` count as failures. Ordinary words such as “error” or “failed”, tool failures, empty responses, and historical messages are not failure signals. At most one notice is sent per consumed user request.

Abort messages and aborted signals (`agent_settled.aborted`) never produce failure notices: user cancellation is not a model failure.

For an idle bridge input, missing model/auth configuration can fail before any lifecycle event. The extension checks public model/registry APIs (with lazy auth resolved first) and reports that startup failure, removing the rejected submission from the bridge queue; busy queued inputs are not preemptively rejected.

Notices keep source routing through retry loops: claimed before sending, not retried after an ambiguous transport failure. Failed partial assistant text is not forwarded, since retries may repeat it. Diagnostics are shortened, with common credential patterns and URL query/fragment data removed.

`npm run typecheck:pi` asserts these event signatures against published Pi 1.2.0 and 1.4.0 declarations; the development host (1.6.x) is covered by `npm run typecheck`. References: [Pi extension API](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [session implementation](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts).
