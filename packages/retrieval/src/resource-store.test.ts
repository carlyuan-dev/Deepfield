import { describe, expect, it } from "vitest";
import { ResourceStore, zeroFillBuffer, type ResourceScope } from "./resource-store.js";

function scope(traceId: string, projectId?: string, fingerprint = "fp-A"): ResourceScope {
  return { traceId, ...(projectId !== undefined ? { projectId } : {}), toolSetFingerprint: fingerprint };
}

function makeStore(options: { clock?: () => number; maxItemsPerTrace?: number; maxBytesPerTrace?: number; ttlMs?: number } = {}) {
  let now = 0;
  return {
    clock: () => now,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    store: new ResourceStore({
      idFactory: () => `r-${Math.random().toString(36).slice(2)}`,
      clock: () => now,
      ...(options.maxItemsPerTrace !== undefined ? { maxItemsPerTrace: options.maxItemsPerTrace } : {}),
      ...(options.maxBytesPerTrace !== undefined ? { maxBytesPerTrace: options.maxBytesPerTrace } : {}),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    }),
  };
}

const metadata = (overrides: Partial<{ finalUrl: string; contentType: string; size: number; sha256: string }> = {}) => ({
  finalUrl: "https://example.com/page",
  contentType: "text/html",
  size: 4,
  sha256: "abc",
  ...overrides,
});

describe("resource store", () => {
  it("binds resources exactly to traceId, projectId and ToolSet fingerprint", () => {
    const { store } = makeStore();
    const { id } = store.put(scope("trace-a", "p1", "fp-A"), Buffer.from("AAAA"), metadata());
    expect(store.get(id, scope("trace-a", "p1", "fp-A"))?.toString()).toBe("AAAA");
    expect(store.get(id, scope("trace-b", "p1", "fp-A"))).toBeUndefined();
    expect(store.get(id, scope("trace-a", undefined, "fp-A"))).toBeUndefined();
    expect(store.get(id, scope("trace-a", "p1", "fp-B"))).toBeUndefined();
    expect(store.size()).toBe(1); // failed reads never delete
  });

  it("uses an opaque id from the factory and never derives it from the url", () => {
    let counter = 0;
    const store = new ResourceStore({ idFactory: () => `opaque-${counter++}` });
    const first = store.put(scope("t"), Buffer.from("x"), metadata({ finalUrl: "https://a.example/" }));
    const second = store.put(scope("t"), Buffer.from("y"), metadata({ finalUrl: "https://b.example/" }));
    expect(first.id).toBe("opaque-0");
    expect(second.id).toBe("opaque-1");
    expect(first.id).not.toContain("a.example");
    expect(second.id).not.toContain("b.example");
  });

  it("enforces per-trace item and byte caps without LRU eviction", () => {
    const { store } = makeStore({ maxItemsPerTrace: 2, maxBytesPerTrace: 10 });
    store.put(scope("t"), Buffer.from("12345"), metadata({ size: 5 }));
    store.put(scope("t"), Buffer.from("abcde"), metadata({ size: 5 }));
    expect(() => store.put(scope("t"), Buffer.from("x"), metadata())).toThrow(/limit/);
    store.releaseTrace("t");
    expect(() => store.put(scope("t"), Buffer.from("12345678901"), metadata({ size: 11 }))).toThrow(/limit/);
    expect(store.size()).toBe(0);
  });

  it("expires resources after the TTL and releases them safely", () => {
    const { store, advance } = makeStore({ ttlMs: 1000 });
    const { id } = store.put(scope("t"), Buffer.from("AAAA"), metadata());
    expect(store.size()).toBe(1);
    advance(1000);
    expect(store.get(id, scope("t"))).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("copies bodies on put and returns copies on get/consume", () => {
    const { store } = makeStore();
    const input = Buffer.from("original");
    const { id } = store.put(scope("t"), input, metadata());
    input.fill(0); // caller mutation must not reach the store
    expect(store.get(id, scope("t"))?.toString()).toBe("original");
    const read = store.get(id, scope("t"))!;
    read.fill(88); // mutating the returned copy must not change the resource
    expect(store.get(id, scope("t"))?.toString()).toBe("original");
    const consumed = store.consume(id, scope("t"))!;
    expect(consumed.toString()).toBe("original");
    expect(store.get(id, scope("t"))).toBeUndefined();
  });

  it("consumes atomically only after authorization succeeds", () => {
    const { store } = makeStore();
    const { id } = store.put(scope("t", "p1"), Buffer.from("AAAA"), metadata());
    expect(store.consume(id, scope("t", "p2"))).toBeUndefined();
    expect(store.size()).toBe(1); // auth failure did not delete
    expect(store.consume(id, scope("t", "p1"))?.toString()).toBe("AAAA");
    expect(store.size()).toBe(0);
    expect(store.consume(id, scope("t", "p1"))).toBeUndefined(); // idempotent
  });

  it("releases only the target trace and is idempotent; dispose clears all", () => {
    const { store } = makeStore();
    store.put(scope("t1"), Buffer.from("A"), metadata());
    store.put(scope("t2"), Buffer.from("B"), metadata());
    expect(store.releaseTrace("t1")).toBe(1);
    expect(store.releaseTrace("t1")).toBe(0); // idempotent
    expect(store.size()).toBe(1);
    store.dispose();
    expect(store.size()).toBe(0);
    expect(store.releaseTrace("t2")).toBe(0);
  });

  it("zero-fills buffers on release", () => {
    const buffer = Buffer.from("secret-body-marker-xyz");
    zeroFillBuffer(buffer);
    expect(buffer.every((byte) => byte === 0)).toBe(true);
  });
});
