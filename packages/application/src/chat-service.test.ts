import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DEEPSEEK_MODEL_ID,
  type AgentWorkerEvent,
  type ChatMessage,
} from "@deepfield/contracts";
import { ChatService, ChatServiceError } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { openTestDb, type TestDb } from "./application-test-helpers.js";
import { chatEvent, deferred, FakeWorker, makeSecrets } from "./chat-service-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

function makeService(
  db: TestDb,
  worker: FakeWorker,
  key = "sk-configured",
  requestIdFactory: () => string = () => "req-1",
) {
  const contextBuilder = new ContextBuilder(db.repos);
  const finished = deferred();
  const service = new ChatService(db.repos, contextBuilder, makeSecrets(key), worker, {
    requestIdFactory,
    onConsumptionFinished: () => finished.resolve(),
  });
  return { service, finished };
}

function makeProject(db: TestDb) {
  const project = db.repos.projects.createWithConversation({
    industry: "人形机器人",
    scope: {},
    launchSource: "direct-ui",
  });
  const conversation = db.repos.conversations.listByProject(project.id)[0]!;
  return { project, conversation };
}

describe("chat service", () => {
  it("rejects blank content before any secret, db or worker access", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker();
    const contextBuilder = new ContextBuilder(db.repos);
    const secrets = makeSecrets("sk-configured");
    const service = new ChatService(db.repos, contextBuilder, secrets, worker);
    const { project, conversation } = makeProject(db);

    await expect(service.send(project.id, "   ", () => {})).rejects.toBeInstanceOf(
      ChatServiceError,
    );
    expect(secrets.getCalls).toBe(0);
    expect(worker.requests).toHaveLength(0);
    expect(db.repos.messages.listByConversation(conversation.id)).toEqual([]);
  });

  it("fails safely when the deepseek key is missing or blank", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker();
    const contextBuilder = new ContextBuilder(db.repos);
    const { project, conversation } = makeProject(db);

    const missing = new ChatService(db.repos, contextBuilder, makeSecrets(undefined), worker);
    await expect(missing.send(project.id, "你好", () => {})).rejects.toBeInstanceOf(
      ChatServiceError,
    );
    expect(worker.requests).toHaveLength(0);
    expect(db.repos.messages.listByConversation(conversation.id)).toEqual([]);
    expect(db.repos.conversations.listByProject(project.id)[0]!.hasUserMessage).toBe(false);
    expect(db.repos.conversations.listRecent()).toEqual([]);

    const blank = new ChatService(db.repos, contextBuilder, makeSecrets("   "), worker);
    await expect(blank.send(project.id, "你好", () => {})).rejects.toBeInstanceOf(
      ChatServiceError,
    );
    expect(worker.requests).toHaveLength(0);
  });

  it("persists the user first, streams events in order and stores one assistant", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        { requestId: request.requestId, type: "text_delta", delta: "测" },
        { requestId: request.requestId, type: "text_delta", delta: "试回" },
        { requestId: request.requestId, type: "completed", text: "测试回复" },
      ],
    });
    const { service, finished } = makeService(db, worker);
    const { project, conversation } = makeProject(db);

    const forwarded: AgentWorkerEvent[] = [];
    let userMessageAtSend: ChatMessage | undefined;
    let contextMessagesAtSend: Array<{ role: string; content: string }> = [];
    worker.onSend = (request) => {
      userMessageAtSend = db.repos.messages.listByConversation(conversation.id)[0];
      contextMessagesAtSend = request.context.messages;
    };

    const result = await service.send(project.id, "你好", (event) => forwarded.push(event));
    expect(result.requestId).toBe("req-1");
    await finished.promise;

    expect(userMessageAtSend).toMatchObject({ role: "user", content: "你好" });
    expect(contextMessagesAtSend.some((message) => message.content === "你好")).toBe(false);
    expect(contextMessagesAtSend.length).toBe(0);

    expect(worker.requests).toHaveLength(1);
    const request = worker.requests[0]!;
    expect(request).toMatchObject({
      requestId: "req-1",
      kind: "chat.prompt",
      prompt: "你好",
      modelId: DEFAULT_DEEPSEEK_MODEL_ID,
      apiKey: "sk-configured",
    });
    expect(request.context.conversationId).toBe(conversation.id);
    expect(request.context.projectId).toBe(project.id);

    expect(forwarded).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "测" },
      { requestId: "req-1", type: "text_delta", delta: "试回" },
      { requestId: "req-1", type: "completed", text: "测试回复" },
    ]);

    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", content: "你好" });
    expect(messages[1]).toMatchObject({ role: "assistant", content: "测试回复" });

    const activities = db.repos.activities.listByProject(project.id);
    const completed = activities.find((activity) => activity.type === "chat.message.completed");
    expect(completed).toMatchObject({ source: "chat", importance: "normal" });
    const payload = JSON.stringify(completed?.payload ?? {});
    expect(payload).not.toContain("测试回复");
    expect(payload).not.toContain("sk-configured");

    expect(db.repos.conversations.listRecent()).toHaveLength(1);
  });

  it("forwards a worker failed event without storing an assistant or completed activity", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "failed", "provider_error")],
    });
    const { service, finished } = makeService(db, worker);
    const { project, conversation } = makeProject(db);

    const forwarded: AgentWorkerEvent[] = [];
    await service.send(project.id, "你好", (event) => forwarded.push(event));
    await finished.promise;

    expect(forwarded).toEqual([
      { requestId: "req-1", type: "failed", code: "provider_error", message: "boom" },
    ]);
    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    const activities = db.repos.activities.listByProject(project.id);
    expect(activities).toHaveLength(1);
    expect(activities[0]!.type).toBe("project.created");
  });

  it("ignores events after the first terminal and persists at most once", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "completed", "最终")],
      postTerminalEvents: [
        { requestId: "req-1", type: "text_delta", delta: "late" },
        chatEvent("req-1", "failed", "late_failure"),
      ],
    });
    const { service, finished } = makeService(db, worker);
    const { project, conversation } = makeProject(db);

    const forwarded: AgentWorkerEvent[] = [];
    await service.send(project.id, "你好", (event) => forwarded.push(event));
    await finished.promise;

    expect(forwarded).toEqual([{ requestId: "req-1", type: "completed", text: "最终" }]);
    const messages = db.repos.messages.listByConversation(conversation.id);
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    const activities = db.repos.activities.listByProject(project.id);
    expect(activities.filter((activity) => activity.type === "chat.message.completed")).toHaveLength(1);
  });

  it("uses an injectable request id factory", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [chatEvent(request.requestId, "completed", "ok")],
    });
    const { service, finished } = makeService(db, worker, "sk-configured", () => "custom-id-9");
    const { project } = makeProject(db);

    const result = await service.send(project.id, "你好", () => {});
    await finished.promise;

    expect(result.requestId).toBe("custom-id-9");
    expect(worker.requests[0]!.requestId).toBe("custom-id-9");
  });

  it("returns the request id immediately while consuming in the background", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({ neverEnds: true });
    const { service } = makeService(db, worker);
    const { project } = makeProject(db);

    const result = await service.send(project.id, "你好", () => {});
    expect(result.requestId).toBe("req-1");
    await new Promise((resolve) => setImmediate(resolve));
    expect(worker.requests).toHaveLength(1);
  });

  it("swallows a throwing renderer sink without unhandled rejection", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        chatEvent(request.requestId, "completed", "最终"),
      ],
    });
    const { service, finished } = makeService(db, worker);
    const { project, conversation } = makeProject(db);

    let sinkCalls = 0;
    await service.send(project.id, "你好", () => {
      sinkCalls += 1;
      throw new Error("sink destroyed");
    });
    await finished.promise;

    expect(sinkCalls).toBe(2);
    expect(db.repos.messages.listByConversation(conversation.id)).toHaveLength(2);
  });
});
