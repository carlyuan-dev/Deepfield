import { describe, expect, it } from "vitest";
import { ToolSet } from "./tool-set.js";

function grant(name: string, version = 1, effect: "network.read.public" | "project.read" = "network.read.public") {
  return {
    identity: { name, version },
    actor: "main_agent" as const,
    effect,
  };
}

describe("ToolSet fingerprint (focused revision)", () => {
  it("treats undefined projectId and the literal string '-' as different authorizations", () => {
    const first = new ToolSet([{ ...grant("net"), projectId: "-" }]);
    const second = new ToolSet([grant("net")]);
    expect(first.fingerprint()).not.toBe(second.fingerprint());
  });

  it("treats delimiter injection inside grant fields as different authorizations", () => {
    // Old delimiter-based serialization joined these into the same string.
    const first = new ToolSet([
      { ...grant("net"), projectId: "x:y", hostPatterns: ["a"] },
    ]);
    const second = new ToolSet([
      { ...grant("net"), projectId: "x", hostPatterns: ["y:a"] },
    ]);
    expect(first.fingerprint()).not.toBe(second.fingerprint());
  });

  it("produces the same fingerprint for the same grants in different orders", () => {
    const first = new ToolSet([grant("a"), { ...grant("b", 1, "project.read"), projectId: "p" }]);
    const second = new ToolSet([{ ...grant("b", 1, "project.read"), projectId: "p" }, grant("a")]);
    expect(first.fingerprint()).toBe(second.fingerprint());
  });

  it("distinguishes every authorization-relevant field", () => {
    const base = grant("net");
    const variants = [
      new ToolSet([base]),
      new ToolSet([{ ...base, effect: "project.read" }]),
      new ToolSet([{ ...base, actor: "developer_probe" }]),
      new ToolSet([{ ...base, projectId: "p" }]),
      new ToolSet([{ ...base, hostPatterns: ["*.example.com"] }]),
      new ToolSet([{ ...base, maxResults: 3 }]),
      new ToolSet([{ ...base, maxBytes: 4096 }]),
      new ToolSet([{ ...base, confirmationKind: "approve" }]),
    ];
    for (let i = 0; i < variants.length; i += 1) {
      for (let j = i + 1; j < variants.length; j += 1) {
        expect(variants[i]!.fingerprint()).not.toBe(variants[j]!.fingerprint());
      }
    }
  });
});
