import { expect, it } from "vitest";
import type { AgentWorkerRequest } from "@deepfield/contracts";
import { createPiChatContextPreparer } from "./pi-chat-context.js";
import { validateFinalAnswer } from "../agent/pi-message-utils.js";

it("anchors automatic and initial visible output instructions to the real human message", () => {
  for (const prompt of ["请加入这些公司", "Trusted host event: recognition completed"]) {
    const request = { requestId: "r", prompt, context: { conversationId: "c", systemPrompt: "", messages: [], humanPrompt: "请加入这些公司" }, toolAccess: { network: "disabled" } } as unknown as AgentWorkerRequest;
    const context = createPiChatContextPreparer("main_agent", request, () => {})({ api: "openai-completions", provider: "test", id: "test" } as never);
    expect(context.basePromptParts.join("\n")).toContain("工具前说明、计划、进度、确认问题和最终回答");
    expect(context.basePromptParts.join("\n")).toContain("真实人类消息使用中文");
    expect(context.finalizationPromptParts.join("\n")).toContain("用户明确要求另一输出语言时遵从该要求");
  }
  expect(validateFinalAnswer("Hello", "请用英文回答", false)).toEqual({ ok: true, text: "Hello" });
});
