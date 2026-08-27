import { describe, expect, it } from "vitest";
import {
  HostClient,
  HostRpcError,
  HostRpcProtocolError,
  HostRpcTimeoutError,
} from "./host-client.js";
import { RemoteToolAuditSink, createHostSecretClient } from "./host-client.js";

interface FakeTimer {
  promise: Promise<void>;
  fire(): void;
  cancel(): void;
}

function makeTimer(): {
  timer: (ms: number) => FakeTimer;
  fire: () => void;
} {
  let latest: { fire(): void } | undefined;
  const timer = (ms: number): FakeTimer => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const handle = { fire: () => resolve() };
    latest = handle;
    return {
      promise: promise.then(() => undefined),
      fire: () => handle.fire(),
      cancel: () => handle.fire(),
    };
  };
  return {
    timer,
    fire: () => latest?.fire(),
  };
}

function makeClient(): {
  client: HostClient;
  posted: unknown[];
  deliver(reply: unknown): void;
} {
  const posted: unknown[] = [];
  const client = new HostClient({
    postMessage: (value) => posted.push(value),
    timer: makeTimer().timer,
    timeoutMs: 1000,
  });
  return {
    client,
    posted,
    deliver: (reply) => client.handleReply(reply),
  };
}

describe("host client", () => {
  it("pairs concurrent requests with replies by host request id and method", async () => {
    const { client, posted, deliver } = makeClient();
    const first = client.request("audit.start", { executionId: "a" });
    const second = client.request("audit.finish", { executionId: "b", status: "completed", attempts: 1 });
    expect(posted).toHaveLength(2);
    const ids = posted.map((value) => (value as { hostRequestId: string }).hostRequestId);
    expect(ids[0]).not.toBe(ids[1]);
    deliver({
      hostRequestId: ids[1]!,
      kind: "host.reply",
      method: "audit.finish",
      ok: true,
      payload: { acknowledged: true },
    });
    deliver({
      hostRequestId: ids[0]!,
      kind: "host.reply",
      method: "audit.start",
      ok: true,
      payload: { acknowledged: true },
    });
    await expect(first).resolves.toEqual({ acknowledged: true });
    await expect(second).resolves.toEqual({ acknowledged: true });
    expect(client.pendingCount()).toBe(0);
  });

  it("settles once on duplicate replies and ignores late replies", async () => {
    const { client, posted, deliver } = makeClient();
    const request = client.request("audit.start", { executionId: "a" });
    const id = (posted[0] as { hostRequestId: string }).hostRequestId;
    const reply = {
      hostRequestId: id,
      kind: "host.reply",
      method: "audit.start",
      ok: true,
      payload: { acknowledged: true },
    };
    deliver(reply);
    deliver(reply);
    deliver({ hostRequestId: "ghost", kind: "host.reply", method: "audit.start", ok: false, code: "audit_failed" });
    await expect(request).resolves.toEqual({ acknowledged: true });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects on error replies and on malformed replies with a safe protocol error", async () => {
    const { client, posted, deliver } = makeClient();
    const errorRequest = client.request("audit.start", { executionId: "a" });
    const errorId = (posted[0] as { hostRequestId: string }).hostRequestId;
    deliver({ hostRequestId: errorId, kind: "host.reply", method: "audit.start", ok: false, code: "audit_failed" });
    await expect(errorRequest).rejects.toBeInstanceOf(HostRpcError);
    const malformed = client.request("audit.start", { executionId: "b" });
    const malformedId = (posted[1] as { hostRequestId: string }).hostRequestId;
    deliver({ hostRequestId: malformedId, kind: "host.reply", method: "audit.start", ok: true, payload: { secret: "x" } });
    await expect(malformed).rejects.toBeInstanceOf(HostRpcProtocolError);
    expect(client.pendingCount()).toBe(0);
  });

  it("times out with the injectable timer and cleans pending", async () => {
    const posted: unknown[] = [];
    const { timer, fire } = makeTimer();
    const client = new HostClient({ postMessage: (v) => posted.push(v), timer, timeoutMs: 1000 });
    const request = client.request("audit.start", { executionId: "a" });
    void (posted[0] as { hostRequestId: string }).hostRequestId;
    fire();
    await expect(request).rejects.toBeInstanceOf(HostRpcTimeoutError);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects pending and future requests on dispose", async () => {
    const { client, posted, deliver } = makeClient();
    const request = client.request("audit.start", { executionId: "a" });
    const id = (posted[0] as { hostRequestId: string }).hostRequestId;
    client.dispose();
    deliver({ hostRequestId: id, kind: "host.reply", ok: true, payload: { acknowledged: true } });
    await expect(request).rejects.toThrow(/disposed/);
    await expect(client.request("audit.start", { executionId: "b" })).rejects.toThrow(/disposed/);
    expect(client.pendingCount()).toBe(0);
  });

  it("RemoteToolAuditSink maps start/finish without sending failure message or metadata", async () => {
    const posted: unknown[] = [];
    const client = new HostClient({ postMessage: (v) => posted.push(v), timeoutMs: 1000 });
    const sink = new RemoteToolAuditSink(client);
    const startPromise = sink.start({
      executionId: "exec-1",
      traceId: "trace-1",
      actor: "developer_probe",
      tool: { name: "echo", version: 1 },
      attempts: 0,
    });
    const finishPromise = sink.finish({
      executionId: "exec-1",
      traceId: "trace-1",
      status: "failed",
      attempts: 3,
      failure: { code: "rate_limited", message: "secret provider message", retryable: true, attempts: 3 },
    });
    const serialized = JSON.stringify(posted);
    expect(serialized).not.toContain("secret provider message");
    expect(serialized).not.toContain("retryable");
    const startPayload = (posted[0] as { payload: Record<string, unknown> }).payload;
    expect(startPayload).toEqual({
      executionId: "exec-1",
      traceId: "trace-1",
      actor: "developer_probe",
      toolName: "echo",
      toolVersion: 1,
    });
    void startPromise.catch(() => {});
    void finishPromise.catch(() => {});
    client.dispose();
  });

  it("secret client only requests the allowlisted provider and never logs keys", async () => {
    const posted: unknown[] = [];
    const client = new HostClient({ postMessage: (v) => posted.push(v), timeoutMs: 1000 });
    const secrets = createHostSecretClient(client);
    const keyPromise = secrets.getProviderKey("deepseek");
    keyPromise.catch(() => {});
    expect(JSON.stringify(posted)).not.toContain("apiKey");
    expect((posted[0] as { payload: { provider: string } }).payload.provider).toBe("deepseek");
    void keyPromise;
    client.dispose();
  });
});

