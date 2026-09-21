import { Value } from "typebox/value";
import type { CapabilityWorkerRequest, CapabilityWorkerEvent } from "@deepfield/capability-sdk";
import { CompanyResearchWorkerEventSchema, CompanyProfileWorkerEventSchema, type CompanyResearchWorkerRequest, type CompanyProfileWorkerRequest } from "./contracts/index.js";
import type { CompanyResearchWorkerPort, CompanyProfileWorkerPort } from "./host-ports.js";

export interface WorkerTransport {
  sendCapability(request: CapabilityWorkerRequest, validate?: (event: CapabilityWorkerEvent) => boolean | "ignore"): AsyncIterable<CapabilityWorkerEvent>;
  cancelCapability(requestId: string, capabilityId: string, operation: string): void;
}
function mapStream<T>(stream: AsyncIterable<CapabilityWorkerEvent>, map: (event: CapabilityWorkerEvent) => T, cleanup: () => void = () => {}): AsyncIterable<T> {
  const iterator = stream[Symbol.asyncIterator]();
  return { [Symbol.asyncIterator]: () => ({
    async next() {
      try { const next = await iterator.next(); if (next.done) { cleanup(); return { done: true, value: undefined }; } return { done: false, value: map(next.value) }; }
      catch (error) { cleanup(); await iterator.return?.(); throw error; }
    },
    async return() { cleanup(); await iterator.return?.(); return { done: true, value: undefined }; },
  }) };
}
export function createCompanyResearchWorkerClient(transport: WorkerTransport): CompanyResearchWorkerPort & CompanyProfileWorkerPort {
  const active = new Map<string, CompanyResearchWorkerRequest>();
  return {
    sendResearch(request: CompanyResearchWorkerRequest) {
      const stream = transport.sendCapability({ kind: "capability.run", capabilityId: "company-research", operation: "research", requestId: request.requestId, input: request }, event => {
        if (event.type === "cancelled" && event.payload === null) return true;
        if (!Value.Check(CompanyResearchWorkerEventSchema, event.payload)) return false;
        if (event.payload.requestId !== request.requestId || event.payload.runId !== request.runId || event.payload.stage !== request.stage) return "ignore";
        return event.type === (["completed", "failed", "cancelled"].includes(event.payload.type) ? event.payload.type : "progress");
      });
      active.set(request.requestId, request);
      return mapStream(stream, event => {
        if (event.type === "cancelled" && event.payload === null) return { requestId: request.requestId, runId: request.runId, stage: request.stage, type: "cancelled" as const };
        if (!Value.Check(CompanyResearchWorkerEventSchema, event.payload)) throw new Error("invalid_capability_event");
        if (event.payload.requestId !== request.requestId || event.payload.runId !== request.runId || event.payload.stage !== request.stage) throw new Error("invalid_capability_correlation");
        return event.payload;
      }, () => { active.delete(request.requestId); });
    },
    sendProfile(request: CompanyProfileWorkerRequest) {
      const stream = transport.sendCapability({ kind: "capability.run", capabilityId: "company-research", operation: "profile", requestId: request.requestId, input: request }, event => Value.Check(CompanyProfileWorkerEventSchema, event.payload) && event.payload.requestId === request.requestId && event.payload.companyId === request.companyId && event.type === (event.payload.type === "diagnostic" ? "progress" : event.payload.type));
      return mapStream(stream, event => {
        if (!Value.Check(CompanyProfileWorkerEventSchema, event.payload) || event.payload.requestId !== request.requestId || event.payload.companyId !== request.companyId) throw new Error("invalid_capability_event");
        return event.payload;
      });
    },
    cancelResearch(requestId, runId, stage) { const request = active.get(requestId); if (request?.runId === runId && request.stage === stage) transport.cancelCapability(requestId, "company-research", "research"); },
  };
}
