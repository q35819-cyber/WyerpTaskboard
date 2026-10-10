import fs from "node:fs/promises";
import path from "node:path";
import { TaskboardError } from "./core/errors.mjs";
import { atomicWriteJson } from "./core/atomic-files.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

function assertOperationId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(id)) {
    throw new TaskboardError("operation_id格式非法", { code: "INVALID_OPERATION_ID", status: 400 });
  }
}
export class TransactionStore {
  constructor(rootDir, { systemEventLog = null } = {}) {
    this.rootDir = rootDir;
    this.dir = path.join(rootDir, "data", "runtime", "transactions");
    this.systemEventLog = systemEventLog;
  }
  async logger() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    return this.systemEventLog;
  }
  async audit(event, details = {}, level = "info") {
    return (await this.logger()).append({ level, component: "transaction-store", event, details });
  }
  pathFor(operationId) {
    assertOperationId(operationId);
    return path.join(this.dir, `${operationId}.json`);
  }
  async read(operationId) {
    const file = this.pathFor(operationId);
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return null;
      await (await this.logger()).error("transaction-store", "journal_read_failed", error, { operation_id: operationId, file });
      throw new TaskboardError("transaction journal读取失败", {
        code: "TRANSACTION_JOURNAL_CORRUPT", status: 500, details: { operationId, cause: error.message },
      });
    }
  }
  async write(transaction) {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      await atomicWriteJson(this.pathFor(transaction.operationId), transaction);
    } catch (error) {
      await (await this.logger()).error("transaction-store", "journal_write_failed", error, { operation_id: transaction.operationId || null, state: transaction.state || null });
      throw error;
    }
    return transaction;
  }
  async prepare(transaction) {
    const existing = await this.read(transaction.operationId);
    if (existing && !["aborted_no_effect"].includes(existing.state)) return existing;
    return this.write({ version: 1, ...transaction, state: "prepared", preparedAt: new Date().toISOString() });
  }
  async phase(operationId, state, patch = {}) {
    const current = await this.read(operationId);
    if (!current) throw new TaskboardError("transaction journal不存在", { code: "TRANSACTION_NOT_FOUND", status: 500 });
    return this.write({ ...current, ...patch, state, updatedAt: new Date().toISOString() });
  }
  async listPending() {
    await fs.mkdir(this.dir, { recursive: true });
    const files = (await fs.readdir(this.dir)).filter((n) => n.endsWith(".json"));
    const result = [];
    for (const name of files) {
      let tx;
      try { tx = JSON.parse(await fs.readFile(path.join(this.dir, name), "utf8")); }
      catch (error) {
        await (await this.logger()).error("transaction-store", "pending_journal_invalid", error, { file: name });
        throw new TaskboardError("pending transaction journal损坏", { code: "TRANSACTION_JOURNAL_CORRUPT", status: 500, details: { file: name, cause: error.message } });
      }
      if (!["committed", "aborted_no_effect"].includes(tx.state)) result.push(tx);
    }
    return result;
  }
}
