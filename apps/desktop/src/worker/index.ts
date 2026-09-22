import type { WorkerEndpoint } from "./message-loop.js";
import { createUtilityAssembly } from "./assembly.js";
import { HostClient } from "./host-client.js";
import { createWorkerUsageRuntime } from "./usage-runtime.js";
import { configureUsageRecorder } from "../shared/usage-collection.js";
import type { TrustedCapabilityEntry } from "../shared/capability-entry.js";

interface ParentPortLike {
  postMessage(value: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
}

/**
 * Main forks the Utility Process as `utilityProcess.fork(agent-worker.js,
 * [skillsDir, startupSnapshotJson], ...)`. The second argument contains only
 * trusted package IDs and paths selected by Main, never renderer input/secrets.
 */
function resolveSkillsDirArg(argv: string[]): string | undefined {
  const moduleIndex = argv.findIndex((arg) => arg.endsWith("agent-worker.js"));
  return moduleIndex >= 0 ? argv[moduleIndex + 1] : undefined;
}

function resolveCapabilitySnapshot(argv: string[]): readonly TrustedCapabilityEntry[] {
  const moduleIndex = argv.findIndex(arg => arg.endsWith("agent-worker.js"));
  try {
    const parsed: unknown = JSON.parse(argv[moduleIndex + 2] ?? "[]");
    if (!Array.isArray(parsed) || parsed.some(entry => !entry || typeof entry !== "object" ||
      ["id", "root", "main", "worker"].some(key => typeof entry[key] !== "string"))) return [];
    return Object.freeze(parsed.map(entry => Object.freeze({ id: entry.id, root: entry.root, main: entry.main, worker: entry.worker })));
  } catch { return []; }
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
  const usageHost = new HostClient({ postMessage: (value) => parentPort.postMessage(value), timeoutMs: 750 });
  endpoint.onMessage((value) => usageHost.handleReply(value));
  const usage = createWorkerUsageRuntime(usageHost);
  configureUsageRecorder(usage.recorder);
  createUtilityAssembly({
    capabilitySnapshot: resolveCapabilitySnapshot(process.argv),
    flushUsage: () => usage.flush(),
    retryUsage: () => usage.retry(),
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
