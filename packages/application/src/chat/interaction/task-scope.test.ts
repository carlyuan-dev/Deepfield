import { expect, it } from "vitest";
import { freezeTaskScope, TaskScopeStore } from "./task-scope.js";

const digest = `sha256:${"a".repeat(64)}`;
const call = (actionId: string, input: unknown) => ({ capabilityId: "records", actionId, contractDigest: digest, input });
const catalog = (actionId: string) => ({ packageVersion: "1", declaration: {
  id: actionId, contractDigest: digest, mode: "immediate", effects: { data: actionId === "delete" ? "destructive" : "write", consumesResources: false },
  taskAuthorization: { mode: "scope", dynamicFields: actionId === "add" ? ["names"] : [], resourceFields: actionId === "add" ? ["parentId"] : [], outputBindings: actionId === "create" ? ["data.id"] : [] },
} } as any);
const proposal = () => ({ endCondition: "创建指定容器并加入找到的记录", firstCall: call("create", { name: "指定容器" }), rules: [
  { id: "create", call: call("create", { name: "指定容器" }), maxExecutions: 1 },
  { id: "add", call: call("add", {}), dynamicFields: ["names"], bindings: { parentId: { ruleId: "create", path: "data.id" } }, maxExecutions: 2 },
] });

it("accepts discovered parameters only inside a confirmed declared resource scope", () => {
  const scope = freezeTaskScope(proposal(), (_cap, action) => catalog(action)); const grants = new TaskScopeStore();
  expect(grants.claim("c", call("create", { name: "指定容器" }), "1")).toBeUndefined();
  grants.activate("c", "human", scope);
  const create = grants.claim("c", call("create", { name: "指定容器" }), "1")!;
  expect(create).toBeDefined();
  expect(grants.claim("c", call("add", { parentId: "model-invented", names: ["A"] }), "1")).toBeUndefined();
  grants.record(create, { status: "completed", data: { id: "new-id" } });
  expect(grants.claim("c", call("add", { parentId: "another", names: ["A"] }), "1")).toBeUndefined();
  expect(grants.claim("c", call("add", { parentId: "new-id", names: ["A"], hidden: "x" }), "1")).toBeUndefined();
  const next = grants.claim("c", call("add", { parentId: "new-id", names: ["A"] }), "1")!;
  expect(next).toBeDefined(); grants.record(next, { status: "completed", data: {} });
  expect(grants.claim("c", call("add", { parentId: "new-id", names: ["A"] }), "1")).toBeUndefined();
  expect(grants.claim("c", call("add", { parentId: "new-id", names: ["B"] }), "1")).toBeDefined();
  expect(grants.claim("c", call("add", { parentId: "new-id", names: ["C"] }), "1")).toBeUndefined();
  grants.revoke("c"); expect(grants.valid(next)).toBe(false);
  expect(new TaskScopeStore().claim("c", call("create", { name: "指定容器" }), "1")).toBeUndefined();
});

it("permits explicitly confirmed exact destructive targets and rejects dynamic destructive scopes", () => {
  const exact = { endCondition: "删除指定记录", firstCall: call("delete", { ids: ["a"] }), rules: [{ id: "delete", call: call("delete", { ids: ["a"] }), maxExecutions: 1 }] };
  const store = new TaskScopeStore(); store.activate("c", "human", freezeTaskScope(exact, (_cap, action) => catalog(action)));
  expect(store.claim("c", call("delete", { ids: ["b"] }), "1")).toBeUndefined();
  expect(store.claim("c", exact.firstCall, "1")).toBeDefined();
  expect(() => freezeTaskScope({ ...exact, rules: [{ ...exact.rules[0]!, dynamicFields: ["ids"] }] }, (_cap, action) => catalog(action))).toThrow();
  const source = proposal(); source.rules[1]!.dynamicFields = ["parentId"];
  expect(() => freezeTaskScope(source, (_cap, action) => catalog(action))).toThrow();
});
