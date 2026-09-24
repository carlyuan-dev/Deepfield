import { describe, expect, it } from "vitest";
import { capabilityContext, type CapabilityDirectoryEntry } from "./capability-context.js";

const entry: CapabilityDirectoryEntry = { capabilityId: "probe", capabilityName: "Probe", packageVersion: "1.0.0", actionId: "lookup",
  title: "Lookup", description: "Look up a record", mode: "immediate", effects: { data: "read", consumesResources: false }, contractDigest: `sha256:${"a".repeat(64)}` };

describe("capability context", () => {
  it("injects no directory or tools when none are ready", () => {
    expect(capabilityContext([], [])).toBe("");
  });
  it("restores only this conversation's current version and digest documentation", () => {
    const description = { conversationId: "A", capabilityId: "probe", actionId: "lookup", packageVersion: "1.0.0", contractDigest: entry.contractDigest,
      documentation: "CURRENT INSTRUCTIONS", declaration: { id: "lookup" } };
    expect(capabilityContext([entry], [description])).toContain("CURRENT INSTRUCTIONS");
    expect(capabilityContext([{ ...entry, contractDigest: `sha256:${"b".repeat(64)}` }], [description])).not.toContain("CURRENT INSTRUCTIONS");
    expect(capabilityContext([entry], [])).not.toContain("CURRENT INSTRUCTIONS");
  });
});
