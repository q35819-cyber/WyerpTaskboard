import path from "node:path";
import { TaskboardError } from "./core/errors.mjs";
import { WindowsMcpClient } from "./windows-mcp-client.mjs";

export class ManualWindowsMcpClient extends WindowsMcpClient {
  constructor(rootDir, options = {}) {
    super(rootDir, {
      ...options,
      configPath: options.configPath || path.join(rootDir, "config", "manual-windows-mcp.json")
    });
  }

  async init() {
    await super.init();
    if (this.config?.manual_only !== true) {
      throw new TaskboardError("手工MCP配置必须显式标记 manual_only=true", {
        code: "MANUAL_MCP_CONFIG_NOT_MANUAL_ONLY",
        status: 500
      });
    }
    return this;
  }

  async status() {
    const base = await super.status();
    return {
      ...base,
      mode: "manual_only",
      automatic_task_integration: false,
      scheduler_integration: false,
      persistent_session: false
    };
  }
}
