import { expect, it } from "vitest";
import { classifyTaskDecision, snapshotExactTaskCalls, TaskGrantStore } from "./task-authorization.js";

const candidate = (input: unknown = { resource: "a", names: ["甲", "乙"] }) => ({
  call: { capabilityId: "records", actionId: "add", contractDigest: `sha256:${"a".repeat(64)}`, input },
  packageVersion: "1", mode: "immediate" as const, effects: { data: "write" as const, consumesResources: true },
  taskAuthorization: { family: "add", mode: "exact_input" as const },
});

it("accepts complete real-user task phrases without granting from quoted, conditional or mixed instructions", () => {
  for (const text of ["可以，补进去，你一路确认就行，不要我来点", "本次一路确认", "本次不用逐个确认。"])
    expect(classifyTaskDecision(text)).toBe("approve_task");
  for (const text of ["不要本次一路确认", "他说‘本次一路确认’", "如果没问题，本次一路确认", "本次一路确认，但先改名字", "本次一路确认？", "确认", "随便执行"])
    expect(classifyTaskDecision(text)).toBeNull();
});

it("snapshots full bounded inputs and excludes undeclared, destructive, background, mixed-family and duplicate calls", () => {
  const original = candidate(); const calls = snapshotExactTaskCalls([original]);
  const { taskAuthorization: _omitted, ...undeclared } = candidate();
  (original.call.input as { resource: string }).resource = "changed";
  expect(calls[0]!.call.input).toEqual({ resource: "a", names: ["甲", "乙"] });
  for (const entries of [[], Array.from({ length: 11 }, (_, i) => candidate({ n: i })),
    [undeclared], [{ ...candidate(), mode: "task" as const }],
    [{ ...candidate(), effects: { data: "destructive" as const, consumesResources: false } }],
    [candidate(), { ...candidate({ n: 2 }), taskAuthorization: { family: "delete", mode: "exact_input" as const } }],
    [candidate(), { ...candidate({ n: 2 }), call: { ...candidate({ n: 2 }).call, capabilityId: "elsewhere" } }],
    [candidate(), candidate()]]) expect(() => snapshotExactTaskCalls(entries)).toThrow();
});

it("claims exact operations once in their owner conversation and revokes outstanding claims", () => {
  const store = new TaskGrantStore();
  const calls = snapshotExactTaskCalls([candidate(), candidate({ resource: "a", names: ["丙"] })]);
  expect(store.claim("c", "p", calls[0]!.digest)).toBeUndefined();
  store.activate("c", "p", "real-message", calls);
  expect(store.claim("other", "p", calls[0]!.digest)).toBeUndefined();
  expect(store.claim("c", "other", calls[0]!.digest)).toBeUndefined();
  expect(store.claim("c", "p", snapshotExactTaskCalls([candidate({ resource: "b", names: ["甲", "乙"] })])[0]!.digest)).toBeUndefined();
  const first = store.claim("c", "p", calls[0]!.digest)!;
  expect(store.valid(first)).toBe(true);
  expect(store.claim("c", "p", calls[0]!.digest)).toBeUndefined();
  store.revoke("c");
  expect(store.valid(first)).toBe(false);
  expect(store.claim("c", "p", calls[1]!.digest)).toBeUndefined();
  expect(new TaskGrantStore().claim("c", "p", calls[0]!.digest)).toBeUndefined();
});
