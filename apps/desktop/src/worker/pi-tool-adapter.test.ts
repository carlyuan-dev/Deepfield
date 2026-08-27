import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
  FakeAuditSink,
  FakeRetryClock,
  ToolBudgetLedger,
  ToolPolicy,
  ToolRegistry,
  ToolRunner,
  ToolSet,
} from "@deepfield/tool-platform";
import type { ToolDefinition, ToolRunContext } from "@deepfield/tool-platform";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { FakePiAgent, makeRuntime, request, stubModel } from "./pi-chat-agent-test-helpers.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { createPiAgentTools, type PiToolAdapterContext } from "./pi-tool-adapter.js";

const factInputSchema = Type.Object(
  { subject: Type.String() },
  { additionalProperties: false },
);
const factOutputSchema = Type.Object(
  { fact: Type.String() },
  { additionalProperties: false },
);

function lookupFactDefinition(
  execute: ToolDefinition<typeof factInputSchema, typeof factOutputSchema>["execute"] = async ({ subject }) => ({ fact: `fact for ${subject}` }),
): ToolDefinition<typeof factInputSchema, typeof factOutputSchema> {
  return {
    identity: { name: "lookup_fact", version: 1 },
    label: "Lookup Fact",
    description: "Looks up a fact offline.",
    inputSchema: factInputSchema,
    outputSchema: factOutputSchema,
    effect: "project.read",
    timeoutMs: 1000,
    retry: { maxRetries: 0, backoffMs: 0 },
    concurrency: 1,
    meter: { category: "none", countsBytes: false, countsTime: true },
    model: { formatOutput: (output) => `fact: ${output.fact}` },
    execute,
  };
}

function makeRunner(registry: ToolRegistry, audit: FakeAuditSink, clock = new FakeRetryClock()): ToolRunner {
  return new ToolRunner({
    registry,
    policy: new ToolPolicy(),
    budget: new ToolBudgetLedger({ maxCalls: 100 }, () => clock.now()),
    audit,
    clock,
  });
}

