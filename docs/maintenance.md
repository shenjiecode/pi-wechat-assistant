# Maintenance and release checks

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.zh.md)

This guide is for the maintainer or someone preparing a release. For development setup, use [Contributing](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md).

## What each check actually proves

| Check | Evidence | Does not prove |
| --- | --- | --- |
| `npm run check` | Source types, dependency boundaries, regression tests, bilingual navigation, npm file list | A live WeChat login or delivery |
| `npm run typecheck:pi` | Compatibility against published APIs for the listed Pi versions | That every host/runtime combination works with a real account |
| CI minimum-runtime job | Compiled registration and text queue submission on Node 20.3.0 | That today's Pi host can itself run on Node 20.3.0 |
| `npm run audit:production` | Known advisories in the production dependency tree; high/critical findings fail | Absence of vulnerabilities in project code, the user's host or the external service |
| `npm audit` | Known advisories in the full locked development tree | Runtime reachability of every finding |
| Real-account checklist below | The scenarios actually exercised with recorded versions | Untested pages, devices, network conditions or future service behavior |

CI runs the test suite on Linux and Windows with Node 20.19.0, 22 and 24. The **CI success** job requires the entire matrix, minimum-runtime jobs and production audit to succeed; skipped or failed dependencies do not count as success. Configure this aggregate as a required check only after it has run successfully on GitHub. Adding a workflow file does not update repository branch-protection settings.

Local commands, from the checkout:

```bash
npm ci
npm run check
npm run typecheck:pi
npm run audit:production
npm audit
```

The regular type check uses the current `@earendil-works/pi-coding-agent` development declarations. The historical import namespace is mapped in `tsconfig.json` for type checking only. The extension's Pi imports remain type-only; the compatibility script maps each selected host's published declarations separately, including 0.73.1. Older host packages are downloaded into an isolated cache for declarations, not installed or executed as the development host. API compatibility is not a recommendation to run an old host with known security advisories.

## Real-account acceptance before release

Record the commit, extension version, Pi package/version, Node version, OS and date. Mark each row **pass / fail / not run**, with a short observation. Use sample content, not personal conversations.

| Scenario | Acceptance condition |
| --- | --- |
| Fresh login and restart | Scan and confirm; receive a real AI reply; restart and reuse credentials successfully. |
| Text and errors | A WeChat task receives the final reply; a deliberately unavailable model produces a useful error. Restore the working model afterward. |
| Images | Single image and a small image batch reach an image-capable model; no duplicate final reply. |
| Files | Inbound file saves without starting a task; follow-up text uses it; an outgoing project file arrives and opens. |
| Receipt off / custom text | Receipt behavior matches the setting; AI replies and file-save confirmations still work. |
| Desktop mirroring off / on | Off sends only WeChat-task replies; on mirrors new desktop input and replies, without replaying history. |
| Session handoff | A stops its bridge, B starts; a fresh WeChat task reaches B's project; A remains open. Test Ask and Auto. |
| Auto-start and manual start | Enabling auto-start offers the handoff choice; manual start honors Auto with auto-start off. |
| Stop and reconnect | Stop blocks bridge sending; start resumes; restarting does not replay old received messages. |
| Upgrade existing configuration | Custom template, unknown JSON fields, `false` toggles and zero image delay survive. |

For handoff timeout, cancellation, changed ownership and unauthorized senders, keep automated regression tests as well. Do not corrupt a real credential store or force-kill a user's active task just to demonstrate an error case. The [tutorial](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.md) provides ordinary round-trip and handoff steps.

## Dependencies and CI maintenance

Dependabot is configured to propose weekly npm and GitHub Actions updates to `develop`, with small PR limits and grouped development patch/minor updates. Review behavior and CI before merging; there is no automatic merge. The configuration must reach the default branch before GitHub starts using it. Security updates are a separate repository setting, and target-branch version-update entries do not enable them.

When an audit fails, inspect the affected dependency path, advisory and fixed versions. Update the lockfile, rerun checks, and record what remains. Do not use `npm audit fix --force` merely to make a number disappear. Do not install unsupported development tooling to silence an alert while still claiming the older CI Node matrix works.

Keep the runtime Node floor separate from development tools and the user's Pi host. New Vitest or Pi releases may raise their own Node requirements. Compatibility samples live in `scripts/check-pi-compat.mjs`; add a representative new host when its API changes.

## Debugging without collecting conversations

Debug logging is off unless `PI_WECHAT_DEBUG=1` is set before starting Pi. New logs record event types, lengths, counts, origins and error codes instead of message previews, account IDs, raw attachment objects, file names or full error text. `debugLog` itself is not a general secret scrubber: new call sites must pass only diagnostic metadata.

The log rotates at approximately 1 MiB to one `.1` backup; individual messages are bounded to 1,000 characters and control characters are flattened. Rotation is best effort across processes, not a transactionally exact disk quota. Use a separate file per process when debugging concurrent sessions. Files created by older versions may still contain private data; updating does not sanitize old logs.

For one PowerShell session, using a project-local output directory:

```powershell
$env:PI_WECHAT_DEBUG = '1'
$env:PI_WECHAT_DEBUG_FILE = Join-Path (Get-Location) 'debug.log'
pi
Remove-Item Env:PI_WECHAT_DEBUG
Remove-Item Env:PI_WECHAT_DEBUG_FILE
```

For bash:

```bash
PI_WECHAT_DEBUG=1 PI_WECHAT_DEBUG_FILE="$PWD/debug.log" pi
```

Inspect logs before sharing. Status output and Pi/provider logs are separate from this logger and may contain identifiers or private information. Share the relevant sanitized excerpt, not a full directory.

## Release and rollback

Follow the [release workflow](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/CONTRIBUTING.md): reviewed branch → `develop` → `main` → explicit version tag. Do not tag or publish merely because CI is green. Keep a real-account acceptance record with the release decision.

After publishing, verify the GitHub Release, publish workflow, npm version and installable archive independently. To recover from a regression, use the [upgrade guide](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/upgrading.md) to select a known release; preserve preferences and custom templates. Do not routinely delete login/transport state, rewrite published tags or force-push the shared branches.
