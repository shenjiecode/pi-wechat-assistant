<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/logo.png" alt="pi-wechat-assistant logo" width="112" height="112">
</p>

<h1 align="center">pi-wechat-assistant</h1>

<p align="center">在微信里继续你的 pi 对话。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-wechat-assistant"><img src="https://img.shields.io/npm/v/pi-wechat-assistant?color=blue" alt="npm version"></a>
  <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20.3-339933" alt="Node.js >=20.3">
</p>

<p align="center">
  <strong>中文</strong> · <a href="https://github.com/shenjiecode/pi-wechat-assistant/blob/main/README.md">English</a> ·
  <a href="https://www.npmjs.com/package/pi-wechat-assistant">npm</a> ·
  <a href="https://pi.dev/packages/pi-wechat-assistant">pi.dev</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/shenjiecode/pi-wechat-assistant/main/assets/cover.png" alt="微信连接 pi 终端" width="640">
</p>

[pi](https://github.com/earendil-works/pi) 的微信扩展：在手机上向运行中的 pi 会话发任务、看回复、传文件。

### 支持什么

- **文字、图片和文件**：向 pi 发送任务和图片，在微信接收回复和项目文件。
- **适合微信阅读**：完整链接、代码分块，回复规则和收件回执均可自定义。
- **可选桌面同步**：同步新的电脑端输入和 AI 回复，不重发历史记录。
- **会话交接**：在不同 pi 会话间切换当前微信连接。

### 安装与开始使用

需要 Node.js **≥20.3.0**，以及已配置可用模型的 pi；同时满足已安装 pi 版本的 Node.js 要求。

在系统终端执行：

```bash
pi install npm:pi-wechat-assistant
```

重新打开 pi，在其终端界面输入：

```text
/wechat login
```

用微信扫码确认，登录后会自动尝试启动桥接；发一条消息，确认收到 AI 回复。以后通常只需 `/wechat start`。

### 常用操作

| 在 pi 中输入 | 用途 |
| --- | --- |
| `/wechat start` / `/wechat stop` | 启动 / 停止本会话的桥接 |
| `/wechat status` | 查看运行状态和发送结果 |
| `/wechat config` | 设置桌面同步、回执、图片和回复模板 |

在 `/wechat ` 后按 Tab 补全子命令，再按 Tab 继续补全参数（例如 `/wechat config handoff auto`）。

微信里输入 `/help` 查看远程命令。**微信 `/stop` 取消 AI 任务；pi 中的 `/wechat stop` 停止桥接。**

电脑和 pi 需保持运行；仅接收绑定微信用户的消息，同一份本地账号状态只能由一个桥接持有。桌面同步默认关闭。纯文件消息只保存，需再发文字说明才会交给 AI 处理。发送限制和排障方法见常见问题。

### 使用指南

- [实操教程](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.zh.md)：跑通真实回复、文件收发和自动会话交接。
- [快速上手](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.zh.md)：安装、连接并验证首次回复。
- [升级指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.zh.md)：更新、重启与保留配置。
- [常见问题与排障](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md)：登录、未收到回复、会话交接和文件问题。
- [配置说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.zh.md) · [完整文档目录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.zh.md)

### 参与开发

环境准备与检查命令见[贡献指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.zh.md)，代码组织见[架构说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.zh.md)，敏感问题请参阅[安全说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.zh.md)。

---

[MIT License](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/LICENSE) · [更新记录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/CHANGELOG.md)
