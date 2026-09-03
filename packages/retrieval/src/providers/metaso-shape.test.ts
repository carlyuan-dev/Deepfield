import { describe, expect, it } from "vitest";
import { summarizeJsonShape, type JsonShape } from "./metaso-shape.js";

describe("metaso value-free shape summarizer (focused revision)", () => {
  it("reduces JSON values to kind labels and never keeps values", () => {
    expect(summarizeJsonShape(null)).toBe("null");
    expect(summarizeJsonShape(true)).toBe("boolean");
    expect(summarizeJsonShape(42)).toBe("number");
    expect(summarizeJsonShape("text")).toBe("string");
  });

  it("keeps property names and array metadata only, in sorted order", () => {
    const secret = "sk-value-that-must-not-appear";
    const shape = summarizeJsonShape({
      data: [{ title: "A", url: "https://example.com", token: secret }],
      credits: 3,
    }) as Extract<JsonShape, { type: "object" }>;
    const serialized = JSON.stringify(shape);
    expect(serialized).toContain('"title":"string"');
    expect(serialized).toContain('"url":"string"');
    expect(serialized).not.toContain("https://example.com");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('"credits":3');
    expect(serialized).toContain('"credits":"number"');
    // keys are sorted
    const sortedObject = summarizeJsonShape({ z: 1, a: "x", m: true }) as Extract<JsonShape, { type: "object" }>;
    expect(Object.keys(sortedObject.properties)).toEqual(["a", "m", "z"]);
  });

  it("reports array length and only the FIRST element shape", () => {
    const shape = summarizeJsonShape([{ title: "A" }, { title: "B" }, 5]) as Extract<JsonShape, { type: "array" }>;
    expect(shape.length).toBe(3);
    expect(shape.first).toEqual({ type: "object", properties: Object.freeze(Object.assign(Object.create(null), { title: "string" })) });
    const empty = summarizeJsonShape([]) as Extract<JsonShape, { type: "array" }>;
    expect(empty.length).toBe(0);
    expect(empty).not.toHaveProperty("first");
    expect(JSON.stringify(empty)).toBe('{"type":"array","length":0}');
  });

  it("deeply freezes every returned node and uses null-prototype property maps", () => {
    const shape = summarizeJsonShape({ nested: { a: [1, 2] } }) as Extract<JsonShape, { type: "object" }>;
    expect(Object.isFrozen(shape)).toBe(true);
    const nested = shape.properties.nested as Extract<JsonShape, { type: "object" }>;
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.getPrototypeOf(nested.properties)).toBe(null);
    expect(Object.isFrozen(nested.properties)).toBe(true);
    const array = nested.properties.a as Extract<JsonShape, { type: "array" }>;
    expect(Object.isFrozen(array)).toBe(true);
  });

  it("stores a literal __proto__ own key safely in the property map", () => {
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, "__proto__", { value: 1, enumerable: true, writable: true, configurable: true });
    const shape = summarizeJsonShape(input) as Extract<JsonShape, { type: "object" }>;
    expect(Object.prototype.hasOwnProperty.call(shape.properties, "__proto__")).toBe(true);
    expect(shape.properties.__proto__).toBe("number");
    expect(Object.getPrototypeOf(shape.properties)).toBe(null);
  });

  it("rejects undefined, functions, symbols and bigints with a fixed error", () => {
    expect(() => summarizeJsonShape(undefined)).toThrow(/shape/i);
    expect(() => summarizeJsonShape(() => 1)).toThrow(/shape/i);
    expect(() => summarizeJsonShape(Symbol("x"))).toThrow(/shape/i);
    expect(() => summarizeJsonShape(10n)).toThrow(/shape/i);
    expect(() => summarizeJsonShape({ a: undefined })).toThrow(/shape/i);
    expect(() => summarizeJsonShape([undefined])).toThrow(/shape/i);
  });

  it("rejects cyclic and repeated object references", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => summarizeJsonShape(cyclic)).toThrow(/shape/i);
    const shared: Record<string, unknown> = { v: 1 };
    expect(() => summarizeJsonShape({ a: shared, b: shared })).toThrow(/shape/i);
  });

  it("rejects symbol keys, accessor properties, non-enumerable fields and custom toJSON without running them", () => {
    const symbolKey: Record<string | symbol, unknown> = { a: 1 };
    symbolKey[Symbol("boom")] = 2;
    expect(() => summarizeJsonShape(symbolKey)).toThrow(/shape/i);

    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, "amount", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-accessor-leak");
      },
    });
    try {
      summarizeJsonShape({ item: accessor });
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/shape/i);
      expect(String(error)).not.toContain("sk-accessor-leak");
    }

    const hidden: Record<string, unknown> = { a: 1 };
    Object.defineProperty(hidden, "secret", { value: "sk-hidden-value", enumerable: false });
    expect(() => summarizeJsonShape(hidden)).toThrow(/shape/i);

    const withToJson: Record<string, unknown> = { a: 1, toJSON() { return "leak"; } };
    expect(() => summarizeJsonShape(withToJson)).toThrow(/shape/i);
  });

  it("rejects sparse arrays and accessor element zero with stable errors", () => {
    const sparse = new Array(2); // hole at index 0
    expect(() => summarizeJsonShape(sparse)).toThrow(/shape/i);
    const accessorElement: unknown[] = [];
    Object.defineProperty(accessorElement, "0", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-element-leak");
      },
    });
    try {
      summarizeJsonShape(accessorElement);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/shape/i);
      expect(String(error)).not.toContain("sk-element-leak");
    }
  });

  it("rejects accessor getters on ANY existing array index (not only index 0)", () => {
    // index 1 carries an accessor while index 0 is a plain value: must be rejected
    const withAccessorIndex: unknown[] = ["plain-first"];
    Object.defineProperty(withAccessorIndex, "1", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-index-one-leak");
      },
    });
    try {
      summarizeJsonShape(withAccessorIndex);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/shape/i);
      expect(String(error)).not.toContain("sk-index-one-leak");
    }

    // a deep non-zero index accessor inside the probed first element chain
    const nested: unknown[] = [[{ ok: 1 }]];
    Object.defineProperty(nested[0] as object, "1", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-nested-index-leak");
      },
    });
    try {
      summarizeJsonShape(nested);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/shape/i);
      expect(String(error)).not.toContain("sk-nested-index-leak");
    }
  });

  it("rejects extra enumerable own properties on arrays (incl. accessors) without running them", () => {
    // a non-index enumerable DATA property is not an ordinary array element
    const withExtraData: unknown[] = [1];
    Object.defineProperty(withExtraData, "extra", { value: 5, enumerable: true, writable: true, configurable: true });
    expect(() => summarizeJsonShape(withExtraData)).toThrow(/shape/i);

    // an extra enumerable ACCESSOR property: rejected without running the getter
    const withExtraGetter: unknown[] = [1];
    Object.defineProperty(withExtraGetter, "extra", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-extra-prop-leak");
      },
    });
    try {
      summarizeJsonShape(withExtraGetter);
      throw new Error("unreachable");
    } catch (error) {
      expect(String(error)).toMatch(/shape/i);
      expect(String(error)).not.toContain("sk-extra-prop-leak");
    }

    // a non-canonical index spelling ("00") is an extra property, not an element
    const nonCanonical: unknown[] = [1];
    Object.defineProperty(nonCanonical, "00", { value: 9, enumerable: true, writable: true, configurable: true });
    expect(() => summarizeJsonShape(nonCanonical)).toThrow(/shape/i);
  });

  it("enforces depth 12, 100 properties per object and 10000 array length", () => {
    const deep: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = deep;
    for (let level = 0; level < 12; level += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    expect(() => summarizeJsonShape(deep)).not.toThrow(); // depth 12 legal
    const tooDeep: Record<string, unknown> = {};
    cursor = tooDeep;
    for (let level = 0; level < 13; level += 1) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }
    expect(() => summarizeJsonShape(tooDeep)).toThrow(/shape/i);

    const manyProps: Record<string, number> = {};
    for (let index = 0; index < 100; index += 1) {
      manyProps[`k${index}`] = index;
    }
    expect(() => summarizeJsonShape(manyProps)).not.toThrow();
    const tooManyProps: Record<string, number> = {};
    for (let index = 0; index < 101; index += 1) {
      tooManyProps[`k${index}`] = index;
    }
    expect(() => summarizeJsonShape(tooManyProps)).toThrow(/shape/i);

    const boundaryArray = new Array(10000);
    boundaryArray[0] = 1; // own data element zero; remaining holes are never inspected
    expect(() => summarizeJsonShape(boundaryArray)).not.toThrow();
    expect(() => summarizeJsonShape(new Array(10001))).toThrow(/shape/i);
  });

  it("never includes numbers, secret values or input in fixed error messages of the SAME offending input", () => {
    // one single illegal input carries secret/url/number values AND a trigger
    // field (accessor) so the produced error is proven sanitized end-to-end
    const offending: Record<string, unknown> = {
      token: "sk-top-secret",
      url: "https://leak.example/x",
      n: 123456789,
    };
    Object.defineProperty(offending, "secret", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-getter-secret");
      },
    });
    try {
      summarizeJsonShape(offending);
      throw new Error("unreachable");
    } catch (error) {
      const message = String(error);
      expect(message).toMatch(/shape/i);
      expect(message).not.toContain("sk-top-secret");
      expect(message).not.toContain("sk-getter-secret");
      expect(message).not.toContain("https://leak.example");
      expect(message).not.toContain("123456789");
    }
    // same end-to-end sanitization through an illegal array input
    const arrayOffending: unknown[] = [];
    Object.defineProperty(arrayOffending, "1", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("sk-array-secret");
      },
    });
    try {
      summarizeJsonShape([arrayOffending, { token: "sk-second-secret", n: 42 }]);
      throw new Error("unreachable");
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain("sk-array-secret");
      expect(message).not.toContain("sk-second-secret");
      expect(message).not.toContain("42");
    }
  });
});
