import { createHash } from "node:crypto";
export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
export function stableEventId(operationId) {
  return `evt_${sha256(String(operationId)).slice(0, 24)}`;
}
