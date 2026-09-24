import { afterEach, expect, it } from "vitest";
import { openTestDb, type TestDb } from "../testing/application-test-helpers.js";
import { ChatService } from "./chat-service.js";
import { ContextBuilder } from "./context-builder.js";
import { FakeWorker, makeSecrets } from "./chat-service-helpers.js";
import { isChatHelpRequest, renderChatHelp } from "./chat-help.js";

const dbs: TestDb[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.cleanup(); });

it("routes only explicit whole-message feature overview requests", () => {
  expect(isChatHelpRequest("/help")).toBe(true);
  expect(isChatHelpRequest("告诉我，你有哪些交互环境的出入口")).toBe(false);
  expect(isChatHelpRequest("我们有哪些工具可以用？")).toBe(false);
  expect(isChatHelpRequest("我们有哪些功能可以调用？")).toBe(false);
  expect(isChatHelpRequest("我们有什么能力？")).toBe(false);
  expect(isChatHelpRequest("帮我新建一个调研主题：大模型")).toBe(false);
  expect(isChatHelpRequest("请解释 /help 的含义")).toBe(false);
});

it("persists dynamic help without resolving profiles or running a worker", async () => {
  const db = openTestDb(); dbs.push(db);
  const conversation = db.repos.conversations.create();
  const worker = new FakeWorker();
  const profiles = makeSecrets("test-key");
  let ready = true;
  const service = new ChatService(db.repos, new ContextBuilder(db.repos), profiles, worker, {
    helpTools: webSearch => webSearch ? [{ name: "网页搜索", description: "搜索公开网页" }] : [{ name: "计算器", description: "计算算术表达式" }],
    capabilityDirectory: () => ready ? [{ capabilityId: "company", capabilityName: "公司研究", packageVersion: "2", actionId: "create",
      title: "新建主题", description: "创建调研主题", mode: "immediate", effects: { data: "write", consumesResources: false }, contractDigest: `sha256:${"a".repeat(64)}` }] : [],
    capabilityHelp: () => ready ? [{ name: "公司研究", markdown: "整理公司资料。\n\n例如：新建一个主题" }] : [],
  });
  const events: string[] = [];
  await service.send(conversation.id, "/help", "help-1", event => { if (event.type === "completed") events.push(event.text); });
  expect(worker.requests).toHaveLength(0);
  expect(profiles.getCalls).toBe(0);
  expect(profiles.searchCalls).toBe(0);
  expect(events[0]).toContain("### 公司研究\n\n整理公司资料。\n\n例如：新建一个主题");
  expect(events[0]).not.toContain("创建调研主题");
  expect(events[0]).not.toMatch(/sha256|company\/create|版本|参数/);
  ready = false;
  await service.send(conversation.id, "/help", "help-2", event => { if (event.type === "completed") events.push(event.text); }, { webSearch: true });
  expect(events[1]).toContain("网页搜索");
  expect(events[1]).toContain("当前没有可用能力");
  expect(db.repos.messages.listByConversation(conversation.id)).toHaveLength(4);
  for (const [index, question] of ["我们有哪些工具可以用？", "我们有哪些功能可以调用？", "我们有什么能力？"].entries()) {
    await service.send(conversation.id, question, `natural-${index}`, () => {});
  }
  expect(worker.requests.map(request => request.prompt)).toEqual(["我们有哪些工具可以用？", "我们有哪些功能可以调用？", "我们有什么能力？"]);
  await service.send(conversation.id, "帮我新建一个调研主题：大模型", "business-1", () => {});
  expect(worker.requests).toHaveLength(4);
});

it("renders name-only legacy help and never invents action listings", () => {
  expect(renderChatHelp([{ name: "计算器", description: "计算表达式" }], [{ name: "旧能力" }]))
    .toBe("## 工具\n\n- **计算器**：计算表达式\n\n## 能力\n\n### 旧能力");
});
