/** Test-only composition of host infrastructure. Never imported by package entries. */
import { createCapabilityAgentRuntime } from "../../../apps/desktop/src/worker/capabilities/agent-runtime.js";
import type { PiRuntime, PiToolSessionProvider } from "../../../apps/desktop/src/worker/agent/pi-runtime.js";
import type { ChatAgent, WorkerEndpoint } from "../../../apps/desktop/src/worker/message-loop.js";
import { createWorkerMessageLoop as createLoop, type WorkerMessageLoopOptions } from "../../../apps/desktop/src/worker/message-loop.js";
import { WorkerCapabilityRegistry } from "../../../apps/desktop/src/worker/capabilities/registry.js";
import { createCompanyResearchAgent as createResearch, type CompanyResearchAgent } from "./company-research-agent.js";
import { createCompanyProfileAgent as createProfile, type CompanyProfileAgent } from "./company-profile-agent.js";
import { CompanyResearchWorkerRequestSchema, CompanyResearchWorkerEventSchema, CompanyProfileWorkerRequestSchema, CompanyProfileWorkerEventSchema } from "../contracts/index.js";
import { Value } from "typebox/value";
import type { ModelGateway } from "../../../apps/desktop/src/shared/model-gateway.js";
import type { CompanyAgent } from "./ports.js";
import { AgentWorkerClient as HostWorkerClient, type MessageEndpoint } from "../../../apps/desktop/src/main/agent-worker-client.js";
import { createCompanyResearchWorkerClient } from "../worker-client.js";

export class AgentWorkerClient extends HostWorkerClient {
  private readonly business = createCompanyResearchWorkerClient(this);
  readonly sendResearch = (...args: Parameters<typeof this.business.sendResearch>) => this.business.sendResearch(...args);
  readonly sendProfile = (...args: Parameters<typeof this.business.sendProfile>) => this.business.sendProfile(...args);
  readonly cancelResearch = (...args: Parameters<typeof this.business.cancelResearch>) => this.business.cancelResearch(...args);
  constructor(endpoint: MessageEndpoint) {
    super({ postMessage: value => endpoint.postMessage(value), onExit: listener => endpoint.onExit(listener), onMessage: listener => endpoint.onMessage(value => {
      const event = value as { requestId?: string; kind?: string; runId?: string; type?: string };
      if (event.runId || event.kind === "company-profile.event") listener({ kind: "capability.event", capabilityId: "company-research", operation: event.kind === "company-profile.event" ? "profile" : "research", requestId: event.requestId, type: ["completed", "failed", "cancelled"].includes(event.type ?? "") ? event.type : "progress", payload: value });
      else listener(value);
    }) });
  }
}

export function createCompanyResearchAgent(options: { piRuntime?: PiRuntime; toolSessions?: PiToolSessionProvider; gateway?: ModelGateway; rawAgent?: ChatAgent } = {}) {
  const runtime = createCapabilityAgentRuntime({ ...(options.piRuntime ? { runtime: options.piRuntime } : {}), ...(options.toolSessions ? { toolSessions: options.toolSessions } : {}), ...(options.gateway ? { gateway: options.gateway } : {}) });
  const rawAgent: CompanyAgent | undefined = options.rawAgent ? { run: (request, emit, signal) => options.rawAgent!.run({ kind: "chat.prompt", requestId: request.requestId, prompt: request.prompt, context: { conversationId: request.requestId, systemPrompt: request.systemPrompt, messages: [], ...(request.finalizationSystemPrompt ? { finalizationSystemPrompt: request.finalizationSystemPrompt } : {}) }, options: { webSearch: request.toolAccess.network === "enabled" }, llm: request.llm, ...(request.search ? { search: request.search } : {}), toolAccess: request.toolAccess }, event => { if (event.type === "failed") throw new Error("failed"); if (event.type !== "transcript_checkpoint") emit(event as never); }, signal) } : undefined;
  return createResearch({ runtime, ...(rawAgent ? { rawAgent } : {}) });
}
export function createCompanyProfileAgent(options: { piRuntime?: PiRuntime; toolSessions: PiToolSessionProvider; gateway?: ModelGateway }) {
  return createProfile({ runtime: createCapabilityAgentRuntime({ ...(options.piRuntime ? { runtime: options.piRuntime } : {}), toolSessions: options.toolSessions, ...(options.gateway ? { gateway: options.gateway } : {}) }) });
}

/** Runs package fixtures through the generic loop; fixture events keep their business payload shape. */
export function createWorkerMessageLoop(endpoint: WorkerEndpoint, chat: ChatAgent, options: WorkerMessageLoopOptions & { researchAgent?: CompanyResearchAgent; profileAgent?: CompanyProfileAgent } = {}) {
  const registry = new WorkerCapabilityRegistry(value => {
    const event = value as { kind: string; payload: unknown };
    endpoint.postMessage(event.kind === "capability.event" ? event.payload : value);
  });
  const activation = registry.begin("company-research");
  if (options.researchAgent) activation.register("research", CompanyResearchWorkerRequestSchema, CompanyResearchWorkerEventSchema, (request, emit, signal) => options.researchAgent!.run(request, event => emit(event, ["completed", "failed", "cancelled"].includes(event.type) ? event.type as "completed" | "failed" | "cancelled" : undefined), signal));
  if (options.profileAgent) activation.register("profile", CompanyProfileWorkerRequestSchema, CompanyProfileWorkerEventSchema, (request, emit, signal) => options.profileAgent!.run(request, event => emit(event, event.type === "diagnostic" ? undefined : event.type), signal));
  activation.ready();
  return createLoop({ postMessage: value => endpoint.postMessage(value), onMessage: listener => endpoint.onMessage(value => {
    if (Value.Check(CompanyResearchWorkerRequestSchema, value) || Value.Check(CompanyProfileWorkerRequestSchema, value)) listener({ kind: "capability.run", capabilityId: "company-research", operation: Value.Check(CompanyResearchWorkerRequestSchema, value) ? "research" : "profile", requestId: value.requestId, input: value });
    else listener(value);
  }) }, chat, { ...options, capabilities: registry });
}
