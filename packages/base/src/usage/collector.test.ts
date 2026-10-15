import { expect, it } from "vitest";
import { normalizeUsageMetrics, type UsageAttempt, type UsageRecorder } from "./contracts.js";
import { createUsageCollector } from "./runtime.js";

const metadata = { profileId: "profile", profileName: "Name", providerId: "openai", modelId: "model", serviceKind: "llm" as const };
function recording(records: UsageAttempt[]): UsageRecorder {
  return { async recordStart(value) { records.push(value); return true; }, async recordFinish(value) { records.push(value); return true; } };
}
function setup() {
  const records: UsageAttempt[] = [];
  let sink = recording(records); let id = 0; let time = 0;
  const collector = createUsageCollector({ createId: () => `id-${++id}`, now: () => new Date(time).toISOString(), getRecorder: () => sink });
  return { records, collector, rebind(value: UsageRecorder) { sink = value; }, advance() { time = 25; } };
}
it("keeps opaque token revisions stable across fresh metadata and honors explicit revisions", () => {
  const { collector, records } = setup(); const token = {};
  collector.startAttempt({ ...metadata }, undefined, token);
  collector.startAttempt({ ...metadata }, undefined, token);
  collector.startAttempt({ ...metadata }, undefined, {});
  collector.startAttempt({ ...metadata, configRevisionId: "saved-revision" }, undefined, token);
  expect(records).toHaveLength(4);
  expect(records[0]!.configRevisionId).toBe(records[1]!.configRevisionId);
  expect(records[2]!.configRevisionId).not.toBe(records[0]!.configRevisionId);
  expect(records[3]!.configRevisionId).toBe("saved-revision");
});
it("captures the recorder at start and makes finish terminal with stable correlation IDs", () => {
  const { collector, records, rebind, advance } = setup(); const next: UsageAttempt[] = [];
  const attempt = collector.startAttempt(metadata, { sourceId: "source", operationId: "operation" });
  rebind(recording(next)); advance();
  attempt.update(normalizeUsageMetrics({ inputTokens: 2, outputTokens: 3 }));
  attempt.finish("succeeded"); attempt.finish("failed"); attempt.update(normalizeUsageMetrics({ inputTokens: 99 }));
  expect(records).toHaveLength(3);
  expect(records.at(-1)).toMatchObject({ operationId: attempt.operationId, attemptId: attempt.attemptId, outcome: "succeeded", totalTokens: 5, revision: 3, durationMs: 25 });
  expect(next).toHaveLength(0);
  collector.startAttempt(metadata).finish("failed", "network_failed");
  expect(next).toHaveLength(2);
});
it("projects only safe metadata and preserves draft identity and legacy normalization", () => {
  const { collector, records } = setup();
  const input = { ...metadata, profileId: "中文", draftSessionId: "draft", profileName: "\u0000Name", apiKey: "secret-never-record", baseUrl: "https://private.invalid" };
  collector.startAttempt(input, { sourceId: "中文" }).finish("succeeded");
  expect(records[0]).toMatchObject({ draftSessionId: "draft", profileName: "Name" });
  expect(records[0]!.profileId).toBeUndefined();
  expect(records[0]!.sourceId).toMatch(/^legacy-source-[a-f0-9]+$/);
  expect(JSON.stringify(records)).not.toContain("secret-never-record");
  expect(JSON.stringify(records)).not.toContain("private.invalid");
});
