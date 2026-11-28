# Settings

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.zh.md)

Run `/wechat config` to open host-native selection and input dialogs. Each row includes its current value and a short explanation. Image settings offer presets (0/2/8/15 seconds and 10/20/50 MB) plus custom input with units and ranges. Select a setting, then choose a value; each confirmed change is saved separately. Esc cancels a value choice, returns from advanced settings, or closes the main menu. Opening settings does not start the bridge or register sending tools. Without UI, the command shows text; `/wechat config show` always shows text.

| Location | Setting | Default | Purpose |
| --- | --- | --- | --- |
| Common | Receipt notifications | On | Send text/image receipt confirmations. Off suppresses both; AI replies, file-save results, and errors are unaffected. |
| Common | Text / image receipt content | Built-in messages | Customize each separately; blank input restores the default, Esc cancels. |
| Common | Bidirectional sync | Off | Forward new desktop input and AI replies to WeChat. Off keeps only replies to WeChat requests. |
| Common | Completion summaries | Off | Send one short AI reply after Pi finishes processing a run. |
| Common | Auto-start WeChat bridge | Off | Attempt to connect WeChat when a pi session opens. In the TUI, a bridge held by another session follows the handoff mode below (ask or auto); headless modes report the lock instead of asking. Enabling it offers to switch the handoff mode to Auto. Does not start/stop the current bridge. |
| Common | Bridge handoff mode | Ask | When another session holds a cooperative-handoff bridge (0.4.4+), Ask shows the takeover dialog and Auto requests the handoff directly. Headless modes never auto-take-over. |
| Common | WeChat message tag and formatting | On | One switch for the `[微信]` marker, WeChat-friendly reply formatting, and the local question-tool guard. Waits for an active task to finish before changing. |
| Common | Reply template actions | Packaged template | View template/path, export without overwriting, or reload an edited file. These are actions, not additional switches. |
| Advanced | WeChat /tools override | Off | Allow WeChat `/tools` to modify local tool permissions. This does not control the two WeChat file/image sending tools. |
| Advanced | Burst-image batch delay | 8000 ms | Wait for related image messages; text arrives sooner and triggers processing. Range 0–60000 ms; zero disables waiting. |
| Advanced | Image download limit | 50 MB | Maximum downloaded image size; minimum 1 MB. Does not change the separate outgoing-file size limit. |

Keep custom source-marker text and the blocked local question-tool names in `config.json`: these serve unusual integrations, rather than routine settings. Keep reply prose in `wechat-prompt.md`. Login credentials, message-send credentials, lock ownership, and the current running state are not editable preferences.

Configuration is stored at `~/.pi/agent/wechat-assistant/config.json`. Saves affect this process and future sessions. Already-open processes cache their settings and do not reload another process's changes automatically; reload the extension or reopen the session before editing settings from another process. Image environment variables remain fallbacks when no corresponding JSON setting exists; the menu shows effective image values. There is no new cross-process settings synchronization in this change.

Existing commands remain supported. Additional explicit commands are `/wechat config auto-start on|off`, `/wechat config handoff ask|auto`, and `/wechat config remote-tools on|off`. For reply files and system-prompt behavior see [WeChat rules](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.md).

## Completion summaries

Use `/wechat config summary on` to enable summaries or `/wechat config summary off` for incremental AI replies. The common settings menu offers the same switch. The choice applies to the next user request. New and upgraded installations default to off. `/wechat config show` displays the saved preference and any fallback for the current Pi host.

Pi can retry, compact the conversation, or continue with follow-up work before settling. The bridge reads the outcome at `agent_before_settle` and sends at `agent_settled`. Hosts that lack either capability use incremental replies. [Pi event lifecycle](https://github.com/earendil-works/pi/blob/v1.6.0/packages/coding-agent/docs/extensions.md#lifecycle-overview)

The notification includes the task and its latest eligible final reply. With the WeChat reply rules enabled, Pi can mark its opening paragraph as a result, task failure, or question. WeChat gets the marked result or the question and its choices. For unmarked answers it gets the full short reply or an excerpt from the beginning and end of a long one. Full details stay in Pi. The bridge makes no additional model request. Pi reports execution errors and cancellation directly. Desktop replies follow the bidirectional sync setting.

Receipts, explicit file transfers and command replies have their own delivery paths. Turn off ordinary receipt messages with `/wechat config ack off` if desired. A summary rejected with `ret=-2` goes to the existing outbox for replay after new WeChat activity.

## Receipt notifications

Use `/wechat config ack on|off` or the common settings menu. Existing `"sendAck": false` in `config.json` is honored. The default is on.

- `/wechat config ack-text Got it, working on it…` sets the text receipt.
- `/wechat config image-ack-text Image received; you can add more details.` sets the image-batch receipt.
- Run either content command without text to restore its built-in message. Editing content does not turn notifications on.

The JSON fields are `sendAck`, `ackText`, and `imageBatchAckText`. Missing or blank content uses the built-in message. A pure-image batch sends at most one receipt; a message containing both text and images keeps the existing behavior of no extra receipt. File-save results and errors remain visible. Commands take effect for subsequent receipts; after editing JSON directly, reload the extension or reopen the session.
