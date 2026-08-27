import { describe, expect, it } from "vitest";
import { ResourceStore, ResourceStoreError, zeroFillBuffer, type ResourceScope } from "./resource-store.js";

function scope(traceId: string, projectId?: string, fingerprint = "fp-A"): ResourceScope {
  return { traceId, ...(projectId !== undefined ? { projectId } : {}), toolSetFingerprint: fingerprint };
}

function makeStore(options: { maxItemsPerTrace?: number; maxBytesPerTrace?: number; ttlMs?: number } = {}) {
  let now = 0;
  return {
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
    expect(store.get(id, scope("trace-a", "p1", "fp-A"))?.body.toString()).toBe("AAAA");
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

  it("enforces per-trace caps by traceId across project/fingerprint scopes", () => {
    const { store } = makeStore({ maxItemsPerTrace: 2, maxBytesPerTrace: 10 });
    store.put(scope("t", "p1", "fp-A"), Buffer.from("12345"), metadata({ size: 5 }));
    store.put(scope("t", "p2", "fp-B"), Buffer.from("abcde"), metadata({ size: 5 }));
    // same traceId, a third scope: still capped (caps aggregate by traceId)
    expect(() => store.put(scope("t", "p3", "fp-C"), Buffer.from("x"), metadata())).toThrow(/limit/);
    // a different trace has its own budget
    store.put(scope("t2"), Buffer.from("xy"), metadata({ size: 2 }));
    expect(store.size()).toBe(3);
    store.releaseTrace("t");
    expect(() => store.put(scope("t", "p1", "fp-A"), Buffer.from("12345678901"), metadata({ size: 11 }))).toThrow(/limit/);
  });

  it("returns ResourceViews with defensive body and metadata copies", () => {
    const { store } = makeStore();
    const input = Buffer.from("original");
    const { id } = store.put(scope("t"), input, metadata({ finalUrl: "https://a.example/" }));
    input.fill(0);
    const view = store.get(id, scope("t"))!;
    expect(view.body.toString()).toBe("original");
    expect(view.metadata.finalUrl).toBe("https://a.example/");
    view.body.fill(88);
    expect(() => {
      (view.metadata as { finalUrl: string }).finalUrl = "https://mutated.example/";
    }).toThrow(TypeError); // metadata is read-only
    const again = store.get(id, scope("t"))!;
    expect(again.body.toString()).toBe("original");
    expect(again.metadata.finalUrl).toBe("https://a.example/");
    const consumed = store.consume(id, scope("t"))!;
    expect(consumed.body.toString()).toBe("original");
    expect(store.get(id, scope("t"))).toBeUndefined();
  });

  it("expires resources after the TTL and releases them safely", () => {
    const { store, advance } = makeStore({ ttlMs: 1000 });
    const { id } = store.put(scope("t"), Buffer.from("AAAA"), metadata());
    expect(store.size()).toBe(1);
    advance(1000);
    expect(store.get(id, scope("t"))).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it("consumes atomically only after authorization succeeds", () => {
    const { store } = makeStore();
    const { id } = store.put(scope("t", "p1"), Buffer.from("AAAA"), metadata());
    expect(store.consume(id, scope("t", "p2"))).toBeUndefined();
    expect(store.size()).toBe(1);
    expect(store.consume(id, scope("t", "p1"))?.body.toString()).toBe("AAAA");
    expect(store.size()).toBe(0);
    expect(store.consume(id, scope("t", "p1"))).toBeUndefined(); // idempotent
  });

  it("releases only the target trace and is idempotent; dispose clears all", () => {
    const { store } = makeStore();
    store.put(scope("t1"), Buffer.from("A"), metadata());
    store.put(scope("t2"), Buffer.from("B"), metadata());
    expect(store.releaseTrace("t1")).toBe(1);
    expect(store.releaseTrace("t1")).toBe(0);
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

describe("resource store id collision and validation (focused revision)", () => {
  it("retries bounded on duplicate ids and never overwrites or loses the old resource", () => {
    const ids = ["dup", "dup", "fresh"];
    let index = 0;
    const store = new ResourceStore({
      idFactory: () => ids[Math.min(index++, ids.length - 1)]!,
    });
    const first = store.put(scope("t"), Buffer.from("old-body"), metadata({ finalUrl: "https://a/" }));
    expect(first.id).toBe("dup");
    const second = store.put(scope("t"), Buffer.from("new-body"), metadata({ finalUrl: "https://b/" }));
    expect(second.id).toBe("fresh");
    expect(store.get("dup", scope("t"))?.body.toString()).toBe("old-body");
    expect(store.get("fresh", scope("t"))?.body.toString()).toBe("new-body");
    expect(store.size()).toBe(2);
  });

  it("fails safely when the id factory keeps returning empty or duplicate ids", () => {
    const store = new ResourceStore({ idFactory: () => "dup" });
    store.put(scope("t"), Buffer.from("x"), metadata());
    expect(() => store.put(scope("t"), Buffer.from("y"), metadata())).toThrow(/id generation/i);
    expect(store.size()).toBe(1);
    const empty = new ResourceStore({ idFactory: () => "" });
    expect(() => empty.put(scope("t"), Buffer.from("x"), metadata())).toThrow(/id generation/i);
    expect(empty.size()).toBe(0);
  });

  it("rejects invalid scope and invalid constructor configuration fail closed", () => {
    const store = makeStore().store;
    expect(() => store.put(scope(""), Buffer.from("x"), metadata())).toThrow(ResourceStoreError);
    expect(() => store.put({ traceId: "t", toolSetFingerprint: "" }, Buffer.from("x"), metadata())).toThrow(ResourceStoreError);
    expect(() => new ResourceStore({ maxItemsPerTrace: 0 })).toThrow(/maxItems/i);
    expect(() => new ResourceStore({ maxItemsPerTrace: -1 })).toThrow(/maxItems/i);
    expect(() => new ResourceStore({ maxBytesPerTrace: -1 })).toThrow(/maxBytes/i);
    expect(() => new ResourceStore({ ttlMs: 0 })).toThrow(/ttl/i);
    expect(() => new ResourceStore({ maxItemsPerTrace: 1.5 })).toThrow(/maxItems/i);
  });
});

describe("resource store runtime trust boundary (focused revision)", () => {
  it("determines the unique id before copying the body (failure leaves no copy)", () => {
    const input = Buffer.from("AAAA");
    let calls = 0;
    const store = new ResourceStore({
      idFactory: () => {
        calls += 1;
        if (calls === 1) {
          return "dup"; // seed resource
        }
        if (calls === 2) {
          input.fill(66); // "BBBB": mutate the caller buffer during the retry
          return "dup"; // collision -> retry
        }
        return "fresh";
      },
    });
    store.put(scope("t"), Buffer.from("old"), metadata({ finalUrl: "https://old/" }));
    const { id } = store.put(scope("t"), input, metadata({ finalUrl: "https://new/" }));
    expect(id).toBe("fresh");
    // The stored body must observe the mutation, proving the copy happens
    // after id selection; a copy made before id selection keeps "AAAA".
    expect(store.get(id, scope("t"))!.body.toString()).toBe("BBBB");
    // exhaustion never leaves an uncleaned copy: size and old resource intact
    const exhausted = new ResourceStore({ idFactory: () => "dup" });
    exhausted.put(scope("t"), Buffer.from("old-body"), metadata());
    expect(() => exhausted.put(scope("t"), Buffer.from("new-body"), metadata())).toThrow(/id generation/i);
    expect(exhausted.size()).toBe(1);
    expect(exhausted.get("dup", scope("t"))!.body.toString()).toBe("old-body");
  });

  it("rejects malformed scope, body and metadata without consuming quota", () => {
    const { store } = makeStore();
    store.put(scope("t"), Buffer.from("valid"), metadata());
    expect(() => store.put({ traceId: "t", projectId: "", toolSetFingerprint: "fp-A" }, Buffer.from("x"), metadata())).toThrow(ResourceStoreError);
    expect(() => store.put(scope("t"), "not-a-buffer" as never, metadata())).toThrow(ResourceStoreError);
    expect(() => store.put(scope("t"), Buffer.from("x"), { finalUrl: "", contentType: "text/html", size: 1, sha256: "a" })).toThrow(ResourceStoreError);
    expect(() => store.put(scope("t"), Buffer.from("x"), { finalUrl: "u", contentType: "text/html", size: Number.NaN, sha256: "a" })).toThrow(ResourceStoreError);
    expect(() => store.put(scope("t"), Buffer.from("x"), { finalUrl: "u", contentType: "text/html", size: 1, sha256: "" })).toThrow(ResourceStoreError);
    expect(() => store.put(scope("t"), Buffer.from("x"), { finalUrl: "u", contentType: "", size: 1, sha256: "a" })).toThrow(ResourceStoreError);
    // malformed puts never occupied quota or left residue
    expect(store.size()).toBe(1);
    expect(store.releaseTrace("t")).toBe(1);
    expect(store.size()).toBe(0);
  });
});
