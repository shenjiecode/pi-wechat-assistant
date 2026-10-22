# Project review and improvements · 2026-10-22

English | [简体中文](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/project-review-2026-10-22.zh.md)

## Assessment

The project already has domain-based source organization, cross-platform tests, a release workflow, configuration compatibility and bilingual documentation. The most useful next improvements are helping a new user complete a task, making release evidence clear, and collecting less private content during debugging.

These changes are on `codex/project-quality-and-guides`. No version bump, npm publication or main-branch merge was performed. Issue #31's command behavior is unchanged, and documentation work does not close that issue.

## Implemented changes

| Finding | Change | Benefit |
| --- | --- | --- |
| Command references still leave auto-start versus handoff unclear | New English/Chinese hands-on tutorial; FAQ explains manual start, the menu and the recommended handoff prompt | A shareable answer to recurring setup questions, including #31 |
| Debug logs included message previews, identities, raw image fields and full errors | Log counts, lengths, presence flags and error codes; URLs retain only origins; rotate to one backup | Less private content collected and bounded normal single-process log growth |
| Full development audit reported 22 findings | Upgrade Vitest to 4.1.12 and compatible dependencies; use current Pi development declarations and isolate historical compatibility declarations | Full audit now reports zero without ignoring advisories or forcing major upgrades |
| Prompt loading imported the authentication facade merely for a path | Depend directly on state storage; add an architecture guard | Prevent growing coupling between formatting, transport and Pi UI |
| CI ran multiple environments but protection required only two Node 22 jobs | Add `CI success` requiring all matrix jobs, minimum-runtime jobs and production audit | One complete validation signal |
| Dependency refreshes depended on manual discovery | Weekly Dependabot configuration targeting develop, with groups and small PR limits | Predictable update proposals, still manually reviewed |
| Contribution/security guides lacked a central support entry and acceptance record | GitHub-discoverable contribution, security and support entries; better bug/PR templates; bilingual maintenance guide | Easier reporting, reproduction and release decisions |

The README logo, cover, tagline and concise entry are preserved. Detailed guides remain in `docs/`, with separate languages and reciprocal links. No documentation-site build or extra service is required; GitHub renders the guides directly.

## Start here

1. [Hands-on tutorial](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/tutorial.md): installation, a real reply, attachments, handoff and stopping.
2. [Maintenance and acceptance](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/maintenance.md): evidence boundaries, release checks, dependencies and diagnostic logs.
3. [Architecture](https://github.com/shenjiecode/pi-wechat-assistant/blob/main/docs/architecture.md): message flow and dependency rules.

Documentation follows the project's full `main` URL convention. Until new pages reach main, open them from this branch or the PR file list.

## Verification record

| Check | Local result |
| --- | --- |
| Environment | Windows, Node 24.19.0, npm 11.17.0 |
| Automated tests | 275 passed: the existing 264 plus 11 log privacy/rotation and architecture-rule tests |
| Types and architecture | Passed; 27 source files checked for allowed domain dependencies, static runtime cycles and type-only Pi imports |
| Pi API declarations | Passed for 0.73.1, 0.78.0, 0.84.0, 0.84.4, 0.99.2, 1.1.0, 1.2.0 and 1.4.0 |
| Full dependency audit | Before: 22 findings (2 critical, 18 high, 1 moderate, 1 low); after: zero |
| Production dependency audit | Zero afterward; development findings do not directly establish user runtime exposure |
| Local runtime smoke | Registration and mocked text submission passed on Node 24.19.0; older local Node downloads timed out, so minimum-runtime evidence comes from remote CI |
| Documentation/package contents | Passed: 34 bilingual/community documentation pages, 166 repository links and 62 published files |
| GitHub CI | All 10 jobs passed for implementation commit `e9fd8ef`: Windows/Linux × Node 20.19.0, 22 and 24; both Node 20.3.0 smoke jobs; production audit; CI success. See the [run record](https://github.com/shenjiecode/pi-wechat-assistant/actions/runs/39793566861) |
| Real WeChat | No QR login or real-account delivery performed; end-to-end acceptance is not established |

Audit figures are a 2026-10-22 lockfile/advisory snapshot, not a permanent security guarantee. Historical API compatibility is not advice to run an old Pi host with known advisories.

After implementation validation, only the documentation index and this report were finalized, with documentation links and package contents rechecked. Runtime code was not changed again.

## Repository settings remain separate

At inspection, main protection still required the two Node 22 jobs; Dependabot security updates were disabled, while secret scanning and push protection were enabled. Adding configuration files does not change these settings.

After review and a successful aggregate run, make `CI success` required for main/develop and decide whether to enable Dependabot security updates. The Dependabot configuration must reach the default branch before GitHub uses it. These are follow-up settings, not completed changes.

## Recommended next work

**First: real-account acceptance.** Use the maintenance checklist for text, images, files, mirroring, restart and two-session handoff. In particular, observe switching while the old session still has an AI task; automated tests do not replace phone-side observations.

**Second: streaming download limits.** Images currently check actual size after reading the response, and file downloads read the whole response. That does not bound memory during download. Implement streaming limits, cancellation and failure notices separately, with missing Content-Length, oversized files and interrupted-network tests. This branch does not change inbound file limits without live verification of the behavior change.

**Third: gradual lifecycle extraction.** `extension/index.ts` and `bridge/queue.ts` remain the most sensitive modules. The new dependency guard is a first step. If session features grow, extract startup/stop/handoff around a clear interface while preserving cancellation, draining and ownership-change tests. A wholesale rewrite for a tidier directory is not justified.

Log rotation is best effort across processes, not an exact disk quota, and old logs are not retroactively sanitized. Use a separate log file for each process during concurrent debugging.

## References

- [Pi contribution guide](https://github.com/earendil-works/pi/blob/main/CONTRIBUTING.md): keeping the core small and expecting contributors to understand changes and show validation; its automatic newcomer-closing policy was not adopted.
- [Fastify contribution guide](https://github.com/fastify/fastify/blob/main/CONTRIBUTING.md): branch-based changes, CI and explicit release responsibility; multi-maintainer approval rules were not imposed on a solo project.
- [Got README](https://github.com/sindresorhus/got/blob/main/readme.md): a concise entry with quick-start and detailed documentation separated; no text or assets copied.
- [GitHub Dependabot reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference): checked grouping, target branches and update scope.

References reviewed on 2026-10-22. Their maintenance/documentation patterns informed this work; implementation, tutorials and this report were written for this project.
