import { describe, expect, it } from "vitest";
import { ToolSet } from "@deepfield/tool-platform";
import { ResourceStore, type ResourceScope } from "./resource-store.js";
import { createParsePdfDefinition } from "./pdf-tool.js";
import type { PdfLoadingTaskLike } from "./pdf-lifecycle.js";

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

/**
 * Deterministic fake PDF loader. destroy() returns a promise and NEVER rejects
 * or settles the in-flight gates: cancellation must come from the tool's own
 * abort race, not from the third-party destroy unwinding awaits.
 */
function fakePdf(options: { destroyRejects?: boolean } = {}) {
  let destroyCalls = 0;
  let consumeCalls = 0;
  const gates = {
    metadata: { reject: () => {} },
    page: { reject: () => {} },
    text: { reject: () => {} },
    load: { reject: () => {} },
  };
  void gates;
  const document = {
    numPages: 2,
    getMetadata: async () => ({ info: {} }),
    getPage: async () => ({
      getTextContent: async () => ({ items: [] }),
      cleanup() {},
    }),
    // mirrors pdfjs: PDFDocumentProxy.destroy() delegates to the loading task
    destroy: () => task.destroy(),
  };
  const task: PdfLoadingTaskLike = {
    promise: new Promise(() => {}), // never settles: the abort race decides
    destroy(): Promise<void> {
      destroyCalls += 1;
      return options.destroyRejects
        ? Promise.reject(new Error("destroy failed"))
        : Promise.resolve();
    },
  };
  const loader = (): PdfLoadingTaskLike => task;
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
  return { loader, store, document, destroyCalls: () => destroyCalls, consumeCalls: () => consumeCalls };
}

describe("parse_pdf abort and destroy lifecycle (focused revision)", () => {
  it("settles cancelled promptly even when the loading promise never settles and destroy stays resolved", async () => {
    const fake = fakePdf();
    const definition = createParsePdfDefinition({ store: fake.store, loader: fake.loader });
    const controller = new AbortController();
    const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
    controller.abort(); // no microtask yields needed: the abort race owns cancellation
    await expect(execute).rejects.toMatchObject({ code: "cancelled" });
    expect(fake.destroyCalls()).toBe(1);
    expect(fake.consumeCalls()).toBe(1);
  });

  it("starts the loading task destroy exactly once on success, parse failure and cancel", async () => {
    // success path: a loader whose document works
    const workingDocument = {
      numPages: 1,
      getMetadata: async () => ({ info: { Title: "ok" } }),
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
        cleanup() {},
      }),
      destroy: () => Promise.resolve(),
    };
    let successDestroys = 0;
    const successTask: PdfLoadingTaskLike = {
      promise: Promise.resolve(workingDocument),
      destroy: () => {
        successDestroys += 1;
        return Promise.resolve();
      },
    };
    const successStore = {
      consume: () => ({ body: Buffer.from("x"), metadata: metadata() }),
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    const success = createParsePdfDefinition({ store: successStore, loader: () => successTask });
    await success.execute({ resourceId: "r1" }, context(), new AbortController().signal, () => {});
    expect(successDestroys).toBe(1);

    // cancel path: destroy must start once (the memoized cleanup is shared)
    const fake = fakePdf();
    const definition = createParsePdfDefinition({ store: fake.store, loader: fake.loader });
    const controller = new AbortController();
    const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
    controller.abort();
    await expect(execute).rejects.toMatchObject({ code: "cancelled" });
    expect(fake.destroyCalls()).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fake.destroyCalls()).toBe(1); // still once after the cleanup settled
  });

  it("never surfaces an unhandled rejection and keeps the stable code when destroy rejects", async () => {
    const fake = fakePdf({ destroyRejects: true });
    const definition = createParsePdfDefinition({ store: fake.store, loader: fake.loader });
    const controller = new AbortController();
    const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
    controller.abort();
    await expect(execute).rejects.toMatchObject({ code: "cancelled" }); // stable code despite failing destroy
    await new Promise<void>((resolve) => setImmediate(resolve)); // let the rejected destroy settle
  });

  it("maps a synchronously throwing loader to a stable code and zero-fills the copies", async () => {
    const consumeBody = Buffer.from("loader-throw-body");
    const store = {
      consume: () => ({ body: consumeBody, metadata: metadata() }),
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    const throwingLoader = (): never => {
      throw new Error("raw loader cause");
    };
    const definition = createParsePdfDefinition({ store, loader: throwingLoader });
    const error = await definition
      .execute({ resourceId: "r1" }, context(), new AbortController().signal, () => {})
      .catch((caught) => caught);
    expect(error).toMatchObject({ code: "invalid_input" });
    expect(String(error)).not.toContain("raw loader cause");
    expect(consumeBody.every((byte) => byte === 0)).toBe(true); // consumed copy zeroed
  });

  it("maps a synchronously throwing loader to cancelled when the signal is already aborted", async () => {
    const store = {
      consume: () => ({ body: Buffer.from("x"), metadata: metadata() }),
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    const definition = createParsePdfDefinition({
      store,
      loader: () => {
        throw new Error("boom");
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {}),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("settles cancelled when aborted during cleanup even though destroy never settles", async () => {
    let destroyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      destroyStarted = resolve;
    });
    let cleanupResolve!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      cleanupResolve = resolve;
    });
    let destroyCalls = 0;
    let capturedData: Uint8Array | undefined;
    const consumedBody = Buffer.from("cleanup-body-marker");
    const document = {
      numPages: 1,
      getMetadata: async () => ({ info: {} }),
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
        cleanup() {},
      }),
      destroy: async () => {},
    };
    const task: PdfLoadingTaskLike = {
      promise: Promise.resolve(document),
      destroy: () => {
        destroyCalls += 1;
        destroyStarted();
        return cleanupGate; // never settles unless the test resolves it
      },
    };
    const loader = (data: Uint8Array): PdfLoadingTaskLike => {
      capturedData = data;
      return task;
    };
    const store = {
      consume: () => ({ body: consumedBody, metadata: metadata() }),
      get: () => undefined,
      size: () => 0,
      releaseTrace: () => 0,
      dispose: () => {},
    } as unknown as ResourceStore;
    const definition = createParsePdfDefinition({ store, loader });
    const controller = new AbortController();
    const execute = definition.execute({ resourceId: "r1" }, context(), controller.signal, () => {});
    await started; // the parse completed and the cleanup (destroy) is in flight
    expect(destroyCalls).toBe(1);
    controller.abort();
    // must settle cancelled promptly despite the never-settling destroy
    await expect(execute).rejects.toMatchObject({ code: "cancelled" });
    expect(destroyCalls).toBe(1); // exactly once
    expect(capturedData!.every((byte) => byte === 0)).toBe(true); // dataView zeroed
    expect(consumedBody.every((byte) => byte === 0)).toBe(true); // consumed copy zeroed
    // a late cleanup completion must not turn into success or a second settle
    cleanupResolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(destroyCalls).toBe(1);
  });
});
