import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { createCapabilityHostServices, defineAction, type ActionDefinition, type CapabilityRegistrar } from "@deepfield/capability-sdk";
import { compileActionCatalog } from "../../../../../scripts/capabilities/build-actions.js";
import { prepareCapabilities, createCapabilityRuntime } from "./runtime.js";
import { CapabilityRegistry } from "./registry.js";
import { DatabaseSync } from "node:sqlite";
import { migrate, createRepositories } from "@deepfield/persistence";

export const testContext = { source: "chat" as const, callerId: "trusted-window", sessionId: "session", invocationId: "invocation", permissions: ["execute"] };
export function testAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return defineAction({ id: "run", title: "Run", description: "A public action", mode: "task",
    effects: { data: "write", consumesResources: true }, inputSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.String(), documentation: { path: "action.md", version: "1" }, permissions: ["execute"], requiresConfirmation: true,
    presentInput: input => ({ title: "Run", fields: [{ label: "Value", value: String((input as { value: string }).value) }] }),
    handler: input => ({ status: "completed", data: (input as { value: string }).value }), ...overrides });
}
export async function actionFixture(action = testAction(), register?: (registrar: CapabilityRegistrar, declaration: Awaited<ReturnType<typeof compileActionCatalog>>[number]) => void) {
  const root = await mkdtemp(join(tmpdir(), "capability-actions-"));
  const paths = { scanRoot: join(root, "installed"), bundledRoot: join(root, "bundled"), statePath: join(root, "state.json") };
  const packageRoot = join(paths.bundledRoot, "public-package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "main.js"), "export function bootstrap() {}\n");
  await writeFile(join(packageRoot, "action.md"), "Validated action documentation.");
  const declarations = await compileActionCatalog({ capabilityRoot: packageRoot, actions: [action] });
  await writeFile(join(packageRoot, "capability.json"), JSON.stringify({ id: "public-package", name: "Public", description: "Fixture", version: "1.0.0", protocolVersion: 2, hostApiVersion: 2, entries: { main: "main.js" }, requirements: [], actions: declarations }));
  const prepared = await prepareCapabilities(paths);
  const registry = new CapabilityRegistry();
  const database = new DatabaseSync(":memory:"); migrate(database);
  const invocations = createRepositories(database).capabilityInvocations;
  const runtime = createCapabilityRuntime(prepared, registry, async () => ({ bootstrap(registrar: CapabilityRegistrar) {
    registrar.register("private", Type.Null(), Type.String(), () => "private");
    if (register) register(registrar, declarations[0]!); else registrar.registerAction!({ definition: action, declaration: declarations[0]! });
  } }), invocations);
  const dispose = runtime.dispose.bind(runtime);
  let closed = false;
  runtime.dispose = async () => { await dispose(); if (!closed) { database.close(); closed = true; } };
  const exits = new Set<() => void>(); let workerCalls = 0;
  const client = { activateCapability: async () => { workerCalls++; }, deactivateCapability: async () => {}, subscribeUnavailable(listener: () => void) { exits.add(listener); return () => { exits.delete(listener); }; } };
  return { root, paths, prepared, registry, runtime, action, invocations, declaration: declarations[0]!,
    call: { capabilityId: "public-package", actionId: "run", contractDigest: declarations[0]!.contractDigest, input: { value: "hello" } },
    start: () => runtime.start(client, createCapabilityHostServices({})), exit: () => { for (const exit of [...exits]) exit(); }, workerCalls: () => workerCalls };
}