function context(overrides: Partial<ToolRunContext> = {}): PiToolAdapterContext {
  return {
    traceId: "trace-1",
    actor: "main_agent",
    toolSet: new ToolSet([
      { identity: { name: "lookup_fact", version: 1 }, actor: "main_agent", effect: "project.read" },
    ]),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe("pi tool adapter", () => {
  it("generates AgentTools only for granted definitions", () => {
    const registry = new ToolRegistry();
    registry.register(lookupFactDefinition());
    registry.register({
      ...lookupFactDefinition(),
      identity: { name: "fetch_url", version: 1 },
      effect: "network.read.public",
    });
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, context());
    expect(tools.map((tool) => tool.name)).toEqual(["lookup_fact"]);
  });

  it("sends the Pi input to the runner and returns formatOutput text", async () => {
    const registry = new ToolRegistry();
    registry.register(lookupFactDefinition());
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, context(), { executionIdFactory: () => "pi-exec-1" });
    const result = await tools[0]!.execute("pi-call-1", { subject: "robot" }, new AbortController().signal, () => {});
    expect(result.content[0]).toEqual({ type: "text", text: "fact: fact for robot" });
    expect(result.details).toEqual({ executionId: "pi-exec-1" });
    expect(audit.records.some((record) => record.kind === "start")).toBe(true);
    expect(audit.records.some((record) => record.kind === "finish")).toBe(true);
  });

  it("maps controlled tool progress to onUpdate only", async () => {
    const registry = new ToolRegistry();
    registry.register(
      lookupFactDefinition(async (_input, _context, _signal, onProgress) => {
        onProgress?.({ kind: "fetching", message: "working" });
        return { fact: "fact" };
      }),
    );
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, context());
    const updates: unknown[] = [];
    const result = await tools[0]!.execute("pi-call-1", { subject: "robot" }, new AbortController().signal, (update) => updates.push(update));
    expect(result.content[0]).toEqual({ type: "text", text: "fact: fact" });
    // The runner snapshots controlled progress kinds only; free text never crosses.
    expect(updates).toEqual([{ content: [], details: { progress: { kind: "fetching" } } }]);
    expect(JSON.stringify(updates)).not.toContain("working");
  });

  it("propagates cancellation as a safe error", async () => {
    const registry = new ToolRegistry();
    registry.register(
      lookupFactDefinition(async (): Promise<{ fact: string }> => {
        await new Promise(() => {});
        return { fact: "never" };
      }),
    );
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, context());
    const controller = new AbortController();
    const promise = tools[0]!.execute("pi-call-1", { subject: "robot" }, controller.signal, () => {});
    controller.abort();
    await expect(promise).rejects.toThrow(/cancelled/);
  });

  it("converts runner failure into a fixed safe error without leaking cause or keys", async () => {
    const registry = new ToolRegistry();
    registry.register(
      lookupFactDefinition(async () => {
        throw new Error("secret executor failure with apiKey sk-leak");
      }),
    );
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, context());
    let error: unknown;
    try {
      await tools[0]!.execute("pi-call-1", { subject: "robot" }, new AbortController().signal, () => {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("secret executor failure");
    expect(String(error)).not.toContain("sk-leak");
    expect(String(error)).not.toContain("apiKey");
  });

  it("shares one runner and audit gate between direct and Pi paths", async () => {
    let calls = 0;
    const registry = new ToolRegistry();
    registry.register({
      ...lookupFactDefinition(async () => {
        calls += 1;
        return { fact: `fact ${calls}` };
      }),
      concurrency: 2,
    });
    const audit = new FakeAuditSink({ deferFinish: true });
    const clock = new FakeRetryClock();
    const runner = makeRunner(registry, audit, clock);
    const runContext = context();
    const direct = runner.execute(
      { executionId: "direct-1", traceId: "trace-1", tool: { name: "lookup_fact", version: 1 }, input: { subject: "a" } },
      runContext,
      new AbortController().signal,
      () => {},
    );
    const tools = createPiAgentTools(registry, runner, runContext);
    const pi = tools[0]!.execute("pi-call-1", { subject: "b" }, new AbortController().signal, () => {});
    let directDone = false;
    let piDone = false;
    void direct.then(() => {
      directDone = true;
    });
    void pi.then(() => {
      piDone = true;
    });
    await audit.finishSeen();
    await flush();
    expect(directDone).toBe(false);
    expect(piDone).toBe(false);
    audit.releaseFinish();
    const [directResult, piResult] = await Promise.all([direct, pi]);
    expect(directResult.status).toBe("completed");
    expect(piResult.content[0]).toEqual({ type: "text", text: "fact: fact 2" });
    expect(calls).toBe(2);
    expect(audit.records.filter((record) => record.kind === "finish")).toHaveLength(2);
  });

  it("keeps createPiChatAgent tools default to [] and injects explicit tools", async () => {
    const defaultAgent = new FakePiAgent({
      events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [] }],
    });
    await createPiChatAgent(makeRuntime(defaultAgent, stubModel)).run(request(), () => {}, new AbortController().signal);
    expect((defaultAgent.receivedOptions?.initialState as { tools?: unknown[] }).tools).toEqual([]);

    const explicitAgent = new FakePiAgent({
      events: [{ type: "agent_start" } as AgentEvent, { type: "agent_end", messages: [] }],
    });
    const registry = new ToolRegistry();
    registry.register(lookupFactDefinition());
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, context());
    await createPiChatAgent(makeRuntime(explicitAgent, stubModel), tools).run(request(), () => {}, new AbortController().signal);
    expect((explicitAgent.receivedOptions?.initialState as { tools?: unknown[] }).tools).toEqual(tools);
  });
});

const smoke = process.env.DEEPSEEK_API_KEY !== undefined ? describe : describe.skip;

smoke("deepseek tool calling smoke (opt-in, offline echo_probe)", () => {
  it("calls echo_probe and completes after the tool result", async () => {
    const { createToolRuntime, echoProbeDefinition, createTrustedToolSet } = await import("./tool-runtime.js");
    const registry = new ToolRegistry();
    registry.register(echoProbeDefinition());
    const audit = new FakeAuditSink();
    const runner = makeRunner(registry, audit);
    const tools = createPiAgentTools(registry, runner, {
      traceId: "smoke-1",
      actor: "main_agent",
      toolSet: createTrustedToolSet(),
    });
    const agent = createPiChatAgent(undefined, tools);
    const events: { type: string }[] = [];
    await agent.run(
      { ...request(), apiKey: process.env.DEEPSEEK_API_KEY as string },
      (event) => events.push(event),
      new AbortController().signal,
    );
    expect(events.some((event) => event.type === "completed")).toBe(true);
    expect(audit.records.some((record) => record.kind === "finish")).toBe(true);
  }, 30000);
});
