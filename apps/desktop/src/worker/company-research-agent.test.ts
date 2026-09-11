import { describe, expect, it } from "vitest";
import { CompanyResearchWorkerEventSchema, RESEARCH_DIRECTIONS, getCompanyResearchTemplate, type CompanyResearchWorkerEvent } from "@deepfield/contracts";
import { Value } from "typebox/value";
import { createCompanyResearchAgent } from "./company-research-agent.js";
import { buildCompanyResearchPrompt } from "./company-research-prompt.js";
import { rawResearchRequest, structureResearchRequest, sse } from "./company-research-test-helpers.js";

const completed = { type: "response.completed", response: { status: "completed" } };
const delta = (text: string) => ({ type: "response.output_text.delta", delta: text });
const requests = [rawResearchRequest(), structureResearchRequest()];
const dsmlOpen = "<｜｜DSML｜｜ calls>";
const dsmlClose = "</｜｜DSML｜｜ calls>";
const dsml = `${dsmlOpen}<｜｜DSML｜｜ invoke name="web_search">private-query</｜｜DSML｜｜ invoke>${dsmlClose}`;
const visibleText = (events: CompanyResearchWorkerEvent[]) => events.flatMap((event) => event.type === "text_delta" ? [event.delta] : []).join("");

describe("company research agent", () => {
  describe("raw DSML boundary", () => {
    it.each(["whole", "split"])("rejects two protocol-only responses (%s deltas) without exposing controls", async (chunks) => {
      let calls = 0;
      const events: CompanyResearchWorkerEvent[] = [];
      const request = rawResearchRequest();
      await createCompanyResearchAgent({ fetchFn: async () => {
        calls++;
        return new Response(sse(...(chunks === "whole" ? [dsml] : [...dsml]).map(delta), completed));
      } }).run(request, (event) => events.push(event), new AbortController().signal);
      expect(events).toEqual([
        { requestId: request.requestId, runId: request.runId, stage: "raw", type: "started" },
        { requestId: request.requestId, runId: request.runId, stage: "raw", type: "failed", code: "research_failed", message: "company research failed" },
      ]);
      expect(calls).toBe(2);
    });

    it.each(["whole", "split"])("streams only the report before/after multiple control blocks (%s deltas)", async (chunks) => {
      let calls = 0;
      const events: CompanyResearchWorkerEvent[] = [];
      const text = `报告前文${dsml}报告后文${dsml}。普通 DSML 字样、<tag> 和反斜杠 \\ 不变。`;
      const expected = "报告前文报告后文。普通 DSML 字样、<tag> 和反斜杠 \\ 不变。";
      await createCompanyResearchAgent({ fetchFn: async () => {
        calls++;
        return new Response(sse(...(chunks === "whole" ? [text] : [...text]).map(delta), completed));
      } }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(visibleText(events)).toBe(expected);
      expect(events.at(-1)).toMatchObject({ type: "completed", text: expected });
      expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("private-query");
      expect(calls).toBe(1);
    });

    it.each([dsml, "", " \n "])("retries empty filtered raw once then completes only the real report", async (first) => {
      let calls = 0;
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(sse(delta(++calls === 1 ? first : "真实报告"), completed)) })
        .run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(calls).toBe(2);
      expect(visibleText(events)).toBe("真实报告");
      expect(events.filter((event) => event.type !== "text_delta").map((event) => event.type)).toEqual(["started", "completed"]);
      expect(events.at(-1)).toMatchObject({ type: "completed", text: "真实报告" });
    });

    it.each([dsml, ""])("does not filter or retry the structure stage", async (text) => {
      let calls = 0;
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => { calls++; return new Response(sse(delta(text), completed)); } })
        .run(structureResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(calls).toBe(1);
      expect(visibleText(events)).toBe("");
      expect(events.at(-1)).toMatchObject(text ? { type: "completed", text } : { type: "failed", code: "structuring_failed" });
    });

    it("cancels during the retry fetch with one terminal and releases both bodies", async () => {
      let calls = 0; let disposed = 0;
      const controller = new AbortController();
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => {
        calls++;
        if (calls === 2) controller.abort();
        return new Response(new ReadableStream({ start(stream) {
          stream.enqueue(new TextEncoder().encode(sse(delta(dsml), completed)));
        }, cancel() { disposed++; } }));
      } }).run(rawResearchRequest(), (event) => events.push(event), controller.signal);
      await Promise.resolve();
      expect(calls).toBe(2);
      expect(events.map((event) => event.type)).toEqual(["started", "cancelled"]);
      expect(disposed).toBe(2);
    });

    it.each([false, true])("counts oversized output even when hidden by DSML (hidden=%s)", async (hidden) => {
      let calls = 0;
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => {
        calls++;
        return new Response(sse(delta((hidden ? dsmlOpen : "") + "x".repeat(1_000_001) + (hidden ? dsmlClose : "")), completed));
      } }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(calls).toBe(1);
      expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(events.at(-1)).toMatchObject({ code: "research_failed" });
    });

    it("does not leak an unterminated control block", async () => {
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(sse(delta(`真实报告${dsmlOpen}private-query`), completed)) })
        .run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(visibleText(events)).toBe("真实报告");
      expect(events.at(-1)).toMatchObject({ type: "completed", text: "真实报告" });
    });

    it("does not flush a truncated DSML opening marker as a completed report", async () => {
      let calls = 0;
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => {
        calls++;
        return new Response(sse(delta("<｜｜DSML｜｜ calls"), completed));
      } }).run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(calls).toBe(2);
    });

    it("flushes an ordinary trailing less-than sign without treating prose as DSML", async () => {
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(sse(delta("普通正文 <"), completed)) })
        .run(rawResearchRequest(), (event) => events.push(event), new AbortController().signal);
      expect(visibleText(events)).toBe("普通正文 <");
      expect(events.at(-1)).toMatchObject({ type: "completed", text: "普通正文 <" });
    });
  });

  it.each(requests)("isolates provider tools and visible output for $stage", async (request) => {
    let url: unknown;
    let init: RequestInit | undefined;
    const events: CompanyResearchWorkerEvent[] = [];
    const text = request.stage === "raw" ? "报告 [公告](https://example.com/report)" : '{"coreSummary":[],"sections":[]}';
    await createCompanyResearchAgent({ fetchFn: async (input, options) => {
      url = input; init = options;
      return new Response(sse(delta(text.slice(0, 5)), delta(text.slice(5)), completed));
    } }).run(request, (event) => events.push(event), new AbortController().signal);
    expect(url).toBe("https://api.deepseek.com/responses");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({ model: "deepseek-v4-flash", stream: true, max_output_tokens: 32768 });
    expect(body).not.toHaveProperty("messages");
    if (request.stage === "raw") {
      expect(body.tools).toEqual([{ type: "web_search" }]);
      expect(body.tool_choice).toEqual({ type: "web_search" });
      expect(body.text).toBeUndefined();
      expect(events.map((event) => event.type)).toEqual(["started", "text_delta", "text_delta", "completed"]);
    } else {
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.text).toEqual({ format: { type: "json_object" } });
      expect(events.map((event) => event.type)).toEqual(["started", "completed"]);
      expect(body.input[0].content).toContain("<raw_research_report>\n" + request.rawReportText + "\n</raw_research_report>");
      expect(body.input[0].content).toContain(JSON.stringify(request.context));
      expect(body.input[0].content).toContain(JSON.stringify(request.template));
      expect(body.input[0].content).toContain(JSON.stringify(request.outputSchema));
    }
    expect(events.at(-1)).toEqual({ requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text });
    expect(events.every((event) => Value.Check(CompanyResearchWorkerEventSchema, event))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(request.apiKey);
  });

  it.each(RESEARCH_DIRECTIONS)("injects only selected modules and task context for %s", (direction) => {
    const template = getCompanyResearchTemplate(direction);
    const prompt = buildCompanyResearchPrompt({ ...rawResearchRequest().context, direction }, template);
    const text = prompt.instructions + "\n" + prompt.input;
    for (const [index, section] of template.sections.entries()) {
      for (const value of [section.sectionId, section.coreQuestion, section.coverage, section.boundary]) expect(text).toContain(value);
      expect(text).toContain("## " + (index + 1) + ". " + section.title + " `" + section.sectionId + "`");
    }
    for (const other of RESEARCH_DIRECTIONS.filter((value) => value !== direction)) {
      for (const section of getCompanyResearchTemplate(other).sections) expect(text).not.toContain(section.sectionId);
    }
    for (const expected of ["2026-06-30", "Humanoid actuators", "Humanoid Robotics", "Unitree Robotics", "https://www.unitree.com"]) expect(prompt.input).toContain(expected);
  });

  describe.each(requests)("$stage stream lifecycle", (request) => {
    it("releases an HTTP failure body without exposing its contents", async () => {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(body, { status: 500 }) }).run(request, (event) => events.push(event), new AbortController().signal);
      expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(cancelled).toBe(true);
      expect(body.locked).toBe(false);
    });

    it("finishes on completed without waiting for EOF or emitting trailing data", async () => {
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(sse(delta("valid"), completed, delta("late"))));
      }, cancel() { cancelled = true; } });
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(stream) }).run(request, (event) => events.push(event), new AbortController().signal);
      expect(events.at(-1)).toMatchObject({ type: "completed", text: "valid", stage: request.stage });
      expect(JSON.stringify(events)).not.toContain("late");
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    }, 1000);

    it("cancels a pending fetch and discards its eventual response", async () => {
      const controller = new AbortController();
      let resolveFetch!: (response: Response) => void;
      let cancelled = false;
      const events: CompanyResearchWorkerEvent[] = [];
      const running = createCompanyResearchAgent({ fetchFn: () => new Promise((resolve) => { resolveFetch = resolve; }) }).run(request, (event) => events.push(event), controller.signal);
      controller.abort();
      await running;
      resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
      await Promise.resolve();
      expect(events.map((event) => event.type)).toEqual(["started", "cancelled"]);
      expect(cancelled).toBe(true);
    });

    it.each(["http", "network", "missing body"])("safely rejects %s errors", async (failure) => {
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => {
        if (failure === "network") throw new Error("provider-secret");
        return failure === "http" ? new Response("provider-secret", { status: 401 }) : new Response(null);
      } }).run(request, (event) => events.push(event), new AbortController().signal);
      expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(events.at(-1)).toMatchObject({ stage: request.stage, code: request.stage === "raw" ? "research_failed" : "structuring_failed" });
      expect(JSON.stringify(events)).not.toContain("provider-secret");
    });

    it.each([
      ["missing completion", sse(delta("partial"))],
      ["missing status", sse(delta("partial"), { type: "response.completed", response: {} })],
      ["wrong status", sse(delta("partial"), { type: "response.completed", response: { status: "incomplete" } })],
      ["incomplete", sse(delta("partial"), { type: "response.incomplete", error: "provider-secret" })],
      ["failed", sse(delta("partial"), { type: "response.failed", error: "provider-secret" })],
      ["error", sse(delta("partial"), { type: "error", error: "provider-secret" }, completed)],
      ["empty", sse(completed)],
      ["whitespace", sse(delta(" \n "), completed)],
      ["malformed", "data: {provider-secret\n\n"],
    ])("rejects %s with one safe terminal", async (_name, stream) => {
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(stream) }).run(request, (event) => events.push(event), new AbortController().signal);
      expect(events.filter((event) => ["failed", "cancelled", "completed"].includes(event.type))).toEqual([{
        requestId: request.requestId, runId: request.runId, stage: request.stage, type: "failed",
        code: request.stage === "raw" ? "research_failed" : "structuring_failed",
        message: request.stage === "raw" ? "company research failed" : "company research structuring failed",
      }]);
      if (request.stage === "structure") expect(events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(JSON.stringify(events)).not.toContain("provider-secret");
    });

    it("handles chunked UTF-8 and CRLF with an unterminated final block", async () => {
      const bytes = new TextEncoder().encode(sse(delta("中文报告"), completed).replaceAll("\n", "\r\n").trimEnd());
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      } });
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => new Response(stream) }).run(request, (event) => events.push(event), new AbortController().signal);
      expect(events.at(-1)).toMatchObject({ type: "completed", stage: request.stage, text: "中文报告" });
    });

    it("cancels a pending reader even when the provider stays open", async () => {
      const controller = new AbortController();
      let cancelled = false;
      let ready!: () => void;
      const reading = new Promise<void>((resolve) => { ready = resolve; });
      const stream = new ReadableStream<Uint8Array>({ pull() { ready(); }, cancel() { cancelled = true; } });
      const events: CompanyResearchWorkerEvent[] = [];
      const running = createCompanyResearchAgent({ fetchFn: async () => new Response(stream) }).run(request, (event) => events.push(event), controller.signal);
      await reading;
      controller.abort();
      await running;
      expect(events.map((event) => event.type)).toEqual(["started", "cancelled"]);
      expect(events.at(-1)).toMatchObject({ stage: request.stage });
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    }, 1000);

    it("does not contact the provider when already cancelled", async () => {
      const controller = new AbortController(); controller.abort();
      let called = false;
      const events: CompanyResearchWorkerEvent[] = [];
      await createCompanyResearchAgent({ fetchFn: async () => { called = true; throw new Error("secret"); } }).run(request, (event) => events.push(event), controller.signal);
      expect(called).toBe(false);
      expect(events.map((event) => event.type)).toEqual(["started", "cancelled"]);
      expect(events.at(-1)).toMatchObject({ stage: request.stage });
    });
  });
});
