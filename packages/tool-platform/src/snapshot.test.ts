import { describe, expect, it } from "vitest";
import { snapshotJsonValue } from "./snapshot.js";

describe("snapshotJsonValue (second revision)", () => {
  it("accepts JSON-safe values and deep-freezes the result", () => {
    const input = {
      text: "hi",
      n: 1,
      ok: true,
      list: [1, "a", null],
      nested: { deep: { x: 2 } },
    };
    const result = snapshotJsonValue(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen((result.value as Record<string, unknown>)["nested"])).toBe(true);
      expect(Object.isFrozen((result.value as Record<string, unknown>)["list"])).toBe(true);
    }
  });

  it("accepts shared acyclic references without treating them as cycles", () => {
    const shared = { x: 1 };
    const result = snapshotJsonValue({ a: shared, b: shared });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ a: { x: 1 }, b: { x: 1 } });
    }
  });

  it("rejects true cycles", () => {
    const node: Record<string, unknown> = { x: 1 };
    node.self = node;
    expect(snapshotJsonValue(node).ok).toBe(false);
  });

  it("rejects non-plain objects, accessors and symbol keys without invoking getters", () => {
    let getterCalls = 0;
    expect(snapshotJsonValue(new Date(0)).ok).toBe(false);
    expect(snapshotJsonValue(new Map([["a", 1]])).ok).toBe(false);
    expect(snapshotJsonValue(new Set([1])).ok).toBe(false);
    expect(snapshotJsonValue(new (class Example { text = "hi" })()).ok).toBe(false);
    const withGetter: Record<string, unknown> = {};
    Object.defineProperty(withGetter, "text", {
      get: () => {
        getterCalls += 1;
        return "hi";
      },
      enumerable: true,
    });
    expect(snapshotJsonValue(withGetter).ok).toBe(false);
    expect(getterCalls).toBe(0);
    const withSymbol: Record<string, unknown> = { text: "hi" };
    Object.defineProperty(withSymbol, Symbol("x"), { value: 1, enumerable: true });
    expect(snapshotJsonValue(withSymbol).ok).toBe(false);
    expect(snapshotJsonValue(undefined).ok).toBe(false);
    expect(snapshotJsonValue(1n).ok).toBe(false);
    expect(snapshotJsonValue(() => 1).ok).toBe(false);
    expect(snapshotJsonValue(NaN).ok).toBe(false);
  });

  it("preserves __proto__ and constructor keys without prototype pollution", () => {
    const input = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "text": "hi"}',
    );
    const result = snapshotJsonValue(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const value = result.value as Record<string, unknown>;
      expect(value["__proto__"]).toEqual({ polluted: true });
      expect(value["constructor"]).toEqual({ x: 1 });
      expect(value["text"]).toBe("hi");
      expect(Object.getPrototypeOf(value)).toBe(null);
      expect(Object.isFrozen(value["__proto__"])).toBe(true);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    }
  });
});
