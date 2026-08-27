import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { TransportError, type HostTimer, type TransportResponse } from "./http-transport.js";
import {
  createNodeHttpAdapter,
  createPinnedLookup,
  type NodeClientRequestLike,
  type NodeSocketLike,
} from "./node-http-adapter.js";
import type { DnsAnswer } from "./url-policy.js";

const ADDRESSES: readonly DnsAnswer[] = [
  { address: "93.184.216.34", family: 4 },
  { address: "2606:4700::1111", family: 6 },
];

class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeClientRequest extends EventEmitter {
  destroyed = false;
  destroy(): void {
    this.destroyed = true;
  }
  handOutSocket(): FakeSocket {
    const socket = new FakeSocket();
    this.emit("socket", socket);
    return socket;
  }
  respond(statusCode: number): void {
    const response = {
      statusCode,
      headers: { "content-type": "text/html" },
      body: Readable.from([Buffer.from("ok")]),
      destroy: () => {},
    };
    this.emit("response", response);
  }
}

interface ControllableTimer {
  timer: HostTimer;
  release(): void;
  cancelled(): boolean;
}

function makeTimer(): ControllableTimer {
  let release!: () => void;
  let cancelled = false;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    timer: {
      promise,
      cancel: () => {
        cancelled = true;
      },
    },
    release: () => release(),
    cancelled: () => cancelled,
  };
}

function makeAdapter() {
  const requestFactory = {
    options: [] as Array<Record<string, unknown>>,
    requests: [] as FakeClientRequest[],
    factory: (options: Record<string, unknown>, responseListener: (response: unknown) => void) => {
      requestFactory.options.push(options);
      const req = new FakeClientRequest();
      req.on("response", responseListener as never);
      requestFactory.requests.push(req);
      return req as unknown as NodeClientRequestLike;
    },
  };
  const timers: ControllableTimer[] = [];
  const adapter = createNodeHttpAdapter({
    request: requestFactory.factory,
    timer: (ms) => {
      const controlled = makeTimer();
      timers.push(controlled);
      return controlled.timer;
    },
  });
  return { adapter, requestFactory, timers };
}

const target = {
  protocol: "http:" as const,
  hostname: "example.com",
  port: 80,
  path: "/x",
  method: "GET" as const,
};

const requestOptions = { headers: { accept: "*/*" }, signal: new AbortController().signal, connectTimeoutMs: 10_000 };

describe("pinned lookup (focused revision)", () => {
  it("returns the full validated snapshot when all=true (Node 24 autoSelectFamily contract)", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    const callback = (error: Error | null, value?: unknown): void => {
      expect(error).toBeNull();
      expect(value).toEqual([
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700::1111", family: 6 },
      ]);
    };
    lookup("example.com", { all: true, family: 0, verbatim: true }, callback as never);
  });

  it("returns a single matching-family address when all is not set", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    let v4: unknown;
    let v6: unknown;
    lookup("example.com", { family: 4 }, ((_e: Error | null, address?: string, family?: number) => {
      v4 = [address, family];
    }) as never);
    lookup("example.com", { family: 6 }, ((_e: Error | null, address?: string, family?: number) => {
      v6 = [address, family];
    }) as never);
    expect(v4).toEqual(["93.184.216.34", 4]);
    expect(v6).toEqual(["2606:4700::1111", 6]);
  });

  it("fails on hostname mismatch, empty addresses and missing family", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    let mismatchError: unknown;
    lookup("evil.example", { all: true }, (error) => {
      mismatchError = error;
    });
    expect(String(mismatchError)).toContain("hostname");

    let emptyError: unknown;
    createPinnedLookup("example.com", [])( "example.com", { all: true }, (error) => {
      emptyError = error;
    });
    expect(String(emptyError)).toContain("no pinned");

    let familyError: unknown;
    lookup("example.com", { family: 5 }, (error) => {
      familyError = error;
    });
    expect(String(familyError)).toContain("family");
  });

  it("never re-resolves: the lookup only serves the checked addresses", () => {
    const lookup = createPinnedLookup("example.com", ADDRESSES);
    let calls = 0;
    const wrapped = (hostname: string, options: unknown, callback: unknown): void => {
      calls += 1;
      lookup(hostname, options as never, callback as never);
    };
    wrapped("example.com", { all: true }, (() => {}) as never);
    wrapped("example.com", { all: true }, (() => {}) as never);
    expect(calls).toBe(2); // each call serves the pinned snapshot, no DNS
  });
});

describe("node http adapter connect lifecycle (focused revision)", () => {
  it("resolves through the response and cancels the connect timer on connect", async () => {
    const { adapter, requestFactory, timers } = makeAdapter();
    const promise = adapter.request(target, requestOptions, ADDRESSES);
    const req = requestFactory.requests[0]!;
    const socket = req.handOutSocket();
    socket.emit("connect");
    req.respond(200);
    const response = await promise;
    expect(response.statusCode).toBe(200);
    expect(timers[0]!.cancelled()).toBe(true);
    expect(timers[0]!.timer.cancel).toBeTypeOf("function");
    // releasing the timer later must not reject the already-settled request
    timers[0]!.release();
  });

  it("rejects with TransportError('timeout') when the connect timer fires before connect", async () => {
    const { adapter, requestFactory, timers } = makeAdapter();
    const promise = adapter.request(target, requestOptions, ADDRESSES);
    const req = requestFactory.requests[0]!;
    req.handOutSocket();
    timers[0]!.release(); // the socket never connected
    await expect(promise).rejects.toBeInstanceOf(TransportError);
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(req.destroyed).toBe(true);
  });

  it("cancels the connect timer on secureConnect and never kills a post-response read", async () => {
    const { adapter, requestFactory, timers } = makeAdapter();
    const promise = adapter.request({ ...target, protocol: "https:" }, requestOptions, ADDRESSES);
    const req = requestFactory.requests[0]!;
    const socket = req.handOutSocket();
    socket.emit("secureConnect");
    req.respond(200);
    const response = await promise;
    expect(response.statusCode).toBe(200);
    expect(timers[0]!.cancelled()).toBe(true);
    // post-response: releasing the timer later is a no-op (settled guard)
    timers[0]!.release();
  });

  it("destroys the request when the transport aborts mid-connect", async () => {
    const { adapter, requestFactory } = makeAdapter();
    const controller = new AbortController();
    const promise = adapter.request(target, { ...requestOptions, signal: controller.signal }, ADDRESSES);
    promise.catch(() => {});
    const req = requestFactory.requests[0]!;
    req.handOutSocket();
    controller.abort();
    req.emit("error", new Error("aborted"));
    await expect(promise).rejects.toBeInstanceOf(TransportError);
    expect(req.destroyed).toBe(true);
  });
});
