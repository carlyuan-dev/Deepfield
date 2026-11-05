import type { WorkerEndpoint } from "./message-loop.js";
import { configureTraceCollector, createTraceCollector, configureTraceContent, createTraceContentCollector } from "@deepfield/base/trace/runtime";
import { randomUUID } from "node:crypto";
import { unwrapTraceContentRun } from "../shared/trace-content.js";
import { createUtilityAssembly } from "./assembly.js";
import { HostClient } from "./host-client.js";
import { createWorkerUsageRuntime } from "./usage-runtime.js";
import { configureUsageRecorder } from "../shared/usage-collection.js";
import { createWorkerTelemetryFlush } from "./shutdown.js";
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
  const acknowledgments = new Map<string, (accepted: boolean) => void>();
  const content = createTraceContentCollector(serialized => new Promise<boolean>(resolve => {
    const deliveryId = randomUUID();
    // Leave the sink unresolved after an ACK deadline: the collector's own
    // timeout closes it, preventing further messages to an unresponsive host.
    const timer = setTimeout(() => { acknowledgments.delete(deliveryId); }, 700);
    acknowledgments.set(deliveryId, accepted => { clearTimeout(timer); acknowledgments.delete(deliveryId); resolve(accepted); });
    try { parentPort.postMessage({ kind: "trace.content", deliveryId, serialized }); }
    catch { clearTimeout(timer); acknowledgments.delete(deliveryId); resolve(false); }
  }));
  configureTraceContent(content);
  const endpoint: WorkerEndpoint = {
    postMessage: (value) => {
      const event = value as { requestId?: unknown; type?: unknown; kind?: unknown };
      if (typeof event.requestId === "string" && ["completed", "failed", "cancelled", "handed_off"].includes(String(event.type)) && (event.kind === undefined || event.kind === "capability.event")) content.revoke(event.requestId);
      parentPort.postMessage(value);
    },
    onMessage: (listener) => {
      const handler = (event: { data: unknown }) => {
        const message = event.data as { kind?: unknown; deliveryId?: unknown; accepted?: unknown } | null;
        if (message?.kind === "trace.content.ack") {
          if (typeof message.deliveryId === "string") acknowledgments.get(message.deliveryId)?.(message.accepted === true);
          return;
        }
        listener(unwrapTraceContentRun(event.data, content));
      };
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
  const trace = createTraceCollector(event => parentPort.postMessage({ kind: "trace.event", event }), { onHealth: health => parentPort.postMessage({ kind: "trace.health", health }) });
  configureTraceCollector(trace);
  createUtilityAssembly({
    capabilitySnapshot: resolveCapabilitySnapshot(process.argv),
    flushUsage: async () => { await Promise.all([createWorkerTelemetryFlush(usage, trace)(), content.close()]); },
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
