import { describe, expect, it } from "vitest";
import { createResourceScope } from "./lifecycle.js";

describe("createResourceScope", () => {
  it("runs deferred cleanup once in reverse registration order", async () => {
    const calls: string[] = [];
    const scope = createResourceScope();
    scope.defer(() => { calls.push("first"); });
    scope.defer(async () => { calls.push("second"); });

    await Promise.all([scope.dispose(), scope.dispose()]);
    await scope.dispose();

    expect(calls).toEqual(["second", "first"]);
    expect(scope.issues).toEqual([]);
  });

  it("continues cleanup after a failure and exposes only a safe issue code", async () => {
    const calls: string[] = [];
    const scope = createResourceScope();
    scope.defer(() => { calls.push("survived"); });
    scope.defer(() => { throw new Error("secret cleanup detail"); });

    await expect(scope.dispose()).resolves.toBeUndefined();

    expect(calls).toEqual(["survived"]);
    expect(scope.issues).toEqual([{ code: "cleanup_failed" }]);
    expect(JSON.stringify(scope.issues)).not.toContain("secret");
  });
});
