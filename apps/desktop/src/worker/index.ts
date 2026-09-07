import type { WorkerEndpoint } from "./message-loop.js";
import { createUtilityAssembly } from "./assembly.js";
import { HostClient } from "./host-client.js";

interface ParentPortLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
}

/**
 * Main forks the Utility Process as `utilityProcess.fork(agent-worker.js,
 * [skillsDir], ...)`, so the first non-secret argument after the module path
 * is the packaged/dev skills directory.
 */
function resolveSkillsDirArg(argv: string[]): string | undefined {
  const moduleIndex = argv.findIndex((arg) => arg.endsWith("agent-worker.js"));
  return moduleIndex >= 0 ? argv[moduleIndex + 1] : undefined;
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
  const skillsDir = resolveSkillsDirArg(process.argv);
  createUtilityAssembly({
    endpoint,
    agentMode: process.env.DEEPFIELD_AGENT_MODE,
    hostClient,
    ...(skillsDir !== undefined ? { skillsDir } : {}),
  });
}

const parentPort = (process as { parentPort?: unknown }).parentPort as ParentPortLike | undefined;
if (parentPort) {
  startWorker(parentPort);
}
