import type { CompanyProfileCompleter } from "@deepfield/application";
import type { CompanyProfileFields } from "@deepfield/contracts";
import { profileResult } from "../../../../packages/application/src/testing/company-profile-test-fixtures.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_MODEL_ID, getCompanyResearchTemplate,
  type CompanyResearchWorkerRequest,
  type LlmRuntimeSnapshot,
  type SearchRuntimeSnapshot,
} from "@deepfield/contracts";
import { createApplicationRuntime } from "./application-runtime.js";
import { AgentWorkerClient } from "./agent-worker-client.js";
import { FakeEndpoint } from "./agent-worker-client-test-helpers.js";
import { openTestDb, type TestDb } from "../../../../packages/application/src/testing/application-test-helpers.js";

const dbs: TestDb[] = [];
const llmSnapshot: LlmRuntimeSnapshot = {
  id: "llm-runtime-test",
  name: "DeepSeek",
  provider: "deepseek",
  protocol: "openai_compatible",
  baseUrl: "https://api.deepseek.com",
  modelId: DEFAULT_DEEPSEEK_MODEL_ID,
  contextWindow: 128_000,
  apiKey: "sk-runtime",
};
const searchSnapshot: SearchRuntimeSnapshot = {
  id: "search-runtime-test",
  name: "Tavily",
  provider: "tavily",
  baseUrl: "https://api.tavily.com",
  options: {},
  apiKey: "search-runtime-key",
};
const runtimeProfiles = () => ({
  resolveActiveLlm: async () => llmSnapshot,
  resolveActiveSearch: async () => searchSnapshot,
});

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("application runtime composition", () => {
  it.each([
    ["raw", "completed"], ["raw", "cancelled"],
    ["structure", "completed"], ["structure", "cancelled"],
  ] as const)("releases a deleted %s target on %s and wakes queued profiles", async (stage, terminal) => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "智能眼镜" });
    const company = db.repos.companies.upsert({ name: "待删除公司" });
    const survivor = db.repos.companies.upsert({ name: "排队公司" });
    db.repos.itemCompanies.add(item.id, company.id);
    db.repos.itemCompanies.add(item.id, survivor.id);
    const endpoint = new FakeEndpoint(); const client = new AgentWorkerClient(endpoint);
    const profiles: string[] = [];
    const runtime = createApplicationRuntime({
      repositories: db.repos, secrets: { get: () => "sk-test" }, worker: client,
      profiles: runtimeProfiles(),
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: profileCompleter({ complete: async (name) => { profiles.push(name); return { headquarters: "中国北京" }; } }),
    });
    const events: unknown[] = [];
    runtime.companyResearch.subscribe((event) => events.push(event));
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const run = await runtime.companyResearch.start(item.id, company.id, { direction: "product_and_technology", asOfDate: "2024-02-29" });
      await flush();
      if (stage === "structure") {
        const request = endpoint.posted[0] as CompanyResearchWorkerRequest;
        endpoint.emit({ requestId: request.requestId, runId: run.id, stage: "raw", type: "completed", text: "原始报告" });
        await flush();
      }
      const request = endpoint.posted.at(-1) as CompanyResearchWorkerRequest;
      runtime.industryResearch.removeCompany(item.id, company.id);
      expect(db.repos.companyResearchRuns.getByIdForTarget(item.id, company.id, run.id)).toBeUndefined();
      const during = runtime.companyResearch.getState(item.id, survivor.id);
      expect(runtime.companyResearch.isRunning()).toBe(true);
      expect(profiles).toEqual([]);
      const cancellation = terminal === "cancelled" ? runtime.companyResearch.cancel(run.id) : undefined;
      const valid = {
        coreSummary: ["现有公开信息不足以形成可靠的核心判断。"],
        sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId) => ({ sectionId, status: "not_found", summary: null, facts: [] })),
      };
      endpoint.emit({ requestId: request.requestId, runId: run.id, stage, type: terminal, ...(terminal === "completed" ? { text: stage === "raw" ? "原始报告" : JSON.stringify(valid) } : {}) });
      await cancellation; await flush(); await runtime.companyProfiles.whenIdle();
      expect(events).toHaveLength(stage === "raw" ? 2 : 3);
      expect(events.at(-1)).toEqual({ type: "state_changed", runId: run.id, itemId: item.id, companyId: company.id });
      expect(runtime.companyResearch.isRunning()).toBe(false);
      expect(runtime.companyResearch.getState(item.id, survivor.id).globalActiveRun).toBeNull();
      expect(profiles).toEqual(["排队公司"]);
      expect(db.repos.companies.getById(survivor.id)?.profileStatus).toBe("ready");
      expect(during.globalActiveRun).toEqual({ runId: run.id, itemId: item.id, companyId: company.id, stage });
    } finally {
      runtime.companyProfiles.dispose(); client.dispose(); await flush();
    }
  });

  it.each(["raw", "structure"] as const)("ignores foreign %s identities through the real client and completes the service run", async (stage) => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "智能眼镜" });
    const company = db.repos.companies.upsert({ name: "小米" });
    db.repos.itemCompanies.add(item.id, company.id);
    const endpoint = new FakeEndpoint();
    const client = new AgentWorkerClient(endpoint);
    const runtime = createApplicationRuntime({
      repositories: db.repos, secrets: { get: () => "sk-runtime" }, worker: client,
      profiles: runtimeProfiles(),
      companyRecognizer: { recognize: async () => [] }, companyCompleter: profileCompleter({ complete: async () => ({}) }),
    });
    const events: unknown[] = [];
    runtime.companyResearch.subscribe((event) => events.push(event));
    const emitCompletion = (request: CompanyResearchWorkerRequest, text: string) => endpoint.emit({
      requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text,
    });
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const run = await runtime.companyResearch.start(item.id, company.id, { direction: "product_and_technology", asOfDate: "2024-02-29" });
      await flush();
      const rawRequest = endpoint.posted[0] as CompanyResearchWorkerRequest;
      expect(rawRequest.stage).toBe("raw");
      if (stage === "structure") { emitCompletion(rawRequest, "原始报告"); await flush(); }
      const current = endpoint.posted.at(-1) as CompanyResearchWorkerRequest;
      expect(current.stage).toBe(stage);
      for (const identity of [{ requestId: "foreign-request" }, { runId: "foreign-run" }, { stage: stage === "raw" ? "structure" : "raw" }]) {
        endpoint.emit({ requestId: current.requestId, runId: run.id, stage, type: "completed", text: "foreign candidate", ...identity });
      }
      await flush();
      expect(runtime.companyResearch.getRun(item.id, company.id, run.id)?.status).toBe(stage === "raw" ? "researching" : "structuring");
      expect(runtime.companyResearch.isRunning()).toBe(true);
      expect(client.pendingCount()).toBe(1);
      if (stage === "raw") { emitCompletion(rawRequest, "原始报告"); await flush(); }
      const structureRequest = endpoint.posted[1] as CompanyResearchWorkerRequest;
      expect(structureRequest.stage).toBe("structure");
      const valid = {
        coreSummary: ["现有公开信息不足以形成可靠的核心判断。"],
        sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId) => ({ sectionId, status: "not_found", summary: null, facts: [] })),
      };
      emitCompletion(structureRequest, JSON.stringify(valid)); await flush();
      expect(runtime.companyResearch.getRun(item.id, company.id, run.id)).toMatchObject({ status: "completed", rawReportText: "原始报告", structuredContent: valid });
      expect(runtime.companyResearch.isRunning()).toBe(false);
      expect(client.pendingCount()).toBe(0);
      expect(endpoint.posted).toHaveLength(2);
      expect(events).toEqual(Array.from({ length: 3 }, () => ({ type: "state_changed", itemId: item.id, companyId: company.id, runId: run.id })));
    } finally {
      runtime.companyProfiles.dispose();
      client.dispose();
      await flush();
    }
  });

  it.each(["researching", "structuring"])("recovers abandoned %s before starting profile enrichment", async (status) => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "智能眼镜" });
    const company = db.repos.companies.upsert({ name: "待补全公司" });
    db.repos.itemCompanies.add(item.id, company.id);
    const input = { direction: "product_and_technology", asOfDate: "2026-09-11" } as const;
    const run = db.repos.companyResearchRuns.createResearching(item.id, company.id, input, {
      ...input, companyName: company.name, topicName: item.industry, currentDate: "2026-09-11",
    }, getCompanyResearchTemplate(input.direction));
    if (status === "structuring") db.repos.companyResearchRuns.completeRaw(run.id, "已保存原始报告");
    const observed: unknown[] = [];
    const runtime = createApplicationRuntime({
      repositories: db.repos, secrets: { get: () => "sk-runtime" },
      profiles: runtimeProfiles(),
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: profileCompleter({ complete: async () => {
        observed.push(db.repos.companyResearchRuns.getActive());
        return { headquarters: "中国北京" };
      } }),
      worker: {
        send: () => ({ async *[Symbol.asyncIterator]() {} }),
        sendResearch: () => { throw Error("startup must not restart research"); },
        cancelResearch: () => {},
      },
    });
    await runtime.companyProfiles.whenIdle();
    expect(runtime.companyResearch.isRunning()).toBe(false);
    expect(runtime.companyResearch.getRun(item.id, company.id, run.id)).toMatchObject(
      status === "researching"
        ? { status: "research_failed", lastFailureCode: "incomplete_response" }
        : { status: "structure_failed", lastFailureCode: "structuring_failed" },
    );
    expect(observed).toEqual([undefined]);
    expect(db.repos.companies.getById(company.id)?.profileStatus).toBe("ready");
    runtime.companyProfiles.dispose();
  });

  it.each(["completed", "structure_failed"])("keeps enrichment paused across both stages, permits Chat, and resumes on %s", async (terminal) => {
    const db = openTestDb(); dbs.push(db);
    const item = db.repos.capabilityItems.create({ industry: "智能眼镜" });
    const company = db.repos.companies.upsert({ name: "小米" });
    db.repos.itemCompanies.add(item.id, company.id);
    const requests: CompanyResearchWorkerRequest[] = [];
    const finish = new Map<string, (text: string) => void>();
    const completedProfiles: string[] = [];
    const runtime = createApplicationRuntime({
      repositories: db.repos, secrets: { get: () => "sk-runtime" },
      profiles: runtimeProfiles(),
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: profileCompleter({ complete: async (name) => { completedProfiles.push(name); return { headquarters: "中国北京" }; } }),
      worker: {
        send: (request) => ({ async *[Symbol.asyncIterator]() {
          yield { requestId: request.requestId, type: "completed", text: "独立 Chat" } as const;
        } }),
        sendResearch: (request) => {
          requests.push(request);
          return (async function* () {
            const text = await new Promise<string>((resolve) => finish.set(request.requestId, resolve));
            yield { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "completed", text } as const;
          })();
        },
        cancelResearch: () => {},
      },
    });
    const run = await runtime.companyResearch.start(item.id, company.id, { direction: "product_and_technology", asOfDate: "2024-02-29" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(completedProfiles).toEqual([]);
    const conversation = runtime.conversationService.create();
    await runtime.chatService.send(conversation.id, "你好", "parallel-chat", () => {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(db.repos.messages.listByConversation(conversation.id).at(-1)?.content).toBe("独立 Chat");
    expect(runtime.companyResearch.isRunning()).toBe(true);
    finish.get(requests[0]!.requestId)!("原始报告");
    await new Promise((resolve) => setImmediate(resolve));
    expect(requests.map((request) => request.stage)).toEqual(["raw", "structure"]);
    expect(completedProfiles).toEqual([]);
    expect(runtime.companyResearch.isRunning()).toBe(true);
    const valid = {
      coreSummary: ["现有公开信息不足以形成可靠的核心判断。"],
      sections: ["products_and_positioning", "technology_and_metrics", "development_and_readiness", "competitive_position", "constraints_and_roadmap"].map((sectionId) => ({ sectionId, status: "not_found", summary: null, facts: [] })),
    };
    finish.get(requests[1]!.requestId)!(terminal === "completed" ? JSON.stringify(valid) : "invalid candidate");
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.companyProfiles.whenIdle();
    expect(runtime.companyResearch.getRun(item.id, company.id, run.id)?.status).toBe(terminal);
    expect(completedProfiles).toEqual(["小米"]);
    expect(db.repos.companies.getById(company.id)?.profileStatus).toBe("ready");
    runtime.companyProfiles.dispose();
  });

  it("wires repositories, secrets and worker into working services", async () => {
    const db = openTestDb();
    dbs.push(db);
    const requests: string[] = [];
    const runtime = createApplicationRuntime({
      repositories: db.repos,
      secrets: { get: (name) => (name === "deepseek.apiKey" ? "sk-runtime" : undefined) },
      profiles: runtimeProfiles(),
      llmHelpers: {
        recognize: async () => [],
        generateConversationTitle: async () => "运行时标题",
      },
      worker: {
        send: (request) => {
          requests.push(request.requestId);
          return {
            async *[Symbol.asyncIterator]() {
              yield { requestId: request.requestId, type: "started" };
              yield { requestId: request.requestId, type: "completed", text: "运行结果" };
            },
          };
        },
        sendResearch: () => ({ async *[Symbol.asyncIterator]() {} }),
        cancelResearch: () => {},
      },
    });

    // Capability storage stays isolated from standalone Conversations.
    runtime.industryResearch.createItem({ industry: "人形机器人" });
    expect(db.repos.conversations.listRecent()).toEqual([]);

    const conversation = runtime.conversationService.create();
    const forwarded: unknown[] = [];
    const result = await runtime.chatService.send(
      conversation.id,
      "你好",
      "runtime-req-1",
      (event) => forwarded.push(event),
    );
    // Drain the background consumption deterministically (all pending microtasks).
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.requestId).toBe("runtime-req-1");
    expect(result.conversation.id).toBe(conversation.id);
    expect(requests).toEqual([result.requestId]);
    expect(forwarded).toEqual([
      { requestId: result.requestId, type: "started" },
      { requestId: result.requestId, type: "completed", text: "运行结果" },
    ]);
    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ role: "assistant", content: "运行结果" });
    expect(requests[0] && runtime.chatService).toBeDefined();
    expect(DEFAULT_DEEPSEEK_MODEL_ID).toBe("deepseek-flash");
  });

  it("exposes conversation create, openInitial and listRecent", () => {
    const db = openTestDb();
    dbs.push(db);
    const runtime = createApplicationRuntime({
      repositories: db.repos,
      secrets: { get: () => undefined },
      profiles: runtimeProfiles(),
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: profileCompleter({ complete: async () => ({}) }),
      worker: {
        send: () => ({
          async *[Symbol.asyncIterator]() {
            /* no events */
          },
        }),
        sendResearch: () => ({ async *[Symbol.asyncIterator]() {} }),
        cancelResearch: () => {},
      },
    });

    const created = runtime.conversationService.create();
    expect(created.title).toBe("新对话");
    const initial = runtime.conversationService.openInitial();
    expect(initial.active.id).toBe(created.id);
    expect(initial.recent).toEqual([]);
    expect(runtime.conversationService.listRecent()).toEqual([]);
  });

  it("recovers a pending company's persisted research topics for profile disambiguation", async () => {
    const db = openTestDb();
    dbs.push(db);
    const contexts: unknown[] = [];
    const runtime = createApplicationRuntime({
      repositories: db.repos,
      secrets: { get: () => undefined },
      profiles: runtimeProfiles(),
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: profileCompleter({
        complete: async (_name, context) => {
          contexts.push(context);
          return { headquarters: "深圳，中国", businessTags: ["人形机器人"] };
        },
      }),
      worker: {
        send: () => ({ async *[Symbol.asyncIterator]() {} }),
        sendResearch: () => ({ async *[Symbol.asyncIterator]() {} }),
        cancelResearch: () => {},
      },
    });
    const topic = runtime.industryResearch.createItem({ industry: "人形机器人" });

    runtime.industryResearch.addCompany(topic.id, { name: "乐奇" });
    await runtime.companyProfiles.whenIdle();

    expect(contexts).toEqual([{ researchTopics: ["人形机器人"] }]);
  });
});

function profileCompleter(completer: { complete(name: string, context?: { researchTopics?: string[] }): Promise<CompanyProfileFields> }): CompanyProfileCompleter {
  return { prepare: async (company, researchTopics) => async () => profileResult(await completer.complete(company.name, { researchTopics })) };
}
