import { TaskboardError } from "../core/errors.mjs";
import * as markdownV1 from "./markdown-task-registry-v1.mjs";
const adapters = new Map([["markdown-task-registry-v1", markdownV1]]);
export function getAdapter(id) {
  const adapter = adapters.get(id);
  if (!adapter) throw new TaskboardError(`不支持的adapter: ${id}`, {
    code: "FORMAT_UNSUPPORTED", status: 422, details: { adapter: id },
  });
  return adapter;
}
