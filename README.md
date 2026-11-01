# WyerpTaskboard

A local Windows-based multiproject taskboard for AI development and independent testing workflows. Released under the MIT license.

## Quick start / 快速启动

1. Install Node.js 24 or later and clone this repository on Windows.
2. Copy config/projects.example.json to config/projects.json and change the root path to the actual clone directory.
3. The browser taskboard is local-only and opens directly without a password. The service retains a private API bearer token in config/admin-secret.json for trusted AI/CLI integrations; it is not used for browser login.
4. Use node cli/service.mjs start to start the local service, then open http://127.0.0.1:47831.
5. If startup requires a task registry, create an empty registry using the included blank template; store all real tasks locally, not in Git.

## 本机免登录说明

- 浏览器打开 http://127.0.0.1:47831 即可直接进入任务看板，不再显示管理员密码登录页。
- **本机访问规则（P0 任务已完成，具体运行状态以当前服务为准）**：本机免登录浏览器写请求要求严格匹配的 Origin，并在浏览器提供时校验 Sec-Fetch-Site=same-origin；不要求浏览器 CSRF token。服务必须仅监听 127.0.0.1，不允许暴露到局域网或公网。部署版本实际行为以通过独立测试的代码为准，修复任务为 WTB-P0-USER-ACCEPTANCE-SYSTEM-GATES-20261031-T1。
- config/admin-secret.json 仅保留给受信任的 AI/CLI Bearer API 调用，不是网页登录密码；不要删除、分享或提交到 GitHub，否则会破坏已有 AI/CLI 自动化接入。
- 如需查看本机 API Bearer 令牌，可在自己的终端运行 node cli/service.mjs secret；不要截图、分享或提交到 GitHub。
- **部署路径**：如果克隆位置不是 D:\WyerpTaskboard，先在 PowerShell 设置 $env:WYERP_TASKBOARD_ROOT = (Get-Location).Path。

## 中文说明

任务看板是本地多项目任务流程工具。跨软件共用三角色、Ponytail 和同一测试/交付流程；真实任务记录、凭据、日志不随公开代码发布。

## Security

- Keep config/admin-secret.json private; it contains the local AI/CLI API bearer token and is not used for browser login.
- Do not publish config/*.json, data, logs, backup archives, task histories, chat cookies, or access tokens.
- Browser extension: copy browser-extension/chat-wake/config.example.js to config.js and configure your own token; do not publish config.js.
- This software runs privileged local operations. Keep the web interface on 127.0.0.1; do not expose it directly to the public Internet.
- Example paths in configuration must be replaced for each installation; the code includes Windows-specific service tooling.

## AI workflow governance
- Start here: root `AGENTS.md` and `WORKFLOW.md`. The complete authoritative role rules are directly in root `总控AI.md`, `开发AI.md`, and `独立测试AI.md`; do not maintain a second conflicting role manual.


- Private/local product requirement records (if present under `docs/产品需求/`) are **not included in the published repository**. The published workflow entry points, role rules and Git delivery standard below are self-contained; do not block a fresh clone on private documents.
- Root `WORKFLOW.md` is the entry for the minimal three-role flow. `docs/流程标准/开发独测Git合并闭环.md` retains detailed Git/delivery compatibility notes; do not duplicate or override the current root rules.
- The three root role files are the sole authoritative responsibility manuals. `docs/governance/` retains short legacy-path compatibility pointers. `templates/webcodex-v1/` provides supporting prompts, not another role authority. There are only three standing AI roles.
- Historical audit reports (including older NO-GO findings) are not live task statuses. Use the taskboard's current task events, accepted candidate and independent QA outcome; writing a rule is not proof that a production gate is implemented.
- Legacy scripts may resolve `docs/governance/` pointers, but must read the full corresponding root role file before executing.
- `templates/webcodex-v1/` is the portable **manual** onboarding baseline: three root role files, `AGENTS.md`, `WORKFLOW.md`, `.agents/skills/ponytail/SKILL.md`, project configuration, Node/Python runnable examples and prompt templates. Ponytail full is mandatory for code changes. Auto onboarding is **not yet implemented**.

## Quality checks

Run npm run check for static syntax validation, and npm test for the existing test suite in an isolated test environment.

## License

MIT. See LICENSE.
