import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import type { CapabilityFormProvider } from "@deepfield/capability-sdk";
import { actionFixture } from "./action-test-helpers.js";

const fixtures: Awaited<ReturnType<typeof actionFixture>>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.runtime.dispose(); await rm(fixture.root, { recursive: true, force: true }); } });

function provider(): CapabilityFormProvider {
  const snapshot = { draft: { capabilityId: "public-package", draftId: "draft", revision: "one" }, view: { capabilityId: "public-package", viewId: "editor", input: {} }, values: {}, inputSchema: {}, transitions: [], readyToSubmit: true };
  return { prepare: async () => snapshot, read: async () => snapshot, update: async () => snapshot, transition: async () => snapshot,
    validate: async () => ({ valid: true, fieldErrors: [] }), submission: async () => ({ actionId: "run", input: { value: "hello" }, revision: "one" }), release: async () => {} };
}

async function fixture(registerForm = true, actionIds: string[] = ["run"]) {
  const formProvider = provider();
  const f = await actionFixture(undefined, (registrar, declaration) => {
    if (registerForm) registrar.registerFormProvider!([{ id: "editor", actionIds, description: "Edit request" }], formProvider);
    registrar.registerAction!({ definition: f.action, declaration });
  });
  fixtures.push(f);
  return { ...f, formProvider };
}

describe("capability form registration", () => {
  it("retains an optional afterAction hook with its provider receiver", async () => {
    const f = await fixture();
    const outcome = { status: "completed", data: "recognized" };
    const snapshot = await f.formProvider.prepare("editor", "run", {});
    f.formProvider.afterAction = async function (ref, actionId, result) {
      expect(this).toBe(f.formProvider);
      expect(ref).toEqual(snapshot.draft);
      expect(actionId).toBe("run");
      expect(result).toBe(outcome);
      return { snapshot, nextActionId: "run" };
    };
    await f.start();
    expect(await f.registry.formProvider("public-package")?.afterAction?.(snapshot.draft, "run", outcome))
      .toEqual({ snapshot, nextActionId: "run" });
  });
  it("publishes immutable form metadata and provider only after ready, even when forms register before actions", async () => {
    const f = await fixture();
    expect(f.registry.forms("public-package")).toEqual([]);
    expect(f.registry.formProvider("public-package")).toBeUndefined();
    await f.start();
    expect(f.registry.forms("public-package")).toEqual([{ id: "editor", actionIds: ["run"], description: "Edit request" }]);
    expect(f.registry.formProvider("public-package")).toBeDefined();
    expect(Object.isFrozen(f.registry.forms("public-package")[0])).toBe(true);
    expect(Object.isFrozen(f.registry.forms("public-package")[0]?.actionIds)).toBe(true);
  });

  it("isolates a form with an action outside the local catalog while keeping its action available", async () => {
    const f = await fixture(true, ["foreign-action"]);
    await f.start();
    expect(f.registry.readyIds()).toEqual(["public-package"]);
    expect(f.registry.publicAction("public-package", "run")).toBeDefined();
    expect(f.registry.forms("public-package")).toEqual([]);
    expect(f.registry.formProvider("public-package")).toBeUndefined();
  });

  it("isolates both declarations of a duplicate form ID while retaining a distinct form", async () => {
    const f = await actionFixture(undefined, (registrar, declaration) => {
      registrar.registerFormProvider!([
        { id: "duplicate", actionIds: ["run"], description: "First" },
        { id: "valid", actionIds: ["run"], description: "Distinct" },
        { id: "duplicate", actionIds: ["run"], description: "Second" },
      ], provider());
      registrar.registerAction!({ definition: f.action, declaration });
    });
    fixtures.push(f);
    await f.start();
    expect(f.registry.readyIds()).toEqual(["public-package"]);
    expect(f.registry.forms("public-package").map(form => form.id)).toEqual(["valid"]);
  });

  it("removes forms on disposal", async () => {
    const f = await fixture(); await f.start();
    await f.runtime.dispose();
    expect(f.registry.forms("public-package")).toEqual([]);
    expect(f.registry.formProvider("public-package")).toBeUndefined();
  });

  it("keeps existing packages without forms ready", async () => {
    const f = await fixture(false); await f.start();
    expect(f.registry.readyIds()).toEqual(["public-package"]);
    expect(f.registry.forms("public-package")).toEqual([]);
  });
});
