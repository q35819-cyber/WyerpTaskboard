export class TaskboardError extends Error {
  constructor(message, { code = "TASKBOARD_ERROR", status = 500, details = null } = {}) {
    super(message);
    this.name = "TaskboardError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
export function invariant(condition, message, options) {
  if (!condition) throw new TaskboardError(message, options);
}
