# WeChat source and reply rules

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.zh.md)

## Sending tools and bridge ownership

`send_file_to_wechat` and `send_image_to_wechat` are registered only while the bridge runs (including configured autostart). A failed start due to another process holding the lock does not register them. Stopping removes both from the active tool set, clears their prompt hints, and keeps them as `hidden` definitions that cannot be activated or reached through codemode; restarting the bridge restores them.

This controls tool availability, not model memory: an already-issued provider request or completed send cannot be recalled, and a model attempting a remembered tool name while stopped receives a refusal with no message sent.

`/wechat start` and `/wechat status` report the owner of the shared bridge lock. If another live process holds it and supports cooperative handoff, interactive `/wechat start` offers confirmation and waits up to 30 seconds for the owner to stop and release the lock. Timeout or uncertain ownership never forces takeover.

## Source marker and routing

The source marker, reply template and question-tool guard share one switch, **on by default**:

```text
/wechat config source on
/wechat config source off
```

When enabled, each submitted WeChat batch starts with `[微信]`, followed by the original input only. Text, voice transcripts, quoted replies, image descriptions, and saved-file notes use the same path. A merged batch carries one marker. Files received without accompanying text or images are saved and acknowledged without starting an AI task.

The bridge identifies its own submitted messages when Pi consumes them. A marker typed in TUI, or `input.source === "extension"` alone, does not establish WeChat origin. This routing also works with the switch off and for follow-ups received during an existing run. With `/wechat config bidirectional off`, TUI replies stay local and WeChat task replies still return to WeChat.

With bidirectional sync enabled, mirrored TUI messages include an image count; image-only input is announced as well. Notices are sent when Pi consumes the message; image data is not forwarded to WeChat.

## Edit the reply template

The packaged default is [`prompts/wechat.md`](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/prompts/wechat.md). The optional user override is `~/.pi/agent/wechat-assistant/wechat-prompt.md` (normally `C:\Users\<user>\.pi\agent\wechat-assistant\wechat-prompt.md` on Windows).

```text
/wechat prompt show
/wechat prompt init
/wechat prompt reload
```

`show` displays the loaded template and its path. `init` exports the default and refuses to overwrite an existing file. Edit that file, then run `reload`; the next agent run uses the updated rules (the command waits for the current task to finish). Already submitted messages and history retain their original text. A failed reload preserves the last valid template; removing the override and reloading restores the packaged default.

The rules ask for short paragraphs, numbered choices, and questions answered through WeChat. They apply only to the current WeChat request and its replies; later inputs from other sources follow normal Pi behavior.

## System prompts and caching

While the bridge runs with the source feature on (the default), every agent run appends one fixed `<wechat-system-rules>` section to the system prompt, regardless of the input source. The section states that the WeChat rules are conditional: they apply only when the latest user request was delivered by the bridge and starts with the source marker. User messages carry only the marker and the original input; history is never rewritten.

Because the section is identical for WeChat and TUI turns, alternating input sources does not rewrite the system prompt. Starting and stopping the bridge changes the tool set (see above), and toggling the source feature or reloading its template changes the system rules — both can affect prompt caching for future runs. Toggling the source feature or reloading the template waits for the current task to finish, so a running reply keeps its original rules.

## Local question tools

When this feature is enabled for a confirmed WeChat request, `tool_call` blocks the official `question` and `questionnaire` example tools and asks the model to put its question in the reply text. Normal TUI requests remain unaffected.

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

`wechatTag` is optional; `[微信]` is the default. Omitting `blockedTools` uses the two official example names; `[]` disables the guard. Tools that open local UI need their names added explicitly. Restart Pi after directly editing `config.json`; the TUI source switch updates the system rules for the next run.

## WeChat text formatting

Only the outgoing WeChat copy is formatted; the Pi transcript retains the original Markdown. Links retain their labels and complete URLs. Headings and emphasis become plain text; tables become labelled rows. Fenced code is sent separately with its language and chunk order, preserving indentation, blank lines, and special characters. Code chunks prefer line boundaries and can be reassembled by removing each chunk's first label line and concatenating the bodies. Long single lines are split at Unicode grapheme boundaries.

Text targets 800 UTF-16 code units per message. An indivisible URL or grapheme may exceed that target to preserve it. Large code/report files can also be sent with `send_file_to_wechat`.

## Pi compatibility

The extension targets Pi >= 1.2.0 (`@earendil-works/pi-coding-agent`); `npm run typecheck:pi` checks the published APIs for Pi 1.2.0 and 1.4.0, and the development host (1.6.x) is covered by `npm run typecheck`. Every submission explicitly specifies `deliverAs: "followUp"`. For starting images, the bridge matches the complete, previously observed input (including original image bytes) once to the run's first user message, so Pi 1.4+ image resizing/re-encoding, added hints, or dropped invalid images do not change source routing — history is never rewritten, and matching never relies on the marker or text alone.

References: [Pi 1.2.0 extension contracts](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/extensions.md), [tool exposure contract](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/extensions/types.ts).
