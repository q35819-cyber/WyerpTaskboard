import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { EventStore } from "./event-store.mjs";

// Watch committed task transactions, including updates written by a separate CLI process.
export class TaskStatusEvents {
  constructor(rootDir) {
    this.dir = path.join(rootDir, "data", "runtime", "transactions");
    this.events = new EventStore(rootDir);
    this.clients = new Map();
    this.watcher = null;
    this.pending = new Map();
    this.seen = new Set();
  }

  async subscribe(projectId, res) {
    if (!this.watcher) {
      await fs.mkdir(this.dir, { recursive: true });
      if (!this.watcher) {
        // Windows temp directories can contain 8.3 aliases; the native watcher needs the long path.
        this.watcher = watch(await fs.realpath(this.dir), { persistent: false }, (_event, name) => {
          if (name && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}\.json$/.test(String(name))) {
            this.schedule(String(name));
          }
        });
        this.watcher.on("error", () => {
          for (const listeners of this.clients.values()) {
            for (const response of listeners) response.end();
          }
          this.close();
        });
      }
    }
    const listeners = this.clients.get(projectId) || new Set();
    this.clients.set(projectId, listeners);
    listeners.add(res);
    const cleanup = () => {
      listeners.delete(res);
      if (!listeners.size) this.clients.delete(projectId);
      if (!this.clients.size) this.close();
    };
    res.once("close", cleanup);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Content-Type-Options": "nosniff"
    });
    res.write("retry: 1000\nevent: ready\ndata: {}\n\n");
  }

  schedule(filename) {
    if (this.pending.has(filename)) clearTimeout(this.pending.get(filename));
    const timer = setTimeout(() => {
      this.pending.delete(filename);
      void this.publishIfCommitted(filename);
    }, 25);
    timer.unref();
    this.pending.set(filename, timer);
  }

  async publishIfCommitted(filename) {
    let tx;
    try { tx = JSON.parse(await fs.readFile(path.join(this.dir, filename), "utf8")); }
    catch { return; } // Ignore incomplete/removed temporary journal entries; later commits emit another rename.
    const event = tx?.event;
    if (tx?.state !== "committed" || !tx?.result?.eventId
      || typeof tx.projectId !== "string" || !this.clients.has(tx.projectId)
      || event?.project_id !== tx.projectId
      || event?.task_id !== tx.taskId
      || typeof event?.new_status !== "string"
      || event?.old_status === event.new_status
      || this.seen.has(tx.operationId)) return;
    let recorded;
    try { recorded = await this.events.findByOperationId(tx.projectId, tx.operationId); }
    catch { return; }
    if (recorded?.event_id !== tx.result.eventId || recorded?.task_id !== tx.taskId
      || recorded?.old_status !== event.old_status || recorded?.new_status !== event.new_status) return;
    this.seen.add(tx.operationId);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value);
    for (const response of this.clients.get(tx.projectId) || []) {
      response.write("event: status\ndata: {\"refresh\":true}\n\n");
    }
  }

  close() {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
