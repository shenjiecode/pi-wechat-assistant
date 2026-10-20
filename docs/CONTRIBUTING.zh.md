# 贡献指南

[English](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md) | 简体中文

感谢你帮助改进 pi-wechat-assistant。较大的改动请先通过 issue 说明问题与预期行为，便于讨论范围。

## 开发环境

开发时使用 Node.js 22 和 npm。CI 在 Linux 和 Windows 上使用 Node.js 20.19.0、22、24 执行完整检查；单独的 Node.js 20.3.0 冒烟检查验证编译后的扩展注册和模拟客户端下的文字队列提交，不运行 Pi 宿主，也不验证真实微信收发。所选 Pi 宿主可能要求更高的 Node.js 版本。

```bash
git clone https://github.com/shenjiecode/pi-wechat-assistant.git
cd pi-wechat-assistant
git switch develop
npm ci
npm run check
```

Pi 直接加载 TypeScript 入口。开发本扩展无需单独构建，也无需生成 `dist/` 目录。

## 分支与提交

采用简单的双分支流程：

```text
feat/*、fix/*、docs/*、chore/* → PR → develop → PR → main → vX.Y.Z
```

- `develop`：汇集日常开发；短期分支从这里创建，普通 PR 以它为目标。
- `main`：稳定发布分支；通过 PR 接收改动，由维护者检查并合并。
- `feat/<主题>`：新功能；`fix/<主题>`：修复问题；`docs/<主题>`：文档；`chore/<主题>`：工具或维护。分支名使用简短、明确的小写英文。

```bash
git switch develop
git pull --ff-only
git switch -c feat/short-topic
```

提交标题采用 `feat: add image captions`、`fix: preserve message order`、`docs: clarify setup` 等格式。工具维护使用 `chore:`，保持行为不变的代码整理使用 `refactor:`，测试使用 `test:`。不强制作用域、提交钩子或自动版本管理。

普通 PR 可以使用 **Squash and merge**。`develop → main` 使用 **Create a merge commit**，保留两个长期分支的共同历史。发布合并后，开始下一项改动前将 `main` 同步回 `develop`。如需从 `main` 紧急修复，也应通过 PR 合入 `main`，再同步回 `develop`。

```bash
git fetch origin
git switch develop
git merge --ff-only origin/main
git push origin develop
```

上述快进同步要求 `develop` 自发布 PR 后没有继续前进。若已有新提交，则通过同步 PR 将 `main` 合入 `develop`；不要重置或强推这两个共享分支。

## 检查命令

| 命令 | 用途 |
| --- | --- |
| `npm run check` | 源码类型检查、测试、文档链接与 npm 包内容检查 |
| `npm run typecheck` | 检查运行时 TypeScript 源码 |
| `npm test` | 运行全部测试 |
| `npm run test:watch` | 开发时持续运行测试 |
| `npm run typecheck:pi` | 检查七个版本的 Pi API 类型兼容性 |
| `npm run check:docs` | 检查文档导航与语言切换链接 |
| `npm run check:package` | 检查发布文件列表，不生成压缩包 |

兼容性检查首次运行会下载已发布的类型声明，并缓存到 `node_modules/.cache/pi-wechat-compat/`。它不会替换已安装依赖，也不能代替微信实际收发验证。

例如，使用 `npm test -- tests/messaging/message.test.ts` 运行单个测试。`tests/integration/` 中的集成测试通过根目录公开入口加载扩展，并模拟 Pi 和微信依赖。

## 代码组织

目录职责和运行流程见[架构说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.zh.md)。测试放在对应领域目录；涉及多个模块的行为放在 `tests/integration/`。

沿用现有风格：TypeScript、ESM、两空格缩进、单引号、不加分号。TypeScript 的相对导入使用 `.js` 后缀以匹配 Node16 模块解析。Pi 导入尽量保持为类型导入，以兼容两个受支持的包命名空间。

保持改动聚焦。行为变化应补充回归测试，面向用户的说明变化应同步更新两份 README，不要提交生成文件、收到的文件、凭据或日志。编辑器配置见 `.editorconfig`；目前未通过格式化器或 lint 工具强制检查格式。

项目概览的英文版保存在 `README.md`，简体中文版保存在 `README.zh.md`。详细说明统一放在 `docs/`，英文命名为 `name.md`，中文命名为 `name.zh.md`。请同步维护语言切换链接和两个语言版本，入口见[文档目录](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.zh.md)。

## Issue 与 PR

欢迎使用任何语言提交 issue、PR、评论或评审，无需翻译或提供双语内容。模板中的英文与中文部分是可选的参考，任选一组填写，也可以直接按自己的方式描述。交流应礼貌、简洁，并提供复现步骤、环境版本和实际执行的验证。项目说明文档仍按上文约定拆分为独立的语言文件。

提交 PR 前运行 `npm run check` 和 `npm run typecheck:pi`。CI 在 Linux 和 Windows 上执行主要检查，并在 Linux 的 Node.js 22 环境执行 Pi 兼容性检查。手动验证与自动化测试应分别说明。

保留现有的缺陷报告、功能建议和 PR 模板；简单明确的小改动不必先开 issue。PR 保持聚焦，说明目标分支、目的和验证结果即可。

`main` 要求通过 PR 合并，并通过 `check (ubuntu-latest, 22)` 和 `check (windows-latest, 22)` 两项 CI；PR 必须与 `main` 保持最新。必需的 Approval 数设为 **0**：GitHub 不允许作者批准自己的 PR，因此由唯一维护者检查差异和检查结果后手动合并。保护规则同样适用于管理员，禁止强推和删除分支。不要代替维护者开启自动合并。

敏感问题请参阅[安全说明](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.zh.md)。

## 发布

1. 通过 PR 向 `develop` 提交版本和更新记录：将 `package.json` 与 `package-lock.json` 更新为相同版本，在 `CHANGELOG.md` 中添加对应的 `## [x.y.z]` 节。可使用 `npm version <版本号> --no-git-tag-version` 更新版本文件而不创建标签。
2. 创建 `develop → main` 的 PR，确认 CI 通过，由维护者使用 **Create a merge commit** 合并。
3. 明确决定发布后，拉取 `main`，在发布提交上创建附注标签。标签版本必须与包版本和更新记录一致。例如，已准备好 `0.6.1` 版本时：

   ```bash
   git switch main
   git pull --ff-only
   git tag -a v0.6.1 -m "Release v0.6.1"
   git push origin v0.6.1
   ```

4. 标签触发发布工作流，验证提交已合入 `main`、标签与包版本一致，运行检查，发布 npm 包，并根据更新记录创建 GitHub Release。普通推送到 `main` 或 `develop` 不会发布。
5. 按上文说明将 `main` 同步回 `develop`。已发布标签保持不变，后续发布使用新版本号。

推送标签和发布需经过明确的发布决定。手动发布工作流接受已有发布标签，并执行相同检查。
