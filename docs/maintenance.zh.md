# 维护与发布检查

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md) | 简体中文

这份文档给维护者和准备发布的人使用。开发环境搭建见[贡献指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.zh.md)。

## 每项检查到底证明什么

| 检查 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| `npm run check` | 源码类型、依赖边界、回归测试、双语导航和 npm 文件清单通过 | 真实微信登录或消息投递成功 |
| `npm run typecheck:pi` | 代码能通过所列 Pi 版本的公开 API 类型检查 | 每个宿主、运行环境都能连真实账号 |
| CI 的 minimum-runtime | 编译后的扩展注册、文字入队能在 Node 20.3.0 跑通 | 今天的 Pi 宿主本身能在 Node 20.3.0 运行 |
| `npm run audit:production` | 检查生产依赖已知公告；高危、严重告警会失败 | 项目代码、用户宿主和外部服务完全没有漏洞 |
| `npm audit` | 检查完整开发依赖锁定树的已知公告 | 每项告警在实际运行中都能被触发 |
| 下方真实账号清单 | 记录的版本和场景确实测过 | 未测的页面、设备、网络和未来服务行为 |

CI 在 Linux、Windows 上分别跑 Node 20.19.0、22、24 的测试。**CI success** 汇总任务要求整个矩阵、最低运行版本检查和生产依赖审计都成功，依赖任务跳过或失败不会被当成通过。先让它在 GitHub 成功跑一次，再把它设成分支保护必需项；提交工作流文件本身不会修改仓库的分支保护。

在代码目录执行：

```bash
npm ci
npm run check
npm run typecheck:pi
npm run audit:production
npm audit
```

普通类型检查使用当前 `@earendil-works/pi-coding-agent` 的开发声明；历史导入名称在 `tsconfig.json` 中只作类型映射。扩展对 Pi 的导入仍然只有类型；兼容脚本会为每个选定宿主单独映射其公开声明，包括 0.73.1。旧宿主包只下载到隔离缓存用于类型检查，不再作为日常开发宿主安装和执行。兼容旧 API 不等于推荐用户运行存在已知安全公告的旧宿主。

## 发布前的真实账号验收

记录提交、扩展版本、Pi 包名和版本、Node 版本、系统和日期。每行写 **通过 / 失败 / 未执行**，附一句实际观察。使用示例内容，不使用私人对话。

| 场景 | 验收条件 |
| --- | --- |
| 首次登录与重启 | 扫码确认，收到真实 AI 回复；重启后凭据可正常复用。 |
| 文字与报错 | 微信任务收到最终回复；故意选择不可用模型能得到明确报错，随后恢复正常模型。 |
| 图片 | 单张图片和小批图片能交给支持图片的模型，没有重复最终回复。 |
| 文件 | 收文件只保存、不直接启动任务；补充文字后能处理；发出的项目文件确实收到且能打开。 |
| 回执关闭与自定义 | 回执符合配置，AI 回复和文件保存确认仍然可用。 |
| 桌面同步关闭与开启 | 关闭时只回微信任务；开启时同步新电脑输入和回复，不重发历史。 |
| 会话交接 | A 停止桥接，B 启动；微信新任务进入 B 的项目，A 会话仍保留；分别测试询问和自动。 |
| 自动启动与手动启动 | 开启自动启动有接管引导；关闭自动启动时，手动 start 仍遵循自动接管配置。 |
| 停止与重新连接 | 停止后桥接不能发送；重新启动可恢复；重启不重放旧消息。 |
| 升级已有配置 | 自定义模板、未知 JSON 字段、`false` 开关和零图片等待值均保留。 |

交接超时、取消、持有者变化、非绑定用户等异常仍要保留自动化回归测试。不要为了演示异常，损坏真实凭据库或强行结束用户正在执行的任务。普通问答和交接步骤见[实操教程](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.zh.md)。

## 依赖和 CI 怎么维护

Dependabot 配置为每周向 `develop` 提交 npm、GitHub Actions 更新，限制同时打开的 PR 数，合并开发依赖的小版本和补丁更新。仍需检查行为和 CI 后手动合并，没有自动合并。配置需要进入默认分支，GitHub 才会使用；安全更新是另一个仓库设置，面向指定分支的版本更新配置不会替你开启它。

审计失败时，先看受影响的依赖路径、公告和修复版本。更新锁文件后重跑检查，记录剩余问题。不要为了让数字归零就执行 `npm audit fix --force`；也不要换上不支持旧 CI Node 的工具，再宣称旧矩阵仍然有效。

区分扩展最低运行版本、开发工具要求、用户 Pi 宿主要求。新版 Vitest 或 Pi 可能提高自己的 Node 门槛。兼容样本在 `scripts/check-pi-compat.mjs` 中；宿主 API 有变化时，增加有代表性的版本。

## 排障时少收集私人内容

只有启动 Pi 前设置 `PI_WECHAT_DEBUG=1` 才开启日志。新日志记录事件类型、长度、数量、网址来源和错误码，不再记录消息预览、账号 ID、原始附件对象、文件名或完整报错。`debugLog` 本身不是万能脱敏器：新增调用点仍必须只传诊断元数据。

日志约 1 MiB 时轮转，保留一个 `.1` 备份；单条内容限制为 1,000 字符，控制字符会被替换。多进程轮转是尽力处理，不是严格的磁盘配额；同时调试多个会话时，应各用一个文件。旧版留下的日志可能包含私人信息，更新不会自动清洗旧日志。

PowerShell 示例，日志放到当前项目中：

```powershell
$env:PI_WECHAT_DEBUG = '1'
$env:PI_WECHAT_DEBUG_FILE = Join-Path (Get-Location) 'debug.log'
pi
Remove-Item Env:PI_WECHAT_DEBUG
Remove-Item Env:PI_WECHAT_DEBUG_FILE
```

bash 示例：

```bash
PI_WECHAT_DEBUG=1 PI_WECHAT_DEBUG_FILE="$PWD/debug.log" pi
```

分享前仍要检查日志。状态输出、Pi 自身日志和模型服务商日志不受这个日志模块控制，可能包含标识或私人信息；只分享相关脱敏片段，不要上传整个目录。

## 发布与恢复

遵循[发布流程](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.zh.md)：评审分支 → `develop` → `main` → 明确决定后打版本标签。CI 通过不自动等于可以发布；发布决定应附上真实账号验收记录。

发布后分别确认 GitHub Release、发布工作流、npm 版本和可安装包。出现回归时，按[升级指南](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.zh.md)选择已知正常版本，并保留偏好和自定义模板。不要把删除登录/收发状态、重写已发布标签或强推共享分支当成常规恢复手段。
