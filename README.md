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
- 写操作仍使用本机 Origin 校验和动态 CSRF 校验；服务只监听 127.0.0.1，不应暴露到局域网或公网。
- config/admin-secret.json 仅保留给受信任的 AI/CLI Bearer API 调用，不是网页登录密码；不要删除、分享或提交到 GitHub，否则会破坏已有 AI/CLI 自动化接入。
- 如需查看本机 API Bearer 令牌，可在自己的终端运行 node cli/service.mjs secret；不要截图、分享或提交到 GitHub。
- **部署路径**：如果克隆位置不是 D:\WyerpTaskboard，先在 PowerShell 设置 $env:WYERP_TASKBOARD_ROOT = (Get-Location).Path。

## 中文说明

任务看板是本地多项目任务治理工具，不包含任何用户的真实任务记录、账号令牌或运行日志。ERP 专用接入功能默认需要额外配置，应按自己的项目情况启用。

## Security

- Keep config/admin-secret.json private; it contains the local AI/CLI API bearer token and is not used for browser login.
- Do not publish config/*.json, data, logs, backup archives, task histories, chat cookies, or access tokens.
- Browser extension: copy browser-extension/chat-wake/config.example.js to config.js and configure your own token; do not publish config.js.
- This software runs privileged local operations. Keep the web interface on 127.0.0.1; do not expose it directly to the public Internet.
- Example paths in configuration must be replaced for each installation; the code includes Windows-specific service tooling.

## AI workflow governance

- `docs/流程标准/开发独测Git合并闭环.md` is the single source of truth for development, independent QA, Git delivery, and task closure.
- `docs/governance/` contains the developer and independent-tester role rules used by ChatGPT wake automation.
- `templates/webcodex-v1/` contains reusable WebCodex execution rules, task templates, and the Git-flow simulation report.

## Quality checks

Run npm run check for static syntax validation, and npm test for the existing test suite in an isolated test environment.

## License

MIT. See LICENSE.
