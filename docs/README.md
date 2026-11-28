# Documentation

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/README.zh.md)

Start with the [project README](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/README.md) for installation and common commands.

## User guides

- [Hands-on tutorial](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.md): follow a task from the first reply through files and a two-session handoff.
- [Quick start](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/quickstart.md): install, connect, and verify your first reply.
- [Upgrading](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md): update the installed source, restart, and preserve settings.
- [FAQ and troubleshooting](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md): missing replies, session handoff, receipts, and files.
- [Settings](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/settings.md): defaults, configuration dialogs, and scope.
- [WeChat source and reply rules](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/wechat-source.md): templates, formatting, tools, and message routing.
- [Model error notifications](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/model-errors.md): failure reporting and Pi compatibility behavior.

## Development

- [Maintenance](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md): automated checks, the minimal real-account release smoke test, debug logging and dependency updates.
- [Architecture](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md): directory responsibilities and runtime flow.
- [Contributing](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md): environment setup, checks, and contribution conventions.
- [Security](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.md): handling sensitive information and reporting vulnerabilities.
- [Changelog](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/CHANGELOG.md): release history.

User guides are maintained in English and Simplified Chinese (`.md` / `.zh.md`, each page linking to its translation; keep both in sync). Internal development docs (`architecture`, `maintenance`, `CONTRIBUTING`) are maintained in Simplified Chinese only.

Use full GitHub URLs for documentation navigation, including the `docs/` path where applicable, so links also work when a page is displayed outside its source directory. Run `npm run check:docs` after editing links.
