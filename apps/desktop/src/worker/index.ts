import {
  createWorkerMessageLoop,
  type ChatAgent,
  type WorkerEndpoint,
} from "./message-loop.js";

const unavailableAgent: ChatAgent = {
  async run(request, emit) {
    emit({
      requestId: request.requestId,
      type: "failed",
      code: "agent_not_configured",
      message: "agent is not configured",
    });
  },
};

interface ParentPortLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
}

function startWorker(parentPort: ParentPortLike): void {
  const endpoint: WorkerEndpoint = {
    postMessage: (value) => parentPort.postMessage(value),
    onMessage: (listener) => {
      const handler = (event: { data: unknown }) => listener(event.data);
      parentPort.on("message", handler);
      return () => {
        parentPort.off("message", handler);
      };
    },
  };
  createWorkerMessageLoop(endpoint, unavailableAgent);
}

const parentPort = (process as { parentPort?: unknown }).parentPort as ParentPortLike | undefined;
if (parentPort) {
  startWorker(parentPort);
}
