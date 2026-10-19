<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/logo.png" alt="pi-wechat-assistant logo" width="112" height="112">
</p>

<h1 align="center">pi-wechat-assistant</h1>

<p align="center">Continue your pi conversation from WeChat.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-wechat-assistant"><img src="https://img.shields.io/npm/v/pi-wechat-assistant?color=blue" alt="npm version"></a>
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node.js >=20.3">
</p>

<p align="center">
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/README.zh.md">中文</a> · <strong>English</strong> ·
  <a href="https://www.npmjs.com/package/pi-wechat-assistant">npm</a> ·
  <a href="https://pi.dev/packages/pi-wechat-assistant">pi.dev</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/cover.png" alt="WeChat connected to pi" width="640">
</p>

A WeChat extension for [pi](https://github.com/earendil-works/pi): connect one WeChat user to one running pi session to send tasks, read replies, and exchange files from your phone.

### Features

- **Two-way sync:** WeChat messages reach pi; new desktop input and AI replies can be mirrored (off by default), without replaying history.
- **Text, images, and files:** supports quoted text and WeChat voice transcripts. Images reach the model; received files are saved under `.pi-wechat-files/` in the project. AI can send project files and images back.
- **Readable replies:** full URLs, code chunks, text-based questions, and customizable reply rules.
- **Session handoff:** confirm in the new session (or set the handoff mode to Auto to skip the prompt), then wait for the old bridge to stop before taking over. The old AI task is not cancelled.
- **Tools on demand:** sending tools are available only while the bridge runs; stopping blocks new sends.

### Install and start

Requires Node.js **≥20.3.0** and pi with a working model configuration.

```bash
pi install npm:pi-wechat-assistant
```

Reopen pi and run in the TUI:

```text
/wechat login
```

Scan and confirm in WeChat. Successful login automatically attempts to start the bridge. Send a WeChat message to begin. Credentials are saved; later sessions normally need only `/wechat start`.

Alternatively, install the GitHub main branch:

```bash
pi install git:github.com/shenjiecode/pi-wechat-assistant
```

### Common commands

| Command | Purpose |
| --- | --- |
| `/wechat start` / `/wechat stop` | Start / stop this session’s bridge |
| `/wechat status` | Inspect running state, lock ownership, and send results |
| `/wechat config` | Settings dialogs: common toggles, image presets, reply templates |
| `/wechat config ack off` | Disable receipt notifications; use `on` to enable. Customize text in the settings dialogs. |
| `/wechat config bidirectional off` | Forward only WeChat-task replies; use `on` to restore two-way sync |
| `/wechat prompt show` / `init` / `reload` | View / export / reload the reply template |
| `/wechat login --force` | Scan again when login credentials expire |
| `/wechat logout` | Stop and clear local login credentials |

Send `/help` in WeChat for remote commands, including `/status`, `/model`, and `/stop`. **WeChat `/stop` cancels the AI task; TUI `/wechat stop` stops the bridge.**

Settings and the optional reply template live in `~/.pi/agent/wechat-assistant/`. While running, the bridge adds fixed, conditional WeChat system rules; incoming messages carry only the `[微信]` source marker.

- [Settings, defaults, and scope](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.md)
- [Reply templates, formatting, and tool compatibility](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.md)
- [All documentation](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.md)

### Limitations

- Desktop pi must keep running. Only one bridge may own the shared local account state. Automatic handoff requires version 0.4.4 or newer on both sides; older owners need a manual stop.
- **Saved login does not guarantee unrestricted proactive sending.** For persistent `ret=-2` failures, send a fresh message from WeChat and retry. Check `/wechat status` for the last send result.
- File-only messages are saved and acknowledged; send text instructions to ask AI to process them. Mirrored desktop images show a count, not the image data. Video is unsupported.
- Only messages from the bound WeChat user are accepted. WeChat `/tools` is disabled by default. Sending tools accept project-local files only, up to 50 MB each.

Development checks ran on Windows, with two-session handoff verified on Linux. API type checks cover pi 0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0, and 1.2.0.

### Contributing

See the [contributing guide](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md) for setup, checks, and submission conventions, and [architecture](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md) for module responsibilities and runtime flow. For sensitive reports, see [security](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md).

---

[MIT License](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE) · [Changelog](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/CHANGELOG.md)
