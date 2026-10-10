# WyerpTaskboard

A local Windows-based multiproject taskboard for AI development and independent testing workflows. Released under the MIT license.

## Quick start / 快速启动

1. Install Node.js 24 or later and clone this repository on Windows.
2. Copy config/projects.example.json to config/projects.json and change the root path to the actual clone directory.
3. **必读 / Administrator password:** config/admin-secret.json is the administrator login credential (adminSecret). On first startup the service generates a unique secret for each installation; config/admin-secret.example.json only documents the structure and contains no real password. Never upload the live file.
4. Use node cli/service.mjs start to start the local service, then open http://127.0.0.1:47831.
5. If startup requires a task registry, create an empty registry using the included blank template; store all real tasks locally, not in Git.

## 管理员登录密码文件（必读）

- **真实密码文件**：config/admin-secret.json，字段 adminSecret 就是本机任务看板的管理员登录密钥，必须只保存在个人电脑或私有服务器。
- **开源示例文件**：config/admin-secret.example.json，不包含实际密码，只说明格式。无需复制为空密码的配置；首次启动时由 AuthManager 自动生成真实密钥。
- **查看本机登录密码**：在本机运行 node cli/service.mjs secret；只在自己的终端查看，不要截图、分享或提交到 GitHub。
- **迁移**：为新设备单独生成自己的密码；不要复用其他电脑正在使用的 admin-secret.json。
- **部署路径**：如果克隆位置不是 D:\WyerpTaskboard，先在 PowerShell 设置 $env:WYERP_TASKBOARD_ROOT = (Get-Location).Path。

## 中文说明

任务看板是本地多项目任务治理工具，不包含任何用户的真实任务记录、账号令牌或运行日志。ERP 专用接入功能默认需要额外配置，应按自己的项目情况启用。

## Security

- Keep the actual admin login credential config/admin-secret.json private; the public config/admin-secret.example.json has an intentionally empty adminSecret.
- Do not publish config/*.json, data, logs, backup archives, task histories, chat cookies, or access tokens.
- Browser extension: copy browser-extension/chat-wake/config.example.js to config.js and configure your own token; do not publish config.js.
- This software runs privileged local operations. Keep the web interface on 127.0.0.1; do not expose it directly to the public Internet.
- Example paths in configuration must be replaced for each installation; the code includes Windows-specific service tooling.

## Quality checks

Run npm run check for static syntax validation, and npm test for the existing test suite in an isolated test environment.

## License

MIT. See LICENSE.
