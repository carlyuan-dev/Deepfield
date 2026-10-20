import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Type } from "typebox";
import { createFauxCore, type AssistantMessage, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { PiExecutionEvent } from "./index.js";
import { createPiAgentExecutor, createPiAgentRun, type PiSession } from "./runtime.js";

function answer(text: string, tool?: string): AssistantMessage {
  return {
    role: "assistant", content: tool ? [{ type: "text", text }, { type: "toolCall", id: tool, name: tool, arguments: {} }] : [{ type: "text", text }],
    api: "openai-completions", provider: "test", model: "test", stopReason: tool ? "toolUse" : "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function fixture(responses: AssistantMessage[]) {
  const faux = createFauxCore({ api: "openai-completions", provider: "test", tokensPerSecond: 100_000 });
  faux.setResponses(responses);
  const calls: Array<{ tools: string[]; toolChoice: SimpleStreamOptions["toolChoice"] }> = [];
  const session: PiSession = { model: faux.getModel(), streamFn(model, context, options) {
    calls.push({ tools: (context.tools ?? []).map(tool => tool.name), toolChoice: options?.toolChoice });
    return faux.streamSimple(model, context, options);
  } };
  const executed: string[] = [];
  const tool = (name: string) => ({ name, label: name, description: name, parameters: Type.Object({}), async execute() {
    executed.push(name);
    return { content: [{ type: "text" as const, text: "done" }], details: {} };
  } });
  return { calls, session, tool, executed };
}

describe("Base Agent independent execution", () => {
  it.each([1, 2])("reserves a tool-free final request at max=%i and ignores historical turns", async maxAgentTurns => {
    const f = fixture(maxAgentTurns === 1 ? [answer("final")] : [answer("working", "local"), answer("final")]);
    const events: PiExecutionEvent[] = [];
    await createPiAgentExecutor().run({
      requestId: "run", prompt: "do it", systemPrompt: "system", maxAgentTurns, session: f.session,
      tools: [f.tool("local")], messages: [answer("old"), answer("older")],
    }, event => events.push(event), new AbortController().signal);
    expect(f.calls).toHaveLength(maxAgentTurns);
    expect(f.calls.at(-1)).toEqual({ tools: [], toolChoice: "none" });
    expect(f.executed).toEqual(maxAgentTurns === 1 ? [] : ["local"]);
    expect(events.filter(event => event.type === "completed")).toEqual([{ requestId: "run", type: "completed", text: "final" }]);
    if (maxAgentTurns === 2) expect(events.some(event => event.type === "text_reset")).toBe(true);
  });

  it("keeps other tools running and cannot restore a withdrawn tool through a scenario hook", async () => {
    const f = fixture([answer("", "network"), answer("", "local"), answer("final")]);
    let turn = 0;
    const tools = [f.tool("network"), f.tool("local")];
    const run = createPiAgentRun({
      initialState: { model: f.session.model, tools },
      streamFn: f.session.streamFn,
      prepareNextTurnWithContext: context => ({ context: { ...context.context, tools: ++turn === 1 ? [tools[1]!] : tools } }),
    }, { maxAgentTurns: 5 });
    expect(await run.run("work", new AbortController().signal)).toEqual({ status: "completed", text: "final" });
    expect(f.calls.map(call => call.tools)).toEqual([["network", "local"], ["local"], ["local"]]);
    expect(f.executed).toEqual(["network", "local"]);
  });

  it("enforces the private turn limit when a scenario clears Pi's mutable newMessages", async () => {
    const f = fixture([
      answer("", "local"), answer("", "local"), answer("", "local"), answer("", "local"), answer("final"),
    ]);
    const run = createPiAgentRun({
      initialState: { model: f.session.model, tools: [f.tool("local")], messages: [answer("history")] },
      streamFn: f.session.streamFn,
      prepareNextTurnWithContext: context => {
        context.newMessages.splice(0);
        return undefined;
      },
      shouldStopAfterTurn: () => false,
    }, { maxAgentTurns: 3 });
    const result = await run.run("work", new AbortController().signal).catch(error => error);
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2]).toEqual({ tools: [], toolChoice: "none" });
    expect(f.executed).toEqual(["local", "local"]);
    expect(result).toMatchObject({ code: "invalid_final_empty" });
  });

  it("never starts a cancelled run and rejects tool protocol as final success", async () => {
    const cancelled = fixture([answer("unused")]);
    const controller = new AbortController();
    controller.abort();
    await expect(createPiAgentExecutor().run({ requestId: "a", prompt: "x", systemPrompt: "", maxAgentTurns: 1, session: cancelled.session }, () => {}, controller.signal)).rejects.toMatchObject({ code: "stream_failed" });
    expect(cancelled.calls).toHaveLength(0);
    const invalid = fixture([answer("<|DSML|>tool")]);
    const events: PiExecutionEvent[] = [];
    await expect(createPiAgentExecutor().run({ requestId: "b", prompt: "x", systemPrompt: "", maxAgentTurns: 1, session: invalid.session }, event => events.push(event), new AbortController().signal)).rejects.toMatchObject({ code: "invalid_final_protocol" });
    expect(events.some(event => event.type === "completed")).toBe(false);
  });

  it("pairs the handoff batch, skips later execution and makes no next model request", async () => {
    const batch = answer("", "ask");
    batch.content.push({ type: "toolCall", id: "write", name: "write", arguments: {} });
    const f = fixture([batch, answer("must not run")]);
    let requested = false;
    const ask = f.tool("ask");
    const events: PiExecutionEvent[] = [];
    await createPiAgentExecutor().run({
      requestId: "handoff", prompt: "work", systemPrompt: "", maxAgentTurns: 4, session: f.session,
      handoff: { isRequested: () => requested },
      tools: [{ ...ask, async execute() { requested = true; return ask.execute(); } }, f.tool("write")],
    }, event => events.push(event), new AbortController().signal);
    expect(f.calls).toHaveLength(1);
    expect(f.executed).toEqual(["ask"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_activity", name: "write", status: "skipped", budgetConsumed: false }));
    expect(events.filter(event => event.type === "handed_off" || event.type === "completed")).toEqual([{ requestId: "handoff", type: "handed_off" }]);
  });

  it("bundles the safe contract without Pi or Node", async () => {
    const result = await build({ entryPoints: [new URL("./index.ts", import.meta.url).pathname], bundle: true, platform: "browser", write: false, metafile: true });
    expect(Object.keys(result.metafile!.inputs).every(path => /agent\/(index|errors)\.ts$/.test(path))).toBe(true);
  });
});
