import { TaskboardError } from "../core/errors.mjs";
import { wyerpAiFlowV1 } from "./wyerp-ai-flow-v1.mjs";
const profiles = new Map([[wyerpAiFlowV1.id, wyerpAiFlowV1]]);
export function getWorkflowProfile(id) {
  const profile = profiles.get(id);
  if (!profile) throw new TaskboardError(`不支持的workflowProfile: ${id}`, {
    code: "FORMAT_UNSUPPORTED", status: 422, details: { workflowProfile: id },
  });
  return profile;
}
