import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import { renderChatHelp } from "@deepfield/application";
import { chatToolDirectory, type UtilityToolRuntime } from "./tool-runtime.js";

/** Model-callable overview using this request's granted tools and ready capability snapshot. */
export function createPiFeatureCatalogTool(request: AgentWorkerRequest, runtime: UtilityToolRuntime): AgentTool<any> {
  return {
    name: "view_available_features",
    label: "查看可用功能",
    description: "当用户询问当前有哪些工具、功能或能力可用时，先调用此只读工具，保留返回目录的标题、项目符号、能力说明和自然语言示例。具体业务请求应继续执行，不要仅列目录。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_toolCallId, _args, signal) {
      if (signal?.aborted) throw new Error("feature catalog call aborted");
      const text = renderChatHelp(chatToolDirectory(runtime, request.toolAccess.network === "enabled"),
        request.context.capabilityHelp ?? []);
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}
