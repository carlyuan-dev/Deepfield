import { describe, expect, it } from "vitest";
import { ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParsePdfDefinition } from "./pdf-tool.js";

const toolSet = new ToolSet([
  { identity: { name: "parse_pdf", version: 1 }, actor: "main_agent", effect: "project.read" },
]);

function context() {
  return { traceId: "t1", actor: "main_agent" as const, toolSet };
}

function scope(): ResourceScope {
  return { traceId: "t1", toolSetFingerprint: toolSet.fingerprint() };
}

const metadata = () => ({
  finalUrl: "https://example.com/report.pdf",
  contentType: "application/pdf",
  size: 0,
  sha256: "abc",
});

describe("parse_pdf abort responsiveness (focused revision)", () => {
  function defer(): { promise: Promise<never>; reject: (error: Error) => void } {
    let reject!: (error: Error) => void;
    const promise = new Promise<never>((_resolve, rejectFn) => {
      reject = rejectFn;
    });
    return { promise, reject };
  }

  function fakePdf(kind: "loading" | "metadata" | "page" | "text") {
    let destroyCalls = 0;
    let consumeCalls = 0;
    const metadataGate = defer();
    const pageGate = defer();
    const textGate = defer();
    const document = {
      numPages: 2,
      getMetadata: async () => {
        if (kind === "metadata") {
          await metadataGate.promise;
        }
        return { info: {} };
      },
      getPage: async () => {
        if (kind === "page") {
          await pageGate.promise;
        }
        return {
          getTextContent: async () => {
            if (kind === "text") {
              await textGate.promise;
            }
            return { items: [] };
          },
          cleanup() {},
        };
      },
      destroy: async () => {},
    };
    const loadingGate = defer();
    // The gates may be rejected by destroy() while still un-awaited (an abort
    // can race the execute's microtask chain): a no-op handler keeps them
    // marked handled; the execute still consumes the relevant rejection.
    loadingGate.promise.catch(() => {});
    metadataGate.promise.catch(() => {});
    pageGate.promise.catch(() => {});
    textGate.promise.catch(() => {});
    const promise = kind === "loading" ? loadingGate.promise : Promise.resolve(document);
    const task = {
      promise,
      destroy() {
        destroyCalls += 1;
        // reject only the gate this kind is awaiting; other gates never get
        // awaited so rejecting them would create unhandled rejections
        if (kind === "loading") {
          loadingGate.reject(new Error("destroyed"));
        } else if (kind === "metadata") {
          metadataGate.reject(new Error("destroyed"));
        } else if (kind === "page") {
          pageGate.reject(new Error("destroyed"));
        } else {
          textGate.reject(new Error("destroyed"));
        }
      },
    };
    const loader = (): typeof task => task;
    const store = {
      consume: () => {
        consumeCalls += 1;
        return { body: Buffer.from("pdf-bytes-marker"), metadata: metadata() };
      },
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    return { loader, store, destroyCalls: () => destroyCalls, consumeCalls: () => consumeCalls };
  }

  it("settles as cancelled when aborted while loading, with destroy and consume", async () => {
    const fake = fakePdf("loading");
    const definition = createParsePdfDefinition({ store: fake.store, loader: fake.loader });
    const controller = new AbortController();
    const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
    controller.abort();
    await expect(execute).rejects.toMatchObject({ code: "cancelled" });
    expect(fake.destroyCalls()).toBe(1);
    expect(fake.consumeCalls()).toBe(1);
  });

  it("settles as cancelled when aborted during getMetadata/getPage/getTextContent", async () => {
    for (const kind of ["metadata", "page", "text"] as const) {
      const fake = fakePdf(kind);
      const definition = createParsePdfDefinition({ store: fake.store, loader: fake.loader });
      const controller = new AbortController();
      const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
      // yield enough microtasks for the execute chain to reach its gate await
      // so the gate rejection is consumed by the in-flight await
      for (let i = 0; i < 12; i += 1) {
        await Promise.resolve();
      }
      controller.abort();
      await expect(execute).rejects.toMatchObject({ code: "cancelled" });
      expect(fake.destroyCalls()).toBe(1);
      expect(fake.consumeCalls()).toBe(1);
    }
  });

  it("keeps the stable failure code when the zero-fill itself throws", async () => {
    // Array-like body: new Uint8Array(body) works, but .fill() throws so the
    // best-effort zero-fill must not override the cancelled outcome.
    const body = {
      length: 14,
      fill() {
        throw new Error("zero-fill failed");
      },
    } as unknown as Buffer;
    const fake = fakePdf("page");
    const proxiedStore = {
      consume: () => ({ body, metadata: metadata() }),
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    const definition = createParsePdfDefinition({ store: proxiedStore, loader: fake.loader });
    const controller = new AbortController();
    const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
    for (let i = 0; i < 12; i += 1) {
      await Promise.resolve();
    }
    controller.abort();
    await expect(execute).rejects.toMatchObject({ code: "cancelled" });
  });
});
