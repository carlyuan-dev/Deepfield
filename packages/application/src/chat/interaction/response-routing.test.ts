import { expect, it } from "vitest";
import { classifyExplicitDecision } from "./response-routing.js";
it("accepts only complete explicit decisions", () => {
  expect(classifyExplicitDecision("确认无误！")).toBe("approve");
  expect(classifyExplicitDecision("取消。")).toBe("cancel");
  for (const text of ["选好了，执行", "没问题你提交吧"]) expect(classifyExplicitDecision(text)).toBe("approve");
  for (const text of ["改完再确认", "不同意", "他说‘同意’", "同意，但修改备注", "确认？", "选好了，如果没问题就执行", "选好了，执行但修改备注", "不要提交", "他说选好了，执行"]) expect(classifyExplicitDecision(text)).toBeNull();
});
