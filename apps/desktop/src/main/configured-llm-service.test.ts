import { describe, expect, it, vi } from "vitest";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import type { ModelGateway } from "../shared/model-gateway.js";
import { ConfiguredLlmService } from "./configured-llm-service.js";

const profile = (id: string): LlmRuntimeSnapshot => ({
  id,
  name: id,
  provider: "custom",
  protocol: "openai_compatible",
  baseUrl: "https://llm.example.test/v1",
  modelId: "model-test",
  contextWindow: 32_000,
  apiKey: `secret-${id}`,
});

describe("ConfiguredLlmService", () => {
  it("resolves the active profile independently for title, recognition, and completion", async () => {
    const profiles = [profile("title"), profile("recognition"), profile("completion")];
    const resolveActiveLlm = vi.fn(async () => profiles.shift()!);
    const completeText = vi.fn(async (current: LlmRuntimeSnapshot, system: string) => {
      if (system.includes("简短中文标题")) return "「测试标题」";
      if (system.includes("只提取")) return JSON.stringify({ names: [" ACME ", "acme"] });
      expect(current.id).toBe("completion");
      return JSON.stringify({ headquarters: "波士顿，美国", businessTags: ["工业机器人"] });
    });
    const gateway = { completeText } as unknown as ModelGateway;
    const service = new ConfiguredLlmService(resolveActiveLlm, gateway);

    await expect(service.generateConversationTitle("首条消息")).resolves.toBe("测试标题");
    await expect(service.recognize("ACME 公司")).resolves.toEqual([{ name: "ACME" }]);
    await expect(service.complete("ACME", { researchTopics: ["机器人"] })).resolves.toEqual({
      headquarters: "波士顿，美国",
      businessTags: ["工业机器人"],
    });

    expect(resolveActiveLlm).toHaveBeenCalledTimes(3);
    expect(completeText.mock.calls.map(([current]) => current.id)).toEqual([
      "title",
      "recognition",
      "completion",
    ]);
  });
});
