import { describe, expect, it } from "vitest";
import { TOOL_FAILURE_MESSAGES } from "@deepfield/tool-platform";
import { TOOL_FAILURE_CODES } from "./tool-execution-repository.js";

describe("tool failure code allowlist (focused revision)", () => {
  it("matches the public stable codes exactly", () => {
    expect([...TOOL_FAILURE_CODES].sort()).toEqual(Object.keys(TOOL_FAILURE_MESSAGES).sort());
  });

  it("rejects prototype-pollution and non-code lookups", () => {
    expect(TOOL_FAILURE_CODES.has("__proto__")).toBe(false);
    expect(TOOL_FAILURE_CODES.has("constructor")).toBe(false);
    expect(TOOL_FAILURE_CODES.has("toString")).toBe(false);
    expect(TOOL_FAILURE_CODES.has("")).toBe(false);
  });
});
