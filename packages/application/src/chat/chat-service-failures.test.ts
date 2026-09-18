import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkerEvent } from "@deepfield/contracts";
import { ChatService } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { openTestDb, type TestDb } from "../testing/application-test-helpers.js";
import { chatEvent, deferred, FakeWorker, makeConversation, makeSecrets } from "./chat-service-helpers.js";

const dbs: TestDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.cleanup();
  }
});

function makeService(db: TestDb, worker: FakeWorker) {
  const contextBuilder = new ContextBuilder(db.repos);
  const finished = deferred();
  const service = new ChatService(db.repos, contextBuilder, makeSecrets("sk-configured"), worker, {
    onConsumptionFinished: () => finished.resolve(),
  });
  return { service, finished };
}

async function runFailureCase(
  db: TestDb,
  worker: FakeWorker,
): Promise<{ forwarded: AgentWorkerEvent[]; messages: number }> {
  const { service, finished } = makeService(db, worker);
  const conversation = makeConversation(db);
  const forwarded: AgentWorkerEvent[] = [];
  await service.send(conversation.id, "你好", "req-1", (event) => forwarded.push(event));
  await finished.promise;
  return {
    forwarded,
    messages: db.repos.messages.listByConversation(conversation.id).length,
  };
}

describe("chat service failure synthesis", () => {
  it("synthesizes one sanitized failed when worker.send throws synchronously", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      sendError: new Error("network exploded with sk-configured and 你好"),
    });
    const { forwarded, messages } = await runFailureCase(db, worker);
    expect(forwarded).toEqual([
      { requestId: "req-1", type: "failed", code: "worker_send_failed", message: "chat request failed" },
    ]);
    const serialized = JSON.stringify(forwarded);
    expect(serialized).not.toContain("network exploded");
    expect(serialized).not.toContain("sk-configured");
    expect(serialized).not.toContain("你好");
    expect(messages).toBe(1);
  });

  it("synthesizes one sanitized failed when iteration throws", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        { requestId: request.requestId, type: "text_delta", delta: "半句" },
      ],
      iterateError: new Error("stream broke with sk-configured"),
    });
    const { forwarded, messages } = await runFailureCase(db, worker);
    expect(forwarded).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "半句" },
      { requestId: "req-1", type: "failed", code: "worker_stream_failed", message: "chat request failed" },
    ]);
    expect(JSON.stringify(forwarded)).not.toContain("stream broke");
    expect(JSON.stringify(forwarded)).not.toContain("sk-configured");
    expect(messages).toBe(1);
  });

  it("synthesizes one sanitized failed when the stream ends without a terminal", async () => {
    const db = openTestDb();
    dbs.push(db);
    const worker = new FakeWorker({
      events: (request) => [
        chatEvent(request.requestId, "started"),
        { requestId: request.requestId, type: "text_delta", delta: "半句" },
      ],
    });
    const { forwarded, messages } = await runFailureCase(db, worker);
    expect(forwarded).toEqual([
      { requestId: "req-1", type: "started" },
      { requestId: "req-1", type: "text_delta", delta: "半句" },
      {
        requestId: "req-1",
        type: "failed",
        code: "worker_stream_ended_without_terminal",
        message: "chat request failed",
      },
    ]);
    expect(messages).toBe(1);
  });
});
