import {
  createWorkerMessageLoop,
  type WorkerEndpoint,
} from "./message-loop.js";
import { createFakeChatAgent } from "./fake-chat-agent.js";
import { createPiChatAgent } from "./pi-chat-agent.js";
import { selectChatAgent } from "./select-chat-agent.js";
import { HostClient, RemoteToolAuditSink } from "./host-client.js";
import { createToolRuntime } from "./tool-runtime.js";

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
  const hostClient = new HostClient({
    postMessage: (value) => parentPort.postMessage(value),
    timeoutMs: 10_000,
  });
  const toolRuntime = createToolRuntime({ audit: new RemoteToolAuditSink(hostClient) });
  const agent = selectChatAgent(process.env.DEEPFIELD_AGENT_MODE, {
    fake: () => createFakeChatAgent(),
    pi: () => createPiChatAgent(undefined, toolRuntime.createAgentTools()),
  });
  createWorkerMessageLoop(endpoint, agent, {
    toolRuntime,
    hostReplyHandler: (reply) => hostClient.handleReply(reply),
  });
}

const parentPort = (process as { parentPort?: unknown }).parentPort as ParentPortLike | undefined;
if (parentPort) {
  startWorker(parentPort);
}
