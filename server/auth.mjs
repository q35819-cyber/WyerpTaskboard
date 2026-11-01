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
    this.controllerProofPath = path.join(rootDir, "config", "controller-proof.json");
    this.adminSecret = null;
    this.controllerSecret = null;
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
    let controller;
    try { controller = JSON.parse(await fs.readFile(this.controllerProofPath, "utf8")); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      controller = { version: 1, proof: randomBytes(32).toString("base64url") };
      await atomicWriteJson(this.controllerProofPath, controller);
    }
    if (controller.version !== 1 || typeof controller.proof !== "string" || controller.proof.length < 32)
      throw new TaskboardError("总控专用凭据配置无效", { code: "CONTROLLER_PROOF_CONFIG_INVALID", status: 500 });
    this.controllerSecret = controller.proof;
    return this;
  }

  verifyAdminSecret(secret) { return safeEqual(secret, this.adminSecret); }
  verifyControllerProof(proof) {
    return typeof proof === "string" && proof.length >= 32 && safeEqual(proof, this.controllerSecret);
  }


  authenticate({ bearer }) {
    if (bearer) {
      if (this.verifyAdminSecret(bearer)) return { mode: "bearer", actorId: "local-admin-cli" };
      throw new TaskboardError("本机API令牌无效", { code: "UNAUTHORIZED", status: 401 });
    }
    return { mode: "session", actorId: "local-user", session: null };
  }
}
