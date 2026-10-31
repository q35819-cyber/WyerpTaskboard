import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { TaskboardError } from "./core/errors.mjs";

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export class AuthManager {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.secretPath = path.join(rootDir, "config", "admin-secret.json");
    this.adminSecret = null;
    this.localCsrf = randomBytes(32).toString("base64url");
  }

  async init() {
    let config;
    try { config = JSON.parse(await fs.readFile(this.secretPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      config = {
        version: 1,
        adminSecret: randomBytes(32).toString("base64url"),
        createdAt: new Date().toISOString(),
      };
      await atomicWriteJson(this.secretPath, config);
    }
    if (!config?.adminSecret) throw new TaskboardError("本地管理员密钥配置无效", {
      code: "AUTH_CONFIG_INVALID", status: 500,
    });
    this.adminSecret = config.adminSecret;
    return this;
  }

  verifyAdminSecret(secret) { return safeEqual(secret, this.adminSecret); }


  authenticate({ bearer }) {
    if (bearer) {
      if (this.verifyAdminSecret(bearer)) return { mode: "bearer", actorId: "local-admin-cli", csrf: null };
      throw new TaskboardError("本机API令牌无效", { code: "UNAUTHORIZED", status: 401 });
    }
    return { mode: "session", actorId: "local-user", csrf: this.localCsrf, session: null };
  }
}
