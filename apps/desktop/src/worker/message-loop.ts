import { Value } from "typebox/value";
import { UsageFlushRequestSchema } from "@deepfield/contracts";
import { withUsageContext } from "../shared/usage-collection.js";
import {
  AgentWorkerEventSchema,
  CompanyProfileWorkerRequestSchema, CompanyProfileWorkerEventSchema,
  type CompanyProfileWorkerRequest, type CompanyProfileWorkerEvent,
  AgentWorkerRequestSchema,
  CompanyResearchCancelRequestSchema,
  CompanyResearchWorkerEventSchema,
  CompanyResearchWorkerRequestSchema,
  ToolExecutionEventSchema,
  ToolRunRequestSchema,
  type AgentWorkerEvent,
  type AgentWorkerRequest,
  type CompanyResearchWorkerEvent,
  type CompanyResearchWorkerRequest,
  type CompanyResearchStage,
  type ToolExecutionEvent,
  type ToolRunRequest,
} from "@deepfield/contracts";
import {
  isHostReply,
  researchFailure,
  safeRequestId,
  toolEnvelope,
  toolFailedEnvelope,
  type ActiveExecution,
  type ChatAgent,
  type ResearchAgent,
  type ToolRuntime,
  type WorkerEndpoint,
  type WorkerLoop,
} from "./message-loop-types.js";
import type { CompanyProfileAgent } from "./capabilities/company-research/company-profile-agent.js";

export type { ActiveExecution, ChatAgent, ResearchAgent, ToolRuntime, WorkerEndpoint, WorkerLoop } from "./message-loop-types.js";

export interface WorkerMessageLoopOptions {
  flushUsage?: () => Promise<void>;
  toolRuntime?: ToolRuntime;
  researchAgent?: ResearchAgent;
  profileAgent?: CompanyProfileAgent;
  hostReplyHandler?: (reply: unknown) => void;
  /** Called once when the loop is disposed (e.g. to dispose the HostClient). */
  onDispose?: () => void;
}

