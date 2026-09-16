import { describe, expect, it } from "vitest";
import * as errors from "./errors.js";

describe("public errors", () => {
  it("serializes only the registered identity and service, never an internal cause", () => {
    const error = new errors.AppError("CONFIG.CREDENTIAL_MISSING", { service: "search" }, { cause: new Error("secret token") });
    expect(errors.toPublicError(error)).toEqual({ code: "CONFIG.CREDENTIAL_MISSING", category: "configuration", context: { service: "search" } });
    expect(JSON.stringify(errors.toPublicError(error))).not.toContain("secret");
  });
  it.each([
    new Error("secret token"), { code: "secret token" },
    { code: "CONFIG.INVALID", category: "external" },
    { code: "CONFIG.INVALID", category: "configuration", message: "secret token" },
    { code: "CONFIG.INVALID", category: "configuration", context: { service: "llm", apiKey: "secret token" } },
  ])("rejects unknown or overpopulated public error data", (value) => {
    expect(errors.toPublicError(value)).toEqual({ code: "INTERNAL.UNKNOWN", category: "internal" });
  });
  it("accepts a cloned DTO with no class prototype", () => {
    expect(errors.toPublicError(structuredClone({ code: "EXTERNAL.TIMEOUT", category: "external", context: { service: "llm" } }))).toEqual({ code: "EXTERNAL.TIMEOUT", category: "external", context: { service: "llm" } });
  });
  it("does not clone a foreign Error's non-enumerable message and cause", () => {
    const foreign = Object.assign(new Error("secret token", { cause: "secret cause" }), { code: "CONFIG.INVALID", category: "configuration" });
    expect(JSON.stringify(errors.toPublicError(foreign))).not.toContain("secret");
    expect(errors.toPublicError(foreign)).not.toBeInstanceOf(Error);
  });
});
