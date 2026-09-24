import { describe, expect, it } from "vitest";
import { ActionConfirmations } from "./action-confirmations.js";
import { testContext } from "./action-test-helpers.js";
const binding = { capabilityId: "public-package", actionId: "run", packageVersion: "1.0.0", contractDigest: `sha256:${"a".repeat(64)}`, input: { value: "hello" } };
describe("main-process confirmation records", () => {
  it("exposes a copy of the exact pending parameters only to the correlated caller", () => {
    const confirmations = new ActionConfirmations();
    try {
      const input = structuredClone(binding); const ref = confirmations.create(input, testContext); input.input.value = "changed";
      expect(confirmations.inspect(ref, { ...testContext, sessionId: "another" })).toBeUndefined();
      const preview = confirmations.inspect(ref, testContext)!;
      expect(preview.input).toEqual({ value: "hello" }); (preview.input as { value: string }).value = "changed";
      const token = confirmations.approve(ref, testContext)!;
      expect(confirmations.consume(token, binding, testContext)).toBe(true);
      expect(confirmations.inspect(ref, testContext)).toBeUndefined();
    } finally { confirmations.dispose(); }
  });
  it("expires pending and approved records and revokes authorization on capability disposal", () => {
    let now = 0; const confirmations = new ActionConfirmations(100, () => now);
    const expired = confirmations.create(binding, testContext); const expiredToken = confirmations.approve(expired, testContext)!;
    now = 101;
    expect(confirmations.approve(expired, testContext)).toBeUndefined(); expect(confirmations.consume(expiredToken, binding, testContext)).toBe(false);
    const revoked = confirmations.create(binding, testContext); const revokedToken = confirmations.approve(revoked, testContext)!;
    confirmations.revokeCapability("public-package");
    expect(confirmations.consume(revokedToken, binding, testContext)).toBe(false);
    const disposed = confirmations.create(binding, testContext); confirmations.dispose();
    expect(confirmations.approve(disposed, testContext)).toBeUndefined(); expect(() => confirmations.create(binding, testContext)).toThrow();
  });
  it.each(["packageVersion", "contractDigest"] as const)("invalidates changed %s and does not allow a second attempt", key => {
    const confirmations = new ActionConfirmations();
    try {
      const ref = confirmations.create(binding, testContext); const token = confirmations.approve(ref, testContext)!;
      expect(confirmations.consume(token, { ...binding, [key]: "different" }, testContext)).toBe(false);
      expect(confirmations.consume(token, binding, testContext)).toBe(false);
    } finally { confirmations.dispose(); }
  });
});
