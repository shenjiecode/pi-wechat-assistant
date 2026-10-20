# Upgrading

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.zh.md)

## Before updating

Read the [release notes](https://github.com/shenjiecode/pi-wechat-assistant/releases). In pi, let the current task finish or cancel it, then run `/wechat stop` in the session that owns the bridge. Stopping the bridge alone is not the same as cancelling an AI task. Close other pi processes using this installation so they do not keep old code or cached settings active.

Run `pi list` in a system terminal to identify the configured source and scope. For a local source checkout, use its normal Git workflow instead.

## Update the installed source

For an unpinned npm installation, run in a system terminal:

```bash
pi update npm:pi-wechat-assistant
```

For an unpinned GitHub installation:

```bash
pi update git:github.com/shenjiecode/pi-wechat-assistant
```

Use the source shown by `pi list`; avoid installing a second npm/Git copy alongside it. For project-local settings, run from that project and consult `pi update --help` for your Pi version's scope options.

Versioned npm sources and Git tags/commits are pinned. Select a specific npm version explicitly, for example:

```bash
pi install npm:pi-wechat-assistant@0.6.3
```

This is a pinned-release example, not an instruction to downgrade a newer installation. Project-local installs use `pi install -l` with the same source. Pins do not advance automatically; choose an explicit newer version later. Targeted updates avoid the version-dependent behavior of bare `pi update`. See Pi's [package guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and [CLI reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md).

## Restart and verify

1. Reopen pi in the intended project. An update does not replace code already loaded in another process.
2. Run `/wechat start`, `/wechat status`, and `/wechat config show` in pi. Credentials are normally reused; scan again if login has expired or you intend to change accounts.
3. Send a fresh message from WeChat and verify that an AI reply returns. Check the last send result if it does not.

`pi --version` reports the Pi host version, not the extension version. `pi list` identifies the configured source; inspect the installed extension's `package.json` when you need its exact version. The npm `latest` badge only describes the published version.

## Configuration and recovery

State lives separately from the package in `~/.pi/agent/wechat-assistant/`, normally `C:\Users\<user>\.pi\agent\wechat-assistant\` on Windows:

- `config.json`: preferences, including receipt settings.
- `wechat-prompt.md`: optional custom reply template.
- Credentials and transport-state files: private login and delivery state; do not share them in issues.

The v0.6.3 refactor needs no migration and preserves existing fields, including unknown fields and explicit `false`/zero values. Back up preferences and custom templates before manual edits. Do not delete the state directory as a routine upgrade step.

Configuration is cached per process. After editing JSON directly, reopen pi; `/wechat stop` followed by `/wechat start` alone does not guarantee a fresh configuration read. Use `/wechat prompt reload` specifically for an edited reply template.

If an upgrade causes trouble, record the extension/Pi/Node versions and sanitized error, then see [FAQ](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/faq.md). You can explicitly install a previous npm version using the same command pattern above; consult that version's release notes for compatibility first.
