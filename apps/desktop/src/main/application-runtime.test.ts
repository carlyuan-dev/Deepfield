import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_DEEPSEEK_MODEL_ID } from "@deepfield/contracts";
import { createApplicationRuntime } from "./application-runtime.js";
import { openTestDb, type TestDb } from "../../../../packages/application/src/application-test-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

describe("application runtime composition", () => {
  it("wires repositories, secrets and worker into working services", async () => {
    const db = openTestDb();
    dbs.push(db);
    const requests: string[] = [];
    const runtime = createApplicationRuntime({
      repositories: db.repos,
      secrets: { get: (name) => (name === "deepseek.apiKey" ? "sk-runtime" : undefined) },
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: { complete: async () => ({}) },
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
    expect(DEFAULT_DEEPSEEK_MODEL_ID).toBe("deepseek-v4-flash");
  });

  it("exposes conversation create, openInitial and listRecent", () => {
    const db = openTestDb();
    dbs.push(db);
    const runtime = createApplicationRuntime({
      repositories: db.repos,
      secrets: { get: () => undefined },
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: { complete: async () => ({}) },
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
      companyRecognizer: { recognize: async () => [] },
      companyCompleter: {
        complete: async (_name, context) => {
          contexts.push(context);
          return { headquarters: "深圳，中国", businessTags: ["人形机器人"] };
        },
      },
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
