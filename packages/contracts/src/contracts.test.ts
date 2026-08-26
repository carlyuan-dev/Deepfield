import { describe, expect, it } from "vitest";
import { Value } from "typebox/value";
import { CreateProjectInputSchema, AgentWorkerEventSchema } from "./index.js";

describe("shared contracts", () => {
  it("accepts a required industry and optional structured scope", () => {
    expect(Value.Check(CreateProjectInputSchema, {
      industry: "人形机器人",
      scope: { focus: "整机与核心零部件", exclusions: ["工业机械臂"] },
      launchSource: "direct-ui",
    })).toBe(true);
    expect(Value.Check(CreateProjectInputSchema, { scope: {} })).toBe(false);
  });

  it("rejects malformed worker stream events", () => {
    expect(Value.Check(AgentWorkerEventSchema, {
      requestId: "req_1",
      type: "text_delta",
      delta: "你好",
    })).toBe(true);
    expect(Value.Check(AgentWorkerEventSchema, {
      requestId: "req_1",
      type: "text_delta",
    })).toBe(false);
  });
});
