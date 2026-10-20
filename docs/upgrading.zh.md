# 升级指南

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md) | 简体中文

## 升级前

阅读[发布说明](https://github.com/shenjiecode/pi-wechat-assistant/releases)。先等待当前任务完成或取消任务，再在持有桥接的 pi 会话中执行 `/wechat stop`。停止桥接不等于取消 AI 任务。关闭使用同一安装的其他 pi 进程，避免它们继续使用旧代码或缓存配置。

在系统终端运行 `pi list`，确认已配置的来源和作用范围。本地源码目录安装应按该目录原有 Git 工作流更新。

## 更新原安装来源

未固定版本的 npm 安装，在系统终端执行：

```bash
pi update npm:pi-wechat-assistant
```

未固定版本的 GitHub 安装：

```bash
pi update git:github.com/shenjiecode/pi-wechat-assistant
```

以 `pi list` 显示的来源为准，避免同时安装 npm/Git 两份扩展。项目级配置应在对应项目目录运行，作用范围选项以当前 Pi 版本的 `pi update --help` 为准。

指定 npm 版本或 Git 标签、提交的来源会固定版本。需要选择某个 npm 版本时显式安装，例如：

```bash
pi install npm:pi-wechat-assistant@0.6.3
```

这只是固定版本示例，不是让更新版本的用户降级。项目级安装使用 `pi install -l` 并指定同一来源。固定版本不会自动更新，后续需显式选择更新版本。指定来源可避免不同 Pi 版本中裸 `pi update` 的行为差异。参见 Pi 的[包管理指南](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)和[命令行参考](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)。

## 重启与验证

1. 在目标项目重新打开 pi。更新不会替换其他进程已加载的代码。
2. 在 pi 中执行 `/wechat start`、`/wechat status` 和 `/wechat config show`。通常复用原凭据，登录过期或需要换账号时再扫码。
3. 从微信发一条新消息，确认 AI 回复返回；没有返回时检查最近发送结果。

`pi --version` 显示 Pi 宿主版本，不是扩展版本。`pi list` 用来识别配置来源；需要确认扩展实际版本时，查看安装目录内的 `package.json`。npm 的 `latest` 徽章仅表示已发布版本。

## 配置与恢复

状态与安装包分开，保存在 `~/.pi/agent/wechat-assistant/`；Windows 上通常为 `C:\Users\<user>\.pi\agent\wechat-assistant\`：

- `config.json`：包括回执设置在内的偏好配置。
- `wechat-prompt.md`：可选的自定义回复模板。
- 凭据与传输状态文件：包含私密登录和投递状态，不要上传到 issue。

v0.6.3 重构无需迁移配置，保留已有字段，包括未知字段及显式 `false`、零值。手动编辑前可备份偏好配置和自定义模板。不要将删除状态目录作为常规升级步骤。

配置按进程缓存。直接修改 JSON 后请重新打开 pi；仅 `/wechat stop` 再 `/wechat start` 不能保证重读配置。编辑回复模板后使用专门的 `/wechat prompt reload`。

升级后出现问题时，记录扩展、Pi、Node 版本和脱敏报错，参见[常见问题](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.zh.md)。也可按上面的命令格式显式安装此前的 npm 版本，但应先查看该版本的发布说明确认兼容性。
