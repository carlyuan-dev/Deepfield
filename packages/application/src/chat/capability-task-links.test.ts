import { describe, expect, it } from "vitest";
import { createRepositories, migrate, openDatabase } from "@deepfield/persistence";
import { requestedCompletionAnalysis, shouldScheduleAnalysis, taskEventId } from "./capability-task-links.js";

describe("capability task links", () => {
  it("recognizes explicit follow-up intent and honors refusal first", () => {
    expect(requestedCompletionAnalysis("调研完成后分析结果")).toBe(true);
    expect(requestedCompletionAnalysis("开始调研，不要完成后自动分析")).toBe(false);
    expect(requestedCompletionAnalysis("开始调研")).toBe(false);
  });
  it("persists task cards per conversation and consumes terminal events once", () => {
    const db = openDatabase(":memory:"); migrate(db);
    const repo = createRepositories(db);
    const a = repo.conversations.create(); const b = repo.conversations.create();
    const snapshot = { taskRef: { capabilityId: "probe", taskId: "task-1" }, status: "queued" as const };
    repo.chatCapabilities.linkTask({ conversationId: a.id, sourceRequestId: "r1", snapshot, analyzeAfter: true, analysisState: "none" });
    expect(repo.chatCapabilities.tasks(b.id)).toEqual([]);
    const done = { ...snapshot, status: "succeeded" as const, updatedAt: "2026-09-23T00:00:00.000Z" };
    expect(repo.chatCapabilities.updateTask(a.id, done, taskEventId(done))).toBe(true);
    expect(repo.chatCapabilities.updateTask(a.id, done, taskEventId(done))).toBe(false);
    expect(shouldScheduleAnalysis(repo.chatCapabilities.tasks(a.id)[0]!)).toBe(true);
    repo.chatCapabilities.setAnalyzeAfter(a.id, "probe", "task-1", false);
    expect(shouldScheduleAnalysis(repo.chatCapabilities.tasks(a.id)[0]!)).toBe(false);
    db.close();
  });
});
