import { AgentWorkerClient, type MessageEndpoint } from "./agent-worker-client.js";
import { randomUUID } from "node:crypto";
import { Value } from "typebox/value";
import { UsageFlushReplySchema, UsageRepairReplySchema } from "@deepfield/contracts";

export interface AgentWorkerChild {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  off(event: "message", listener: (value: unknown) => void): void;
  off(event: "exit", listener: (code: number) => void): void;
  kill(): void;
}

export interface AgentWorkerRuntimeOptions {
  /** Central host-request router; the single message listener stays on the client. */
  host?: { handleRequest(message: unknown): void };
}

export interface AgentWorkerRuntime {
  flushUsage(): Promise<boolean>;
  repairUsage(): Promise<boolean>;
  client: AgentWorkerClient;
  postMessage(value: unknown): void;
  dispose(): void;
}

export function createAgentWorkerRuntime(
  child: AgentWorkerChild,
  options: AgentWorkerRuntimeOptions = {},
): AgentWorkerRuntime {
  let alive = true;
  const endpoint: MessageEndpoint = {
    postMessage: (value) => child.postMessage(value),
    onMessage: (listener) => {
      child.on("message", listener);
      return () => {
        child.off("message", listener);
      };
    },
    onExit: (listener) => {
      child.on("exit", listener);
      return () => {
        child.off("exit", listener);
      };
    },
  };
  const client = new AgentWorkerClient(endpoint, {
    ...(options.host !== undefined ? { hostHandler: options.host.handleRequest } : {}),
  });
  const unsubscribeAlive = endpoint.onExit(() => {
    alive = false;
  });
  return {
    async repairUsage() {
      if (!alive) return false;
      const requestId = randomUUID();
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); child.off("message", receive); child.off("exit", exited); resolve(ok); };
        const receive = (value: unknown) => { if (Value.Check(UsageRepairReplySchema, value) && value.requestId === requestId) finish(value.repaired); };
        const exited = () => finish(false);
        const timer = setTimeout(() => finish(false), 4000);
        child.on("message", receive); child.on("exit", exited);
        try { child.postMessage({ kind: "usage.repair", requestId }); } catch { finish(false); }
      });
    },
    async flushUsage() {
      if (!alive) return false;
      const requestId = randomUUID();
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer); child.off("message", receive); child.off("exit", exited); resolve(ok);
        };
        const receive = (value: unknown) => { if (Value.Check(UsageFlushReplySchema, value) && value.requestId === requestId) finish(true); };
        const exited = () => finish(false);
        const timer = setTimeout(() => finish(false), 2500);
        child.on("message", receive);
        child.on("exit", exited);
        try { child.postMessage({ kind: "usage.flush", requestId }); } catch { finish(false); }
      });
    },
    client,
    postMessage: (value) => child.postMessage(value),
    dispose() {
      client.dispose();
      unsubscribeAlive();
      if (alive) {
        child.kill();
        alive = false;
      }
    },
  };
}
