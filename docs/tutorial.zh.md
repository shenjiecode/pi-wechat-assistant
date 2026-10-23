# 实操教程：从电脑连接微信，再切换到另一个 Pi 会话

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.md) | 简体中文

跟着做完，你应该能在手机上收到一次真实 AI 回复、试过文件收发，并把微信连接切换到另一个 Pi 会话。这是供你验证自己环境的步骤，不代表所有环境都已经经过实测。

## 先分清在哪里输入

| 位置 | 输入什么 | 例子 |
| --- | --- | --- |
| 系统终端（PowerShell、bash 等） | 安装和版本命令 | `pi install npm:pi-wechat-assistant` |
| Pi 终端界面（TUI） | 扩展命令 | `/wechat config` |
| 绑定的微信对话 | 任务和远程命令 | `/help` |

电脑保持联网，Pi 保持运行；在你想处理的项目目录打开 Pi。扩展使用这个会话的模型、工具和项目，不是在手机上另外运行一个 Agent。

## 1. 先把第一条消息跑通

先在电脑上让 Pi 回答一个普通问题。如果本地模型都不能回答，先把模型配置好，再排查微信。Node.js 需要 ≥20.3.0，**同时满足已安装 Pi 版本的要求**。

在系统终端执行：

```bash
node --version
pi --version
pi install npm:pi-wechat-assistant
```

重新打开 Pi，在 Pi 界面输入：

```text
/wechat login
/wechat status
```

用手机扫码并确认。登录会自动尝试启动桥接；确认状态中显示本会话正在运行。已有凭据通常可以复用，换 Pi 会话不需要强制重新登录。

在微信发送：

> 请回复“微信已连通”，不要修改任何文件。

两头都看一下：Pi 收到了任务，微信也收到了模型的最终回复。“已收到”一类回执只说明接收处理执行了，不代表 AI 任务已经完成。没有跑通时，先看[排障说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md)。

## 2. 试文字、图片和文件

第一次建议用临时项目和不含敏感信息的示例文件。

| 在微信里操作 | 应当看到什么 |
| --- | --- |
| “把当前项目 README 总结成三点，不要改文件。” | 收到针对这个项目的总结。 |
| 发一张图片，再发“描述一下这张图”。 | 如果模型支持图片，图片会交给模型处理。只发图片时，默认最多等 8 秒收集同一批图片。 |
| 发 `sample.txt`，再单独发“总结刚才那个文件”。 | 文件先保存到当前项目的 `.pi-wechat-files/`，后面的文字才让 Pi 处理它。 |
| “把项目里的 README.md 作为文件发给我。” | Pi 可以调用扩展的发送工具；确认微信实际收到且能打开。文件须位于当前项目内，且不超过 50 MB 的发出限制。 |

纯文件消息只保存，不自动开始 AI 任务；模型能力和工具权限仍然有效。模型说“已发送”，不能代替在手机上确认确实收到了文件。

## 3. 选好新会话怎么连接

在 Pi 输入 `/wechat config`。这里有两个不同的设置：

| 设置 | 管什么 |
| --- | --- |
| 自动启动微信桥接 | 打开 Pi 会话时，是否尝试启动桥接。 |
| 持锁接管方式 | 别的会话占着桥接时，先询问还是直接请求交接。 |

希望切换方便，可以执行：

```text
/wechat config auto-start on
```

如果还没有开启自动接管，TUI 会引导选择 **「改为自动接管（推荐）」**，选它即可。也可以从 `/wechat config` → **「持锁接管方式」** → **「自动接管（不再询问）」** 设置，或直接输入：

```text
/wechat config handoff auto
```

保存这两个配置都不会立即启动当前桥接，需要时再执行 `/wechat start`。即使自动启动**关闭**，手动 `/wechat start` 也会遵循接管设置。开启自动接管后，新开的自动启动会话可能把微信连接接过去；希望每次确认，就设为 `handoff ask`。

## 4. 实际切换一次

1. 在会话 A 中执行 `/wechat start`，确认微信能正常问答。
2. 在目标项目打开会话 B。如果自动启动关闭，在 B 中执行 `/wechat config handoff auto`，再执行 `/wechat start`。
3. B 请求 A 停止微信桥接。A 释放占用后，B 启动。A 的 Pi 会话依然保留，聊天记录不会被删除，也不会复制进 B。
4. 在 A、B 分别看 `/wechat status`：A 应停止，B 应运行。微信再发一个能辨认 B 项目的新任务，确认由 B 回复。

旧会话需要支持协作交接（0.4.4+）。无界面模式不会自动接管；交接最多等 30 秒，旧会话没响应、锁无法确认或持有者变化时会报错，不会强删锁。如果还需要当前任务的最终回复，切换前先等它完成，或明确取消任务。交接不保证迁移正在进行的 AI 任务。

等待期间每 5 秒显示耗时；旧会话释放后会提示正在启动当前会话。若提示「未声明协作交接支持」，应升级并重启旧会话，或先在那里执行 `/wechat stop`。若超时，本次启动已经结束，需要检查状态后重新执行 `/wechat start`。诊断日志说明见[维护指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.zh.md)。

已打开的进程会缓存配置；在其他进程改过设置后，应重新打开。遇到锁报错，先记录锁状态和进程 ID，不要直接删掉整个状态目录。`/wechat start!` 目前不是有效命令。

## 5. 调整通知，再正确停止

在 Pi 中：

```text
/wechat config ack off
/wechat config bidirectional on
```

这两项可选，彼此独立。`ack off` 关闭收件回执，AI 回复和文件保存结果仍保留；`bidirectional on` 还会同步新的电脑输入及 AI 回复，不会重发历史记录。如果只想看微信任务的回复，保持双向同步关闭即可。

| 想做什么 | 命令 |
| --- | --- |
| 从微信取消当前 AI 任务 | 微信 `/stop` |
| 断开本会话的微信桥接 | Pi `/wechat stop` |
| 以后新会话手动连接 | Pi `/wechat config auto-start off` |
| 以后接管先询问 | Pi `/wechat config handoff ask` |

`/wechat stop` 不会关闭下一次会话的自动启动，也不等于“取消 AI 任务”。

接下来：[配置参考](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.zh.md) · [安全升级](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.zh.md) · [获取帮助](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/.github/SUPPORT.zh.md)
