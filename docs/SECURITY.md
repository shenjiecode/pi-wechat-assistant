# Security

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/SECURITY.zh.md)

This extension handles local login credentials, message-send credentials, conversation content and project files. Never include real tokens, account identifiers, private messages or unredacted logs in public issues or pull requests.

Deferred AI text, recipient identifiers, timestamps and original session/project metadata are stored as plaintext under `~/.pi/agent/wechat-assistant/outbox/`, without login or message context tokens. Files are partitioned by bot account and bound user, with POSIX directory/file modes `0700`/`0600`; check local account ACLs on Windows. Successfully replayed records are removed; uncertain deliveries remain for review. Stopping or logging out does not delete the outbox. Never upload it publicly; stop the bridge before backing up or removing records you no longer need.

## Reporting a vulnerability

Use [Report a vulnerability](https://github.com/shenjiecode/pi-wechat-assistant/security/advisories/new) to submit a private report. Include the affected version, impact, and a minimal reproduction with fake credentials. Do not disclose exploit details or sensitive data in public issues.

Ordinary bugs without sensitive details can use the bug report template. Reports are welcome in any language; no translation is required.

## Verification limits

Use the latest maintained Pi host for normal operation; API compatibility checks do not mean the host is free of security advisories. This extension's production dependencies and its development/host dependencies are audited separately; see [maintenance](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md).

Debug logging is opt-in. Current log call sites avoid message bodies, attachment secrets and full error text; logs rotate with one backup. Existing logs from older releases are not sanitized by an upgrade. Review diagnostic excerpts before sharing; `/wechat status` and host/provider output are separate and can still contain private details.

Automated tests cover sender validation, ownership, queueing and extension behavior with mocked services. Passing tests or Pi API type checks does not establish the security of the external WeChat service or prove successful delivery with a real account.
