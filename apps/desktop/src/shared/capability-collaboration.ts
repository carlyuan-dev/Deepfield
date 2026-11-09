import { createAgentCoordinator } from "@deepfield/base/agent/collaboration/runtime";
import type { AgentCoordinator } from "@deepfield/base/agent/collaboration";
import type { CapabilityAgentCollaboration, CapabilityHostServices } from "@deepfield/capability-sdk";
import { currentTrace, startTraceSpan, withTrace } from "@deepfield/base/trace/runtime";

/** Called by the trusted package loader, never by model arguments. */
export function scopeCapabilityCollaboration(services: CapabilityHostServices, capabilityId: string, defer: (cleanup: () => Promise<void>) => void): CapabilityHostServices {
  if (!services.has("agent.collaboration.v1")) return services;
  const scopes = new Map<string, AgentCoordinator>();
  let disposed = false;
  const port: CapabilityAgentCollaboration = {
    version: 1,
    create({ taskScopeId, ...options }) {
      if (disposed || !taskScopeId || taskScopeId.length > 200) throw new Error("invalid_collaboration_scope");
      const scopeId = `${capabilityId}:${taskScopeId}`;
      if (scopes.has(scopeId)) throw new Error("duplicate_collaboration_scope");
      const parent = currentTrace();
      const coordinator = createAgentCoordinator({ ...options, scopeId, owner: { kind: "capability", id: capabilityId },
        execute: async (request, controls) => {
          const span = startTraceSpan("task", parent?.requestId ?? taskScopeId, { capabilityId, taskId: request.taskId, runId: request.runId }, parent);
          try {
            const result = await withTrace(span.context, () => options.execute(request, controls));
            span.end(controls.signal.aborted ? "cancelled" : "succeeded");
            return result;
          } catch (error) { span.end(controls.signal.aborted ? "cancelled" : "failed", "execution_failed"); throw error; }
        },
      });
      const close = coordinator.close.bind(coordinator);
      coordinator.close = async () => { await close(); scopes.delete(scopeId); };
      scopes.set(scopeId, coordinator);
      return coordinator;
    },
  };
  defer(async () => { disposed = true; await Promise.all([...scopes.values()].map(scope => scope.close())); });
  return Object.freeze({ version: 1 as const, has: (name: string) => services.has(name),
    get<T>(name: string): T { return name === "agent.collaboration.v1" ? port as T : services.get<T>(name); } });
}
