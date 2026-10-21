import { expect, it, vi } from "vitest";
import { InteractionResponseClassifier } from "./response-intent.js";
import type { ModelGateway } from "../../shared/model-gateway.js";
import type { LlmRuntimeSnapshot } from "@deepfield/contracts";

const setup = (result = "approve") => {
  const completeText = vi.fn<ModelGateway["completeText"]>(async () => result);
  const classifier = new InteractionResponseClassifier(async () => ({}) as LlmRuntimeSnapshot, { completeText } as unknown as ModelGateway);
  return { classifier, completeText };
};
it("classifies a natural current confirmation with only the displayed summary and message", async () => {
  const f = setup();
  expect(await f.classifier.classify("现在可以开始了", "提交便签：项目计划", "request")).toBe("approve");
  expect(f.completeText).toHaveBeenCalledOnce();
  expect(JSON.parse(f.completeText.mock.calls[0]![2]!)).toEqual({ pendingSummary: "提交便签：项目计划", userMessage: "现在可以开始了" });
});
it("accepts only a single enum in common model wrappers", async () => {
  for (const output of ['"approve"', '```json\n{"intent":"approve"}\n```', "APPROVE"]) {
    expect(await setup(output).classifier.classify("现在可以开始了", "提交便签", "request")).toBe("approve");
  }
  for (const output of ['{"intent":"approve","condition":"change first"}', "approve if ready", "approve\ncancel"]) {
    expect(await setup(output).classifier.classify("现在可以开始了", "提交便签", "request")).toBe("unclear");
  }
});
it("keeps negative, edited and quoted assent from approving old values", async () => {
  const f = setup();
  for (const text of ["不同意，请等等", "没问题但先修改备注", "他说“没问题你提交吧”"]) {
    expect(await f.classifier.classify(text, "提交便签", "request")).toBe("unclear");
  }
  expect(f.completeText).not.toHaveBeenCalled();
});
it("fails closed on invalid model output and uses the explicit fast path without a request", async () => {
  const f = setup('{"approved":true}');
  expect(await f.classifier.classify("现在可以开始了", "提交便签", "request")).toBe("unclear");
  expect(await f.classifier.classify("确认无误！", "提交便签", "explicit")).toBe("approve");
  expect(f.completeText).toHaveBeenCalledOnce();
});
