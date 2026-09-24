import { expect, it } from "vitest";
import { classifyExplicitDecision } from "./response-routing.js";
it("accepts only complete explicit decisions", () => {
  expect(classifyExplicitDecision("确认无误！")).toBe("approve");
  expect(classifyExplicitDecision("取消。")).toBe("cancel");
  for (const text of ["改完再确认", "不同意", "他说‘同意’", "同意，但修改备注", "确认？"]) expect(classifyExplicitDecision(text)).toBeNull();
});
