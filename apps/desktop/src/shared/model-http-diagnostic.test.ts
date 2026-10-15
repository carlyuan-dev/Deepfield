import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";
import { DiagnosticResultSchema, ModelDiagnosticSchema } from "@deepfield/contracts";
import { classifyModelHttpDiagnostic, readModelErrorPrefix } from "./model-http-diagnostic.js";

describe("bounded HTTP error diagnostics", () => {
  it("reads at most 8 KiB while leaving the full SDK response readable", async () => {
    const body = "x".repeat(8192) + "Invalid schema for function 'propose_actions': secret-key";
    const response = new Response(body, { status: 400 });
    const prefix = await readModelErrorPrefix(response);
    expect(new TextEncoder().encode(prefix)).toHaveLength(8192);
    expect(classifyModelHttpDiagnostic(400, prefix, ["propose_actions"])).toEqual({ httpStatus: 400, reason: "unknown" });
    expect(await response.text()).toBe(body);
  });

  it("stops reading the diagnostic branch at the byte budget without waiting for the rest", async () => {
    let reads = 0;
    const reader = {
      read: async () => { reads++; return { done: false, value: new Uint8Array(1024).fill(120) }; },
      cancel: async () => undefined,
      releaseLock: () => undefined,
    };
    const response = { clone: () => ({ body: { getReader: () => reader } }) } as unknown as Response;
    expect(await readModelErrorPrefix(response)).toHaveLength(8192);
    expect(reads).toBe(8);
  });

  it("does not infer a root type or tool name from a generic 400", () => {
    expect(classifyModelHttpDiagnostic(400, "propose_actions object secret-key", ["propose_actions"])).toEqual({ httpStatus: 400, reason: "unknown" });
    expect(classifyModelHttpDiagnostic(400, "Invalid schema for function 'propose_actions': nested property invalid", [])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema" });
  });

  it("classifies a real JSON error message without losing escaped object quotes", () => {
    const body = JSON.stringify({ error: { message: 'Invalid schema for function \'propose_actions\': schema must be a JSON Schema of "type: object", got "type: None". secret-key' } });
    expect(classifyModelHttpDiagnostic(400, body, ["propose_actions"])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema", toolName: "propose_actions", rootObjectRequired: true });
  });

  it("maps an exact missing root type path only to a requested known tool", () => {
    const body = JSON.stringify({ error: { message: "tools[2].function.parameters: missing field `type` secret-key" } });
    expect(classifyModelHttpDiagnostic(400, body, ["request_user_input", "interaction_draft", "propose_actions"])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema", toolName: "propose_actions" });
    expect(classifyModelHttpDiagnostic(400, body, [])).toEqual({ httpStatus: 400, reason: "invalid_tool_schema" });
  });

  it("stops a stalled short error body when the caller deadline expires", async () => {
    const abort = new AbortController();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }), { status: 400 });
    const read = readModelErrorPrefix(response, abort.signal);
    abort.abort();
    await expect(read).resolves.toEqual(expect.any(String));
    void response.body?.cancel();
  });

  it("accepts old results and restricts diagnostics to safe fields", () => {
    const old = { ok: false, latencyMs: 1, code: "provider_error", message: "连接不可用" };
    expect(Check(DiagnosticResultSchema, old)).toBe(true);
    expect(Check(DiagnosticResultSchema, { ...old, diagnostic: { httpStatus: 400, reason: "invalid_tool_schema", rootObjectRequired: true, toolName: "propose_actions" } })).toBe(true);
    expect(Check(ModelDiagnosticSchema, { httpStatus: 400, reason: "unknown", body: "secret-key" })).toBe(false);
    expect(Check(ModelDiagnosticSchema, { httpStatus: 400, reason: "unknown", toolName: "secret-key" })).toBe(false);
  });
});
