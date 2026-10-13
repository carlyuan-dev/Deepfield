import { describe, expect, it } from "vitest";
import { BaseError, captureResult, serializeError, type PublicErrorCodec } from "@deepfield/base/errors";

type TestError =
  | { code: "TEST.INVALID"; category: "input"; context?: { field: string } }
  | { code: "TEST.UNKNOWN"; category: "internal" };

const codec: PublicErrorCodec<TestError> = {
  parse(candidate) {
    if (candidate === null || typeof candidate !== "object") return undefined;
    const value = candidate as Record<string, unknown>;
    if (Object.keys(value).some((key) => !["code", "category", "context"].includes(key))) return undefined;
    if (value.code === "TEST.UNKNOWN" && value.category === "internal" && !("context" in value)) {
      return { code: "TEST.UNKNOWN", category: "internal" };
    }
    if (value.code !== "TEST.INVALID" || value.category !== "input") return undefined;
    if (!("context" in value)) return { code: "TEST.INVALID", category: "input" };
    if (value.context === null || typeof value.context !== "object") return undefined;
    const context = value.context as Record<string, unknown>;
    if (Object.keys(context).length !== 1 || typeof context.field !== "string") return undefined;
    return { code: "TEST.INVALID", category: "input", context: { field: context.field } };
  },
  unknown: () => ({ code: "TEST.UNKNOWN", category: "internal" }),
};

describe("Base.Errors", () => {
  it("retains internal causes while publishing only the local error identity", () => {
    const cause = new Error("private detail");
    const error = new BaseError("TEST.INVALID", "input", undefined, { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BaseError");
    expect(error.message).toBe("TEST.INVALID");
    expect(error.cause).toBe(cause);
    expect(serializeError(error, codec)).toStrictEqual({ code: "TEST.INVALID", category: "input" });
  });

  it("projects ordinary Errors without exposing diagnostic or extra properties", () => {
    const error = Object.assign(new Error("private message", { cause: "private cause" }), {
      code: "TEST.INVALID", category: "input", context: { field: "title" }, apiKey: "secret",
    });
    const result = serializeError(error, codec);
    expect(result).toStrictEqual({ code: "TEST.INVALID", category: "input", context: { field: "title" } });
    if (result.code === "TEST.INVALID") expect(result.context).not.toBe(error.context);
  });

  it("preserves valid local DTOs with independently copied context", () => {
    const dto = { code: "TEST.INVALID", category: "input", context: { field: "title" } };
    const result = serializeError(dto, codec);
    expect(result).toStrictEqual({ code: "TEST.INVALID", category: "input", context: { field: "title" } });
    expect(result).not.toBe(dto);
    if (result.code === "TEST.INVALID") expect(result.context).not.toBe(dto.context);
  });

  it.each([
    { code: "TEST.UNRECOGNIZED", category: "input" },
    { code: "TEST.INVALID", category: "internal" },
    { code: "TEST.INVALID", category: "input", apiKey: "secret" },
    { code: "TEST.INVALID", category: "input", context: { field: "title", apiKey: "secret" } },
    null,
  ])("uses fresh local fallbacks for invalid candidates: %j", (candidate) => {
    const first = serializeError(candidate, codec);
    expect(first).toStrictEqual({ code: "TEST.UNKNOWN", category: "internal" });
    expect(serializeError(candidate, codec)).not.toBe(first);
  });

  it("propagates codec implementation errors", () => {
    const failure = new Error("broken codec");
    expect(() => serializeError(null, { ...codec, parse() { throw failure; } })).toThrow(failure);
    expect(() => serializeError(null, { ...codec, unknown() { throw failure; } })).toThrow(failure);
  });

  it.each([() => 42, async () => 42])("captures successful work", async (work) => {
    await expect(captureResult(work, (error) => serializeError(error, codec))).resolves.toStrictEqual({ ok: true, value: 42 });
  });

  it.each([
    () => { throw new Error("private failure"); },
    async () => { throw new Error("private failure"); },
  ])("captures work failure as a public result", async (work) => {
    await expect(captureResult(work, (error) => serializeError(error, codec))).resolves.toStrictEqual({
      ok: false, error: { code: "TEST.UNKNOWN", category: "internal" },
    });
  });

  it("rejects with a converter failure instead of treating it as a work failure", async () => {
    const failure = new Error("broken converter");
    await expect(captureResult(() => { throw new Error("work failed"); }, () => { throw failure; })).rejects.toBe(failure);
  });
});
