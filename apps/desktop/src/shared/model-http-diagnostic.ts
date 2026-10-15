import type { ModelDiagnostic } from "@deepfield/contracts";
import type { ModelDiagnostic as BaseModelDiagnostic } from "@deepfield/base/model";
import { classifyModelHttpDiagnostic as classifyBaseDiagnostic } from "@deepfield/base/model/runtime";
export { readModelErrorPrefix } from "@deepfield/base/model/runtime";

/** Translate only this request's tool index into the existing Settings whitelist. */
export function toSettingsModelDiagnostic(diagnostic: BaseModelDiagnostic, requestedToolNames: readonly string[]): ModelDiagnostic {
  const index = diagnostic.toolIndex;
  const name = index !== undefined && Number.isSafeInteger(index) && index >= 0 && index < requestedToolNames.length ? requestedToolNames[index] : undefined;
  return {
    httpStatus: diagnostic.httpStatus, reason: diagnostic.reason,
    ...(name === "request_user_input" || name === "interaction_draft" || name === "propose_actions" ? { toolName: name } : {}),
    ...(diagnostic.rootObjectRequired === true ? { rootObjectRequired: true } : {}),
  };
}

export function classifyModelHttpDiagnostic(httpStatus: number, prefix: string, requestedToolNames: readonly string[]): ModelDiagnostic {
  return toSettingsModelDiagnostic(classifyBaseDiagnostic(httpStatus, prefix, requestedToolNames), requestedToolNames);
}
