import { SystemEventLog } from "../server/system-event-log.mjs";

export async function logCliEvent(rootDir, component, event, details = {}, level = "info") {
  try {
    const log = await new SystemEventLog(rootDir).init();
    return await log.append({ level, component, event, details });
  } catch (error) {
    console.warn("cli event log failed:", component, event, error?.message || error);
    return { ok: false };
  }
}

export async function logCliError(rootDir, component, operation, error, details = {}) {
  try {
    const log = await new SystemEventLog(rootDir).init();
    return await log.error(component, "cli_failed", error, { operation, ...details });
  } catch (logError) {
    console.warn("cli error log failed:", component, operation, logError?.message || logError);
    return { ok: false };
  }
}
