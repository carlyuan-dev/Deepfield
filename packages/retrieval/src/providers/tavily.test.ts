import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { ProviderHttpClient } from "../provider-http-client.js";
import { createTavilyProvider } from "./tavily.js";

function provider(published_date: unknown, url = "https://example.com/source") {
  return createTavilyProvider({ token: "local-fixture", client: new ProviderHttpClient({ endpoint: { origin: "https://api.tavily.com", pathPrefix: "/search" }, transport: { async request() {
    return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify({ results: [{ title: "中文🌱标题", url, content: "公开摘要", published_date }] }))]), destroy() {} };
  } } }) });
}
it.each([
  ["2026-08-22T09:16:00+08:00", "valid", "2026-08-22"], ["2024-02-29", "valid", "2024-02-29"],
  [undefined, "missing", undefined], ["3天前", "unparseable", undefined], ["2026-02-30T09:00:00Z", "unparseable", undefined],
  ["2026-08-22T99:00:00Z", "unparseable", undefined], [null, "invalid_type", undefined], [{ secret: "never-copy" }, "invalid_type", undefined], [42, "invalid_type", undefined],
  ["2026-08-22T24:00:00Z", "unparseable", undefined],
])("preserves optional published_date safely (%j)", async (value, status, date) => {
  const response = await provider(value).search({ query: "公司", maxResults: 5 }, new AbortController().signal);
  expect(response.results[0]).toMatchObject({ title: "中文🌱标题", sourceDate: { provider: "tavily", fieldName: "published_date", status } });
  expect(response.results[0]?.date).toBe(date);
  if (typeof value === "string") expect(response.results[0]?.sourceDate?.rawValue).toBe(value);
  else expect(response.results[0]?.sourceDate).not.toHaveProperty("rawValue");
  expect(JSON.stringify(response)).not.toContain("never-copy");
});
it("bounds raw date UTF-8 and records original length/hash without inventing a date", async () => {
  const raw = "2026-08-22" + "🌱中".repeat(400);
  const response = await provider(raw).search({ query: "公司", maxResults: 5 }, new AbortController().signal);
  const date = response.results[0]?.sourceDate!;
  expect(Buffer.byteLength(date.rawValue!, "utf8")).toBeLessThanOrEqual(2048);
  expect(date.rawValue).not.toContain("\uFFFD");
  expect(date).toMatchObject({ status: "unparseable", rawValueTruncated: true, rawValueBytes: Buffer.byteLength(raw), rawValueHash: createHash("sha256").update(raw).digest("hex") });
  expect(response.results[0]).not.toHaveProperty("date");
});
it("still rejects unsafe mandatory URLs with malformed optional dates", async () => {
  await expect(provider({}, "javascript:alert(1)").search({ query: "公司", maxResults: 5 }, new AbortController().signal)).rejects.toMatchObject({ code: "dangerous_url" });
});
