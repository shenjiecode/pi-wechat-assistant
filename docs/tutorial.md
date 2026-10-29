# Hands-on tutorial: take a Pi task from your computer to WeChat

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.zh.md)

By the end, you should have seen a real AI reply on your phone, tried a file, and moved the WeChat connection between two Pi sessions. These are instructions to verify your own setup, not a claim that every environment has been tested.

## Know where to type

| Where | What belongs there | Example |
| --- | --- | --- |
| System terminal (PowerShell, bash, etc.) | Installation and version commands | `pi install npm:pi-wechat-assistant` |
| Pi terminal UI (TUI) | Extension commands | `/wechat config` |
| The bound WeChat conversation | Tasks and remote commands | `/help` |

Keep the computer online and Pi running. Start Pi in the project you intend to work on. The extension uses that session's model, tools and project; it does not run a separate agent on your phone.

## 1. Make the first connection

First ask Pi an ordinary question on the computer. If the model cannot answer locally, configure it before troubleshooting WeChat. Use Node.js ≥20.3.0 **and** satisfy your installed Pi version's Node requirement.

Run in the system terminal:

```bash
node --version
pi --version
pi install npm:pi-wechat-assistant
```

Reopen Pi, then type in its TUI:

```text
/wechat login
/wechat status
```

Scan the displayed QR code and confirm on your phone. Login attempts to start the bridge. Check that status says this session is running. Existing credentials are normally reused; do not force a new login just to change Pi sessions.

Send this in WeChat:

> Reply with “WeChat connected”. Do not modify any files.

Check both ends: Pi receives the request, and the final model reply arrives in WeChat. A receipt such as “received” only proves receipt handling, not completion of the AI task. If it fails, start with [troubleshooting](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md).

## 2. Try text, an image and a file

Use a disposable project and non-sensitive sample files for your first run.

| In WeChat | Expected result |
| --- | --- |
| “Summarize this project's README in three points. Do not edit files.” | A project-specific summary comes back. |
| Send an image, then “Describe this image.” | The image reaches Pi's model if it supports image input. Image-only messages normally wait up to 8 seconds to collect a batch. |
| Send `sample.txt`, then a separate message “Summarize the file I just sent.” | The file is saved under the active project's `.pi-wechat-files/`; the following text asks Pi to process it. |
| “Send the project's README.md back as a file.” | Pi can use the extension's sending tool; check that the file really arrives and opens. The file must exist inside the active project and fit the 50 MB outgoing limit. |

A file-only message saves the file without starting an AI task. Model capabilities and tool permissions still apply. A statement from the model that a file was sent is not a substitute for checking receipt on the phone.

## 3. Choose how new sessions connect

In Pi, open `/wechat config`. The two settings have different jobs:

| Setting | What it controls |
| --- | --- |
| Auto-start WeChat bridge | Try starting the bridge when a Pi session opens. |
| Bridge handoff mode | When another session owns the bridge, ask first or request handoff automatically. |

For convenient switching, run:

```text
/wechat config auto-start on
```

If automatic handoff is not already enabled, the TUI offers **“改为自动接管（推荐）”** (switch to automatic handoff, recommended). Choose it. Alternatively, use `/wechat config` → **“持锁接管方式”** → **“自动接管（不再询问）”**, or set it directly:

```text
/wechat config handoff auto
```

Saving either preference does not start the current bridge. Run `/wechat start` if needed. Handoff also applies to manual `/wechat start` with auto-start **off**. Once automatic handoff is enabled, opening another auto-start session may move WeChat there; use `handoff ask` if you want a confirmation each time.

## 4. Verify a handoff between two sessions

1. In session A, run `/wechat start` and confirm a WeChat round trip.
2. Open session B in the intended project. If auto-start is off, run `/wechat config handoff auto`, then `/wechat start` in B.
3. B requests A to stop its WeChat bridge. After A releases ownership, B starts. A's Pi session remains open; its conversation is not deleted or copied into B.
4. Run `/wechat status` in both sessions: A should be stopped, B running. Send a fresh WeChat task that identifies B's project and confirm the reply comes from B.

The old session must support cooperative handoff (0.4.4+). Headless sessions never automatically take over. Handoff waits up to 30 seconds; an unresponsive owner, unknown lock or changed owner causes a failure rather than a forced lock deletion. Wait for the current task to finish, or cancel it deliberately, before switching if you need its final reply. Handoff does not promise to migrate an in-progress AI task.

Progress shows elapsed waiting time every five seconds; release is followed by a notice that the current session is starting. If the owner did not declare handoff support, upgrade and restart that session, or run `/wechat stop` there first. A timeout ends the attempt: inspect the status before running `/wechat start` again. See the [maintenance guide](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md) for diagnostic logs.

An already-open process caches configuration. Reopen it after changing settings elsewhere. For lock errors, record the lock status and process ID; do not delete the whole state directory. `/wechat start!` is not a supported command.

## 5. Adjust noise and stop safely

In Pi:

```text
/wechat config ack off
/wechat config bidirectional on
```

These are optional, independent settings. `ack off` disables receipt notices, while AI replies and file-save results remain. `bidirectional on` also mirrors new desktop input and AI replies; it does not replay old history. Leave it off if you only want responses to WeChat tasks.

| Action | Command |
| --- | --- |
| Cancel the active AI task from WeChat | WeChat `/stop` |
| Disconnect this session's WeChat bridge | Pi `/wechat stop` |
| Keep starting manually in future sessions | Pi `/wechat config auto-start off` |
| Ask before future handoffs | Pi `/wechat config handoff ask` |

`/wechat stop` does not disable auto-start for the next session, and does not itself mean “cancel the AI task”.

Next: [Settings reference](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.md) · [Upgrade safely](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md) · [Get help](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/.github/SUPPORT.md)