describe("host client typed correlation (focused revision)", () => {
  it("settles a synchronous reply delivered during postMessage", async () => {
    let client!: HostClient;
    client = new HostClient({
      postMessage: (value) => {
        client.handleReply({
          hostRequestId: (value as { hostRequestId: string }).hostRequestId,
          kind: "host.reply",
          method: "audit.start",
          ok: true,
          payload: { acknowledged: true },
        });
      },
      timeoutMs: 1000,
    });
    const promise = client.request("audit.start", { executionId: "a" });
    await expect(promise).resolves.toEqual({ acknowledged: true });
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects a reply whose method mismatches the request", async () => {
    const posted: unknown[] = [];
    const client = new HostClient({ postMessage: (v) => posted.push(v), timeoutMs: 1000 });
    const request = client.request("audit.start", { executionId: "a" });
    const id = (posted[0] as { hostRequestId: string }).hostRequestId;
    client.handleReply({
      hostRequestId: id,
      kind: "host.reply",
      method: "secret.getProviderKey",
      ok: true,
      payload: { apiKey: "sk-secret" },
    });
    await expect(request).rejects.toBeInstanceOf(HostRpcProtocolError);
    expect(client.pendingCount()).toBe(0);
  });

  it("never delivers a secret payload to an audit request (schema level)", async () => {
    const posted: unknown[] = [];
    const client = new HostClient({ postMessage: (v) => posted.push(v), timeoutMs: 1000 });
    const request = client.request("audit.finish", { executionId: "a", status: "completed", attempts: 1 });
    const id = (posted[0] as { hostRequestId: string }).hostRequestId;
    client.handleReply({
      hostRequestId: id,
      kind: "host.reply",
      method: "audit.finish",
      ok: true,
      payload: { apiKey: "sk-secret" },
    });
    await expect(request).rejects.toBeInstanceOf(HostRpcProtocolError);
    let leaked = "";
    try {
      await client.request("audit.start", { executionId: "b" });
    } catch (error) {
      leaked = String(error);
    }
    expect(leaked).not.toContain("sk-secret");
    expect(client.pendingCount()).toBe(0);
  });

  it("cleans up atomically when postMessage throws", async () => {
    const client = new HostClient({
      postMessage: () => {
        throw new Error("transport failed");
      },
      timeoutMs: 1000,
    });
    await expect(client.request("audit.start", { executionId: "a" })).rejects.toThrow(/disposed/);
    expect(client.pendingCount()).toBe(0);
  });

  it("rejects unknown error codes as protocol errors without leaking the raw value", async () => {
    const posted: unknown[] = [];
    const client = new HostClient({ postMessage: (v) => posted.push(v), timeoutMs: 1000 });
    const request = client.request("audit.start", { executionId: "a" });
    const id = (posted[0] as { hostRequestId: string }).hostRequestId;
    client.handleReply({
      hostRequestId: id,
      kind: "host.reply",
      method: "audit.start",
      ok: false,
      code: "sk-secret-raw-value",
    });
    const error = await request.catch((caught) => caught);
    expect(error).toBeInstanceOf(HostRpcProtocolError);
    expect(String(error)).not.toContain("sk-secret-raw-value");
    expect(client.pendingCount()).toBe(0);
  });
});
