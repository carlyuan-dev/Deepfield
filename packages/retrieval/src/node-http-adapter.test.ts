import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { TransportError, type HostTimer, type TransportResponse } from "./http-transport.js";
import {
  createNodeHttpAdapter,
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
  endCalls = 0;
  end(): void {
    this.endCalls += 1;
  }
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

describe("node http adapter connect lifecycle (focused revision)", () => {
  it("finalizes the client request exactly once so Node sends it", () => {
    const { adapter, requestFactory } = makeAdapter();
    void adapter.request(target, requestOptions, ADDRESSES);

    expect(requestFactory.requests[0]!.endCalls).toBe(1);
  });

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

describe("node http adapter timeout semantics and settle atomicity (focused revision)", () => {
  it("times out an HTTPS handshake that only completed TCP (no secureConnect)", async () => {
    const { adapter, requestFactory, timers } = makeAdapter();
    const promise = adapter.request({ ...target, protocol: "https:" }, requestOptions, ADDRESSES);
    const req = requestFactory.requests[0]!;
    const socket = req.handOutSocket();
    socket.emit("connect"); // TCP done, TLS never completes
    expect(timers[0]!.cancelled()).toBe(false); // connect must NOT clear the TLS timer
    timers[0]!.release();
    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(req.destroyed).toBe(true);
  });

  it("clears the connect timer only on secureConnect for HTTPS and only on connect for HTTP", async () => {
    const httpsCase = makeAdapter();
    const httpsPromise = httpsCase.adapter.request({ ...target, protocol: "https:" }, requestOptions, ADDRESSES);
    const httpsReq = httpsCase.requestFactory.requests[0]!;
    const httpsSocket = httpsReq.handOutSocket();
    httpsSocket.emit("connect");
    expect(httpsCase.timers[0]!.cancelled()).toBe(false);
    httpsSocket.emit("secureConnect");
    expect(httpsCase.timers[0]!.cancelled()).toBe(true);
    httpsReq.respond(200);
    await httpsPromise;

    const httpCase = makeAdapter();
    const httpPromise = httpCase.adapter.request(target, requestOptions, ADDRESSES);
    const httpReq = httpCase.requestFactory.requests[0]!;
    const httpSocket = httpReq.handOutSocket();
    httpSocket.emit("secureConnect"); // irrelevant for http
    expect(httpCase.timers[0]!.cancelled()).toBe(false);
    httpSocket.emit("connect");
    expect(httpCase.timers[0]!.cancelled()).toBe(true);
    httpReq.respond(200);
    await httpPromise;
  });

  it("settles atomically: a late error or duplicate response after success has no side effects", async () => {
    const { adapter, requestFactory, timers } = makeAdapter();
    const promise = adapter.request(target, requestOptions, ADDRESSES);
    const req = requestFactory.requests[0]!;
    const socket = req.handOutSocket();
    socket.emit("connect");
    req.respond(200);
    const response = await promise;
    expect(response.statusCode).toBe(200);
    // late request error after success: must not reject or double-destroy
    const originalDestroy = req.destroy.bind(req);
    let destroyCalls = 0;
    req.destroy = () => {
      destroyCalls += 1;
      originalDestroy();
    };
    req.emit("error", new Error("late"));
    expect(destroyCalls).toBe(0);
    // duplicate response after success: must be ignored without destroying it
    const lateResponse = {
      statusCode: 500,
      headers: {},
      body: Readable.from([]),
      destroyCalls: 0,
      destroy() {
        this.destroyCalls += 1;
      },
    };
    req.emit("response", lateResponse);
    expect(lateResponse.destroyCalls).toBe(0);
    await promise; // still resolves, no rejection
    expect(timers[0]!.cancelled()).toBe(true);
  });

  it("removes the socket lifecycle listeners after settle", async () => {
    const { adapter, requestFactory } = makeAdapter();
    const promise = adapter.request(target, requestOptions, ADDRESSES);
    const req = requestFactory.requests[0]!;
    const socket = req.handOutSocket();
    socket.emit("connect");
    req.respond(200);
    await promise;
    expect(socket.listenerCount("connect")).toBe(0);
    expect(socket.listenerCount("secureConnect")).toBe(0);
    expect(socket.listenerCount("error")).toBe(0);
  });
});
