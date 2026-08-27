import { AgentWorkerClient, type MessageEndpoint } from "./agent-worker-client.js";

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
