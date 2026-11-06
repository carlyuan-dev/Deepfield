import { describe, expect, it } from "vitest";
import { projectMemoryHistory } from "@deepfield/contracts";

describe("memory history privacy", () => {
  it("removes memory write arguments and read bodies while preserving tool pairs and ordinary user text", () => {
    const messages = [
      { role: "user", content: "原话保留", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call", name: "memory_remember", arguments: { content: "PRIVATE_OLD" } }] },
      { role: "toolResult", toolName: "memory_remember", toolCallId: "call", content: [{ type: "text", text: JSON.stringify({ status: "saved", entries: [{ content: "PRIVATE_OLD" }], memoryRefs: [{ id: "m", revision: 1 }] }) }] },
    ];
    const projected = projectMemoryHistory(messages as never);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_OLD");
    expect(projected[0]).toEqual(messages[0]);
    expect(projected[1]).toMatchObject({ content: [{ id: "call", name: "memory_remember" }] });
    expect(projected[2]).toMatchObject({ toolCallId: "call", toolName: "memory_remember" });
    expect(JSON.stringify(projected[2])).toContain('historical_reference');
    const result = projected[2] as unknown as { content: Array<{ text: string }> };
    expect(JSON.parse(result.content[0]!.text).memoryRefs).toEqual([{ id: "m", revision: 1 }]);
  });
});
