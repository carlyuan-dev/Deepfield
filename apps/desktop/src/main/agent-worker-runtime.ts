import { AgentWorkerClient, type MessageEndpoint } from "./agent-worker-client.js";

export interface AgentWorkerChild {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  off(event: "message", listener: (value: unknown) => void): void;
  off(event: "exit", listener: (code: number) => void): void;
  kill(): void;
}

export interface AgentWorkerRuntime {
  client: AgentWorkerClient;
  dispose(): void;
}

export function createAgentWorkerRuntime(child: AgentWorkerChild): AgentWorkerRuntime {
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
  const client = new AgentWorkerClient(endpoint);
  const unsubscribeAlive = endpoint.onExit(() => {
    alive = false;
  });
  return {
    client,
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
