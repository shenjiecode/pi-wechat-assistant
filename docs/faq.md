# FAQ and troubleshooting

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md)

Start with `/wechat status` in the pi terminal UI: check bridge ownership, running state, and the last send result. Then locate the symptom below.

## `/wechat` is missing after installation

Run `pi list` in the system terminal to confirm the configured source, then reopen pi in the intended project. Check startup errors, the installed Node.js version against the Pi host's requirements, and whether the extension is disabled in Pi's package configuration. Avoid loading both npm and Git copies. See [quick start](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.md) and [upgrade](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md).

## Login succeeded, but WeChat gets no reply

1. Confirm that the computer and pi session are still running and connected to the network.
2. Run `/wechat status` in pi. If credentials exist but the bridge is stopped, use `/wechat start`.
3. Send a fresh text message from the bound WeChat account. Other users' messages are not accepted.
4. If the message reaches pi but no AI response is produced, test a direct prompt in pi and inspect model/authentication errors. If pi produces a reply but WeChat receives nothing, inspect the last send result.

Saved login credentials do not guarantee unrestricted proactive sending. For persistent `ret=-2` failures, send a fresh message from WeChat and retry. Repeatedly reinstalling the extension does not refresh that conversation activity. If login has expired, use `/wechat login --force` and scan again.

## I only receive a receipt or a model error

A receipt confirms intake, not completion. Check the pi terminal for ongoing work or model/provider errors. Automatic retries and error notifications differ by Pi version; see [model error notifications](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/model-errors.md). Turning off receipt notifications does not disable AI replies or error notices.

## Another session owns the bridge

One bridge may own the shared local account state at a time. In the old session, run `/wechat stop`, then `/wechat start` in the new session; alternatively, follow the new session's takeover prompt. Cooperative handoff requires extension 0.4.4+ on both sides; older owners need a manual stop.

`/wechat config handoff auto` skips the confirmation for cooperative handoff in the interactive UI. Headless sessions do not automatically take over. Handoff transfers the bridge, not the old conversation history, and does not cancel the old AI task. Do not manually delete a live session's lock to bypass ownership.

## Desktop conversations are not mirrored

This is the default since 0.6.0. WeChat tasks still receive their own replies. Enable new desktop input/reply mirroring with `/wechat config bidirectional on` in pi. Existing explicit settings are preserved, and historical messages are not replayed.

## How do I change receipts or settings?

Use `/wechat config`, or `/wechat config ack off` to disable text/image receipt notifications. Custom text and image receipts are separate settings; blank content restores defaults. File-save results and errors remain visible.

Preferences are cached per process. Direct JSON edits or changes made by another pi process require reopening the affected session. Stopping and restarting only the bridge is insufficient. An edited reply template uses `/wechat prompt reload`. See [settings](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.md) and [reply rules](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.md).

## Images or files do not behave as expected

| Symptom | Explanation / action |
| --- | --- |
| Image processing waits | Pure images are batched; send accompanying text or adjust `image-wait` in settings. |
| A received file does not start a task | File-only messages are saved and acknowledged. Send a text instruction next. |
| AI cannot send a file back | Start the bridge; use a file inside the active project and no larger than 50 MB. |
| Image download fails | Check the error and download limit in settings; the incoming-image limit is separate from the outgoing-file limit. |
| Desktop images show only a count | Desktop mirroring does not forward image data. Send the image from WeChat for model input. |
| Video does not work | Video is unsupported. |

## What do stop and logout do?

- WeChat `/stop` requests cancellation of the AI task.
- Pi `/wechat stop` stops this session's bridge, blocks new sends, and retains login credentials.
- Pi `/wechat logout` stops the bridge and clears local login/context/cursor state; it does not reset preferences or the custom reply template.

## What should I include in a bug report?

Use [issues](https://github.com/shenjiecode/pi-wechat-assistant/issues) in any language. Include extension/Pi/Node versions, OS, installation source, minimal steps, expected/actual behavior, and sanitized `/wechat status` output. `pi --version` is the host version; find the extension version in its installed `package.json`.

If more detail is needed, `PI_WECHAT_DEBUG=1` enables debugging when set before launching pi. Logs default to `~/.pi/agent/wechat-assistant/debug.log`; `PI_WECHAT_DEBUG_FILE` overrides the path. Logs may contain message content and local paths: redact them, tokens, account identifiers, and private data before sharing. Disable debugging afterwards. Vulnerabilities belong in [private reporting](https://github.com/shenjiecode/pi-wechat-assistant/security/advisories/new), not public logs.

[All documentation](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.md)
