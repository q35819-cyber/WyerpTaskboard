import { ScanStore } from "./scan-store.mjs";
import { TaskScanner } from "./task-scanner.mjs";
import { SystemEventLog } from "./system-event-log.mjs";

export class TaskScanLoop {
  constructor(rootDir, {
    scanStore = null,
    scanner = null,
    tickMs = 1_000,
    setTimer = setInterval,
    clearTimer = clearInterval,
    onError = (error) => console.error("task-scan loop failed:", error?.message || error),
    systemEventLog = null,
  } = {}) {
    this.rootDir = rootDir;
    this.scanStore = scanStore;
    this.scanner = scanner;
    this.tickMs = Math.max(250, Number(tickMs || 1_000));
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.onError = onError;
    this.systemEventLog = systemEventLog;
    this.timer = null;
    this.running = false;
  }

  async init() {
    this.systemEventLog ||= await new SystemEventLog(this.rootDir).init();
    this.scanStore ||= await new ScanStore(this.rootDir).init();
    this.scanner ||= await new TaskScanner(this.rootDir, { scanStore: this.scanStore }).init();
    return this;
  }

  async reportError(error, phase) {
    await this.systemEventLog?.error("task-scan-loop", "loop_failed", error, { phase }).catch(() => { /* LOG-IGNORE: logger failure must not recursively fail the scan loop. */ });
    this.onError?.(error);
  }

  async tick(trigger = "service_ticker") {
    if (this.running) return { state: "skipped", reason: "loop_scan_active" };
    this.running = true;
    try {
      const decision = await this.scanStore.scheduledDecision();
      if (!decision.run) return { state: "skipped", ...decision };
      return await this.scanner.scanOnce({
        trigger: decision.reason === "rearm" ? "service_rearm" : trigger,
      });
    } finally {
      this.running = false;
    }
  }

  async start() {
    await this.init();
    try {
      await this.scanner.scanOnce({ trigger: "service_start" });
    } catch (error) {
      await this.reportError(error, "service_start");
    }
    this.timer = this.setTimer(() => {
      this.tick().catch(error => { void this.reportError(error, "service_ticker"); });
    }, this.tickMs);
    this.timer?.unref?.();
    return this;
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}
