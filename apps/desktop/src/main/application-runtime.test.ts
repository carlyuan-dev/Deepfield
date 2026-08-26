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
      },
    });

    const project = runtime.projectService.create({
      industry: "人形机器人",
      scope: {},
      launchSource: "direct-ui",
    });
    const conversation = db.repos.conversations.listByProject(project.id)[0]!;
    const forwarded: unknown[] = [];
    const result = await runtime.chatService.send(
      project.id,
      "你好",
      "runtime-req-1",
      (event) => forwarded.push(event),
    );
    // Drain the background consumption deterministically (all pending microtasks).
    await new Promise((resolve) => setImmediate(resolve));

    expect(result.requestId).toBe("runtime-req-1");
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
});
