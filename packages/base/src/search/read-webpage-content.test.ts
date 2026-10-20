import { describe, expect, it } from "vitest";
import { FakeAuditSink, FakeRetryClock, ToolBudgetLedger, ToolPolicy, ToolRegistry, ToolRunner, ToolSet } from "../tools/runtime.js";
import { createReadWebpageDefinition } from "../tools/web/read-webpage-tool.js";
import { ResourceStore } from "./resource-store.js";

async function read(html: string) {
  const store = new ResourceStore();
  const definition = createReadWebpageDefinition({
    store,
    transport: {
      async fetch(_url, options) {
        options?.onExternalDispatch?.();
        const body = Buffer.from(html);
        return { statusCode: 200, finalUrl: "https://example.com/article", contentType: "text/html", body, decompressedBytes: body.length, sha256: "fixture" };
      },
    },
  });
  const registry = new ToolRegistry();
  registry.register(definition);
  registry.freeze();
  const clock = new FakeRetryClock();
  const audit = new FakeAuditSink();
  const budget = new ToolBudgetLedger({ maxCalls: 1, categoryCalls: { fetch: 1 } }, () => clock.now());
  const runner = new ToolRunner({ registry, policy: new ToolPolicy(), budget, audit, clock });
  const result = await runner.execute(
    { executionId: "read", traceId: "trace", tool: definition.identity, input: { url: "https://example.com/article" } },
    { traceId: "trace", actor: "main_agent", toolSet: new ToolSet([{ identity: definition.identity, actor: "main_agent", effect: "network.read.public" }]) },
    new AbortController().signal, () => undefined,
  );
  expect(store.size()).toBe(0);
  return { result, budget, audit };
}

describe("webpage content availability", () => {
  it("reports a successful HTTP challenge as restricted while retaining dispatched quota and failed audit", async () => {
    const { result, budget, audit } = await read("<p>正在进行安全检测... 为保障您的访问安全，系统正在检测当前网络环境，该过程通常需要几秒钟，请耐心等待</p>");
    expect(result).toMatchObject({ status: "failed", budgetConsumed: true, failure: { code: "access_restricted", message: expect.stringContaining("访问受限") } });
    expect(result).not.toHaveProperty("output");
    expect(budget.snapshot().categories.fetch).toMatchObject({ consumed: 1, remaining: 0 });
    expect(audit.records.filter(record => record.kind === "finish")).toEqual([
      expect.objectContaining({ record: expect.objectContaining({ status: "failed", budgetConsumed: true }) }),
    ]);
  });

  it("reports an explicit login gate as restricted", async () => {
    const { result } = await read("<title>登录</title><p>请登录后阅读全文。</p>");
    expect(result).toMatchObject({ status: "failed", failure: { code: "access_restricted" } });
  });

  it("reports a script shell without extracted text as unavailable", async () => {
    const { result } = await read("<title>新闻</title><script>renderArticle()</script>");
    expect(result).toMatchObject({ status: "failed", failure: { code: "content_unavailable", message: expect.stringContaining("正文") } });
  });

  it("keeps a short captcha news article with an ordinary login link readable", async () => {
    const text = '公司发布新 captcha 技术，提示“正在进行安全检测... 为保障您的访问安全，系统正在检测当前网络环境，该过程通常需要几秒钟，请耐心等待”。';
    const { result } = await read(`<p>${text}</p><a href="/login">登录</a>`);
    expect(result).toMatchObject({ status: "completed", output: { title: "", text } });
  });
});
