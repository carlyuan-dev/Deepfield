import {
  createWorkerMessageLoop,
  type WorkerEndpoint,
} from "./message-loop.js";
import { createFakeChatAgent } from "./fake-chat-agent.js";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { selectChatAgent } from "./select-chat-agent.js";

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
  const agent = selectChatAgent(process.env.DEEPFIELD_AGENT_MODE, {
    fake: () => createFakeChatAgent(),
    pi: () => createPiChatAgent(),
  });
  createWorkerMessageLoop(endpoint, agent);
}

const parentPort = (process as { parentPort?: unknown }).parentPort as ParentPortLike | undefined;
if (parentPort) {
  startWorker(parentPort);
}
