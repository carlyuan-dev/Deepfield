import { expect, it } from "vitest";
import { Type } from "typebox";
import { rm } from "node:fs/promises";
import { createRepositories, migrate, openDatabase } from "../../../../../packages/persistence/src/testing/repositories.js";
import { actionFixture, testAction } from "./action-test-helpers.js";
import { CapabilityChatHost } from "./chat-host.js";

it("allows a child to read the real action result but never write, open UI or request resource-consuming work", async () => {
  for (const effects of [{ data: "read", consumesResources: false }, { data: "write", consumesResources: false }, { data: "read", consumesResources: true }] as const) {
    let executed = 0;
    const fixture = await actionFixture(testAction({ mode: "immediate", requiresConfirmation: false, effects,
      handler: () => { executed++; return { status: "completed", data: "visible result" }; } }));
    await fixture.start();
    const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
    const conversation = repos.conversations.create();
    const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
    try {
      host.begin("parent", conversation.id, "read");
      await host.call("parent", "main-description", "describe", fixture.call);
      const description = await host.call("parent", "child-description", "describe", fixture.call, "child_agent") as { status: string };
      const result = await host.call("parent", "child-invoke", "invoke", fixture.call, "child_agent");
      if (effects.data === "read" && !effects.consumesResources) {
        expect(description.status).toBe("described"); // Parent cache must not hide the schema from a separate child context.
        expect(result).toMatchObject({ status: "completed", data: "visible result" });
        expect(executed).toBe(1);
        const encoded = await host.call("parent", "encoded-input", "invoke", { ...fixture.call, input: JSON.stringify(fixture.call.input) }, "child_agent");
        expect(encoded).toMatchObject({ status: "completed", data: "visible result" });
        expect(executed).toBe(2);
        expect(await host.call("parent", "invalid-encoded", "invoke", { ...fixture.call, input: '{"value":12}' }, "child_agent")).toMatchObject({ status: "error" });
        expect(executed).toBe(2);
      } else { expect(result).toMatchObject({ status: "error" }); expect(executed).toBe(0); }
      expect(await host.call("parent", "child-open", "open", {}, "child_agent")).toMatchObject({ status: "error" });
      expect(host.operations(conversation.id)).toEqual([]);
    } finally { host.dispose(); db.close(); await fixture.runtime.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
  }
});

it("preserves JSON-looking text when the action actually accepts a string", async () => {
  const fixture = await actionFixture(testAction({ mode: "immediate", requiresConfirmation: false,
    effects: { data: "read", consumesResources: false }, inputSchema: Type.String(), handler: input => ({ status: "completed", data: input }) }));
  await fixture.start();
  const db = openDatabase(":memory:"); migrate(db); const repos = createRepositories(db);
  const host = new CapabilityChatHost(() => fixture.runtime, fixture.registry, repos);
  try {
    host.begin("parent", repos.conversations.create().id, "read");
    await host.call("parent", "describe", "describe", fixture.call);
    expect(await host.call("parent", "invoke", "invoke", { ...fixture.call, input: '{"value":"literal"}' }, "child_agent"))
      .toMatchObject({ status: "completed", data: '{"value":"literal"}' });
  } finally { host.dispose(); db.close(); await fixture.runtime.dispose(); await rm(fixture.root, { recursive: true, force: true }); }
});
