import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { compileActionCatalog, verifyBuiltActionCatalog } from "../../../scripts/capabilities/build-actions.js";
import { ActionOutcomeSchema, ActionResultSchema, OperationPresentationSchema, ReadSliceSchema, TaskSnapshotSchema } from "./interaction.js";
import { defineAction } from "./actions.js";

const inputSchema = Type.Object({ query: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const outputSchema = Type.Object({ items: Type.Array(Type.String()) }, { additionalProperties: false });
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function recordsAction(documentationPath = "docs/find.md") {
  return defineAction({
    id: "records.find",
    title: "Find records",
    description: "Find matching records",
    mode: "immediate",
    effects: { data: "read", consumesResources: true },
    inputSchema,
    outputSchema,
    documentation: { path: documentationPath, version: "1" },
    permissions: ["records.read"],
    requiresConfirmation: false,
    handler: async () => ({ status: "completed" as const, data: { items: [] } }),
  });
}

async function packageRoot(documentation = "Find records by query."): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "deepfield-actions-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "docs/find.md"), documentation);
  return root;
}

describe("compileActionCatalog", () => {
  it("binds optional exact-task admission metadata into the compiled contract", async () => {
    const root = await packageRoot();
    const [plain] = await compileActionCatalog({ capabilityRoot: root, actions: [recordsAction()] });
    const [task] = await compileActionCatalog({ capabilityRoot: root, actions: [{ ...recordsAction(), taskAuthorization: { family: "records", mode: "exact_input" } }] });
    expect(task?.taskAuthorization).toEqual({ family: "records", mode: "exact_input" });
    expect(task?.contractDigest).not.toBe(plain?.contractDigest);
  });
  it("compiles handler-free metadata and keeps read effects independent from resource consumption", async () => {
    const root = await packageRoot();
    const [compiled] = await compileActionCatalog({ capabilityRoot: root, actions: [recordsAction()] });

    expect(compiled).toMatchObject({
      id: "records.find",
      effects: { data: "read", consumesResources: true },
      documentation: { path: "docs/find.md", version: "1", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
      contractDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(compiled).not.toHaveProperty("handler");
    expect(Value.Check(compiled!.inputSchema, { query: "delivery" })).toBe(true);
    expect(Value.Check(compiled!.inputSchema, { query: "delivery", companyId: "not-public" })).toBe(false);
  });

  it("changes the documentation and contract digests when only documentation content changes", async () => {
    const first = (await compileActionCatalog({ capabilityRoot: await packageRoot("Version one"), actions: [recordsAction()] }))[0]!;
    const second = (await compileActionCatalog({ capabilityRoot: await packageRoot("Version two"), actions: [recordsAction()] }))[0]!;

    expect(second.documentation.digest).not.toBe(first.documentation.digest);
    expect(second.contractDigest).not.toBe(first.contractDigest);
  });

  it("rejects missing documentation and duplicate action ids", async () => {
    const root = await packageRoot();
    await expect(compileActionCatalog({ capabilityRoot: root, actions: [recordsAction("docs/missing.md")] }))
      .rejects.toThrow("action_documentation_missing");
    await expect(compileActionCatalog({ capabilityRoot: root, actions: [recordsAction(), recordsAction()] }))
      .rejects.toThrow("duplicate_action_id");
  });

  it("rejects invalid action metadata and unsupported schema keywords during compilation", async () => {
    const root = await packageRoot();
    const invalid = {
      ...recordsAction(),
      title: "",
      inputSchema: { type: "string", pattern: "hidden" },
    } as unknown as ReturnType<typeof recordsAction>;
    await expect(compileActionCatalog({ capabilityRoot: root, actions: [invalid] }))
      .rejects.toThrow("invalid_action_definition");
  });

  it("is exercised by built-package verification and rejects a missing output document", async () => {
    const root = await packageRoot();
    const [action] = await compileActionCatalog({ capabilityRoot: root, actions: [recordsAction()] });
    await writeFile(join(root, "capability.json"), JSON.stringify({
      id: "records", name: "Records", description: "Records", version: "2.0.0",
      protocolVersion: 2, hostApiVersion: 2, entries: { main: "dist/main.js" }, requirements: [], actions: [action],
    }));
    await expect(verifyBuiltActionCatalog(root)).resolves.toBeUndefined();

    const missingRoot = await mkdtemp(join(tmpdir(), "deepfield-actions-missing-"));
    temporaryRoots.push(missingRoot);
    await writeFile(join(missingRoot, "capability.json"), JSON.stringify({
      id: "records", name: "Records", description: "Records", version: "2.0.0",
      protocolVersion: 2, hostApiVersion: 2, entries: { main: "dist/main.js" }, requirements: [], actions: [action],
    }));
    await expect(verifyBuiltActionCatalog(missingRoot)).rejects.toThrow("action_documentation_missing");
  });
});

describe("common interaction schemas", () => {
  it("accepts bounded optional operation presentation on outcomes, results and tasks", () => {
    const presentation = { text: "正在创建主题", linkLabel: "查看预览", target: { capabilityId: "records", viewId: "preview", input: {} }, autoOpen: true };
    expect(Value.Check(OperationPresentationSchema, presentation)).toBe(true);
    expect(Value.Check(OperationPresentationSchema, { ...presentation, text: "x".repeat(1001) })).toBe(false);
    expect(Value.Check(OperationPresentationSchema, { ...presentation, linkLabel: "" })).toBe(false);
    expect(Value.Check(ActionOutcomeSchema(outputSchema), { status: "completed", data: { items: ["one"] }, presentation })).toBe(true);
    expect(Value.Check(ActionResultSchema(outputSchema), { status: "error", error: { code: "failure", message: "Failed", retryable: false },
      capabilityId: "records", actionId: "records.find", packageVersion: "2.0.0", contractDigest: `sha256:${"a".repeat(64)}`, invocationId: "one", presentation })).toBe(true);
    expect(Value.Check(TaskSnapshotSchema, { taskRef: { capabilityId: "records", taskId: "one" }, status: "running", presentation })).toBe(true);
  });
  it("validates handler outcomes without applying the business output schema to common branches", () => {
    const schema = ActionOutcomeSchema(outputSchema);
    expect(Value.Check(schema, { status: "completed", data: { items: ["one"] } })).toBe(true);
    expect(Value.Check(schema, { status: "completed", data: { unexpected: true } })).toBe(false);
    expect(Value.Check(schema, {
      status: "accepted", taskRef: { capabilityId: "records", taskId: "task-1" },
      taskStatus: "queued", message: "Queued",
    })).toBe(true);
    expect(Value.Check(schema, {
      status: "error", error: { code: "unavailable", message: "Unavailable", retryable: true },
    })).toBe(true);
  });

  it("requires host-owned metadata on all four public result variants", () => {
    const schema = ActionResultSchema(outputSchema);
    const metadata = {
      capabilityId: "records",
      actionId: "records.find",
      packageVersion: "2.0.0",
      contractDigest: `sha256:${"a".repeat(64)}`,
      invocationId: "invocation-1",
    };
    const variants = [
      { status: "completed", data: { items: ["one"] } },
      { status: "accepted", taskRef: { capabilityId: "records", taskId: "task-1" }, taskStatus: "queued" },
      { status: "requires_confirmation", confirmationRef: "confirmation-1", inputSummary: { query: "one" } },
      { status: "error", error: { code: "unavailable", message: "Unavailable", retryable: true } },
    ] as const;

    for (const variant of variants) {
      expect(Value.Check(schema, variant)).toBe(false);
      expect(Value.Check(schema, { ...metadata, ...variant })).toBe(true);
    }
    expect(Value.Check(schema, { ...metadata, contractDigest: "not-a-digest", ...variants[0] })).toBe(false);
    expect(Value.Check(schema, { ...metadata, packageVersion: "", ...variants[0] })).toBe(false);
  });

  it("accepts non-document artifact formats and arbitrary structured data", () => {
    expect(Value.Check(ReadSliceSchema, {
      format: "application/vnd.example.rows+json",
      data: { rows: [{ id: "record-1" }] },
      revision: "rev-1",
      truncated: false,
    })).toBe(true);
  });
});
