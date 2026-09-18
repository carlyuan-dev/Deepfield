import { describe, expect, it, vi } from "vitest";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";
import { ModelGatewayError, type ModelGateway } from "../shared/model-gateway.js";
import { ConfiguredLlmService, normalizeConversationTitle } from "./configured-llm-service.js";

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
  it("keeps title and name recognition offline without a profile completion pipeline", async () => {
    const profiles = [profile("title"), profile("recognition")];
    const resolveActiveLlm = vi.fn(async () => profiles.shift()!);
    const completeText = vi.fn(async (current: LlmRuntimeSnapshot, system: string) => {
      if (system.includes("简短中文标题")) return "「首条消息测试标题」";
      if (system.includes("只提取")) return JSON.stringify({ names: [" ACME ", "acme"] });
      throw new Error("unexpected task");
    });
    const gateway = { completeText } as unknown as ModelGateway;
    const service = new ConfiguredLlmService(resolveActiveLlm, gateway);

    await expect(service.generateConversationTitle("首条消息")).resolves.toBe("首条消息测试标题");
    await expect(service.recognize("ACME 公司")).resolves.toEqual([{ name: "ACME" }]);
    expect(service).not.toHaveProperty("complete");

    expect(resolveActiveLlm).toHaveBeenCalledTimes(2);
    expect(completeText.mock.calls.map(([current]) => current.id)).toEqual([
      "title",
      "recognition",
    ]);
  });

  it("bounds title input, retries one transient request failure, and reports safe categories", async () => {
    const diagnostics: string[] = [];
    const completeText = vi.fn()
      .mockRejectedValueOnce(new ModelGatewayError("network", true))
      .mockResolvedValueOnce("产业链竞争格局分析");
    const service = new ConfiguredLlmService(async () => profile("title"), { completeText } as unknown as ModelGateway, {
      onTitleDiagnostic: (diagnostic) => diagnostics.push(diagnostic.category),
    });
    await expect(service.generateConversationTitle("请帮我".repeat(1000))).resolves.toBe("产业链竞争格局分析");
    expect(completeText).toHaveBeenCalledTimes(2);
    expect(Array.from(completeText.mock.calls[0]![2] as string).length).toBeLessThanOrEqual(1000);
    expect(diagnostics).toEqual(["request_retry"]);
  });

  it("does not retry permanent or unknown gateway failures", async () => {
    for (const error of [new ModelGatewayError("authentication", false), new Error("unknown")]) {
      const completeText = vi.fn().mockRejectedValue(error);
      const service = new ConfiguredLlmService(async () => profile("title"), { completeText } as unknown as ModelGateway);
      await expect(service.generateConversationTitle("分析机器人行业")).resolves.toBeUndefined();
      expect(completeText).toHaveBeenCalledTimes(1);
    }
  });

  it("normalizes simple title prefixes, rejects structural wrappers, and allows valid subject words", () => {
    expect(normalizeConversationTitle("标题：天气查询")).toBe("天气查询");
    expect(normalizeConversationTitle("人工智能解释")).toBe("人工智能解释");
    expect(normalizeConversationTitle("产品使用说明书")).toBe("产品使用说明书");
    expect(normalizeConversationTitle('["机器人产业链"]')).toBeUndefined();
    expect(normalizeConversationTitle("**机器人产业链**")).toBeUndefined();
    expect(normalizeConversationTitle("<title>机器人产业链</title>")).toBeUndefined();
    expect(normalizeConversationTitle("以下是标题：机器人产业链")).toBeUndefined();
  });

  it("does not retry configuration or invalid output and keeps invalid titles as fallback", async () => {
    const unavailable = vi.fn().mockRejectedValue(new Error("missing profile secret"));
    const configDiagnostics: string[] = [];
    const missing = new ConfiguredLlmService(unavailable, { completeText: vi.fn() } as unknown as ModelGateway, {
      onTitleDiagnostic: (value) => configDiagnostics.push(value.category),
    });
    await expect(missing.generateConversationTitle("问题")).resolves.toBeUndefined();
    expect(configDiagnostics).toEqual(["configuration"]);

    const completeText = vi.fn().mockResolvedValue("下面是标题：机器人");
    const invalidDiagnostics: string[] = [];
    const invalid = new ConfiguredLlmService(async () => profile("title"), { completeText } as unknown as ModelGateway, {
      onTitleDiagnostic: (value) => invalidDiagnostics.push(value.category),
    });
    await expect(invalid.generateConversationTitle("问题")).resolves.toBeUndefined();
    expect(completeText).toHaveBeenCalledTimes(1);
    expect(invalidDiagnostics).toEqual(["invalid_output"]);
    expect(normalizeConversationTitle("```json\n{\"title\":\"机器人\"}\n```")).toBeUndefined();
  });

  it("aborts each bounded title attempt and falls back after one retry", async () => {
    const signals: AbortSignal[] = [];
    const diagnostics: string[] = [];
    const gateway = {
      completeText: vi.fn((_snapshot, _system, _prompt, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<string>(() => {});
      }),
    } as unknown as ModelGateway;
    const service = new ConfiguredLlmService(async () => profile("title"), gateway, {
      titleTimeoutMs: 5,
      onTitleDiagnostic: (value) => diagnostics.push(value.category),
    });
    await expect(service.generateConversationTitle("分析机器人行业")).resolves.toBeUndefined();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(diagnostics).toEqual(["request_retry", "timeout"]);
  });
});
