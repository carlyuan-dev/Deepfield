import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createUsageRepository, migrate } from "@deepfield/persistence";
import { createMainUsageRuntime } from "./usage-runtime.js";
import { createAgentWorkerRuntime, type AgentWorkerChild } from "./agent-worker-runtime.js";
import type { AgentWorkerEvent, AgentWorkerRequest } from "@deepfield/contracts";

class FakeChild implements AgentWorkerChild {
  posted: unknown[] = [];
  killed = false;
  private messageListeners = new Set<(value: unknown) => void>();
  private exitListeners = new Set<(code: number) => void>();

  postMessage(value: unknown): void {
    this.posted.push(value);
  }

  on(event: "message", listener: (value: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  on(
    event: "message" | "exit",
    listener: ((value: unknown) => void) | ((code: number) => void),
  ): void {
    if (event === "message") {
      this.messageListeners.add(listener as (value: unknown) => void);
    } else {
      this.exitListeners.add(listener as (code: number) => void);
    }
  }

  off(event: "message", listener: (value: unknown) => void): void;
  off(event: "exit", listener: (code: number) => void): void;
  off(
    event: "message" | "exit",
    listener: ((value: unknown) => void) | ((code: number) => void),
  ): void {
    if (event === "message") {
      this.messageListeners.delete(listener as (value: unknown) => void);
    } else {
      this.exitListeners.delete(listener as (code: number) => void);
    }
  }

  kill(): void {
    this.killed = true;
  }

  emitMessage(value: unknown): void {
    for (const listener of [...this.messageListeners]) {
      listener(value);
    }
  }

  emitExit(code: number): void {
    for (const listener of [...this.exitListeners]) {
      listener(code);
    }
  }

  messageListenerCount(): number {
    return this.messageListeners.size;
  }

  exitListenerCount(): number {
    return this.exitListeners.size;
  }
}

function request(requestId: string): AgentWorkerRequest {
  return {
    requestId,
    kind: "chat.prompt",
    prompt: "你好",
    context: { conversationId: "c1", systemPrompt: "sys", messages: [] },
    options: { webSearch: false },
    llm: {
      id: "llm-test",
      name: "DeepSeek",
      provider: "deepseek",
      protocol: "openai_compatible",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-flash",
      contextWindow: 128_000,
      apiKey: "sk-test-key",
    },
    toolAccess: { network: "disabled", maxAgentTurns: 6, maxSearchCalls: 0, maxFetchCalls: 0 },
  };
}

function completed(requestId: string): AgentWorkerEvent {
  return { requestId, type: "completed", text: "done" };
}

async function collect(stream: AsyncIterable<AgentWorkerEvent>): Promise<AgentWorkerEvent[]> {
  const values: AgentWorkerEvent[] = [];
  for await (const item of stream) {
    values.push(item);
  }
  return values;
}

describe("agent worker runtime", () => {
  it.each(["timeout", "post-failure", "already-dead", "exit-during-flush", "acknowledged"])("persists honest shutdown coverage across restart with no known records: %s", async (mode) => {
    vi.useFakeTimers();
    const db = new DatabaseSync(":memory:"); migrate(db);
    const repository = createUsageRepository(db);
    const usage = createMainUsageRuntime(repository);
    const child = new FakeChild(); const runtime = createAgentWorkerRuntime(child);
    // Mirrors the Main exit callback after shutdown has already begun.
    child.on("exit", () => { void usage.workerExited(false); });
    try {
      if (mode === "post-failure") child.postMessage = () => { throw Error("transport closed"); };
      if (mode === "already-dead") child.emitExit(1);
      const shutdown = usage.shutdown(runtime);
      const flush = child.posted.at(-1) as { kind: string; requestId: string } | undefined;
      if (mode !== "already-dead" && mode !== "post-failure") expect(flush?.kind).toBe("usage.flush");
      if (mode === "exit-during-flush") {
        child.emitExit(1);
        // A queued reply arriving after exit cannot turn failure into success.
        child.emitMessage({ kind: "usage.flushed", requestId: flush?.requestId });
      }
      if (mode === "acknowledged") child.emitMessage({ kind: "usage.flushed", requestId: flush?.requestId });
      await vi.advanceTimersByTimeAsync(2500); await shutdown;
      // The later expected child exit must retain an earlier flush warning.
      child.emitExit(0);
      expect(repository.getHealth()).toMatchObject({ cleanShutdown: true, failedRecords: 0, droppedRecords: 0, pendingRecords: 0, degraded: mode !== "acknowledged", lastErrorCode: mode === "acknowledged" ? null : "worker_flush_unconfirmed" });
      const restarted = createMainUsageRuntime(repository);
      const dashboard = await restarted.query.getDashboard({ serviceKind: "llm", range: "month", timeZone: "UTC" });
      expect(dashboard.summary.requests).toBe(0);
      expect(dashboard.health).toMatchObject({ previousUncleanShutdown: false, degraded: mode !== "acknowledged", failedRecords: 0, droppedRecords: 0, lastErrorCode: mode === "acknowledged" ? null : "worker_flush_unconfirmed" });
      await restarted.shutdown();
    } finally { runtime.dispose(); db.close(); vi.useRealTimers(); }
  });
  it("waits for the matching validated usage flush reply and removes its temporary listener", async () => {
    const child = new FakeChild(); const runtime = createAgentWorkerRuntime(child);
    const before = child.messageListenerCount();
    const flushed = runtime.flushUsage();
    const request = child.posted.at(-1) as { requestId: string };
    child.emitMessage({ kind: "usage.flushed", requestId: request.requestId, secret: "extra" });
    child.emitMessage({ kind: "usage.flushed", requestId: request.requestId });
    expect(await flushed).toBe(true);
    expect(child.messageListenerCount()).toBe(before);
    runtime.dispose();
  });
  it("adapts child messaging and streams events", async () => {
    const child = new FakeChild();
    const runtime = createAgentWorkerRuntime(child);
    const stream = runtime.client.send(request("req-1"));
    expect(child.posted).toEqual([request("req-1")]);
    child.emitMessage(completed("req-1"));
    expect(await collect(stream)).toEqual([completed("req-1")]);
    runtime.dispose();
  });

  it("dispose disposes the client and kills a live child", () => {
    const child = new FakeChild();
    const runtime = createAgentWorkerRuntime(child);
    expect(child.messageListenerCount()).toBe(1);
    expect(child.exitListenerCount()).toBe(2);
    runtime.dispose();
    expect(child.killed).toBe(true);
    expect(child.messageListenerCount()).toBe(0);
    expect(child.exitListenerCount()).toBe(0);
  });

  it("does not kill an already exited child on dispose", () => {
    const child = new FakeChild();
    const runtime = createAgentWorkerRuntime(child);
    child.emitExit(1);
    runtime.dispose();
    expect(child.killed).toBe(false);
    expect(child.exitListenerCount()).toBe(0);
  });
});
