# Quick start

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.zh.md)

Connect WeChat to an existing pi session, then verify a complete message-and-reply cycle.

## 1. Prepare pi

- Install and configure [pi](https://github.com/earendil-works/pi). Confirm that a normal prompt in its terminal UI receives a model reply first.
- Use Node.js 20.3.0 or newer **and meet your installed pi version's Node requirement**.
- Keep the computer and pi session running with network access. The extension connects the scanning WeChat user to one active local bridge; it does not run pi on your phone.

In your system terminal:

```bash
node --version
pi --version
pi install npm:pi-wechat-assistant
```

Reopen pi in the project you want to work with. Commands beginning with `/wechat` belong in the pi terminal UI, not PowerShell/bash or the WeChat chat.

To follow the GitHub main branch instead of npm releases, use `pi install git:github.com/shenjiecode/pi-wechat-assistant`. Choose one installation source; do not load both copies.

## 2. Log in and check the bridge

In pi, run `/wechat login`, scan the displayed QR code with WeChat, and confirm. Login attempts to start the bridge automatically. Existing credentials are reused; use `/wechat login --force` when you need a fresh login.

Run `/wechat status` and check that this session's bridge is running. A saved credential file alone does not prove that. If another session owns the bridge, follow the takeover prompt or stop that session's bridge first; see [FAQ](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md).

## 3. Verify a round trip

In the WeChat conversation used for the bridge, send:

> Reply with “WeChat connected”. Do not modify any files.

You should see the request reach pi and an AI reply return to WeChat. Receipt notifications are enabled by default, but a receipt alone does not prove that the model completed the task. If there is no final reply, see [FAQ](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md).

## 4. Try everyday tasks

- Send a text task, such as summarizing the current project.
- Send an image, then a question. Image-only messages wait briefly for more images; text can trigger processing sooner.
- Send a file, then explain what to do with it. File-only messages are saved under the active project's `.pi-wechat-files/` and acknowledged without starting an AI task.

Only the bound WeChat user's messages are accepted. Sending files back to WeChat is limited to project-local files, up to 50 MB each.

## 5. Choose your preferences

Open `/wechat config` in pi. Desktop-to-WeChat mirroring and auto-start are off by default; replies to WeChat tasks still return to WeChat.

```text
/wechat config bidirectional on
/wechat config ack off
```

The first command enables mirroring of new desktop input and AI replies. The second disables receipt notifications only. Both are optional. See [settings](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.md) for custom receipt text, auto-start, handoff, and image limits.

For later sessions, normally use `/wechat start` without scanning again. In WeChat, `/help` lists remote commands and `/stop` cancels the current AI task. In pi, `/wechat stop` stops the bridge.

Next: [Upgrade](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md) · [FAQ](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md) · [All documentation](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.md)
