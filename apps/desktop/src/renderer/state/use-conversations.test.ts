import { describe, expect, it } from "vitest";
import { mergeConversationTitle } from "./use-conversations.js";

describe("conversation title metadata merge", () => {
  it("changes only title and preserves newer send metadata", () => {
    const current = {
      id: "c1" as never,
      title: "fallback",
      hasUserMessage: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    };
    const staleTitleEvent = { ...current, title: "智能标题", updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(mergeConversationTitle(current, staleTitleEvent)).toEqual({ ...current, title: "智能标题" });
  });
});
