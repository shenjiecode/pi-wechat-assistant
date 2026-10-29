# WeChat source and reply rules

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.zh.md)

## Sending tools and bridge ownership

`send_file_to_wechat` and `send_image_to_wechat` are registered only when the bridge starts (including configured autostart). A failed start due to another process holding the lock does not register them. Stopping removes both from the active tool set, clears their prompt hints, and replaces their definitions with `hidden` exposure on hosts that support it. On these hosts hidden tools cannot be activated or reached through codemode. Older hosts use active-tool removal, cleanup before the next run, and call/execution guards. Restart restores the two tools.

This controls current tool availability, not model memory: earlier conversation/tool records remain, and an already-issued provider request or completed send cannot be recalled. Legacy TUI tool selectors may still list registered, inactive definitions. A model attempting a remembered tool name while stopped receives a refusal; no message is sent.

After a started bridge stops, the `context` hook adds one temporary “sending tools unavailable” notice to each model request. It does not write to session history or the system prompt and does not trigger a turn. Restart removes this notice from subsequent model contexts; an extension that has never started adds no notice. Repeated context processing replaces the notice instead of accumulating copies.

`/wechat start` and `/wechat status` report the owner of the shared bridge lock. If another live process holds it and supports handoff (0.4.4+), interactive `/wechat start` offers confirmation and waits up to 30 seconds for it to stop and release the lock. Older owners require `/wechat stop` in their session. Timeout or uncertain ownership never forces takeover. The PID probe proves only that the lock owner exists, not that it is polling successfully. Missing locks and confirmed exited processes permit starting; malformed/unreadable locks and permission/probe failures remain uncertain and are not overwritten automatically. These diagnostics do not provide cross-process message forwarding.

Verified against published Pi APIs 0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0, 1.2.0, and 1.4.0. See the [legacy dynamic-tool example](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/examples/extensions/dynamic-tools.ts) and [modern tool exposure contract](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts).

The source marker, reply template, and question-tool guard share one switch, **on by default**:

```text
/wechat config source on
/wechat config source off
```

When enabled, each submitted WeChat batch starts with `[微信]`, followed by the original input only. Text, voice transcripts, quoted replies, image descriptions, and saved-file notes use the same path. A merged batch carries one marker. Files received without accompanying text or images are saved and acknowledged without starting an AI task.

The bridge identifies its own submitted messages when Pi consumes them. A marker typed in TUI, or `input.source === "extension"` alone, does not establish WeChat origin. This routing also works with the switch off and for follow-ups received during an existing run. With `/wechat config bidirectional off`, TUI replies stay local and WeChat task replies still return to WeChat.

With bidirectional sync enabled, mirrored TUI messages include an image count. Image-only input is also announced. These notices are sent when Pi consumes the message; image data is not automatically forwarded to WeChat.

## Edit the reply template

The packaged default is [`prompts/wechat.md`](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/prompts/wechat.md). The optional user override is `~/.pi/agent/wechat-assistant/wechat-prompt.md` (normally `C:\Users\<user>\.pi\agent\wechat-assistant\wechat-prompt.md` on Windows).

```text
/wechat prompt show
/wechat prompt init
/wechat prompt reload
```

`show` displays the loaded template and its path. `init` exports the default and refuses to overwrite an existing file. Edit that file, then run `reload`; the next agent run uses the updated rules (the command waits for the current task to finish). Already submitted messages, queued Pi follow-ups, and history retain their original text. A failed reload preserves the last valid template. Removing the override and reloading restores the packaged default.

The rules ask for short paragraphs, numbered choices, and questions answered through WeChat. They apply only to the current WeChat request and its replies; later inputs from TUI or another source follow normal Pi behavior.

## System prompts and cache behavior

While the bridge runs with the source feature on (the default), every agent run appends one fixed `<wechat-system-rules>` section to the system prompt, regardless of whether the input came from WeChat or the TUI. The section states that the WeChat rules are conditional: they apply only when the latest user request was delivered by the bridge and starts with the source marker. User messages carry only the marker and the original input; history is never rewritten.

Because the section is identical for WeChat and TUI turns, alternating input sources does not rewrite the system prompt. Toggling the source feature or reloading the template changes only future runs — both commands wait for the current task to finish — so a running reply keeps its original rules. Starting and stopping the bridge still changes the tool set (see below) and can affect prompt caching. Toggling the source feature or reloading its template can also affect caching by changing the system rules; alternating input sources alone does not.

## Local question tools

When this feature is enabled for a confirmed WeChat request, `tool_call` blocks the official `question` and `questionnaire` example tools and asks the model to put its question in the reply text. Normal TUI requests remain unaffected. Pi versions supporting nested tool execution also apply this guard to those calls, including calls through codemode.

For other question tools, list their exact registered names in `config.json`:

```json
{
  "messageSourceTag": {
    "enabled": true,
    "wechatTag": "[微信]",
    "blockedTools": ["question", "questionnaire", "ask_user"]
  }
}
```

`wechatTag` is optional; `[微信]` is the default. Omitting `blockedTools` uses the two official example names; `[]` disables the guard. Other tools that open local UI need their names added explicitly. The template can guide the model but cannot automatically identify every third-party blocking UI tool. Restart Pi after directly editing `config.json`; the TUI source switch updates the system rules for the next run and waits for the current task to finish.

## WeChat text formatting

Only the outgoing WeChat copy is formatted; the Pi transcript retains the original Markdown. Links retain their labels and complete URLs. Headings and emphasis become plain text; tables become labelled rows. Fenced code is sent separately with its language and chunk order, preserving indentation, blank lines, and special characters. Code chunks prefer line boundaries and can be reassembled by removing each chunk's first label line and concatenating the bodies. Long single lines are split at Unicode grapheme boundaries.

Text targets 800 UTF-16 code units per message. An indivisible URL or grapheme may exceed that target to preserve it. Large code/report files can also be sent with `send_file_to_wechat`.

## Compatibility validation

`npm run typecheck:pi` checks the published APIs for Pi **0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0, 1.2.0, and 1.4.0**. It downloads integrity-checked declarations into the project's `node_modules/.cache`, without replacing installed dependencies. `npm test` exercises legacy/new startup event forms, tool activation, source routing, follow-ups, template reloads, mixed media, and formatting. These automated checks do not connect to a real WeChat account or model provider.

The implementation uses stable `sendUserMessage`, `input`, message lifecycle, `tool_call`, and active-tool APIs. Every submission explicitly specifies `deliverAs: "followUp"`. It holds submissions during the observed `before_agent_start` phase, then drains at `agent_start` and message consumption. For starting images, the bridge uses `before_agent_start.prompt` and `images` when present to match the complete, previously observed input (including original image bytes), and binds that observation once to the run's first user message. This survives Pi 1.4.0 resizing/re-encoding images, adding hints, or omitting invalid images, without modifying history or trusting a marker/text-only match. Interactive/RPC and unmatched extension inputs remain non-WeChat. Busy follow-ups and hosts without this preparation metadata retain exact content matching; custom starts, run completion, and bridge reset clear the preparation binding. This uses public lifecycle events, not private host APIs or system prompt sections.

References: [Pi 1.2.0 extension contracts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [Pi 1.2.0 startup concurrency changes](https://github.com/earendil-works/pi/releases/tag/v1.2.0), [Pi 0.73.1 dynamic tools](https://github.com/earendil-works/pi/blob/v0.73.1/packages/coding-agent/examples/extensions/dynamic-tools.ts).
