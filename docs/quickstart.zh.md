# 快速上手

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.md) | 简体中文

将微信连接到已有 pi 会话，并验证一次完整的发消息与收回复流程。

## 1. 准备 pi

- 安装并配置 [pi](https://github.com/earendil-works/pi)，先确认在电脑端终端界面直接提问能收到模型回复。
- 使用 Node.js 20.3.0 或更新版本，**同时满足已安装 pi 版本的 Node 要求**。
- 电脑和 pi 会话需要保持运行并联网。扩展将扫码的微信用户连接到一个活跃的本地桥接，不是在手机上运行 pi。

在系统终端执行：

```bash
node --version
pi --version
pi install npm:pi-wechat-assistant
```

在需要操作的项目目录重新打开 pi。以 `/wechat` 开头的命令应输入 pi 的终端界面，不是在 PowerShell/bash 或微信聊天里执行。

也可用 `pi install git:github.com/shenjiecode/pi-wechat-assistant` 跟随 GitHub 主分支，而非 npm 发布版本。选择一种安装来源，不要同时加载两份扩展。

## 2. 登录并检查桥接

在 pi 中执行 `/wechat login`，用微信扫描显示的二维码并确认。登录成功后会自动尝试启动桥接。已有凭据时会直接复用；需要重新扫码时使用 `/wechat login --force`。

执行 `/wechat status`，检查本会话桥接是否正在运行。仅有凭据文件不能证明桥接已启动。如果由其他会话持有，请按接管提示操作，或先停止旧会话的桥接，详见[常见问题](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md)。

## 3. 验证一次完整收发

在微信中的桥接会话发送：

> 请回复“微信已连接”，不要修改任何文件。

应能看到请求进入 pi，随后 AI 回复返回微信。收件回执默认开启，但仅收到回执不代表模型任务已经完成。没有最终回复时，请查看[常见问题](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md)。

## 4. 尝试日常任务

- 发文字任务，例如让 pi 概述当前项目。
- 发图片后补充文字问题。纯图片消息会短暂等待其他图片，文字到来可提前触发处理。
- 发文件后说明需要做什么。纯文件消息保存到当前项目的 `.pi-wechat-files/` 并确认，不会自行启动 AI 任务。

仅接收绑定微信用户的消息。发回微信的文件必须位于项目目录内，每个文件不超过 50 MB。

## 5. 选择常用设置

在 pi 输入 `/wechat config`。电脑到微信的双向同步和自动启动默认关闭；微信任务的回复仍会返回微信。

```text
/wechat config bidirectional on
/wechat config ack off
```

第一条开启新的电脑输入和 AI 回复同步；第二条仅关闭收件回执通知。均为可选设置。自定义回执、自动启动、交接和图片限制详见[配置说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.zh.md)。

以后打开会话通常只需 `/wechat start`，不用重新扫码。微信中的 `/help` 显示远程命令，`/stop` 取消当前 AI 任务；pi 中的 `/wechat stop` 停止桥接。

下一步：[升级指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.zh.md) · [常见问题](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md) · [文档目录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.zh.md)
