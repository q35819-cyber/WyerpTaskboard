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
  constructor(rootDir, { sessionTtlMs = 12 * 60 * 60 * 1000 } = {}) {
    this.rootDir = rootDir;
    this.secretPath = path.join(rootDir, "config", "admin-secret.json");
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
    this.adminSecret = null;
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

  createSession() {
    const id = randomBytes(24).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const now = Date.now();
    this.sessions.set(id, { id, csrf, createdAt: now, lastSeenAt: now });
    return { id, csrf };
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (Date.now() - session.lastSeenAt > this.sessionTtlMs) {
      this.sessions.delete(id);
      return null;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  deleteSession(id) { this.sessions.delete(id); }

  authenticate({ sessionId, bearer }) {
    if (bearer && this.verifyAdminSecret(bearer)) return { mode: "bearer", actorId: "local-admin-cli", csrf: null };
    const session = sessionId ? this.getSession(sessionId) : null;
    if (!session) throw new TaskboardError("未登录或会话已过期", { code: "UNAUTHORIZED", status: 401 });
    return { mode: "session", actorId: "local-admin", csrf: session.csrf, session };
  }
}
