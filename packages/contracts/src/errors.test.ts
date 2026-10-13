import { describe, expect, it } from "vitest";
import { BaseError } from "@deepfield/base/errors";
import { CapabilityUnavailableError } from "@deepfield/capability-sdk";
import * as errors from "./errors.js";

describe("public errors", () => {
  it("keeps AppError identity while sharing the BaseError contract", () => {
    const context = { service: "search" } as const;
    const error = new errors.AppError("CONFIG.CREDENTIAL_MISSING", context);
    expect(error).toBeInstanceOf(BaseError);
    expect(error.name).toBe("AppError");
    expect(error.message).toBe("CONFIG.CREDENTIAL_MISSING");
    expect(error.code).toBe("CONFIG.CREDENTIAL_MISSING");
    expect(error.category).toBe("configuration");
    expect(error.context).toBe(context);
  });
  it("copies public context so callers cannot mutate the input", () => {
    const context: errors.AppErrorContext = { service: "search" };
    const error = new errors.AppError("CONFIG.CREDENTIAL_MISSING", context);
    const result = errors.toPublicError(error);
    expect(result.context).toEqual({ service: "search" });
    expect(result.context).not.toBe(context);
    result.context!.service = "llm";
    expect(context).toEqual({ service: "search" });
  });
  it.each(Object.entries(errors.APP_ERROR_CATEGORIES))("preserves the registered %s identity", (code, category) => {
    const dto = { code, category };
    expect(errors.toPublicError(dto)).toEqual(dto);
    expect(errors.toPublicError(new errors.AppError(code as errors.AppErrorCode))).toEqual(dto);
  });
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
    { code: "CONFIG.INVALID", category: "configuration", context: { service: "storage" } },
    new BaseError("TEST.INVALID", "input"),
    { code: "TEST.INVALID", category: "input" },
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
    expect(errors.toPublicError(foreign)).toEqual({ code: "CONFIG.INVALID", category: "configuration" });
    expect(errors.toPublicError(foreign)).not.toHaveProperty("context");
  });
  it("keeps the SDK exception private unless a DTO supplies its valid category", () => {
    expect(errors.toPublicError(new CapabilityUnavailableError())).toEqual({ code: "INTERNAL.UNKNOWN", category: "internal" });
    expect(errors.toPublicError({ code: "capability_unavailable", category: "resource" })).toEqual({ code: "capability_unavailable", category: "resource" });
  });
});

describe("appResult compatibility", () => {
  it("wraps a synchronous success", async () => {
    expect(await errors.appResult(() => 42)).toEqual({ ok: true, value: 42 });
  });
  it("wraps a synchronous AppError", async () => {
    expect(await errors.appResult(() => { throw new errors.AppError("CONFIG.INVALID"); })).toEqual({ ok: false, error: { code: "CONFIG.INVALID", category: "configuration" } });
  });
  it("wraps an asynchronous AppError", async () => {
    expect(await errors.appResult(async () => { throw new errors.AppError("CONFIG.INVALID"); })).toEqual({ ok: false, error: { code: "CONFIG.INVALID", category: "configuration" } });
  });
});
