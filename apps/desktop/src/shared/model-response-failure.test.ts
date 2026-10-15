import { afterEach, expect, it, vi } from "vitest";
import { PiModelGateway, ModelGatewayError } from "./model-gateway.js";
import { defaultPiRuntime, createPiChatAgent } from "../worker/agent/pi-chat-agent.js";
import { capture, request, FakePiAgent, makeRuntime, stubModel } from "../worker/agent/pi-chat-agent-test-helpers.js";
import { createLlmUsageTransport } from "./usage-collection.js";

const snapshot = { id: "fixture", name: "fixture", provider: "custom" as const, protocol: "openai_compatible" as const, baseUrl: "https://fixture.invalid/v1", modelId: "fixture", contextWindow: 32000, apiKey: "fixture-key" };
const context = { messages: [{ role: "user" as const, content: "fixture", timestamp: 1 }] };
const chunk = 'data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
function brokenBody(code?: string, beforeError?: () => void) {
  let reads = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (reads++ === 0) controller.enqueue(new TextEncoder().encode(chunk));
    else { beforeError?.(); controller.error(new TypeError("secret-body-text", { cause: { code, message: "secret-cause" } })); }
  } }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
afterEach(() => vi.unstubAllGlobals());

it.each(["ECONNRESET", "UND_ERR_SOCKET", undefined])("preserves sanitized direct body failure for %s without retry", async code => {
  const fetch = vi.fn(async () => brokenBody(code)); vi.stubGlobal("fetch", fetch);
  const failure = await new PiModelGateway().completeText(snapshot, "fixture", "fixture").catch(error => error);
  expect(failure).toMatchObject({ stage: "response_body", category: code ? "network" : "unknown", retryable: !!code });
  expect(failure.cause).toBeUndefined();
  expect(JSON.stringify(failure)).not.toContain("secret");
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("gives caller cancellation priority over a body failure", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => brokenBody("ECONNRESET", () => controller.abort())); vi.stubGlobal("fetch", fetch);
  const failure = await new PiModelGateway().completeText(snapshot, "fixture", "fixture", controller.signal).catch(error => error);
  expect(failure).toMatchObject({ category: "timeout" });
  expect(failure.stage).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("clears a previous turn failure before the next stream and excludes HTTP and provider errors", async () => {
  const fetch = vi.fn().mockImplementationOnce(async () => brokenBody("ECONNRESET"))
    .mockImplementationOnce(async () => new Response("unauthorized", { status: 401 }))
    .mockImplementationOnce(async () => new Response('data: {"error":{"message":"provider failure","type":"server_error"}}\n\n', { headers: { "content-type": "text/event-stream" } }));
  vi.stubGlobal("fetch", fetch);
  const session = defaultPiRuntime().createSession(snapshot)!;
  await (await session.streamFn(session.model, context, { apiKey: snapshot.apiKey })).result();
  expect(session.getModelFailure?.()).toMatchObject({ stage: "response_body", category: "network" });
  for (let i = 0; i < 2; i++) {
    const stream = await session.streamFn(session.model, context, { apiKey: snapshot.apiKey });
    expect(session.getModelFailure?.()).toBeUndefined();
    expect(await stream.result()).toMatchObject({ stopReason: "error" });
    expect(session.getModelFailure?.()).toBeUndefined();
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});

it("keeps a failing body consumer unchanged when the internal diagnostic callback throws", async () => {
  const transport = createLlmUsageTransport(snapshot, undefined, async () => brokenBody("ECONNRESET"), () => { throw new Error("diagnostic failed"); });
  const response = await transport.fetch("https://fixture.invalid");
  await expect(response.text()).rejects.toThrow("secret-body-text");
  transport.finish("error");
});

it("does not publish a body failure after cancellation during observer finalization", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async () => brokenBody("ECONNRESET")); vi.stubGlobal("fetch", fetch);
  const failures: ModelGatewayError[] = [];
  const gateway = new PiModelGateway();
  const stream = gateway.createStream(snapshot, event => { if (event.state === "failed") controller.abort(); }, error => failures.push(error))(
    gateway.createModel(snapshot), context, { apiKey: snapshot.apiKey, signal: controller.signal, requestObservation: { requestId: "fixture", phase: "ordinary", origins: [] } } as any);
  await stream.result();
  expect(failures).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not publish body classification when the request observer fails", async () => {
  const fetch = vi.fn(async () => brokenBody("ECONNRESET")); vi.stubGlobal("fetch", fetch);
  const failures: ModelGatewayError[] = [];
  const gateway = new PiModelGateway();
  const stream = gateway.createStream(snapshot, event => { if (event.state === "failed") throw new Error("storage failed"); }, error => failures.push(error))(
    gateway.createModel(snapshot), context, { apiKey: snapshot.apiKey, requestObservation: { requestId: "fixture", phase: "ordinary", origins: [] } } as any);
  await expect(stream.result()).rejects.toThrow("storage failed");
  expect(failures).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each([true, false])("classifies actual Pi Agent body failure precisely: %s", async bodyFailure => {
  const fetch = vi.fn(async () => bodyFailure ? brokenBody("ECONNRESET") : new Response("failure", { status: 500 })); vi.stubGlobal("fetch", fetch);
  const input = request(); input.llm = snapshot;
  const result = await capture(createPiChatAgent(), undefined, input);
  expect(result.error).toMatchObject({ code: bodyFailure ? "stream_failed" : "provider_failed" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not relabel an arbitrary prompt rejection using a previous model failure", async () => {
  const fake = new FakePiAgent({ events: [{ type: "agent_start" }], reject: new Error("storage failed") });
  const runtime = makeRuntime(fake, stubModel);
  const session = runtime.createSession(snapshot)!;
  runtime.createSession = () => ({ ...session, getModelFailure: () => new ModelGatewayError("network", true, undefined, "response_body") });
  const result = await capture(createPiChatAgent(runtime));
  expect(result.error).toMatchObject({ code: "provider_failed" });
});