export function createWorkerMessageLoop(
  endpoint: WorkerEndpoint,
  chatAgent: ChatAgent,
  options: WorkerMessageLoopOptions = {},
): WorkerLoop {
  const active = new Map<string, ActiveExecution>();
  const activeExecutions = new Map<string, ActiveExecution>();
  let disposed = false;
  const unsubscribe = endpoint.onMessage((value) => handleInbound(value));

  function handleInbound(value: unknown): void {
    if (disposed) {
      return;
    }
    if (Value.Check(UsageFlushRequestSchema, value)) {
      for (const execution of active.values()) execution.controller.abort();
      void Promise.resolve().then(() => options.flushUsage?.()).catch(() => {}).then(() => {
        endpoint.postMessage({ kind: "usage.flushed", requestId: value.requestId });
      });
      return;
    }
    if (isHostReply(value)) {
      options.hostReplyHandler?.(value);
      return;
    }
    if (Value.Check(AgentWorkerRequestSchema, value)) {
      startChat(value);
      return;
    }
    if (Value.Check(CompanyProfileWorkerRequestSchema, value)) {
      startProfile(value);
      return;
    }
    if (Value.Check(CompanyResearchWorkerRequestSchema, value)) {
      startResearch(value);
      return;
    }
    if (Value.Check(CompanyResearchCancelRequestSchema, value)) {
      cancelResearch(value.requestId, value.runId, value.stage);
      return;
    }
    if (Value.Check(ToolRunRequestSchema, value)) {
      startTool(value);
      return;
    }
    const requestId = safeRequestId(value);
    if (requestId !== undefined) {
      endpoint.postMessage({
        requestId,
        type: "failed",
        code: "invalid_request",
        message: "invalid agent worker request",
      } satisfies AgentWorkerEvent);
    }
  }

  function startProfile(request: CompanyProfileWorkerRequest): void {
    const execution = begin(request.requestId, "profile");
    if (!execution) return;
    execution.companyId = request.companyId;
    const emit = (event: CompanyProfileWorkerEvent): void => {
      if (disposed || execution.settled) return;
      if (!Value.Check(CompanyProfileWorkerEventSchema, event) || event.requestId !== request.requestId || event.companyId !== request.companyId) {
        execution.settle("agent_failed", "", true);
        return;
      }
      if (event.type !== "diagnostic") execution.finalize();
      endpoint.postMessage(event);
    };
    void Promise.resolve().then(() => withUsageContext({ sourceId: "company-profile", taskId: request.requestId }, () => options.profileAgent?.run(request, emit, execution.controller.signal)))
      .then(() => { if (!execution.settled) execution.settle("agent_failed", "", false); })
      .catch(() => execution.settle("agent_failed", "", false));
  }

  function startResearch(request: CompanyResearchWorkerRequest): void {
    const agent = options.researchAgent;
    if (!agent) {
      endpoint.postMessage({
        requestId: request.requestId,
        runId: request.runId,
        type: "failed",
        ...researchFailure(request.stage),
      } satisfies CompanyResearchWorkerEvent);
      return;
    }
    const execution = begin(request.requestId, "research", undefined, request.runId, request.stage);
    if (!execution) return;
    const emit = (event: unknown): void => {
      if (disposed || execution.settled) return;
      if (
        !Value.Check(CompanyResearchWorkerEventSchema, event) ||
        event.requestId !== request.requestId ||
        event.runId !== request.runId ||
        event.stage !== request.stage
      ) {
        execution.settle("research_failed", "company research failed", true);
        return;
      }
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
        execution.finalize();
        endpoint.postMessage(event);
        return;
      }
      endpoint.postMessage(event);
    };
    void Promise.resolve()
      .then(() => withUsageContext({ sourceId: `company-research-${request.stage}`, taskId: request.requestId, operationId: request.runId, stageId: request.stage }, () => agent.run(request, emit, execution.controller.signal)))
      .then(() => {
        if (!execution.settled && !disposed) {
          execution.settle("research_failed", "company research failed", false);
        }
      })
      .catch(() => execution.settle("research_failed", "company research failed", false));
  }

  function cancelResearch(requestId: string, runId: string, stage: CompanyResearchStage): void {
    const execution = active.get(requestId);
    if (execution?.kind === "research" && execution.runId === runId && execution.stage === stage) {
      // Finalize before abort listeners can emit: cancellation wins exactly once.
      execution.finalize();
      execution.controller.abort();
      endpoint.postMessage({ requestId, runId, stage, type: "cancelled" } satisfies CompanyResearchWorkerEvent);
    }
  }

  function startChat(request: AgentWorkerRequest): void {
    const execution = begin(request.requestId, "chat");
    if (!execution) {
      return;
    }
    const emit = (event: unknown): void => {
      if (disposed || execution.settled) {
        return;
      }
      if (
        !Value.Check(AgentWorkerEventSchema, event) ||
        safeRequestId(event) !== request.requestId
      ) {
        execution.settle("invalid_event", "agent emitted an invalid event", true);
        return;
      }
      if (event.type === "completed" || event.type === "failed") {
        execution.finalize();
        endpoint.postMessage(event);
        return;
      }
      endpoint.postMessage(event);
    };

    void Promise.resolve()
      .then(() => withUsageContext({ sourceId: "chat", taskId: request.requestId }, () => chatAgent.run(request, emit, execution.controller.signal)))
      .then(() => {
        if (!execution.settled && !disposed) {
          execution.settle(
            "agent_no_terminal_event",
            "agent finished without a terminal event",
            false,
          );
        }
      })
      .catch(() => {
        execution.settle("agent_error", "agent execution failed", false);
      });
  }

  function startTool(request: ToolRunRequest): void {
    const runtime = options.toolRuntime;
    if (!runtime) {
      postToolTerminal(
        request.requestId,
        request.executionId,
        request.traceId,
        request.tool,
        "tool_not_found",
        "tool execution is not available",
      );
      return;
    }
    if (activeExecutions.has(request.executionId)) {
      // A second execution for an already-active logical id is refused; the
      // first execution keeps running (its transport generation stays unique).
      postToolTerminal(
        request.requestId,
        request.executionId,
        request.traceId,
        request.tool,
        "duplicate_execution",
        "tool execution id already active",
      );
      return;
    }
    const execution = begin(request.requestId, "tool", request.executionId);
    if (!execution) {
      return;
    }
    execution.traceId = request.traceId;
    execution.tool = request.tool;
    const emit = (event: unknown): void => {
      if (disposed || execution.settled) {
        return;
      }
      if (
        !Value.Check(ToolExecutionEventSchema, event) ||
        (event as ToolExecutionEvent).executionId !== request.executionId ||
        (event as ToolExecutionEvent).traceId !== request.traceId
      ) {
        execution.settle("invalid_event", "agent emitted an invalid tool event", true);
        return;
      }
      if (
        event.type === "completed" ||
        event.type === "failed" ||
        event.type === "cancelled"
      ) {
        execution.finalize();
        endpoint.postMessage(toolEnvelope(request.requestId, event));
        return;
      }
      endpoint.postMessage(toolEnvelope(request.requestId, event));
    };

    void Promise.resolve()
      .then(() => runtime.run(request, emit, execution.controller.signal))
      .then(() => {
        if (!execution.settled && !disposed) {
          execution.settle(
            "agent_no_terminal_event",
            "tool finished without a terminal event",
            false,
          );
        }
      })
      .catch(() => {
        execution.settle("tool_error", "tool execution failed", false);
      });
  }

  function postToolTerminal(
    requestId: string,
    executionId: string,
    traceId: string,
    tool: { name: string; version: number },
    code: string,
    message: string,
  ): void {
    if (disposed) {
      return;
    }
    endpoint.postMessage(
      toolFailedEnvelope(requestId, executionId, traceId, tool, code, message, Date.now()),
    );
  }

  /** Registers an active execution; returns undefined on duplicate transport ids. */
  function begin(
    requestId: string,
    kind: "chat" | "research" | "tool" | "profile",
    executionId?: string,
    runId?: string,
    stage?: CompanyResearchStage,
  ): ActiveExecution | undefined {
    const existing = active.get(requestId);
    if (existing) {
      existing.settle("duplicate_request", "a request with this id is already active", true);
      return undefined;
    }
    const controller = new AbortController();
    const execution: ActiveExecution = {
      kind,
      requestId,
      ...(executionId !== undefined ? { executionId } : {}),
      ...(runId !== undefined ? { runId } : {}),
      ...(stage !== undefined ? { stage } : {}),
      controller,
      settled: false,
      settle: () => {},
      finalize: () => {},
    };
    const finalize = (): void => {
      if (execution.settled) {
        return;
      }
      execution.settled = true;
      active.delete(requestId);
      if (executionId !== undefined) {
        activeExecutions.delete(executionId);
      }
    };
    execution.settle = (code: string, message: string, abortSignal: boolean): void => {
      if (execution.settled) {
        return;
      }
      finalize();
      if (abortSignal) {
        execution.controller.abort();
      }
      if (disposed) {
        return;
      }
      if (execution.kind === "profile" && execution.companyId !== undefined) {
        endpoint.postMessage({ kind: "company-profile.event", requestId, companyId: execution.companyId, type: "failed", code: "agent_failed" } satisfies CompanyProfileWorkerEvent);
        return;
      }
      if (
        execution.kind === "tool" &&
        execution.executionId !== undefined &&
        execution.traceId !== undefined &&
        execution.tool !== undefined
      ) {
        endpoint.postMessage(
          toolFailedEnvelope(
            requestId,
            execution.executionId,
            execution.traceId,
            execution.tool,
            code,
            message,
            Date.now(),
          ),
        );
        return;
      }
      if (execution.kind === "research" && execution.runId !== undefined && execution.stage !== undefined) {
        endpoint.postMessage({
          requestId,
          runId: execution.runId,
          type: "failed",
          ...researchFailure(execution.stage),
        } satisfies CompanyResearchWorkerEvent);
        return;
      }
      endpoint.postMessage({
        requestId,
        type: "failed",
        code,
        message,
      } satisfies AgentWorkerEvent);
    };
    execution.finalize = finalize;
    active.set(requestId, execution);
    if (executionId !== undefined) {
      activeExecutions.set(executionId, execution);
    }
    return execution;
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribe();
      for (const execution of active.values()) {
        execution.settled = true;
        execution.controller.abort();
      }
      active.clear();
      activeExecutions.clear();
      options.onDispose?.();
    },
    activeCount() {
      return active.size;
    },
  };
}
